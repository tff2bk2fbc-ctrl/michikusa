# FCM iOS token緊急修正・セキュリティ事前審査

日付: 2026-08-19

## 障害と確定原因

本番通信モニターの最新runは、Cloud Run HMAC修正前の`relay_error`から`rejected`へ変化していた。Cloud Runの`POST /send`はHTTP 200で、FCMの`validate_only`診断はHTTP 400 `INVALID_ARGUMENT`を返した。

D1の通知先を値非表示で形状だけ確認すると、`platform=ios`、64文字、16進数のみだった。これは`@capacitor/push-notifications`のiOS実装が返すAPNs device tokenの形式であり、FCM HTTP v1のregistration tokenではない。

通信経路は次の状態だった。

```text
iPhone → APNs device token → D1 → Worker → Cloud Run → FCM HTTP v1
                                                        └─ INVALID_ARGUMENT
```

Google Cloud project、Firebase project、Sender ID、Bundle ID、APNs認証キー、FCM API、Cloud Run ADC、サービスアカウントIAMは整合していた。実token、Google access token、HMAC secret、APNs鍵はログ・画面・Gitへ出していない。

## 緊急対策本部の分担

- 本番通信・セキュリティ班: D1、Cloudflare deployment、Cloud Run request log、FCM `validate_only`を照合。
- iOS端末班: Capacitorプラグイン、AppDelegate、SwiftPM、JavaScript登録・受信・開封経路を監査。
- Google/Firebase班: Firebase構成、APNsキー、FCM API、ADC、IAM、Bundle ID／Sender IDを監査。
- 主担当: サーバー防御、relay分類、ネイティブ依存置換、Xcode同期、テスト、リリース統合。

三班は独立に「APNs tokenをFCM tokenとして保存したこと」を根本原因と判定した。

## 実装

### iOS

- `@capacitor/push-notifications`を削除し、`@capacitor-firebase/messaging@8.4.0`へ置換。
- `FirebaseMessaging.getToken()`のFCM registration tokenだけを認証済み`/api/push/token`へ保存。
- `tokenReceived`で更新tokenを保存。
- `notificationReceived`と`notificationActionPerformed`で受信・開封receiptを保存。
- 新token保存成功後、端末に残る旧tokenを認証済みDELETEで削除。
- `FirebaseMessagingAutoInitEnabled=false`とし、利用者が通知を許可して`getToken()`するまでFCM identifierを自動発行しない。
- AppDelegateからAPNs登録成功・失敗とbackground remote notificationをFirebase Messagingへ転送。
- 旧Push pluginとFirebase Messaging pluginの併用をインストーラーで禁止。

### Worker

- `platform=ios`かつ64文字16進数の旧APNs形状tokenを`wrong_token_type`として保存拒否。
- 送信前に旧APNs形状tokenを除外し、同じ利用者に属する該当行だけを削除。
- 正しいFCM token登録後、同じ利用者の旧APNs形状行だけを削除。
- FCM無効tokenの削除も`token + user_id`一致を必須にし、送信待ち中の所有者変更で別利用者の行を消さない。

### Cloud Run relay

- FCMが「有効なFCM registration tokenではない」と明示した応答を`invalid_registration`へ分類。
- 生のFCM応答、token値、Authorization、通知本文をログや利用者画面へ返さない。
- HMAC、timestamp、nonce、body署名、本文16KiB、最大8件、位置/email/IP/device token data拒否を維持。

### キャッシュ更新

- Web資産を`v124`、Worker healthを`api-45`へ更新し、旧`native.js?v=123`が残らないようにした。

## 検証

- 通知・オンボーディング・認証・セキュリティ関連: 20件成功。
- relayテスト: 6/6成功。Secret Manager末尾改行、HMAC、リプレイ、機微data、無効token分類を含む。
- `node --check`: Worker、native.js、relay成功。
- `sh -n native/ios/apply-to-capacitor.sh`: 成功。
- `git diff --check`: 成功。
- Capacitor sync後のSwiftPM: `CapacitorFirebaseMessaging`あり、`CapacitorPushNotifications`なし。
- リポジトリ／Capacitor root／Xcode同梱`native.js`一致。
- Xcode Simulator Debug: `** BUILD SUCCEEDED **`。
- npm audit: high 0、critical 0。moderate 3件はCapacitor CLIのビルド用`xcode`→`uuid`依存で、アプリ実行時の新規依存ではない。

iCloud配下でNode依存読み込みが一度`ECANCELED`になったため、relayは同じsource・package lockを一時ディレクトリへ複製して再実行し6/6成功した。

## 残るリリースゲート

- 実機へFirebase Messaging入りの`v124`をビルド・インストールする。
- 通知モニターで、FCM受付、端末受信、通知開封、目視確認を順に確認する。
- 実機成功後、最終セキュリティ承認を得てcommit、Worker `api-45`、Cloud Run relay、GitHubを公開する。

端末内ネイティブプラグインはWeb／Workerのデプロイだけでは更新されないため、旧アプリのままでは解消しない。

## 参照資料

- Firebase: <https://firebase.google.com/docs/cloud-messaging/ios/get-started>
- Capacitor Firebase Messaging: <https://capawesome.io/docs/plugins/firebase/cloud-messaging/>
- ローカル実装: `public/native.js`、`native/ios/AppDelegate.swift`、`native/ios/apply-to-capacitor.sh`、`src/index.js`、`services/fcm-relay/server.mjs`
