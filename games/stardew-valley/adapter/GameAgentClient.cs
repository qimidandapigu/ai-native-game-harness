using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net.WebSockets;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace StardewAgentMod;

internal sealed class GameAgentClient : IAsyncDisposable
{
    private readonly Uri gatewayUri;
    private readonly SemaphoreSlim connectLock = new(1, 1);
    private readonly SemaphoreSlim sendLock = new(1, 1);
    private readonly ConcurrentDictionary<long, TaskCompletionSource<JsonDocument>> pending = new();
    private ClientWebSocket? socket;
    private CancellationTokenSource? connectionLifetime;
    private string? saveId;
    private long nextRequestId;

    public event Action<string>? AssistantPresented;
    public event Action<string>? AssistantStreaming;
    public event Action<string, string?>? AssistantStatusChanged;
    public event Action<string>? AssistantFailed;

    public GameAgentClient(string gatewayUrl)
    {
        this.gatewayUri = new Uri(gatewayUrl, UriKind.Absolute);
        if (this.gatewayUri.Scheme is not "ws" and not "wss")
            throw new ArgumentException("GatewayUrl must use ws:// or wss://.", nameof(gatewayUrl));
    }

    public void SetSaveId(string? value)
    {
        value = string.IsNullOrWhiteSpace(value) ? null : value.Trim();
        if (string.Equals(this.saveId, value, StringComparison.Ordinal)) return;
        this.saveId = value;
        this.ResetConnection();
    }

    public async Task<string> SendChatAsync(string text, object context, CancellationToken cancellationToken)
    {
        using JsonDocument response = await this.SendRequestAsync(
            "chat.send",
            new { text, context },
            cancellationToken
        ).ConfigureAwait(false);
        return ReadReply(response.RootElement);
    }

    public async Task PublishObservationAsync(object observation, CancellationToken cancellationToken)
    {
        await this.EnsureConnectedAsync(cancellationToken).ConfigureAwait(false);
        await this.SendPayloadAsync(new
        {
            jsonrpc = "2.0",
            method = "state.update",
            @params = new { observation }
        }, cancellationToken).ConfigureAwait(false);
    }

    private static string ReadReply(JsonElement root)
    {
        if (root.TryGetProperty("error", out JsonElement error))
        {
            string message = error.TryGetProperty("message", out JsonElement errorMessage)
                ? errorMessage.GetString() ?? "Unknown gateway error."
                : "Unknown gateway error.";
            throw new InvalidOperationException(message);
        }
        if (!root.TryGetProperty("result", out JsonElement result)
            || !result.TryGetProperty("reply", out JsonElement reply))
        {
            throw new InvalidOperationException("Gateway returned no reply.");
        }
        return reply.GetString() ?? string.Empty;
    }

