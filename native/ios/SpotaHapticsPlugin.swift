import Capacitor
import UIKit

/// Spotaの短い操作結果だけを、iPhoneのTaptic Engineへ渡す。
/// JavaScriptへ端末情報を返さず、連続振動や任意パターンも受け付けない。
@objc(SpotaHapticsPlugin)
public final class SpotaHapticsPlugin: CAPPlugin, CAPBridgedPlugin {
    private var lastImpactAt: TimeInterval = 0

    public let identifier = "SpotaHapticsPlugin"
    public let jsName = "SpotaHaptics"
    public let pluginMethods: [CAPPluginMethod] = [
        .init(name: "impact", returnType: CAPPluginReturnPromise)
    ]

    @objc public func impact(_ call: CAPPluginCall) {
        let requested = (call.getString("style") ?? "medium").lowercased()
        let rawIntensity = call.getDouble("intensity") ?? 0.88
        let intensity = CGFloat(min(1, max(0.15, rawIntensity)))

        let style: UIImpactFeedbackGenerator.FeedbackStyle
        switch requested {
        case "soft": style = .soft
        case "light": style = .light
        case "heavy": style = .heavy
        case "rigid": style = .rigid
        default: style = .medium
        }

        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.resolve()
                return
            }
            let now = ProcessInfo.processInfo.systemUptime
            guard now - self.lastImpactAt >= 0.07 else {
                call.resolve()
                return
            }
            self.lastImpactAt = now
            let generator = UIImpactFeedbackGenerator(style: style)
            generator.prepare()
            generator.impactOccurred(intensity: intensity)
            call.resolve()
        }
    }
}
