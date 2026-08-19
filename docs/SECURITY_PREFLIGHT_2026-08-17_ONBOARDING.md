# 初回起動・アカウント安全機能・通信モニター セキュリティ事前審査

確認日: 2026-08-17（Asia/Tokyo）

対象: 未commitの `v123` / `api-44` / 規約版 `2026-08-17.1`

## 判定

- コード差分: **APPROVE**
- 本番D1 migration: **APPROVE / 適用済み**
- 法務レビュー（無料版・請求時開示方式）: **条件付きAPPROVE**
- 税務レビュー（無料版・住所常時公開の要否）: **APPROVE / 税務上の即時ブロッカーなし**
- GitHub pushによる自動公開: **BLOCK**
- 実機Push通知: **BLOCK（外部設定と実機接続待ち）**

初回起動、規約表示・同意、Appleログイン経路、アプリ内アカウント削除、投稿通報、通信モニターは、ローカルの自動テストとiOS Simulatorビルドに合格した。本番D1はバックアップ後に `0004` と `0005` を適用し、外部キー違反0件を確認した。

GitHubへのpushはCloudflareの自動公開を伴う。このため、次の公開条件を満たすまでは実行しない。

1. 利用規約とプライバシーポリシーへ、運営者の氏名または法人名、継続して受信できる請求窓口、運営者情報（住所・電話番号を含む）を請求があった場合に遅滞なく提供する方法を記載する。課金開始前に、特定商取引法上の表示方法を法務レビューで確定する。
2. Firebase AuthenticationでAppleプロバイダーを有効化し、Apple Developer側でbundle ID `com.damo.michikusa` のSign in with Apple capabilityを有効化する。
3. Google Cloud Run上のFCM中継サービスへ、実行時サービスアカウント（ADC）を付与する。CloudflareにはサービスアカウントJSONを置かず、`FCM_RELAY_URL` とローテーション可能な `FCM_RELAY_SHARED_SECRET` だけを設定する。（2026-08-17: revision `spota-fcm-relay-00002-t9w`をデプロイ済み。`/health` 200、署名なし`/send` 401を確認。）
4. APNs認証キーをFirebaseへ登録し、署名済みアプリを物理iPhoneへ入れる。
5. 物理iPhoneを接続し、通知を許可してログインする。現在の本番 `push_tokens` は0件で、接続済み実機もない。
6. アプリの通信モニターを実行し、FCM受付、端末受信、通知開封、画面上の目視確認の4段階をすべて完了させる。

## 実装した5項目

### 1. Appleでサインイン

- iPhoneではCapacitor Firebase AuthenticationのネイティブAppleログインを使い、ID tokenとnonceをFirebase Web SDKへ橋渡しする。
- WebではFirebase `OAuthProvider('apple.com')` を使い、popupが使えない場合だけredirectへ退避する。
- GitHubから再現できるよう、Apple Sign In entitlement、Push entitlement、Xcode capability、Firebase provider設定を `native/ios/apply-to-capacitor.sh` に固定した。

### 2. アプリ内アカウント削除

- 確認欄の完全一致「削除」、10分以内の再認証、1日3回の上限を必須にした。
- Apple利用者はApple authorization codeをFirebase SDKへ渡し、Apple token revocation完了後だけサーバー削除を許可する。
- Firebase Authを先に削除し、D1の利用者行とcascade対象、R2写真を順次削除する。共有されているR2 objectは残す。
- R2は50件ずつ処理し、途中失敗はcronで再開する。完了後の監査行には生の利用者IDとprovider UIDを残さずhashだけを保持する。
- Firebase削除直後の古いID tokenでアカウントが自動再作成されるのを2時間防ぐ。

### 3. 投稿・利用者の通報

- 認証済み `POST /api/reports` のみ。1日20件、本文500文字、理由allowlist、対象の閲覧権限、自分自身の通報禁止をサーバーで検証する。
- `client_operation_id` のunique indexで二重送信を防ぐ。
- 通報フォームは理由の明示選択、補足ラベル、送信状態、エラー表示を備える。

### 4. 本番D1 migration

- 適用前バックアップ: `work/d1-backup/pre-account-safety-20260817.sql`（Git対象外）
- バックアップ容量: 586,021 bytes
- SHA-256: `684cc77be61e7b53db95fee6b185715c9984cef101e6e90b33dbd4dae2df3993`
- 適用済み: `0004_legal_acceptance.sql`、`0005_account_safety_monitor.sql`
- 作成確認: 6テーブル、reports追加2列
- `pragma_foreign_key_check`: 0件

### 5. 本番通信モニター

