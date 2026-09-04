using System;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using StardewModdingAPI;

namespace StardewAgentMod.Harness;

/// <summary>
/// Adapter Protocol 1.0 的 WebSocket Adapter。后台线程只处理字节与 JSON；
/// observe/execute 一律通过 MainThreadDispatcher 回到 SMAPI 主线程。
/// </summary>
internal sealed class AdapterProtocolClient : IAsyncDisposable
{
    private Uri hostUri;
    private readonly IAdapterProtocolHandler handler;
    private readonly MainThreadDispatcher dispatcher;
    private readonly IMonitor monitor;
    private readonly SemaphoreSlim sendLock = new(1, 1);
    private readonly CancellationTokenSource lifetime = new();
    private readonly object socketGate = new();

    private ClientWebSocket? socket;
    private Task? loop;
    private string? lastError;
    private bool connected;

    public AdapterProtocolClient(
        string hostUrl,
        IAdapterProtocolHandler handler,
        MainThreadDispatcher dispatcher,
        IMonitor monitor)
    {
        this.hostUri = ParseHostUri(hostUrl);

        this.handler = handler;
        this.dispatcher = dispatcher;
        this.monitor = monitor;
    }

    public event Action<bool>? ConnectionChanged;

    public void Start()
    {
        this.loop ??= this.RunReconnectLoopAsync(this.lifetime.Token);
    }

    public void Reconnect()
    {
        lock (this.socketGate)
            this.socket?.Abort();
    }

    public bool UpdateHost(string hostUrl)
    {
        Uri next = ParseHostUri(hostUrl);
        lock (this.socketGate)
        {
            if (this.hostUri == next) return false;
            this.hostUri = next;
            this.socket?.Abort();
        }
        this.monitor.Log($"[Harness] 已自动适配动作通道：{next}", LogLevel.Info);
        return true;
    }

    private static Uri ParseHostUri(string hostUrl)
    {
        var uri = new Uri(hostUrl, UriKind.Absolute);
        if (uri.Scheme is not "ws" and not "wss")
            throw new ArgumentException("AdapterProtocolUrl must use ws:// or wss://.", nameof(hostUrl));
        if (!uri.IsLoopback)
            throw new ArgumentException("AdapterProtocolUrl must use a loopback host.", nameof(hostUrl));
        return uri;
    }

    private async Task RunReconnectLoopAsync(CancellationToken cancellationToken)
    {
        int delayMs = 250;
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await this.ConnectOnceAsync(cancellationToken).ConfigureAwait(false);
                delayMs = 250;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                this.SetConnected(false);
                if (!string.Equals(this.lastError, ex.Message, StringComparison.Ordinal))
                {
                    this.lastError = ex.Message;
                    this.monitor.Log($"[Harness] Adapter Protocol 暂未连接：{ex.Message}", LogLevel.Trace);
                }
            }

            if (cancellationToken.IsCancellationRequested) break;
            try
            {
                await Task.Delay(delayMs, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            delayMs = Math.Min(5000, delayMs * 2);
        }
        this.SetConnected(false);
    }

    private async Task ConnectOnceAsync(CancellationToken cancellationToken)
    {
        Uri targetUri;
        lock (this.socketGate)
            targetUri = this.hostUri;
        using var activeSocket = new ClientWebSocket();
        activeSocket.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
        lock (this.socketGate)
            this.socket = activeSocket;
        try
        {
            await activeSocket.ConnectAsync(targetUri, cancellationToken).ConfigureAwait(false);
            await this.HandshakeAsync(activeSocket, cancellationToken).ConfigureAwait(false);
            this.lastError = null;
            this.SetConnected(true);
            await this.ReceiveLoopAsync(activeSocket, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            lock (this.socketGate)
            {
                if (ReferenceEquals(this.socket, activeSocket)) this.socket = null;
            }
            this.SetConnected(false);
        }
    }

    private async Task HandshakeAsync(ClientWebSocket activeSocket, CancellationToken cancellationToken)
    {
        string id = $"hello-{Guid.NewGuid():N}";
        await this.SendAsync(activeSocket, new
        {
            jsonrpc = "2.0",
            id,
            method = "adapter.hello",
            @params = this.handler.Hello(),
        }, cancellationToken).ConfigureAwait(false);

        using CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(15));
        while (!timeout.IsCancellationRequested)
        {
            string raw = await ReceiveMessageAsync(activeSocket, timeout.Token).ConfigureAwait(false);
            using JsonDocument document = JsonDocument.Parse(raw);
            JsonElement root = document.RootElement;
            if (root.TryGetProperty("id", out JsonElement responseId)
                && responseId.ValueKind == JsonValueKind.String
                && responseId.GetString() == id)
            {
                if (root.TryGetProperty("result", out JsonElement result)
                    && result.TryGetProperty("accepted", out JsonElement accepted)
                    && accepted.ValueKind == JsonValueKind.True
                    && result.TryGetProperty("protocolVersion", out JsonElement version)
                    && version.GetString() == "1.0")
                {
                    return;
                }

                string message = root.TryGetProperty("error", out JsonElement error)
                    && error.TryGetProperty("message", out JsonElement errorMessage)
                        ? errorMessage.GetString() ?? "Adapter handshake rejected."
                        : "Adapter handshake rejected.";
                throw new InvalidOperationException(message);
            }

            // HarnessCore performs its initial game.observe while onAdapterReady
            // is still resolving, so the first frame can be a host request rather
            // than the hello acknowledgement. Serve it without leaving the
            // handshake loop; all game access still crosses the main dispatcher.
            if (await this.HandleHostRequestAsync(activeSocket, root, timeout.Token).ConfigureAwait(false))
                continue;

            throw new InvalidOperationException("Adapter handshake received an unexpected message.");
        }

        throw new TimeoutException("Adapter handshake timed out.");
    }

