using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using NAudio.Wave;

namespace XtyMediaHost;

internal static class Protocol
{
    private static readonly object OutputLock = new();

    public static void Send(object payload)
    {
        lock (OutputLock)
        {
            Console.Out.WriteLine(JsonSerializer.Serialize(payload));
            Console.Out.Flush();
        }
    }

    public static void Error(string message, string? requestId = null) => Send(new { type = "error", requestId, message });
}

internal sealed record WindowCapture(byte[] Png, int Width, int Height);

internal static class WindowCaptureService
{
    public static void EnableDpiAwareness()
    {
        try { _ = SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch (EntryPointNotFoundException) { }
    }

    public static WindowCapture CaptureForegroundClient(int expectedProcessId, int maxWidth)
    {
        IntPtr window = GetForegroundWindow();
        if (window == IntPtr.Zero) throw new InvalidOperationException("当前没有前台窗口");
        _ = GetWindowThreadProcessId(window, out uint actualProcessId);
        if (actualProcessId != unchecked((uint)expectedProcessId))
        {
            throw new InvalidOperationException("目标游戏当前不是前台窗口");
        }
        if (!IsWindowVisible(window) || IsIconic(window))
        {
            throw new InvalidOperationException("目标游戏窗口不可见或已最小化");
        }
        if (!GetClientRect(window, out Rect client) || client.Right <= client.Left || client.Bottom <= client.Top)
        {
            throw new InvalidOperationException($"无法读取目标游戏客户区，Win32={Marshal.GetLastWin32Error()}");
        }

        var origin = new Point { X = client.Left, Y = client.Top };
        if (!ClientToScreen(window, ref origin))
        {
            throw new InvalidOperationException($"无法定位目标游戏客户区，Win32={Marshal.GetLastWin32Error()}");
        }

        int width = client.Right - client.Left;
        int height = client.Bottom - client.Top;
        using var source = new Bitmap(width, height, PixelFormat.Format24bppRgb);
        using (Graphics graphics = Graphics.FromImage(source))
        {
            graphics.CopyFromScreen(origin.X, origin.Y, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
        }

        int outputWidth = Math.Min(width, maxWidth);
        int outputHeight = Math.Max(1, (int)Math.Round(height * (outputWidth / (double)width)));
        using Bitmap output = outputWidth == width
            ? new Bitmap(source)
            : Resize(source, outputWidth, outputHeight);
        using var stream = new MemoryStream();
        output.Save(stream, ImageFormat.Png);
        return new WindowCapture(stream.ToArray(), output.Width, output.Height);
    }

    private static Bitmap Resize(Bitmap source, int width, int height)
    {
        var resized = new Bitmap(width, height, PixelFormat.Format24bppRgb);
        using Graphics graphics = Graphics.FromImage(resized);
        graphics.CompositingQuality = CompositingQuality.HighQuality;
        graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
        graphics.SmoothingMode = SmoothingMode.HighQuality;
        graphics.DrawImage(source, 0, 0, width, height);
        return resized;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}

internal sealed class AudioDevices : IDisposable
{
    private const int MinimumRecordingBytes = 44 + (16000 * 2 * 3 / 10);
    private readonly object gate = new();
    private WaveInEvent? recorder;
    private WaveFileWriter? writer;
    private MemoryStream? recording;
    private int recordingProcessId;
    private string? recordingId;
    private int recordingSequence;
    private WaveOutEvent? streamingOutput;
    private BufferedWaveProvider? streamingBuffer;
    private string? playbackId;
    private Timer? recordingTimeout;

    public bool IsRecording
    {
        get
        {
            lock (this.gate) return this.recorder is not null;
        }
    }

    public void StartRecording(int processId)
    {
        this.CancelPlayback();
        string nextRecordingId;
        lock (this.gate)
        {
            if (this.recorder is not null) return;
            this.recordingProcessId = processId;
            this.recordingId = nextRecordingId = Guid.NewGuid().ToString("N");
            this.recordingSequence = 0;
            this.recording = new MemoryStream();
            this.recorder = new WaveInEvent
            {
                DeviceNumber = 0,
                WaveFormat = new WaveFormat(16000, 16, 1),
                BufferMilliseconds = 100
            };
            this.writer = new WaveFileWriter(this.recording, this.recorder.WaveFormat);
            this.recorder.DataAvailable += this.OnDataAvailable;
            this.recorder.RecordingStopped += this.OnRecordingStopped;
            this.recorder.StartRecording();
            this.recordingTimeout = new Timer(_ =>
            {
                Protocol.Error("录音已达到 30 秒上限，已自动停止");
                this.StopRecording();
            }, null, TimeSpan.FromSeconds(30), Timeout.InfiniteTimeSpan);
        }
        Protocol.Send(new
        {
            type = "recording.started",
            processId,
            recordingId = nextRecordingId,
            sampleRate = 16000,
            bitsPerSample = 16,
            channels = 1
        });
    }

    public void StopRecording(int? expectedProcessId = null)
    {
        int processId;
        string? activeRecordingId;
        lock (this.gate)
        {
            if (this.recorder is null) return;
            if (expectedProcessId is not null && this.recordingProcessId != expectedProcessId.Value) return;
            processId = this.recordingProcessId;
            activeRecordingId = this.recordingId;
            this.recordingTimeout?.Dispose();
            this.recordingTimeout = null;
            this.recorder.StopRecording();
        }
        if (activeRecordingId is not null)
        {
            Protocol.Send(new { type = "recording.stopped", processId, recordingId = activeRecordingId });
        }
    }

    private void OnDataAvailable(object? sender, WaveInEventArgs e)
    {
        string? activeRecordingId;
        int processId;
        int sequence;
        byte[] chunk = new byte[e.BytesRecorded];
        Buffer.BlockCopy(e.Buffer, 0, chunk, 0, e.BytesRecorded);
        lock (this.gate)
        {
            this.writer?.Write(chunk, 0, chunk.Length);
            activeRecordingId = this.recordingId;
            processId = this.recordingProcessId;
            sequence = ++this.recordingSequence;
        }
        if (activeRecordingId is null) return;
        Protocol.Send(new
        {
            type = "recording.chunk",
            processId,
            recordingId = activeRecordingId,
            sequence,
            audioBase64 = Convert.ToBase64String(chunk)
        });
    }

    private void OnRecordingStopped(object? sender, StoppedEventArgs e)
    {
        byte[]? wav = null;
        int processId;
        string? completedRecordingId;
        lock (this.gate)
        {
            processId = this.recordingProcessId;
            completedRecordingId = this.recordingId;
            try
            {
                this.writer?.Dispose();
                wav = this.recording?.ToArray();
            }
            finally
            {
                if (this.recorder is not null)
                {
                    this.recorder.DataAvailable -= this.OnDataAvailable;
                    this.recorder.RecordingStopped -= this.OnRecordingStopped;
                    this.recorder.Dispose();
                }
                this.recorder = null;
                this.writer = null;
                this.recording?.Dispose();
                this.recording = null;
                this.recordingId = null;
                this.recordingTimeout?.Dispose();
                this.recordingTimeout = null;
            }
        }

        if (e.Exception is not null)
        {
            Protocol.Error($"麦克风录制失败：{e.Exception.Message}");
            return;
        }
        if (completedRecordingId is null) return;
        if (wav is null || wav.Length < MinimumRecordingBytes)
        {
            Protocol.Send(new
            {
                type = "recording.cancelled",
                processId,
                recordingId = completedRecordingId,
                message = "录音太短，请按住语音键说话至少 1 秒再松开。"
            });
            return;
        }
        Protocol.Send(new
        {
            type = "recording.completed",
            processId,
            recordingId = completedRecordingId,
            mediaType = "audio/wav",
            audioBase64 = Convert.ToBase64String(wav)
        });
    }

    public async Task PlayAsync(byte[] wav)
    {
        this.CancelPlayback();
        using var stream = new MemoryStream(wav, writable: false);
        using var reader = new WaveFileReader(stream);
        using var output = new WaveOutEvent();
        var stopped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        output.PlaybackStopped += (_, e) =>
        {
            if (e.Exception is null) stopped.TrySetResult();
            else stopped.TrySetException(e.Exception);
        };
        output.Init(reader);
        output.Play();
        await stopped.Task.ConfigureAwait(false);
    }

    public void StartPcmPlayback(string nextPlaybackId, int sampleRate, int bitsPerSample, int channels)
    {
        if (bitsPerSample != 16 || channels != 1) throw new InvalidOperationException("流式播放当前只支持 PCM16 单声道");
        this.CancelPlayback();
        lock (this.gate)
        {
            var buffer = new BufferedWaveProvider(new WaveFormat(sampleRate, bitsPerSample, channels))
            {
                BufferDuration = TimeSpan.FromSeconds(20),
                DiscardOnBufferOverflow = true,
                ReadFully = true
            };
            var output = new WaveOutEvent { DesiredLatency = 80, NumberOfBuffers = 3 };
            output.Init(buffer);
            this.playbackId = nextPlaybackId;
            this.streamingBuffer = buffer;
            this.streamingOutput = output;
        }
    }

    public void AppendPcmPlayback(string targetPlaybackId, byte[] pcm)
    {
        lock (this.gate)
        {
            if (this.playbackId != targetPlaybackId || this.streamingBuffer is null || this.streamingOutput is null) return;
            this.streamingBuffer.AddSamples(pcm, 0, pcm.Length);
            if (this.streamingOutput.PlaybackState != PlaybackState.Playing) this.streamingOutput.Play();
        }
    }

    public async Task FinishPcmPlaybackAsync(string targetPlaybackId)
    {
        while (true)
        {
            TimeSpan buffered;
            lock (this.gate)
            {
                if (this.playbackId != targetPlaybackId || this.streamingBuffer is null) return;
                buffered = this.streamingBuffer.BufferedDuration;
            }
            if (buffered <= TimeSpan.FromMilliseconds(20)) break;
            await Task.Delay(TimeSpan.FromMilliseconds(Math.Min(100, Math.Max(20, buffered.TotalMilliseconds / 2)))).ConfigureAwait(false);
        }
        lock (this.gate)
        {
            if (this.playbackId == targetPlaybackId) this.DisposeStreamingPlaybackLocked();
        }
    }

    public void CancelPlayback(string? targetPlaybackId = null)
    {
        lock (this.gate)
        {
            if (targetPlaybackId is not null && this.playbackId != targetPlaybackId) return;
            this.DisposeStreamingPlaybackLocked();
        }
    }

    private void DisposeStreamingPlaybackLocked()
    {
        this.streamingOutput?.Stop();
        this.streamingOutput?.Dispose();
        this.streamingOutput = null;
        this.streamingBuffer = null;
        this.playbackId = null;
    }

    public void Dispose()
    {
        this.StopRecording();
        this.CancelPlayback();
    }
}

internal sealed class PushToTalkHook : IDisposable
{
    private const int WhKeyboardLl = 13;
    private const int WmKeyDown = 0x0100;
    private const int WmKeyUp = 0x0101;
    private const int WmSysKeyDown = 0x0104;
    private const int WmSysKeyUp = 0x0105;
    private const int WmQuit = 0x0012;

    private readonly AudioDevices audio;
    private readonly object gate = new();
    private readonly HashSet<int> allowedProcesses = new();
    private readonly Thread thread;
    private HookProc? callback;
    private IntPtr hook;
    private uint threadId;
    private int virtualKey = 0x77;
    private bool keyHeld;

    public PushToTalkHook(AudioDevices audio)
    {
        this.audio = audio;
        this.thread = new Thread(this.Run)
        {
            IsBackground = true,
            Name = "XTY Push-to-talk hook"
        };
        this.thread.Start();
    }

    public void Configure(IEnumerable<int> processIds, int nextVirtualKey)
    {
        lock (this.gate)
        {
            this.allowedProcesses.Clear();
            foreach (int processId in processIds.Where(value => value > 0)) this.allowedProcesses.Add(processId);
            this.virtualKey = nextVirtualKey;
        }
    }

    public bool AllowsProcess(int processId)
    {
        lock (this.gate) return this.allowedProcesses.Contains(processId);
    }

    private void Run()
    {
        this.threadId = GetCurrentThreadId();
        this.callback = this.OnKeyboard;
        using Process process = Process.GetCurrentProcess();
        using ProcessModule? module = process.MainModule;
        this.hook = SetWindowsHookEx(WhKeyboardLl, this.callback, GetModuleHandle(module?.ModuleName), 0);
        if (this.hook == IntPtr.Zero)
        {
            Protocol.Error($"无法注册全局语音按键，Win32={Marshal.GetLastWin32Error()}");
            return;
        }
        while (GetMessage(out Message message, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref message);
            DispatchMessage(ref message);
        }
    }

    private IntPtr OnKeyboard(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0)
        {
            int key = Marshal.ReadInt32(data);
            bool down = message == (IntPtr)WmKeyDown || message == (IntPtr)WmSysKeyDown;
            bool up = message == (IntPtr)WmKeyUp || message == (IntPtr)WmSysKeyUp;
            int configuredKey;
            lock (this.gate) configuredKey = this.virtualKey;
            if (key == configuredKey && down && !this.keyHeld && !HasModifierKey())
            {
                int foregroundProcess = ForegroundProcessId();
                bool allowed;
                lock (this.gate) allowed = this.allowedProcesses.Contains(foregroundProcess);
                if (allowed)
                {
                    this.keyHeld = true;
                    try { this.audio.StartRecording(foregroundProcess); }
                    catch (Exception ex) { Protocol.Error($"无法开始录音：{ex.Message}"); }
                }
            }
            else if (key == configuredKey && up && this.keyHeld)
            {
                this.keyHeld = false;
                try { this.audio.StopRecording(); }
                catch (Exception ex) { Protocol.Error($"无法停止录音：{ex.Message}"); }
            }
        }
        return CallNextHookEx(this.hook, code, message, data);
    }

    private static bool HasModifierKey()
    {
        return IsKeyDown(0x10) || IsKeyDown(0x11) || IsKeyDown(0x12);
    }

    private static bool IsKeyDown(int virtualKey) => (GetAsyncKeyState(virtualKey) & 0x8000) != 0;

    private static int ForegroundProcessId()
    {
        IntPtr window = GetForegroundWindow();
        _ = GetWindowThreadProcessId(window, out uint processId);
        return unchecked((int)processId);
    }

    public void Dispose()
    {
        if (this.hook != IntPtr.Zero) UnhookWindowsHookEx(this.hook);
        if (this.threadId != 0) PostThreadMessage(this.threadId, WmQuit, IntPtr.Zero, IntPtr.Zero);
        if (this.thread.IsAlive) this.thread.Join(TimeSpan.FromSeconds(2));
        this.callback = null;
    }

    private delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Message
    {
        public IntPtr Handle;
        public uint Id;
        public UIntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public Point Point;
        public uint Private;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, HookProc callback, IntPtr instance, uint threadId);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")]
    private static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll")]
    private static extern bool TranslateMessage([In] ref Message message);
    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage([In] ref Message message);
    [DllImport("user32.dll")]
    private static extern bool PostThreadMessage(uint threadId, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int virtualKey);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string? moduleName);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
}

internal static class Program
{
    public static async Task Main()
    {
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = new UTF8Encoding(false);
        WindowCaptureService.EnableDpiAwareness();
        using var audio = new AudioDevices();
        using var hook = new PushToTalkHook(audio);
        Protocol.Send(new { type = "ready", version = "1.1", capabilities = new[] { "recording.pcm-stream", "playback.pcm-stream", "playback.cancel" } });

        string? line;
        while ((line = await Console.In.ReadLineAsync().ConfigureAwait(false)) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            try
            {
                using JsonDocument document = JsonDocument.Parse(line);
                JsonElement root = document.RootElement;
                string method = root.GetProperty("method").GetString() ?? "";
                JsonElement parameters = root.TryGetProperty("params", out JsonElement value) ? value : default;
                switch (method)
                {
                    case "configure":
                    {
                        int key = parameters.GetProperty("pushToTalkVirtualKey").GetInt32();
                        int[] processIds = parameters.GetProperty("processIds").EnumerateArray()
                            .Select(item => item.GetInt32()).ToArray();
                        hook.Configure(processIds, key);
                        break;
                    }
                    case "recording.start":
                    {
                        int processId = parameters.GetProperty("processId").GetInt32();
                        audio.StartRecording(processId);
                        break;
                    }
                    case "recording.stop":
                    {
                        int processId = parameters.GetProperty("processId").GetInt32();
                        audio.StopRecording(processId);
                        break;
                    }
                    case "play":
                    {
                        byte[] wav = Convert.FromBase64String(parameters.GetProperty("audioBase64").GetString() ?? "");
                        _ = audio.PlayAsync(wav).ContinueWith(task =>
                        {
                            if (task.Exception is not null) Protocol.Error($"音频播放失败：{task.Exception.GetBaseException().Message}");
                        }, TaskScheduler.Default);
                        break;
                    }
                    case "play.start":
                    {
                        audio.StartPcmPlayback(
                            parameters.GetProperty("playbackId").GetString() ?? throw new InvalidOperationException("playbackId 不能为空"),
                            parameters.GetProperty("sampleRate").GetInt32(),
                            parameters.GetProperty("bitsPerSample").GetInt32(),
                            parameters.GetProperty("channels").GetInt32());
                        break;
                    }
                    case "play.chunk":
                    {
                        string playbackId = parameters.GetProperty("playbackId").GetString() ?? "";
                        byte[] pcm = Convert.FromBase64String(parameters.GetProperty("audioBase64").GetString() ?? "");
                        audio.AppendPcmPlayback(playbackId, pcm);
                        break;
                    }
                    case "play.end":
                    {
                        string playbackId = parameters.GetProperty("playbackId").GetString() ?? "";
                        _ = audio.FinishPcmPlaybackAsync(playbackId).ContinueWith(task =>
                        {
                            if (task.Exception is not null) Protocol.Error($"流式音频结束失败：{task.Exception.GetBaseException().Message}");
                        }, TaskScheduler.Default);
                        break;
                    }
                    case "play.cancel":
                    {
                        string? playbackId = parameters.TryGetProperty("playbackId", out JsonElement id) ? id.GetString() : null;
                        audio.CancelPlayback(playbackId);
                        break;
                    }
                    case "capture":
                    {
                        string requestId = parameters.GetProperty("requestId").GetString()
                            ?? throw new InvalidOperationException("capture.requestId 不能为空");
                        try
                        {
                            int processId = parameters.GetProperty("processId").GetInt32();
                            int maxWidth = parameters.GetProperty("maxWidth").GetInt32();
                            if (!hook.AllowsProcess(processId)) throw new InvalidOperationException("该进程没有注册为游戏 Adapter");
                            if (maxWidth < 320 || maxWidth > 3840) throw new InvalidOperationException("maxWidth 必须在 320 到 3840 之间");
                            WindowCapture capture = WindowCaptureService.CaptureForegroundClient(processId, maxWidth);
                            Protocol.Send(new
                            {
                                type = "capture.completed",
                                requestId,
                                processId,
                                mediaType = "image/png",
                                imageBase64 = Convert.ToBase64String(capture.Png),
                                width = capture.Width,
                                height = capture.Height
                            });
                        }
                        catch (Exception ex)
                        {
                            Protocol.Error($"游戏窗口截图失败：{ex.Message}", requestId);
                        }
                        break;
                    }
                    case "shutdown":
                        return;
                }
            }
            catch (Exception ex)
            {
                Protocol.Error($"媒体命令处理失败：{ex.Message}");
            }
        }
    }
}