    private async Task EnsureConnectedAsync(CancellationToken cancellationToken)
    {
        if (this.socket?.State == WebSocketState.Open) return;
        await this.connectLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (this.socket?.State == WebSocketState.Open) return;
            this.ResetConnection();
            this.connectionLifetime = new CancellationTokenSource();
            this.socket = new ClientWebSocket();
            await this.socket.ConnectAsync(this.gatewayUri, cancellationToken).ConfigureAwait(false);
            _ = this.ReceiveLoopAsync(this.socket, this.connectionLifetime.Token);

            using JsonDocument hello = await this.SendRequestCoreAsync(
                "adapter.hello",
                new
                {
                    adapterId = "qimidandapigu.StardewAgent",
                    gameId = "stardew-valley",
                    version = "0.6.1",
                    protocolVersion = "1.1",
                    capabilities = new[] { "assistant.text-stream" },
                    processId = Environment.ProcessId,
                    saveId = this.saveId
                },
                cancellationToken
            ).ConfigureAwait(false);
            if (hello.RootElement.TryGetProperty("error", out JsonElement error))
            {
                string message = error.TryGetProperty("message", out JsonElement errorMessage)
                    ? errorMessage.GetString() ?? "Adapter handshake failed."
                    : "Adapter handshake failed.";
                throw new InvalidOperationException(message);
            }
        }
        catch
        {
            this.ResetConnection();
            throw;
        }
        finally
        {
            this.connectLock.Release();
        }
    }

    private async Task<JsonDocument> SendRequestAsync(string method, object parameters, CancellationToken cancellationToken)
    {
        await this.EnsureConnectedAsync(cancellationToken).ConfigureAwait(false);
        return await this.SendRequestCoreAsync(method, parameters, cancellationToken).ConfigureAwait(false);
    }

    private async Task<JsonDocument> SendRequestCoreAsync(string method, object parameters, CancellationToken cancellationToken)
    {
        long id = Interlocked.Increment(ref this.nextRequestId);
        var completion = new TaskCompletionSource<JsonDocument>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!this.pending.TryAdd(id, completion)) throw new InvalidOperationException("Duplicate gateway request ID.");
        using CancellationTokenRegistration registration = cancellationToken.Register(() =>
        {
            if (this.pending.TryRemove(id, out TaskCompletionSource<JsonDocument>? removed))
                removed.TrySetCanceled(cancellationToken);
        });
        try
        {
            await this.SendPayloadAsync(new
            {
                jsonrpc = "2.0",
                id,
                method,
                @params = parameters
            }, cancellationToken).ConfigureAwait(false);
            return await completion.Task.ConfigureAwait(false);
        }
        catch
        {
            this.pending.TryRemove(id, out _);
            throw;
        }
    }

    private async Task SendPayloadAsync(object payload, CancellationToken cancellationToken)
    {
        ClientWebSocket activeSocket = this.socket
            ?? throw new InvalidOperationException("Gateway is not connected.");
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(payload);
        await this.sendLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await activeSocket.SendAsync(bytes, WebSocketMessageType.Text, true, cancellationToken)
                .ConfigureAwait(false);
        }
        finally
        {
            this.sendLock.Release();
        }
    }

    private async Task ReceiveLoopAsync(ClientWebSocket activeSocket, CancellationToken cancellationToken)
    {
        try
        {
            while (activeSocket.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
            {
                using MemoryStream message = new();
                byte[] buffer = new byte[8192];
                WebSocketReceiveResult result;
                do
                {
                    result = await activeSocket.ReceiveAsync(buffer, cancellationToken).ConfigureAwait(false);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        if (!cancellationToken.IsCancellationRequested)
                            this.AssistantFailed?.Invoke("与 Harness 的连接已关闭，请确认 Harness 正在运行。");
                        return;
                    }
                    message.Write(buffer, 0, result.Count);
                    if (message.Length > 4 * 1024 * 1024)
                        throw new InvalidOperationException("Gateway message exceeded 4 MiB.");
                }
                while (!result.EndOfMessage);

                JsonDocument document = JsonDocument.Parse(message.ToArray());
                JsonElement root = document.RootElement;
                if (root.TryGetProperty("id", out JsonElement responseId)
                    && responseId.ValueKind == JsonValueKind.Number
                    && responseId.TryGetInt64(out long id)
                    && this.pending.TryRemove(id, out TaskCompletionSource<JsonDocument>? completion))
                {
                    completion.TrySetResult(document);
                    continue;
                }

                try { this.DispatchNotification(root); }
                finally { document.Dispose(); }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
        catch (Exception ex)
        {
            this.FailPending(ex);
            this.AssistantFailed?.Invoke($"与 Harness 的连接中断：{ex.Message}");
        }
    }

    private void DispatchNotification(JsonElement root)
    {
        if (!root.TryGetProperty("method", out JsonElement methodElement)) return;
        string method = methodElement.GetString() ?? "";
        JsonElement parameters = root.TryGetProperty("params", out JsonElement value) ? value : default;
        switch (method)
        {
            case "gateway.ready":
                this.AssistantStatusChanged?.Invoke("ready", null);
                break;
            case "assistant.delta":
            case "assistant.text.delta":
                if (parameters.TryGetProperty("text", out JsonElement partialText))
                    this.AssistantStreaming?.Invoke(partialText.GetString() ?? "");
                break;
            case "assistant.present":
                if (parameters.TryGetProperty("text", out JsonElement text))
                    this.AssistantPresented?.Invoke(text.GetString() ?? "");
                break;
            case "assistant.status":
                string status = parameters.TryGetProperty("status", out JsonElement statusValue)
                    ? statusValue.GetString() ?? "" : "";
                string? transcript = parameters.TryGetProperty("transcript", out JsonElement transcriptValue)
                    ? transcriptValue.GetString() : null;
                this.AssistantStatusChanged?.Invoke(status, transcript);
                break;
            case "assistant.error":
                string message = parameters.TryGetProperty("message", out JsonElement errorValue)
                    ? errorValue.GetString() ?? "未知错误" : "未知错误";
                this.AssistantFailed?.Invoke(message);
                break;
        }
    }

    private void FailPending(Exception error)
    {
        foreach ((long id, TaskCompletionSource<JsonDocument> completion) in this.pending)
        {
            if (this.pending.TryRemove(id, out _)) completion.TrySetException(error);
        }
    }

    private void ResetConnection()
    {
        this.connectionLifetime?.Cancel();
        this.connectionLifetime?.Dispose();
        this.connectionLifetime = null;
        this.socket?.Dispose();
        this.socket = null;
        this.FailPending(new WebSocketException("Gateway connection reset."));
    }

    public ValueTask DisposeAsync()
    {
        this.ResetConnection();
        this.connectLock.Dispose();
        this.sendLock.Dispose();
        return ValueTask.CompletedTask;
    }
}
