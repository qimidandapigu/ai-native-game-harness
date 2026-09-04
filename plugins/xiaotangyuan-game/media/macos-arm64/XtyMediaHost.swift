import AppKit
import ApplicationServices
import AVFoundation
import CoreGraphics
import Foundation
import ScreenCaptureKit

private let hostVersion = "0.1.0"
private let recordingSampleRate = 16_000.0
private let maximumRecordingBytes = 16 * 1024 * 1024
private let permissionPromptsDisabled = ProcessInfo.processInfo.environment["XTY_MEDIA_HOST_DISABLE_PERMISSION_PROMPTS"] == "1"

private final class JsonLineWriter {
    private let lock = NSLock()

    func emit(_ value: [String: Any]) {
        do {
            let data = try JSONSerialization.data(withJSONObject: value)
            lock.lock()
            defer { lock.unlock() }
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([0x0A]))
        } catch {
            FileHandle.standardError.write(Data("Media Host JSON error: \(error)\n".utf8))
        }
    }

    func error(_ message: String, requestId: String? = nil, processId: Int32? = nil) {
        var event: [String: Any] = ["type": "error", "message": message]
        if let requestId { event["requestId"] = requestId }
        if let processId { event["processId"] = Int(processId) }
        emit(event)
    }
}

private final class RecordingState {
    let processId: Int32
    let recordingId: String
    let engine: AVAudioEngine
    let converter: AVAudioConverter
    var sequence = 0
    var pcm = Data()

    init(processId: Int32, recordingId: String, engine: AVAudioEngine, converter: AVAudioConverter) {
        self.processId = processId
        self.recordingId = recordingId
        self.engine = engine
        self.converter = converter
    }
}

private final class MicrophoneRecorder {
    private let writer: JsonLineWriter
    private let lock = NSLock()
    private var current: RecordingState?

    init(writer: JsonLineWriter) {
        self.writer = writer
    }

    func requestPermission() {
        if permissionPromptsDisabled { return }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                if !granted { self?.writer.error("macOS 麦克风权限未授予，请在系统设置的隐私与安全性中允许 AI Native Game Harness 使用麦克风。") }
            }
        case .denied, .restricted:
            writer.error("macOS 麦克风权限未授予，请在系统设置的隐私与安全性中允许 AI Native Game Harness 使用麦克风。")
        default:
            break
        }
    }

    func start(processId: Int32) {
        guard processId > 0 else {
            writer.error("录音需要有效的游戏进程 ID。", processId: processId)
            return
        }
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
            requestPermission()
            writer.error("麦克风尚未授权，授权后请重新按住语音键。", processId: processId)
            return
        }

        lock.lock()
        let alreadyRecording = current != nil
        lock.unlock()
        if alreadyRecording { return }

        // AVAudioEngine can retain an input tap briefly after removeTap/stop.
        // A fresh engine per recording avoids re-installing onto that stale node,
        // which otherwise raises an Objective-C exception on a later V press.
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let sourceFormat = input.outputFormat(forBus: 0)
        guard sourceFormat.sampleRate > 0, sourceFormat.channelCount > 0,
              let targetFormat = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: recordingSampleRate,
                channels: 1,
                interleaved: false),
              let converter = AVAudioConverter(from: sourceFormat, to: targetFormat) else {
            writer.error("无法初始化 macOS 麦克风音频格式。", processId: processId)
            return
        }

        let state = RecordingState(
            processId: processId,
            recordingId: UUID().uuidString,
            engine: engine,
            converter: converter
        )
        lock.lock()
        current = state
        lock.unlock()

        input.installTap(onBus: 0, bufferSize: 2_048, format: sourceFormat) { [weak self, weak state] buffer, _ in
            guard let state else { return }
            self?.consume(buffer, targetFormat: targetFormat, state: state)
        }
        do {
            engine.prepare()
            try engine.start()
            writer.emit([
                "type": "recording.started",
                "processId": Int(processId),
                "recordingId": state.recordingId,
                "sampleRate": Int(recordingSampleRate),
                "bitsPerSample": 16,
                "channels": 1,
            ])
        } catch {
            input.removeTap(onBus: 0)
            engine.stop()
            engine.reset()
            lock.lock()
            if current === state { current = nil }
            lock.unlock()
            writer.error("启动 macOS 麦克风失败：\(error.localizedDescription)", processId: processId)
        }
    }

    func stop(processId: Int32? = nil) {
        lock.lock()
        guard let state = current, processId == nil || state.processId == processId else {
            lock.unlock()
            return
        }
        current = nil
        lock.unlock()

        state.engine.inputNode.removeTap(onBus: 0)
        state.engine.stop()
        state.engine.reset()
        writer.emit([
            "type": "recording.stopped",
            "processId": Int(state.processId),
            "recordingId": state.recordingId,
        ])
        guard !state.pcm.isEmpty else {
            writer.emit([
                "type": "recording.cancelled",
                "processId": Int(state.processId),
                "recordingId": state.recordingId,
                "message": "没有录到声音，请按住语音键说完后再松开。",
            ])
            return
        }
        let wav = buildWav(pcm: state.pcm, sampleRate: Int(recordingSampleRate), channels: 1)
        writer.emit([
            "type": "recording.completed",
            "processId": Int(state.processId),
            "recordingId": state.recordingId,
            "mediaType": "audio/wav",
            "audioBase64": wav.base64EncodedString(),
        ])
    }

    func cancel(_ message: String) {
        lock.lock()
        let state = current
        current = nil
        lock.unlock()
        guard let state else { return }
        state.engine.inputNode.removeTap(onBus: 0)
        state.engine.stop()
        state.engine.reset()
        writer.emit([
            "type": "recording.cancelled",
            "processId": Int(state.processId),
            "recordingId": state.recordingId,
            "message": message,
        ])
    }

    private func consume(_ input: AVAudioPCMBuffer, targetFormat: AVAudioFormat, state: RecordingState) {
        lock.lock()
        guard current === state else {
            lock.unlock()
            return
        }
        let ratio = targetFormat.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount(max(1, ceil(Double(input.frameLength) * ratio) + 8))
        guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else {
            lock.unlock()
            return
        }
        var supplied = false
        var conversionError: NSError?
        let status = state.converter.convert(to: output, error: &conversionError) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return input
        }
        guard status != .error, conversionError == nil,
              output.frameLength > 0,
              let samples = output.int16ChannelData?.pointee else {
            lock.unlock()
            return
        }
        let bytes = Data(bytes: samples, count: Int(output.frameLength) * MemoryLayout<Int16>.size)
        state.pcm.append(bytes)
        state.sequence += 1
        let sequence = state.sequence
        let processId = state.processId
        let recordingId = state.recordingId
        let exceeded = state.pcm.count > maximumRecordingBytes
        lock.unlock()

        if exceeded {
            DispatchQueue.main.async { [weak self] in self?.cancel("录音超过大小限制，已取消。") }
            return
        }
        writer.emit([
            "type": "recording.chunk",
            "processId": Int(processId),
            "recordingId": recordingId,
            "sequence": sequence,
            "audioBase64": bytes.base64EncodedString(),
        ])
    }
}