- 利用者が明示的に開始した時だけ、専用botが一時投稿、DM、いいね、Flash、アプリ内通知、Push通知を作る。
- Push payloadに緯度・経度、メール、端末tokenを入れない。
- 実行は1日3回、15分で期限切れ。作成したartifactをrun IDで記録し、cronはモニター所有データだけを削除する。
- 通知成功を「FCM受付」「端末受信」「通知を開いた」「画面で見えた」の4段階に分けた。FCMのHTTP成功だけでは通知確認済みにしない。
- Cloudflare WorkerはGoogle OAuth鍵を保持しない。HTTPSのCloud Run中継へ、5分以内のtimestamp・nonce・HMAC-SHA-256署名を付けて最大8件ずつ送る。中継はGoogle ADCでFCM HTTP v1を呼び、無効な登録tokenだけをWorkerへ返してD1から削除する。
- 中継は本文16KiB、最大8メッセージ、通知長、dataキー、位置情報・メール・IP等の機微キーを検証する。Cloud Runの公開URL自体はHMACなしでは処理を受け付けない。
- HMAC共有secretはSecret Managerへ登録し、Cloud Runには `--set-secrets` で注入する。リポジトリ、Wrangler vars、サービスアカウントJSONへ保存しない。

## 通信と秘密情報の監査

- 新規送信先はApple認証、Firebase Identity Toolkit、Cloud RunのFCM中継、FCM HTTP v1。いずれもHTTPSを使用する。Google OAuth token endpointへのアクセスはCloud RunのADCライブラリ内だけで発生し、Cloudflare Workerからは呼ばない。
- Firebase client API keyは公開クライアント識別子であり、Web/iOSクライアントに既存配置されている。同keyはGoogle Cloud側でFirebase用途・bundle ID・Web originに制限する必要がある。
- サービスアカウントprivate key、APNs key、FCM tokenをGitへ追加していない。
- Google Cloud側のBilling紐付け、サービスアカウント、FCM権限、Secret Manager version 1、Cloud Run revision `spota-fcm-relay-00002-t9w`は設定済み。Cloudflare secret `FCM_RELAY_URL` と `FCM_RELAY_SHARED_SECRET` も登録済み（secret値は表示・記録していない）。旧 `FCM_SERVICE_ACCOUNT` は使用しない。現在の本番Workerソースは`api-43`のままで、ローカル`api-44`のGitHub push／ソース公開は法務・実機条件確認後に行う。
- 本番D1はmigration後もactive user 2件、active post 13件を維持し、新規のmonitor run・deletion job・reportは各0件、push tokenは0件。したがって実機通知成功はまだ主張しない。

## 検証証跡

- `npm run check`: 101/101成功。
- アカウント安全機能の実行型テスト: migration、削除参照、通報、HMAC署名付きFCM relay、モニターartifact生成・限定cleanup。
- Wrangler dry-run: Worker、静的assets、D1×10、R2、Rate Limiter、Assets bindingを確認する。
- iOS Simulator Debug build: capability適用後に成功。
- リポジトリとCapacitor iOS同梱assetsの主要ファイルを一致確認する。

## 残る法務・運用上の注意

この文書は実装と通信経路に関する技術審査であり、弁護士等による法務確認ではない。運営者名、継続して受信できる請求窓口、請求時に運営者情報を遅滞なく提供する方法がない利用規約・プライバシーポリシーを正式版として公開しない。請求時開示方式を採用する場合も、実際に対応できる窓口と運用記録を先に用意する。Cloudflare、Firebase、FCM、Cloud Vision等の処理データ・契約主体・処理国・保存期間・削除方法が未確認のまま、個人情報保護法対応済みとは表示しない。

## 2026-08-17 実機Push確認の自動化可能範囲

### 自動で完了できる検証（実行済み）

- `npm run check`: 102/102成功。Appleログイン経路、通知モニター、FCM中継、写真・認証・認可・公開範囲の回帰を含む。
- `git diff --check`: 成功。
- `npm audit --prefix services/fcm-relay --omit=dev --audit-level=moderate`: 脆弱性0件。
- Cloud Run FCM中継 `GET /health`: HTTP 200、`{"ok":true}`。
- Cloud Run FCM中継へ署名なし`POST /send`: HTTP 401、`{"error":"unauthorized"}`。秘密情報なしで送信できないことを確認。
- 本番Worker `/api/health`: HTTP 200、現行公開版は`api-43`。ローカル未公開差分`api-44`はまだ送っていない。
- iOS設定静的検査: `native/ios/App.entitlements`の`aps-environment`、適用スクリプトのPush NotificationsとFirebase Authentication capabilityを確認。
- リポジトリ内の`.p8`、Apple AuthKey、Firebase Admin SDK／サービスアカウントJSON: tracked/present 0件。
- `wrangler deploy --dry-run`: 静的38ファイル（gzip 40.09 KiB）、D1×10、R2、Rate Limiter、Assets bindingを確認。実デプロイはしていない。

