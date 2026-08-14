# リリース前セキュリティ・通信監査

確認日: 2026-08-15（Asia/Tokyo）

対象: 未commitの `v101` / `api-39` / iOS同梱Web assets

## リリース判定のルール

- デザイン監査、Cloudflare・通信監査、認証・認可監査を分離する。
- 各監査はコードを編集せず、根拠箇所と `APPROVE` / `BLOCK` を返す。
- `BLOCK` が1件でも残る間はcommit・push・本番反映を行わない。
- D1 migrationはセキュリティ承認後、Workerの自動deployより先に適用する。

## ブラウザ・iOSからの通信

| 接続先 | 発生条件 | 送信され得る情報 | 防御・保存方針 |
|---|---|---|---|
| 自分のCloudflare Worker | API利用時 | Firebase ID token、投稿、選択した公開範囲、写真、位置 | HTTPS。位置を含む地図範囲・検索語・逆引きはPOST本文。API応答は原則`no-store`。 |
| OpenFreeMap | 地図表示時 | IP、User-Agent、表示範囲を推測できるstyle/tileリクエスト | 位置許可確認前は日本全体の中立表示。正確な現在地を端末へ永続化しない。Service Workerへ外部tileを保存しない。 |
| Firebase / Google Sign-In | 認証状態復元、ログイン操作 | Firebase公開設定、認証情報、Googleアカウント情報 | Firebase ID tokenをWorkerで署名・issuer・audience・有効期限検証。 |
| Apple Maps / Google Maps | 利用者が「経路」を押した時だけ | 選択した目的地 | 自動送信せず、外部アプリへの明示操作に限定。 |
| 出典リンク | 利用者が出典を押した時だけ | 通常のリンク遷移情報 | 自動接続ではない。 |

iOSはWorker上の画面を直接実行せず、署名されたアプリへ同梱した `public/` を使う。`server.url` は設定しない。`_headers` が適用されないローカル配信にも備え、`index.html` 自体へCSPを設定する。

## Workerからの外部通信

| 接続先 | 発生条件 | 送信する情報 | 制限 |
|---|---|---|---|
| Google Firebase JWKS | Firebase token検証時、公開鍵cache miss | 公開鍵取得のみ | 1時間メモリcache、5秒timeout、応答200KB上限 |
| Nominatim | 利用者が地名を入力し検索実行した時だけ | 検索語。端末IP、Firebase token、写真、GPSは転送しない | cache、IP hash毎時、全体毎秒1回・日次上限、8秒timeout |
| jp-postal-code-api | ログイン利用者が郵便番号検索を実行した時だけ | 7桁郵便番号のみ | 利用者/全体burst、毎時・日次、24時間cache、5秒timeout、応答100KB上限 |
| Google Cloud Vision | ログイン利用者が`friends`または`public`写真を保存した時だけ | 公開配信用view/thumb画像 | Worker Secret、利用者毎時30・日次120、アプリ全体月900、10秒timeout。失敗時はprivateへ戻す。 |
| Google OAuth / FCM | FCM service accountが設定済みで通知送信する時だけ | device token、通知本文、通知種別 | 宛先日次・全体毎時制限、8秒timeout。2026-08-15時点でFCM secret未設定のため停止中。 |
| Cloudflare D1 / R2 | アプリDB・写真保存時 | アカウント、投稿、写真、設定 | binding経由。Secret値はD1へ保存しない。所有者・公開範囲を毎回検証。 |

Hotpepper、Rakuten、WikipediaオンラインAPI、Google Places、Gemini、外部画像proxyは現在のruntime経路から削除した。Wikipedia等の既存D1索引は外部APIを呼ばず、Cloudflare内部の読取だけを行う。

## ログと履歴

- Workers invocation URL logは `invocation_logs:false` とし、独自ログは5% samplingのエラー種別だけに限定する。
- エラー文字列からURL、細かい小数、改行を除去し、240文字で切る。
- Authorization、Firebase token、写真body、share token、正確な座標、検索語を意図的にログ出力するコードは置かない。
- 過去の完全な通信履歴は、保存されていないため復元できない。確認できる範囲はコード経路、Cloudflare設定、D1のcounter名、端末のテスト通信に限る。
- 旧 `app_config` にあった有料API用Secret値はCloudflare Secretsへ移し、D1から削除済み。D1にはquota/rate counterだけを残す。
- Secrets一覧には `GOOGLE_API_KEY` と、現在のコードが使わないHotpepper/Rakuten用3件がある。休眠Secretsは値を表示せず、今回の変更では削除しない。
- Git履歴にはFirebaseクライアント用公開API key形式が含まれる。これはFirebaseの公開設定だが、Google Cloud側でAPI制限・bundle/origin制限を維持する。

## 主要な防御

- 社会機能、写真、通知、メッセージ、プロフィール変更はFirebase認証後に限定。
- Photo IDだけで更新せず、`photo_id + post_id + user_id`を照合。
- 投稿・写真・コメント・メッセージ・共有は入力容量、回数、日次または総量を制限。
- フレンド一覧はread burst、申請・承認はPOST固定とwrite burstを適用。申請は利用者40件/日・全体100,000件/日・未回答500件、承認は利用者200件/日・全体100,000件/日で停止する。
- 同じ送信済みpending申請は友情行を再書き込みせず既存状態を返す。
- 地名検索はcache照会前にIPの一方向hash単位60回/分を適用し、cache missだけ追加で上流1回/秒・全体5,000回/日を消費する。
- 公開shareはclient全体のburst制限をtoken別制限より先に実施し、ランダムtokenによる制限回避を防止。
- 公開位置は相手と公開範囲に応じてexact / 約500m / 約2km / hiddenをサーバーで選択。
- 正確な現在地をlocalStorageへ保存せず、旧保存値を起動時に削除。権限取消を検知したら中立表示へ戻す。
- 外部JavaScriptを同一originへ固定し、バージョン、SRI、ライセンスを記録。

## デプロイ前チェック

1. `npm run check`
2. `git diff --check`
3. `wrangler deploy --dry-run`
4. Web/iOS `public/` の一致確認
5. iOS Simulator向け署名なしbuild
6. D1 `profile_icon` migration適用とschema確認（完了）
7. 2つの独立セキュリティ監査がともに `SECURITY APPROVE`（完了）
8. commit・push後、Cloudflare自動deployの `api-39` と `v101` を確認