    private async Task ReceiveLoopAsync(ClientWebSocket activeSocket, CancellationToken cancellationToken)
    {
        while (activeSocket.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
        {
            string raw = await ReceiveMessageAsync(activeSocket, cancellationToken).ConfigureAwait(false);
            using JsonDocument document = JsonDocument.Parse(raw);
            await this.HandleHostRequestAsync(activeSocket, document.RootElement, cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task<bool> HandleHostRequestAsync(
        ClientWebSocket activeSocket,
        JsonElement root,
        CancellationToken cancellationToken)
    {
        if (!root.TryGetProperty("method", out JsonElement methodElement)
            || methodElement.ValueKind != JsonValueKind.String
            || !root.TryGetProperty("id", out JsonElement idElement)
            || idElement.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        string id = idElement.GetString()!;
        string method = methodElement.GetString()!;
        JsonElement parameters = root.TryGetProperty("params", out JsonElement rawParams)
            ? rawParams.Clone()
            : JsonSerializer.SerializeToElement(new { });

        object response;
        try
        {
            using CancellationTokenSource requestTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            requestTimeout.CancelAfter(TimeSpan.FromSeconds(15));
            object result = method switch
            {
                "system.ping" => new { pong = true },
                "game.observe" => await this.dispatcher.InvokeAsync(this.handler.Observe, requestTimeout.Token).ConfigureAwait(false),
                "game.execute" => await this.dispatcher.InvokeAsync(() => this.handler.Execute(parameters), requestTimeout.Token).ConfigureAwait(false),
                _ => throw new AdapterMethodException(-32601, $"Unsupported Harness request: {method}"),
            };
            response = new { jsonrpc = "2.0", id, result };
        }
        catch (Exception ex)
        {
            Exception error = ex is AggregateException aggregate ? aggregate.GetBaseException() : ex;
            int code = error is AdapterMethodException methodError ? methodError.Code : -32603;
            response = new
            {
                jsonrpc = "2.0",
                id,
                error = new { code, message = error.Message },
            };
        }

        await this.SendAsync(activeSocket, response, cancellationToken).ConfigureAwait(false);
        return true;
    }

    private async Task SendAsync(ClientWebSocket activeSocket, object payload, CancellationToken cancellationToken)
    {
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(payload);
        await this.sendLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await activeSocket.SendAsync(
                new ArraySegment<byte>(bytes),
                WebSocketMessageType.Text,
                endOfMessage: true,
                cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            this.sendLock.Release();
        }
    }

    private static async Task<string> ReceiveMessageAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        using MemoryStream message = new();
        byte[] buffer = new byte[8192];
        WebSocketReceiveResult result;
        do
        {
            result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken).ConfigureAwait(false);
            if (result.MessageType == WebSocketMessageType.Close)
                throw new WebSocketException("Harness closed the Adapter Protocol connection.");
            if (result.MessageType != WebSocketMessageType.Text)
                throw new WebSocketException("Harness sent a non-text Adapter Protocol message.");
            message.Write(buffer, 0, result.Count);
            if (message.Length > 4 * 1024 * 1024)
                throw new InvalidOperationException("Adapter Protocol message exceeded 4 MiB.");
        }
        while (!result.EndOfMessage);
        return Encoding.UTF8.GetString(message.ToArray());
    }

    private void SetConnected(bool value)
    {
        if (this.connected == value) return;
        this.connected = value;
        this.ConnectionChanged?.Invoke(value);
        this.monitor.Log(
            value ? "[Harness] Adapter Protocol 1.0 已连接。" : "[Harness] Adapter Protocol 已断开，正在重连。",
            value ? LogLevel.Info : LogLevel.Trace);
    }

    public async ValueTask DisposeAsync()
    {
        this.lifetime.Cancel();
        lock (this.socketGate)
            this.socket?.Abort();
        if (this.loop is not null)
        {
            try { await this.loop.ConfigureAwait(false); }
            catch (OperationCanceledException) { }
        }
        this.dispatcher.CancelPending("Adapter Protocol client is stopping.");
        this.sendLock.Dispose();
        this.lifetime.Dispose();
    }

    private sealed class AdapterMethodException : Exception
    {
        public AdapterMethodException(int code, string message) : base(message)
        {
            this.Code = code;
        }

        public int Code { get; }
    }
}