private final class PcmPlayback {
    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private let format: AVAudioFormat
    private var stopped = false

    init(sampleRate: Double) throws {
        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: sampleRate,
            channels: 1,
            interleaved: false) else {
            throw NSError(domain: "XtyMediaHost", code: 1, userInfo: [NSLocalizedDescriptionKey: "无效的 PCM 播放格式"])
        }
        self.format = format
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        engine.prepare()
        try engine.start()
        node.play()
    }

    func append(_ data: Data) {
        guard !stopped, data.count >= 2 else { return }
        let frameCount = data.count / MemoryLayout<Int16>.size
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frameCount)),
              let samples = buffer.int16ChannelData?.pointee else { return }
        buffer.frameLength = AVAudioFrameCount(frameCount)
        data.withUnsafeBytes { raw in
            if let base = raw.baseAddress { memcpy(samples, base, frameCount * MemoryLayout<Int16>.size) }
        }
        node.scheduleBuffer(buffer)
    }

    func finish(_ completion: @escaping () -> Void) {
        guard !stopped,
              let marker = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1),
              let sample = marker.int16ChannelData?.pointee else {
            completion()
            return
        }
        marker.frameLength = 1
        sample[0] = 0
        node.scheduleBuffer(marker, completionCallbackType: .dataPlayedBack) { _ in
            DispatchQueue.main.async { [weak self] in
                self?.stop()
                completion()
            }
        }
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        node.stop()
        engine.stop()
    }
}

private final class MediaHostRuntime {
    private let writer = JsonLineWriter()
    private lazy var recorder = MicrophoneRecorder(writer: writer)
    private var processIds = Set<Int32>()
    private var pushToTalkKey = "v"
    private var keyMonitor: Any?
    private var recordingProcessId: Int32?
    private var wavePlayers: [String: AVAudioPlayer] = [:]
    private var pcmPlayers: [String: PcmPlayback] = [:]

