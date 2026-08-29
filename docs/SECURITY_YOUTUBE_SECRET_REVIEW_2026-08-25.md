# YouTube APIキーのCloudflare Secret登録に関するセキュリティレビュー

レビュー日: 2026-08-25（Asia/Tokyo）
追記日: 2026-08-26（Asia/Tokyo）
判定: **条件付き承認（Secret登録済み・未接続）**

## 結論

Cloudflare Worker Secretへ登録すること自体は、GitHub・モバイルアプリ・ブラウザへAPIキーを置くより安全です。ただし、Cloudflareアカウント、Workerコード、ログ、CI、登録操作のいずれかが誤ると漏えいします。「暗号化されているため絶対に漏れない」とは判断しません。

今回の確認では、YouTube APIキーの値は読み取り・表示・保存していません。ユーザーがCloudflare Secretへの登録を完了しましたが、Workerへの接続、YouTube通信、追加deploy、GitHub pushは行っていません。

## 確認結果

| ID | 重要度 | 確認内容 | 結果 |
| --- | --- | --- | --- |
| YT-SEC-001 | 低 | YouTubeキーのリポジトリ混入 | 現在の`src/`、`public/`、`services/`、`wrangler.jsonc`にYouTubeキー値なし。キー名と登録状態だけを台帳に記録。 |
| YT-SEC-002 | 低 | クライアント配布 | YouTube API呼び出し・`YOUTUBE_DATA_API_KEY`参照・公開routeは未実装。現状はクライアントへ配布されない。 |
| YT-SEC-003 | 低 | Workerログ・エラー | `src/index.js:228-231`は一般化した500応答、`src/index.js:2479-2485`はURL等を削ってログ長を制限。キーを意図的に出すログは確認されず。 |
| YT-SEC-004 | 中 | Cloudflare/GitHub権限 | Cloudflare管理者・deploy権限を持つアカウントが侵害される、または悪意あるWorkerをdeployするとSecretを外部送信できる。最小権限とdeployレビューが必要。 |
| YT-SEC-005 | 高 | API接続前の濫用対策 | YouTube専用の認証route、query allowlist、per-user/global quota、cache、kill switchは未実装。接続前に必須。未実装のまま公開接続しない。 |
| YT-SEC-006 | 中 | APIキーのアプリケーション制限 | Google Cloud側ではYouTube Data API v3に限定済み。Cloudflare Workersは固定送信元IPを前提にしにくいため、IP制限は動作確認なしに設定しない。 |

## 漏えいし得る経路

1. `wrangler.jsonc`、`.env`、`.dev.vars`、GitHub、iOS/Androidの資産へキーを貼り付ける。
2. `echo`、コマンド引数、シェル履歴、CIログ、スクリーンショット、チャットへキーを出す。
3. `console.log`、`console.error`、`wrangler tail`、D1のエラー列へキーを保存する。
4. `env.YOUTUBE_DATA_API_KEY`をAPIレスポンス、デバッグroute、クライアント向けJavaScriptへ返す。
5. CloudflareアカウントまたはGoogle Cloudプロジェクトの管理権限が侵害される。
6. YouTube APIをユーザー入力から直接呼び出し、第三者にquotaを消費される。

## 登録時の安全条件

- Secret名は`YOUTUBE_DATA_API_KEY`とし、値はWorker Secretへだけ保存する。
- APIキー値をコマンド引数・ファイル・GitHub・アプリ本体へ書かない。
- Cloudflareの正しい本番Worker（`broad-wildflower-9e30`）を確認してから登録する。
- Google Cloud側のAPI制限はYouTube Data API v3だけにする。利用開始前にquota上限・アラート・停止手順を設定する。
- Worker側に、固定query allowlist、レスポンス上限、キャッシュ、日次/月次quota、kill switch、タイムアウト、ログredactionを実装する。
- YouTubeの表示、削除、認可撤回、保存期間の条件を確認するまで、一般公開・D1保存を行わない。
- 初回はfixtureまたはstagingで検証し、APIキーの値を出力しないsecret-scanを通す。

## 登録方法の推奨

最も安全なのは、ユーザーがCloudflare Dashboardで直接入力する方法です。Cloudflare公式ドキュメントでは、Secretは暗号化された値としてWorkerへ渡され、DashboardとWranglerでは値が非表示になると説明されています。ただし、Dashboardでの追加はDeployを伴うため、対象Workerと差分を確認してから確定してください。

Wranglerを使う場合も、キー値を引数に書かず、対話プロンプトへ直接入力します。`wrangler secret put`は新しいWorkerバージョンを作成して即時deployするため、実行前に必ず対象Workerと変更内容を確認します。

## セキュリティ部の判定

**Secretへの手動登録:** APPROVE（登録済み）
**キーをSpotaへ接続:** BLOCK（quota・allowlist・kill switch・法務/利用条件の確認後）
**一般公開:** BLOCK（YouTube実通信と表示/削除要件の実機・ステージング確認後）

参照: [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
