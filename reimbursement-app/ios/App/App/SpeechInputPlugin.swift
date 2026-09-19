import AVFoundation
import Capacitor
import Speech
import UIKit

@objc(SpeechInputPlugin)
public class SpeechInputPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SpeechInputPlugin"
    public let jsName = "SpeechInput"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]
    private var runID: String?
    private var pendingStart: CAPPluginCall?
    private var engine: AVAudioEngine?
    private var tapInstalled = false
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var recognizer: SFSpeechRecognizer?
    private var transcript = ""
    private var finishing = false
    private var finishReason = ""
    private var timer: Timer?
    private var observers: [NSObjectProtocol] = []

    override public func load() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.finish("应用已进入后台，录音已停止。")
        })
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            if (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.began.rawValue {
                self?.finish("录音被系统中断，已保留识别文字。")
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            if (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue {
                self?.finish("麦克风连接已改变，录音已停止。")
            }
        })
    }

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard self.runID == nil else { call.reject("已有录音正在进行。"); return }
            guard let id = call.getString("id"), UUID(uuidString: id) != nil,
                  let locale = call.getString("locale"), ["zh-CN", "en-US"].contains(locale) else {
                call.reject("录音参数无效。"); return
            }
            self.runID = id
            self.pendingStart = call
            SFSpeechRecognizer.requestAuthorization { [weak self] status in
                DispatchQueue.main.async {
                    guard let self = self, self.runID == id else { return }
                    guard status == .authorized else {
                        self.failStart("请在 iPhone 设置中允许报销工作台使用语音识别，或改用键盘输入。")
                        return
                    }
                    AVAudioApplication.requestRecordPermission { [weak self] granted in
                        DispatchQueue.main.async {
                            guard let self = self, self.runID == id else { return }
                            guard granted else { self.failStart("未获麦克风权限，请在 iPhone 设置中允许，或改用键盘输入。"); return }
                            guard UIApplication.shared.applicationState == .active else { self.failStart("请返回应用后重新开始录音。"); return }
                            self.begin(id: id, locale: locale)
                        }
                    }
                }
            }
        }
    }

    private func begin(id: String, locale: String) {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)), recognizer.supportsOnDeviceRecognition else {
            failStart("此设备暂不支持该语言的本机识别。请检查系统听写语言设置，或使用键盘麦克风。应用不会改用云端录音识别。")
            return
        }
        guard recognizer.isAvailable else { failStart("系统语音识别暂不可用，请稍后重试或使用键盘输入。"); return }
        let engine = AVAudioEngine()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        request.contextualStrings = ["ChatGPT", "Codex", "DeepSeek", "科研", "报销"]
        self.engine = engine
        self.request = request
        self.recognizer = recognizer
        transcript = ""
        finishing = false
        finishReason = ""
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement)
            try session.setActive(true)
            let node = engine.inputNode
            let format = node.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else { failStart("找不到可用麦克风。"); return }
            node.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
            tapInstalled = true
            engine.prepare()
            try engine.start()
            task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                DispatchQueue.main.async {
                    guard let self = self, self.runID == id else { return }
                    if let result = result {
                        self.transcript = result.bestTranscription.formattedString
                        if result.isFinal { self.complete(); return }
                        self.emit(phase: self.finishing ? "stopping" : "recording")
                    }
                    if error != nil {
                        self.complete(self.finishing ? self.finishReason : "识别已停止。请检查文字，必要时重新录音。")
                    }
                }
            }
            let call = pendingStart
            pendingStart = nil
            call?.resolve()
            emit(phase: "recording")
            timer = Timer.scheduledTimer(withTimeInterval: 55, repeats: false) { [weak self] _ in
                self?.finish("本段录音已满 55 秒。采用文字后可继续录下一段。")
            }
        } catch { failStart("麦克风启动失败，请关闭其他录音应用后重试。"); }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            if self?.runID == call.getString("id") { self?.finish("") }
            call.resolve()
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            if self?.runID == call.getString("id") { self?.reset() }
            call.resolve()
        }
    }

    private func finish(_ reason: String) {
        guard runID != nil, !finishing else { return }
        if pendingStart != nil { failStart(reason.isEmpty ? "录音已取消。" : reason); return }
        finishing = true
        finishReason = reason
        stopMicrophone()
        request?.endAudio()
        timer?.invalidate()
        emit(phase: "stopping")
        // The recognizer may never deliver a final result after an interruption.
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in self?.complete() }
    }

    private func emit(phase: String, message: String = "") {
        guard let id = runID else { return }
        notifyListeners("transcript", data: ["id": id, "text": transcript, "phase": phase, "message": message])
    }

    private func complete(_ message: String? = nil) {
        emit(phase: "review", message: message ?? finishReason)
        reset()
    }

    private func stopMicrophone() {
        if let engine = engine {
            engine.stop()
            if tapInstalled { engine.inputNode.removeTap(onBus: 0) }
            tapInstalled = false
            self.engine = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    private func failStart(_ message: String) {
        let call = pendingStart
        pendingStart = nil
        reset()
        call?.reject(message)
    }

    private func reset() {
        runID = nil // Invalidate late callbacks before cancelling the recognition task.
        let pending = pendingStart
        pendingStart = nil
        timer?.invalidate()
        timer = nil
        stopMicrophone()
        request?.endAudio()
        task?.cancel()
        task = nil
        request = nil
        recognizer = nil
        transcript = ""
        finishing = false
        finishReason = ""
        pending?.reject("录音已取消。")
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        timer?.invalidate()
        engine?.stop()
        task?.cancel()
    }
}