    func start() {
        NSApplication.shared.setActivationPolicy(.prohibited)
        recorder.requestPermission()
        if !requestInputMonitoringPermission() {
            writer.error("macOS 输入监控权限未授予，请在系统设置的隐私与安全性中允许 AI Native Game Harness 监听按住说话快捷键。")
        }
        keyMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown, .keyUp]) { [weak self] event in
            DispatchQueue.main.async { self?.handleGlobalKey(event) }
        }
        if keyMonitor == nil {
            writer.error("无法安装 macOS 全局按键监听，请在系统设置的隐私与安全性中允许输入监控。")
        }
        writer.emit(["type": "ready", "version": hostVersion])
    }

    func handle(_ envelope: [String: Any]) {
        guard let method = envelope["method"] as? String else {
            writer.error("Media Host 命令缺少 method。")
            return
        }
        let params = envelope["params"] as? [String: Any] ?? [:]
        switch method {
        case "configure":
            let rawIds = params["processIds"] as? [NSNumber] ?? []
            processIds = Set(rawIds.map { $0.int32Value }.filter { $0 > 0 })
            if let key = (params["pushToTalkKey"] as? String)?.lowercased(), key.count == 1 {
                pushToTalkKey = key
            }
        case "recording.start":
            guard let processId = number(params["processId"])?.int32Value else {
                writer.error("recording.start 缺少 processId。")
                return
            }
            recordingProcessId = processId
            recorder.start(processId: processId)
        case "recording.stop":
            let processId = number(params["processId"])?.int32Value
            recorder.stop(processId: processId)
            recordingProcessId = nil
        case "play":
            playWave(params)
        case "play.start":
            startPcm(params)
        case "play.chunk":
            appendPcm(params)
        case "play.end":
            finishPcm(params)
        case "play.cancel":
            cancelPlayback(params["playbackId"] as? String)
        case "capture":
            capture(params)
        case "shutdown":
            shutdown()
        default:
            writer.error("未知的 Media Host 命令：\(method)")
        }
    }

    private func handleGlobalKey(_ event: NSEvent) {
        guard event.charactersIgnoringModifiers?.lowercased() == pushToTalkKey else { return }
        if event.type == .keyDown {
            guard !event.isARepeat, recordingProcessId == nil,
                  let processId = NSWorkspace.shared.frontmostApplication?.processIdentifier,
                  processIds.contains(processId) else { return }
            recordingProcessId = processId
            recorder.start(processId: processId)
        } else if event.type == .keyUp, let processId = recordingProcessId {
            recorder.stop(processId: processId)
            recordingProcessId = nil
        }
    }

    private func playWave(_ params: [String: Any]) {
        let playbackId = (params["playbackId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            ?? UUID().uuidString
        guard let base64 = params["audioBase64"] as? String,
              let data = Data(base64Encoded: base64) else {
            writer.error("play 缺少有效的 WAV 数据。", requestId: playbackId)
            return
        }
        do {
            let player = try AVAudioPlayer(data: data)
            wavePlayers[playbackId] = player
            player.prepareToPlay()
            player.play()
            DispatchQueue.main.asyncAfter(deadline: .now() + max(0.05, player.duration)) { [weak self] in
                guard let self else { return }
                self.wavePlayers.removeValue(forKey: playbackId)
                self.writer.emit(["type": "playback.finished", "playbackId": playbackId])
            }
        } catch {
            writer.error("播放 WAV 失败：\(error.localizedDescription)", requestId: playbackId)
        }
    }

    private func startPcm(_ params: [String: Any]) {
        guard let playbackId = params["playbackId"] as? String, !playbackId.isEmpty else {
            writer.error("play.start 缺少 playbackId。")
            return
        }
        let sampleRate = number(params["sampleRate"])?.doubleValue ?? 24_000
        pcmPlayers.removeValue(forKey: playbackId)?.stop()
        do {
            pcmPlayers[playbackId] = try PcmPlayback(sampleRate: sampleRate)
        } catch {
            writer.error("启动 PCM 播放失败：\(error.localizedDescription)")
        }
    }

    private func appendPcm(_ params: [String: Any]) {
        guard let playbackId = params["playbackId"] as? String,
              let base64 = params["audioBase64"] as? String,
              let data = Data(base64Encoded: base64) else { return }
        pcmPlayers[playbackId]?.append(data)
    }

    private func finishPcm(_ params: [String: Any]) {
        guard let playbackId = params["playbackId"] as? String,
              let player = pcmPlayers[playbackId] else { return }
        player.finish { [weak self] in
            guard let self else { return }
            self.pcmPlayers.removeValue(forKey: playbackId)
            self.writer.emit(["type": "playback.finished", "playbackId": playbackId])
        }
    }

    private func cancelPlayback(_ playbackId: String?) {
        if let playbackId {
            pcmPlayers.removeValue(forKey: playbackId)?.stop()
        } else {
            for player in pcmPlayers.values { player.stop() }
            pcmPlayers.removeAll()
            for player in wavePlayers.values { player.stop() }
            wavePlayers.removeAll()
        }
    }

    private func capture(_ params: [String: Any]) {
        guard let requestId = params["requestId"] as? String,
              let processId = number(params["processId"])?.int32Value else {
            writer.error("capture 缺少 requestId 或 processId。")
            return
        }
        let maxWidth = max(320, number(params["maxWidth"])?.intValue ?? 1_280)
        captureLargestWindow(processId: processId, maxWidth: maxWidth) { [writer] result in
            do {
                let image = try result.get()
                let bitmap = NSBitmapImageRep(cgImage: image)
                guard let png = bitmap.representation(using: .png, properties: [:]) else {
                    throw NSError(domain: "XtyMediaHost", code: 3, userInfo: [NSLocalizedDescriptionKey: "窗口截图无法编码为 PNG"])
                }
                writer.emit([
                    "type": "capture.completed",
                    "requestId": requestId,
                    "processId": Int(processId),
                    "mediaType": "image/png",
                    "imageBase64": png.base64EncodedString(),
                    "width": image.width,
                    "height": image.height,
                ])
            } catch {
                writer.error("macOS 游戏窗口截图失败：\(error.localizedDescription)。请检查屏幕录制权限。", requestId: requestId)
            }
        }
    }

    private func shutdown() {
        recorder.cancel("Media Host 正在关闭。")
        cancelPlayback(nil)
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
        exit(0)
    }
}

private func requestInputMonitoringPermission() -> Bool {
    if permissionPromptsDisabled { return true }
    let promptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    return AXIsProcessTrustedWithOptions([promptKey: true] as CFDictionary)
}

private func number(_ value: Any?) -> NSNumber? {
    if let number = value as? NSNumber { return number }
    if let text = value as? String, let double = Double(text) { return NSNumber(value: double) }
    return nil
}

private func buildWav(pcm: Data, sampleRate: Int, channels: Int) -> Data {
    var wav = Data()
    wav.append(Data("RIFF".utf8))
    wav.appendLittleEndian(UInt32(36 + pcm.count))
    wav.append(Data("WAVEfmt ".utf8))
    wav.appendLittleEndian(UInt32(16))
    wav.appendLittleEndian(UInt16(1))
    wav.appendLittleEndian(UInt16(channels))
    wav.appendLittleEndian(UInt32(sampleRate))
    wav.appendLittleEndian(UInt32(sampleRate * channels * 2))
    wav.appendLittleEndian(UInt16(channels * 2))
    wav.appendLittleEndian(UInt16(16))
    wav.append(Data("data".utf8))
    wav.appendLittleEndian(UInt32(pcm.count))
    wav.append(pcm)
    return wav
}

private extension Data {
    mutating func appendLittleEndian<T: FixedWidthInteger>(_ value: T) {
        var little = value.littleEndian
        Swift.withUnsafeBytes(of: &little) { append(contentsOf: $0) }
    }
}

private func captureLargestWindow(
    processId: Int32,
    maxWidth: Int,
    completion: @escaping (Result<CGImage, Error>) -> Void
) {
    SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, error in
        if let error {
            completion(.failure(error))
            return
        }
        guard let window = content?.windows
            .filter({ candidate in
                candidate.owningApplication?.processID == processId
                    && candidate.windowLayer == 0
                    && candidate.frame.width > 64
                    && candidate.frame.height > 64
            })
            .max(by: { lhs, rhs in
                lhs.frame.width * lhs.frame.height < rhs.frame.width * rhs.frame.height
            }) else {
            completion(.failure(NSError(
                domain: "XtyMediaHost",
                code: 5,
                userInfo: [NSLocalizedDescriptionKey: "找不到可截图的游戏窗口"])))
            return
        }

        let scale = max(1.0, Double(SCContentFilter(desktopIndependentWindow: window).pointPixelScale))
        let sourceWidth = max(1, Int(Double(window.frame.width) * scale))
        let sourceHeight = max(1, Int(Double(window.frame.height) * scale))
        let outputWidth = min(maxWidth, sourceWidth)
        let outputHeight = max(1, Int((Double(sourceHeight) * Double(outputWidth) / Double(sourceWidth)).rounded()))
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        configuration.width = outputWidth
        configuration.height = outputHeight
        configuration.scalesToFit = true
        configuration.preservesAspectRatio = true
        configuration.showsCursor = false

        SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { image, error in
            if let image {
                completion(.success(image))
            } else {
                completion(.failure(error ?? NSError(
                    domain: "XtyMediaHost",
                    code: 6,
                    userInfo: [NSLocalizedDescriptionKey: "窗口截图没有返回图像"])))
            }
        }
    }
}

private let runtime = MediaHostRuntime()
runtime.start()

DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let envelope = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
        DispatchQueue.main.async { runtime.handle(envelope) }
    }
    DispatchQueue.main.async { runtime.handle(["method": "shutdown", "params": [:]]) }
}

RunLoop.main.run()
