import Capacitor
import Foundation
import Photos
import UIKit

private final class DailyPhotoCompletionGate {
    private let lock = NSLock()
    private var completed = false

    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !completed else { return false }
        completed = true
        return true
    }
}

/// 許可済みのフォトライブラリから、1日につき候補を1枚だけ選ぶ。
/// PhotoKitのlocalIdentifierはJavaScriptへ渡さず、一回限りの匿名tokenで受け渡す。
@objc(DailyPhotoPlugin)
public final class DailyPhotoPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DailyPhotoPlugin"
    public let jsName = "DailyPhoto"
    public let pluginMethods: [CAPPluginMethod] = [
        .init(name: "authorizationStatus", returnType: CAPPluginReturnPromise),
        .init(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
        .init(name: "randomCandidate", returnType: CAPPluginReturnPromise),
        .init(name: "photo", returnType: CAPPluginReturnPromise),
        .init(name: "discard", returnType: CAPPluginReturnPromise)
    ]

    private enum StateKey {
        static let day = "spota.daily-photo.day"
        static let token = "spota.daily-photo.token"
        static let asset = "spota.daily-photo.asset"
        static let completed = "spota.daily-photo.completed"
        static let seen = "spota.daily-photo.seen"
    }

    private let imageManager = PHCachingImageManager()
    private let stateLock = NSLock()
    private var candidateRequestInFlight = false
    private var fullRequestInFlight = false
    private var cachedPreviewToken: String?
    private var cachedPreview: JSObject?

    private func statusName(_ status: PHAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "granted"
        case .limited: return "limited"
        case .denied, .restricted: return "denied"
        case .notDetermined: return "prompt"
        @unknown default: return "denied"
        }
    }

    private func canRead(_ status: PHAuthorizationStatus) -> Bool {
        status == .authorized || status == .limited
    }

    private func localDay() -> String {
        let values = Calendar.autoupdatingCurrent.dateComponents([.year, .month, .day], from: Date())
        return String(format: "%04d-%02d-%02d", values.year ?? 0, values.month ?? 0, values.day ?? 0)
    }

    private func resetExpiredStateLocked() {
        let defaults = UserDefaults.standard
        let today = localDay()
        guard defaults.string(forKey: StateKey.day) != today else { return }
        defaults.set(today, forKey: StateKey.day)
        defaults.removeObject(forKey: StateKey.token)
        defaults.removeObject(forKey: StateKey.asset)
        defaults.set(false, forKey: StateKey.completed)
        cachedPreviewToken = nil
        cachedPreview = nil
        candidateRequestInFlight = false
        fullRequestInFlight = false
    }

    private func rememberAssetLocked(_ identifier: String) {
        let defaults = UserDefaults.standard
        var seen = (defaults.stringArray(forKey: StateKey.seen) ?? []).filter { $0 != identifier }
        seen.insert(identifier, at: 0)
        defaults.set(Array(seen.prefix(30)), forKey: StateKey.seen)
    }

    private func finishDayLocked(assetIdentifier: String) {
        let defaults = UserDefaults.standard
        rememberAssetLocked(assetIdentifier)
        defaults.set(true, forKey: StateKey.completed)
        defaults.removeObject(forKey: StateKey.token)
        defaults.removeObject(forKey: StateKey.asset)
        cachedPreviewToken = nil
        cachedPreview = nil
        candidateRequestInFlight = false
        fullRequestInFlight = false
    }

    /// A preview that is unavailable on-device is skipped without exposing its PhotoKit ID.
    /// The day remains open so the scheduled retry can choose another eligible asset.
    private func skipUnavailableCandidateLocked(assetIdentifier: String, token: String) {
        let defaults = UserDefaults.standard
        guard defaults.string(forKey: StateKey.token) == token,
              defaults.string(forKey: StateKey.asset) == assetIdentifier else { return }
        rememberAssetLocked(assetIdentifier)
        defaults.removeObject(forKey: StateKey.token)
        defaults.removeObject(forKey: StateKey.asset)
        cachedPreviewToken = nil
        cachedPreview = nil
    }

    @objc public func authorizationStatus(_ call: CAPPluginCall) {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        call.resolve(["status": statusName(status)])
    }

    @objc public func requestAuthorization(_ call: CAPPluginCall) {
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { [weak self] status in
            DispatchQueue.main.async {
                guard let self else { call.reject("写真へのアクセスを確認できませんでした"); return }
                call.resolve(["status": self.statusName(status)])
            }
        }
    }

    @objc public func randomCandidate(_ call: CAPPluginCall) {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard canRead(status) else {
            call.resolve(["status": statusName(status), "candidate": NSNull()])
            return
        }

        stateLock.lock()
        resetExpiredStateLocked()
        let defaults = UserDefaults.standard
        if defaults.bool(forKey: StateKey.completed) {
            stateLock.unlock()
            call.resolve(["status": statusName(status), "candidate": NSNull()])
            return
        }
        if let token = defaults.string(forKey: StateKey.token),
           token == cachedPreviewToken, let preview = cachedPreview {
            stateLock.unlock()
            call.resolve(["status": statusName(status), "candidate": preview])
            return
        }
        guard !candidateRequestInFlight else {
            stateLock.unlock()
            call.reject("候補を準備しています")
            return
        }
        candidateRequestInFlight = true
        let existingAsset = defaults.string(forKey: StateKey.asset)
        let existingToken = defaults.string(forKey: StateKey.token)
        let seenOrder = defaults.stringArray(forKey: StateKey.seen) ?? []
        let excluded = Set(seenOrder)
        stateLock.unlock()

        var chosen: PHAsset?
        var token = existingToken
        if let existingAsset {
            let existing = PHAsset.fetchAssets(withLocalIdentifiers: [existingAsset], options: nil).firstObject
            if let existing, !existing.isHidden { chosen = existing }
            else { token = UUID().uuidString }
        }

        var resetSeenCycle = false
        var retainedRecentAsset: String?
        if chosen == nil {
            let assets = PHAsset.fetchAssets(with: .image, options: nil)
            var eligibleCount = 0, visibleCount = 0
            assets.enumerateObjects { asset, _, _ in
                guard !asset.isHidden else { return }
                visibleCount += 1
                guard !excluded.contains(asset.localIdentifier) else { return }
                eligibleCount += 1
                if Int.random(in: 0..<eligibleCount) == 0 { chosen = asset }
            }

            // A small library eventually exhausts `seen`. Start a new cycle instead of
            // permanently returning no candidate; avoid only the most recent asset when possible.
            if chosen == nil, visibleCount > 0 {
                retainedRecentAsset = visibleCount > 1 ? seenOrder.first : nil
                eligibleCount = 0
                assets.enumerateObjects { asset, _, _ in
                    guard !asset.isHidden, asset.localIdentifier != retainedRecentAsset else { return }
                    eligibleCount += 1
                    if Int.random(in: 0..<eligibleCount) == 0 { chosen = asset }
                }
                resetSeenCycle = chosen != nil
            }
            token = UUID().uuidString
        }

        guard let chosen, !chosen.isHidden, let token else {
            stateLock.lock()
            resetExpiredStateLocked()
            candidateRequestInFlight = false
            defaults.set(true, forKey: StateKey.completed)
            stateLock.unlock()
            call.resolve(["status": statusName(status), "candidate": NSNull()])
            return
        }

        stateLock.lock()
        resetExpiredStateLocked()
        guard !defaults.bool(forKey: StateKey.completed) else {
            candidateRequestInFlight = false
            stateLock.unlock()
            call.reject("今日の候補は終了しました")
            return
        }
        if resetSeenCycle {
            defaults.set(retainedRecentAsset.map { [$0] } ?? [], forKey: StateKey.seen)
        }
        defaults.set(token, forKey: StateKey.token)
        defaults.set(chosen.localIdentifier, forKey: StateKey.asset)
        stateLock.unlock()

        // 候補段階ではiCloud通信を許可しない。端末内にあるプレビューだけを読む。
        requestJPEG(for: chosen, longestSide: 1400, quality: 0.84, networkAllowed: false) { [weak self] result in
            guard let self else { call.reject("写真を読めませんでした"); return }
            switch result {
            case .success(var payload):
                payload["id"] = token
                self.stateLock.lock()
                self.resetExpiredStateLocked()
                let valid = defaults.string(forKey: StateKey.token) == token &&
                    defaults.string(forKey: StateKey.asset) == chosen.localIdentifier &&
                    !defaults.bool(forKey: StateKey.completed)
                self.candidateRequestInFlight = false
                if valid {
                    self.cachedPreviewToken = token
                    self.cachedPreview = payload
                }
                self.stateLock.unlock()
                DispatchQueue.main.async {
                    if valid { call.resolve(["status": self.statusName(status), "candidate": payload]) }
                    else { call.reject("候補の有効期限が切れました") }
                }
            case .failure(let error):
                self.stateLock.lock()
                self.resetExpiredStateLocked()
                self.skipUnavailableCandidateLocked(assetIdentifier: chosen.localIdentifier, token: token)
                self.candidateRequestInFlight = false
                self.stateLock.unlock()
                DispatchQueue.main.async { call.reject("端末内の候補を準備できませんでした", nil, error) }
            }
        }
    }

    @objc public func photo(_ call: CAPPluginCall) {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard canRead(status), let token = call.getString("id"), !token.isEmpty else {
            call.reject("写真を読む許可がありません")
            return
        }

        stateLock.lock()
        resetExpiredStateLocked()
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: StateKey.completed),
              defaults.string(forKey: StateKey.token) == token,
              let identifier = defaults.string(forKey: StateKey.asset),
              !fullRequestInFlight else {
            stateLock.unlock()
            call.reject("候補トークンが無効です")
            return
        }
        fullRequestInFlight = true
        stateLock.unlock()

        let assets = PHAsset.fetchAssets(withLocalIdentifiers: [identifier], options: nil)
        guard let asset = assets.firstObject, !asset.isHidden else {
            stateLock.lock(); fullRequestInFlight = false; stateLock.unlock()
            call.reject("写真が見つかりません")
            return
        }

        // 利用者が「使う」を選んだ後だけ、必要ならiCloud原本の取得を許可する。
        requestJPEG(for: asset, longestSide: 4096, quality: 0.94, networkAllowed: true) { [weak self] result in
            guard let self else { call.reject("写真を読めませんでした"); return }
            switch result {
            case .success(var payload):
                payload["id"] = token
                self.stateLock.lock()
                self.resetExpiredStateLocked()
                let valid = defaults.string(forKey: StateKey.token) == token &&
                    defaults.string(forKey: StateKey.asset) == identifier &&
                    !defaults.bool(forKey: StateKey.completed)
                if valid { self.finishDayLocked(assetIdentifier: identifier) }
                else { self.fullRequestInFlight = false }
                self.stateLock.unlock()
                DispatchQueue.main.async {
                    if valid { call.resolve(["status": self.statusName(status), "photo": payload]) }
                    else { call.reject("候補トークンが無効です") }
                }
            case .failure(let error):
                self.stateLock.lock(); self.fullRequestInFlight = false; self.stateLock.unlock()
                DispatchQueue.main.async { call.reject("写真を読めませんでした", nil, error) }
            }
        }
    }

    @objc public func discard(_ call: CAPPluginCall) {
        guard let token = call.getString("id"), !token.isEmpty else {
            call.reject("候補トークンがありません")
            return
        }
        stateLock.lock()
        resetExpiredStateLocked()
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: StateKey.completed),
              defaults.string(forKey: StateKey.token) == token,
              let identifier = defaults.string(forKey: StateKey.asset) else {
            stateLock.unlock()
            call.reject("候補トークンが無効です")
            return
        }
        finishDayLocked(assetIdentifier: identifier)
        stateLock.unlock()
        call.resolve(["ok": true])
    }

    private func requestJPEG(for asset: PHAsset, longestSide: CGFloat, quality: CGFloat,
                             networkAllowed: Bool,
                             completion: @escaping (Result<JSObject, Error>) -> Void) {
        let scale = min(1, longestSide / CGFloat(max(asset.pixelWidth, asset.pixelHeight)))
        let target = CGSize(width: max(1, CGFloat(asset.pixelWidth) * scale),
                            height: max(1, CGFloat(asset.pixelHeight) * scale))
        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = networkAllowed
        let gate = DailyPhotoCompletionGate()

        imageManager.requestImage(for: asset, targetSize: target, contentMode: .aspectFit,
                                  options: options) { image, info in
            if (info?[PHImageResultIsDegradedKey] as? Bool) == true { return }
            guard gate.claim() else { return }
            if (info?[PHImageCancelledKey] as? Bool) == true {
                completion(.failure(NSError(domain: "SpotaDailyPhoto", code: 1,
                                            userInfo: [NSLocalizedDescriptionKey: "写真の読み込みを中止しました"])))
                return
            }
            if let error = info?[PHImageErrorKey] as? Error { completion(.failure(error)); return }
            guard let image, let data = image.jpegData(compressionQuality: quality) else {
                completion(.failure(NSError(domain: "SpotaDailyPhoto", code: 2,
                                            userInfo: [NSLocalizedDescriptionKey: "写真を読めませんでした"])))
                return
            }
            var exif: JSObject = [:]
            if let location = asset.location {
                exif["Latitude"] = location.coordinate.latitude
                exif["Longitude"] = location.coordinate.longitude
            }
            if let date = asset.creationDate {
                exif["CreateDate"] = ISO8601DateFormatter().string(from: date)
            }
            completion(.success([
                "dataUrl": "data:image/jpeg;base64," + data.base64EncodedString(),
                "exif": exif
            ]))
        }
    }
}