### 自動化できなかった検証と理由

- 本番D1の`push_tokens`件数は、読み取り専用SELECTを試行したが、この端末のCloudflare APIが`code 7403 (not authorized)`を返したため再取得できなかった。既存監査記録上は0件であり、今回の試行で値を変更していない。
- Xcode 26.4で、ユーザーのローカルプロジェクト`/Users/shigematsutomoki/michikusa-app/ios/App/App.xcodeproj`を署名なしSimulator向けにビルドし、`** BUILD SUCCEEDED **`を確認した。Booted iPhone 17 Pro Simulatorへ`simctl install`後、bundle ID `com.damo.michikusa`の起動（PID 60180）まで成功した。これはコンパイル・起動確認であり、実機インストール、署名、APNsの最終反映までは含まない。
- 実機への通知送信は、ユーザーのAPNs許可、Firebase登録、実機push token、通知を受ける端末が必要であり、勝手に外部ユーザーへ送ることはできない。

### ユーザー操作が必要な最終確認

1. XcodeでユーザーのiOSプロジェクトを開き、Team／Bundle ID `com.damo.michikusa`／Push Notifications／Sign in with Appleを確認して実機へインストールする。
2. 初回案内で通知を許可し、Appleログインを完了する。これによりD1へ実機tokenが登録される。
3. 「通信モニターを開始」を一度だけ実行し、FCM受付、端末受信、通知開封、画面上の目視の4段階を確認する。受信・開封・目視は端末画面を見ないと判定できない。
4. 4段階の結果（成功／失敗、発生時刻、エラー表示）を共有後、セキュリティ担当がpush可否を再判定する。

この段階では外部送信・本番Worker更新・GitHub pushを行っていない。実機確認が終わるまで公開ゲートは`BLOCK`を維持する。

### 公開順序に関する補足

Appleログインの「コードを動かす」だけなら、FirebaseのAppleプロバイダー設定とローカルXcodeアプリで確認できる。一方、Cloudflare上の本番URLで初回案内、規約同意、`/api/legal/acceptance`、プロフィール保存まで確認するには、最新の`public/`とWorker（現在の本番は`api-43`）を公開する必要がある。したがって、実機テストを本番URLで行う場合は「公開してから実機確認、確認後に最終push」という順序にできない構成になっている。

現状の安全な選択肢は次の二つである。

1. Xcodeへ同じWeb資産をローカル同期し、ローカル／SimulatorでAppleログイン経路を先に確認する（本番公開なし）。
2. 本番Workerへ公開する場合は、公開差分を候補版として明示し、公開直後に実機4段階確認を行い、失敗時は直ちにロールバックする。これは本番状態を変更するため、ユーザーの明示許可と公開後監視が必要である。

「本番URLで実機確認する」ことを選ぶ場合、Appleログイン確認そのものは公開前には成立しないという制約を、セキュリティゲートの前提として記録する。

## 2026-08-17 Appleログイン失敗時の診断更新

- `public/sync.js`とCapacitor同梱`public/sync.js`に、Appleログインの安全なエラーコード表示を追加した。表示対象は`auth/*`またはApple OSコードだけに限定し、ID token、メール、URL、Appleの内部エラー本文は表示しない。
- `auth/operation-not-allowed`、`auth/invalid-credential`、`auth/account-exists-with-different-credential`、`auth/popup-blocked`、`apple/1000`（Bundle ID／Team設定）、`apple/1001`（キャンセル）を利用者向けに判別する。
- Apple確認画面をキャンセルした場合にボタンがdisabledのまま残る不具合を修正し、キャンセル後に再試行できるようにした。
- `npm run check`: 103/103成功。iOS Simulator Debug build: `BUILD SUCCEEDED`。Web資産とiOS同梱資産の一致も確認した。
- 静的設定（Team ID `Q4684PUCF7`、Bundle ID `com.damo.michikusa`、Apple Sign In capability、FirebaseAuthentication provider list、`GoogleService-Info.plist`）は揃っている。したがって、次回の実機操作で表示されるコードにより、Firebase Apple provider設定またはApple Developer側設定の不一致を確定する。

## 2026-08-17 `auth/missing-or-invalid-nonce`修正

