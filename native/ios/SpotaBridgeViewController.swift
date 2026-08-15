import Capacitor

/// アプリ固有のPhotoKitプラグインだけをCapacitorへ登録する。
final class SpotaBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginType(DailyPhotoPlugin.self)
    }
}
