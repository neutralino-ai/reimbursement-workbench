import Capacitor
import QuickLook
import UIKit

@objc(MobileSettingsPlugin)
public class MobileSettingsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MobileSettingsPlugin"
    public let jsName = "MobileSettings"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getConnection", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveConnection", returnType: CAPPluginReturnPromise)
    ]
    private let key = "reimbursement.apiBaseUrl"
    @objc func getConnection(_ call: CAPPluginCall) {
        call.resolve(["apiBaseUrl": UserDefaults.standard.string(forKey: key) ?? ""])
    }
    @objc func saveConnection(_ call: CAPPluginCall) {
        guard let value = call.getString("apiBaseUrl"), let url = URLComponents(string: value),
              url.scheme == "https", let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              (url.path.isEmpty || url.path.range(of: "^/[a-zA-Z0-9/_-]*$", options: .regularExpression) != nil) else {
            call.reject("API 地址须为完整 HTTPS 地址。"); return
        }
        // Only this public endpoint is persisted. Credentials never enter UserDefaults.
        UserDefaults.standard.set(value, forKey: key)
        call.resolve(["apiBaseUrl": value])
    }
}

@objc(ReimbursementFilesPlugin)
public class ReimbursementFilesPlugin: CAPPlugin, CAPBridgedPlugin, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
    public let identifier = "ReimbursementFilesPlugin"
    public let jsName = "ReimbursementFiles"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "present", returnType: CAPPluginReturnPromise)]
    private var activeCall: CAPPluginCall?
    private var file: URL?
    private var directory: URL?
    private let root = FileManager.default.temporaryDirectory.appendingPathComponent("reimbursement-previews", isDirectory: true)

    override public func load() {
        // Only our own temporary preview copies; authoritative originals stay on the API.
        try? FileManager.default.removeItem(at: root)
    }

    @objc func present(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard self.activeCall == nil, let presenter = self.bridge?.viewController, presenter.presentedViewController == nil else {
                call.reject("请先关闭当前文件预览或分享窗口。"); return
            }
            guard let encoded = call.getString("base64"), encoded.count <= 28_000_000,
                  let bytes = Data(base64Encoded: encoded), bytes.count > 0, bytes.count <= 20 * 1024 * 1024,
                  let name = call.getString("filename"), name.utf8.count <= 220,
                  !name.contains("/"), !name.contains("\\"), !name.hasPrefix("."),
                  name.rangeOfCharacter(from: .controlCharacters) == nil,
                  ["pdf", "png", "jpg", "jpeg", "gif", "webp", "docx", "zip", "json", "csv"].contains((name as NSString).pathExtension.lowercased()),
                  let mode = call.getString("mode"), ["preview", "share"].contains(mode) else {
                call.reject("此文件无法在手机中打开（支持 PDF、图片、Word、ZIP、JSON、CSV，最大 20 MB）。"); return
            }
            do {
                let directory = self.root.appendingPathComponent(UUID().uuidString, isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
                self.directory = directory
                let file = directory.appendingPathComponent(name)
                try bytes.write(to: file, options: [.atomic, .completeFileProtection])
                self.file = file
                self.activeCall = call
                if mode == "preview" && QLPreviewController.canPreview(file as NSURL) {
                    let preview = QLPreviewController()
                    preview.dataSource = self
                    preview.delegate = self
                    presenter.present(preview, animated: true)
                } else {
                    let activity = UIActivityViewController(activityItems: [file], applicationActivities: nil)
                    activity.popoverPresentationController?.sourceView = presenter.view
                    activity.popoverPresentationController?.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1)
                    activity.completionWithItemsHandler = { [weak self] _, _, _, error in
                        DispatchQueue.main.async { self?.cleanup(error: error) }
                    }
                    presenter.present(activity, animated: true)
                }
            } catch {
                if self.activeCall == nil { self.activeCall = call }
                self.cleanup(error: error)
            }
        }
    }

    public func numberOfPreviewItems(in controller: QLPreviewController) -> Int { file == nil ? 0 : 1 }
    public func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { file! as NSURL }
    public func previewControllerDidDismiss(_ controller: QLPreviewController) { cleanup() }

    private func cleanup(error: Error? = nil) {
        let call = activeCall
        activeCall = nil
        file = nil
        if let directory = directory { try? FileManager.default.removeItem(at: directory) }
        directory = nil
        if error != nil { call?.reject("分享或预览未能完成，请重试。") } else { call?.resolve() }
    }
}
