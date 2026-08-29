import UIKit
import Capacitor
import WebKit

/// アプリ固有のPhotoKitプラグインを登録し、WebViewの初回描画まで
/// LaunchScreenと同じ画像を保持して白画面を見せない。
final class SpotaBridgeViewController: CAPBridgeViewController {
    private var startupCover: UIImageView?
    private var startupPoll: DispatchWorkItem?
    private var startupFallback: DispatchWorkItem?

    override func viewDidLoad() {
        super.viewDidLoad()
        installStartupCover()
    }

    override func capacitorDidLoad() {
        bridge?.registerPluginType(DailyPhotoPlugin.self)

        guard let webView = bridge?.webView else {
            scheduleStartupFallback()
            return
        }

        if let startupCover {
            view.bringSubviewToFront(startupCover)
        }
        scheduleStartupFallback()
        checkFirstVisual(in: webView)
    }

    deinit {
        startupPoll?.cancel()
        startupFallback?.cancel()
    }

    private func installStartupCover() {
        let cover = UIImageView(image: UIImage(named: "Splash"))
        cover.translatesAutoresizingMaskIntoConstraints = false
        cover.contentMode = .scaleAspectFill
        cover.backgroundColor = .systemBackground
        // 不透明な起動画面の背後へ、見えないタップやVoiceOver焦点を通さない。
        cover.isUserInteractionEnabled = true
        cover.isAccessibilityElement = true
        cover.accessibilityLabel = "Spotaを読み込んでいます"
        cover.accessibilityTraits = .staticText
        cover.accessibilityViewIsModal = true
        view.addSubview(cover)
        NSLayoutConstraint.activate([
            cover.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            cover.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            cover.topAnchor.constraint(equalTo: view.topAnchor),
            cover.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        startupCover = cover
    }

    private func scheduleStartupFallback() {
        startupFallback?.cancel()
        let fallback = DispatchWorkItem { [weak self] in
            self?.hideStartupCover()
        }
        startupFallback = fallback
        // 読込失敗時に起動画面へ閉じ込めないための最終安全弁。
        DispatchQueue.main.asyncAfter(deadline: .now() + 12, execute: fallback)
    }

    private func checkFirstVisual(in webView: WKWebView) {
        webView.evaluateJavaScript("Boolean(window.__spotaNativeVisualReady)") { [weak self, weak webView] value, _ in
            DispatchQueue.main.async { [weak self, weak webView] in
                guard let self, self.startupCover != nil else { return }
                if (value as? Bool) == true {
                    self.hideStartupCover()
                } else if let webView {
                    self.scheduleStartupPoll(for: webView)
                }
            }
        }
    }

    private func scheduleStartupPoll(for webView: WKWebView) {
        startupPoll?.cancel()
        let poll = DispatchWorkItem { [weak self, weak webView] in
            guard let self, let webView else { return }
            self.checkFirstVisual(in: webView)
        }
        startupPoll = poll
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: poll)
    }

    private func hideStartupCover() {
        guard let cover = startupCover else { return }
        startupPoll?.cancel()
        startupPoll = nil
        startupFallback?.cancel()
        startupFallback = nil

        let completion: (Bool) -> Void = { [weak self, weak cover] _ in
            guard let self, let cover else { return }
            cover.accessibilityViewIsModal = false
            cover.removeFromSuperview()
            if self.startupCover === cover {
                self.startupCover = nil
            }
            UIAccessibility.post(notification: .screenChanged, argument: self.bridge?.webView)
        }
        if UIAccessibility.isReduceMotionEnabled {
            cover.alpha = 0
            completion(true)
        } else {
            UIView.animate(
                withDuration: 0.2,
                delay: 0,
                options: [.beginFromCurrentState, .curveEaseOut],
                animations: { cover.alpha = 0 },
                completion: completion
            )
        }
    }
}
