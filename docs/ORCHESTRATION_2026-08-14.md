# リリース前大型更新 — オーケストレーション記録

日付: 2026-08-14

## 依頼の確定内容

- ⑥ プロフィールは、下方向のスワイプに指追従し、距離または終端速度で閉じる。未達なら滑らかに元へ戻す。
- ⑨ 風景写真に限定しない。利用者が写真ピッカーで許可した候補をランダム順に1枚ずつ表示し、右で使用、左で不使用を選ぶ。
- ⑫ いいね、コメント、フォロー、通知・未読、チャット、ハッシュタグ、アルバム、期限付き共有をD1へ永続化する。
- 画面構成と情報の優先順位は、利用者提供PDFを基準にする。

## 並列監査と参照ソース

### デザイン・iOS操作監査

参照:

- 利用者提供PDF `名称未設定のノート 2.pdf`
- `public/release.js`
- `public/post.js`
- `public/place.js`
- `public/app.css`
- `public/index.html`
- Apple HIG、Webアクセシビリティ指針、Design Taste frontend指針

反映した主な指摘:

- プロフィールスワイプの速度減衰と未実行rAFの停止
- 写真取得中に別画面を閉じる非同期競合の遮断
- デッキ内で原寸Blobを大量保持しない方式
- 5操作ナビと現在地ボタンの分離
- Service Workerと静的アセット版の同時更新

### Cloudflare / D1監査

参照:

- `src/index.js`
- `migrations/0001_social_release.sql`
- `wrangler.jsonc`
- Cloudflare D1およびRate Limiting bindingの公式仕様

反映した主な指摘:

- `created_at:id` 複合カーソルと `last_read_at:last_read_id` 既読位置
- 投稿・コメント・メッセージの冪等操作ID
- 読み取り連打をD1カウンターからRate Limiting bindingへ移動
- 公開遅延投稿を15分ごとに通知へ反映
- ブロック時のフォロー・通知・会話表示の整合
- migrationをWorkerより先に適用するリリース順序

### 攻撃者視点・回帰監査

参照:

- 新規ソーシャルAPI全ルート
- R2写真取得経路
- 共有リンクと画像モデレーション経路
- Push通知とD1利用量
- 既存テストおよび追加テスト

反映した主な指摘:

- `view` と `thumb` を別々にサーバー検査し、一方だけの安全画像差し替えを防止
- アルバム非公開化・削除後に保存済み共有画像URLを再利用できない再認可
- 共有URLのIP・トークン単位レート制限と `no-store`
- Push本文へコメント・DM本文を直接出さない
- 通知とメッセージの未読二重加算を解消

## 検証

- JavaScript構文検査: 合格
- SQLiteへのmigration適用: 合格
- 外部キー検査: 違反0
- 投稿通知の全受信者一括SQL: 合格
- 自動テスト: 28件すべて合格
- `git diff --check`: 合格
- 390 × 844の実表示確認: ホーム、5操作ナビ、ソーシャル、アルバム、写真左右判定でコンソールエラー0

## リリース状態

2026-08-15、本番D1へコードより先にmigrationを適用した。

- 適用前Time Travel bookmark: `000000b7-00000000-000050c7-e18c15914355e79b080c35b4bf1f0b28`
- 適用後Time Travel bookmark: `000000b7-00000007-000050c7-7c0d62aedb63c92cad1dc461caa8eb35`
- 実行結果: 42 queries、84 rows written、D1 0.90 MB
- 確認結果: 新規11テーブル、`posts` 2列、`photos` 3列、外部キー違反0
- 既存写真3件は `legacy` として保存し、該当する公開・フレンド投稿3件を安全のため非公開化
- 未検証のまま公開状態に残った投稿: 0件

この確認後にコードをcommit / pushし、Cloudflareの自動デプロイ後に公開ヘルスチェックを行う。

## 2026-08-15 反映確認hotfix

GitHubとCloudflareの配信ファイルは一致していたが、新規ブラウザで外部CDNのMapLibre読込が失敗し、`maplibregl is not defined` から地図初期化が停止することを確認した。後続処理でも未生成の `map` を直接参照していたため、更新済み画面が正常に見えない状態だった。

- MapLibre 4.7.1をWorkerで固定URLから取得し、同一オリジンのversioned URLとして配信
- JS/CSSのSRIハッシュを維持し、端末のIPを外部CDNへ直接送らない構成へ変更
- 地図生成前の参照を `window.__michikusaMap` の存在確認付きへ変更
- frontendを `v99`、Service Worker cacheを `spota-v25`、APIを `api-37` へ更新
- 自動テスト29件、SRI実測、ローカルWorker実画面、コンソールエラー0を確認