- 実機で再現されたエラーはFirebaseの`auth/missing-or-invalid-nonce`だった。
- 原因は、Capacitor Firebase Authenticationを`skipNativeAuth:false`（ネイティブFirebaseへサインイン）で呼んだ後、同じcredentialをFirebase Web SDKへ渡していたこと。ネイティブ側でnonceを使った後のcredential再利用となり、Web SDKのnonce検証に失敗していた。
- Appleだけ`FA.signInWithApple({skipNativeAuth:true})`へ変更し、ネイティブ側はAppleの認証UIとcredential生成だけ、Firebaseのセッション確立はWeb SDKがraw nonce付きcredentialで一度だけ行う構成へ修正した。Googleの既存経路は変更していない。
- リポジトリ、`michikusa-app/public`、Xcode同梱`public`の3箇所へ同じ修正を反映した。`npm run check` 103/103成功、iOS Simulator Debug buildも成功した。
- この修正はローカルXcodeアプリには反映済みだが、本番Cloudflare Worker／Web資産にはまだpushしていない。再ビルドした実機でAppleログイン成功を確認後、push判定を更新する。

## 2026-08-17 通知オンなのに通信モニターが開始できない切り分け

- Appleログイン成功後、利用者から「アプリの通知はオンだが、通知が許可されていないためモニターが起動しない」と報告された。
- 原因候補は、iPhoneの通知許可、APNsへの端末登録、取得したAPNs tokenの認証済みD1保存の3段階が別々であるにもかかわらず、旧UIが全ての失敗を「通知が許可されていない」と表示していたこと。通知設定がオンでも、APNs登録または`POST /api/push/token`が失敗すればモニターは安全のため開始しない。
- `public/native.js`とCapacitor同梱版2箇所の`setupPush`を構造化結果へ変更した。`permission_denied`、`registration_error`、`registration_timeout`、`token_save_failed`、`plugin_unavailable`等を区別し、APNs token・メール・URL・生のOSエラーを画面やログへ出さない。
- `registrationError` listenerを`register()`前に登録し、8秒タイムアウトを追加した。サーバー保存がHTTP失敗または通信例外の場合は「通知はオンだがサーバー登録に失敗」と表示する。成功時だけ`{ok:true,code:'registered'}`を返し、モニターは`ok`を確認してから開始する。
- `public/sync.js`とCapacitor同梱版2箇所の通信モニターを構造化結果に対応させた。これにより、利用者は設定を再確認すべきなのか、アプリ再起動・通信確認が必要なのかを画面で判断できる。
- 失敗時は秘密情報を含まない固定コード（例:`permission_denied`、`registration_error`、`token_save_failed`）も表示する。サポート時に設定・APNs・サーバーのどの段階で止まったかを再現しやすくした。
- `npm run check`: 104/104成功。`git diff --check`成功。リポジトリと2つのCapacitor資産の`native.js`／`sync.js`一致を確認。Xcode Simulator Debug build: `** BUILD SUCCEEDED **`。
- 実機のAPNs受信、D1へのtoken保存、FCM受付、通知開封、目視確認はまだ未実施であり、GitHub push／Cloudflare本番公開は行っていない。再ビルドした実機で通信モニターを再試行し、表示された構造化エラーコードを記録してから最終セキュリティ判定を行う。

## 2026-08-18 `registration_timeout`の根本原因修正

- 実機で`registration_timeout`が発生したため、Capacitor Push NotificationsのiOS READMEとプラグイン実装を照合した。
- `AppDelegate.swift`に、iOSの`didRegisterForRemoteNotificationsWithDeviceToken`と`didFailToRegisterForRemoteNotificationsWithError`から、Capacitorが購読する`capacitorDidRegisterForRemoteNotifications`／`capacitorDidFailToRegisterForRemoteNotifications`へ転送する処理が存在しなかった。通知許可はオンでも、JavaScript側へAPNs tokenも登録失敗も届かず、8秒タイムアウトになっていた。
- `native/ios/AppDelegate.swift`をリポジトリのネイティブ資産として追加し、`native/ios/apply-to-capacitor.sh`が生成済みCapacitorアプリへ同ファイルを適用するようにした。ローカルXcodeプロジェクトの`AppDelegate.swift`にも同じ転送を反映した。
- 成功時はAPNs tokenがCapacitorへ渡り、失敗時は`registration_error`がJavaScriptへ返るため、`registration_timeout`のまま原因不明で待ち続けない構成になった。
- `npm run check`: 104/104成功。iOS同梱JavaScript構文検査成功。ディスク不足で一度停止した後、一時ビルド成果物を整理して容量を確保し、Xcode Simulator Debug build `** BUILD SUCCEEDED **`を確認した。
- 実機での再ビルド・APNs token取得・D1保存・FCM受付・通知開封・目視確認は未実施。GitHub push／Cloudflare本番公開は行っていない。
