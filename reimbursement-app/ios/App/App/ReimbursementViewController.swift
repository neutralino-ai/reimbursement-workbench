import Capacitor

class ReimbursementViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(SpeechInputPlugin())
        bridge?.registerPluginInstance(MobileSettingsPlugin())
        bridge?.registerPluginInstance(ReimbursementFilesPlugin())
    }
}
