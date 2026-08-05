# Codex オーケストレーション記録

更新日: 2026-08-05（Asia/Tokyo）

## 目的

`spota` の単一HTMLを機能別ファイルへ分割し、公開前に問題となる認証、認可、課金DoS、位置情報、画像検査、外部依存の脆弱性を確認・対策する。

## 作業の流れ

1. `CODEX_HANDOFF.md` を確認し、設計原則、読み込み順、既知課題、検証規約を整理した。
2. GitHubの `main` を取得した。引き継ぎに記載された分割版が未反映で、GitHub側は3,072行の単一 `public/index.html` だった。
3. 提供された `files.zip` の13ファイルを検査し、`public/` へ分割版を反映した。
4. 全JavaScriptの構文、DOM ID参照、Service Worker、Cloudflare Workerを検査した。
5. セキュリティ専門担当が読み取り専用レビューを行い、重大度と攻撃経路を整理した。
6. Worker担当とフロント担当を分離して並行実装し、主担当がAPI契約と差分を統合した。
7. 修正後に別担当が再レビューし、分担間の不整合と競合条件を追加検出した。
8. 主担当が再レビュー指摘を修正し、Wranglerのdry-runとローカルHTTP検証を実施した。

## 担当とモデルの使い分け

### 主担当（Codex）

- 引き継ぎとソースの統合
- 分割版の反映
- エージェント間のAPI契約調整
- 認証付きGoogle API呼び出しへの統一
- 写真アップロード再試行、認証画像表示、TOCTOU対策、画像シグネチャ確認
- Cloudflare Static Assets向け `_headers` の追加
- 全体検証、記録、コミット、push

### Workerセキュリティ担当（`gpt-5.6-sol` / high）

- Firebase認証境界
- Photo IDOR/BOLA
- 投稿・画像の容量、件数、頻度、総量制限
- D1 quota/rateカウンタの原子化
- Google Places、Vision、Geminiの保護
- Nominatim中継、キャッシュ、座標丸め
- Push・タグの座標精度
- Hotpepper、楽天、画像proxyの制限
- サーバー側画像モデレーション

### フロントセキュリティ担当（軽量モデル）

- Nominatim直接通信を同一Origin APIへ変更
- Vision判定をfail-closedへ変更
- 有料APIを認証付き `api()` 経由へ変更
- `exifr` のバージョン固定
- JavaScript構文とDOM ID参照の確認

### 独立セキュリティレビュー担当（`sol` 系）

- 初回の脆弱性レビュー
- 修正後の認証・認可・競合・データ消失の再レビュー
- コード変更は行わず、根拠と再現経路を主担当へ報告

## 主な変更

- フロントを `app.css`、`boot.js`、`lazy.js`、`core.js`、`map.js`、`place.js`、`data.js`、`native.js`、`post.js`、`sync.js`、`ui.js`、`sw.js` に分割した。
- Google Places、Vision、Gemini、Push、タグ、写真APIをFirebase認証後へ移動した。
- 写真更新時に `photo_id`、`user_id`、`post_id` を照合し、他ユーザーの写真を更新できないようにした。
- 画像のContent-Lengthと実バイト数、MIME、画像シグネチャ、1投稿枚数、時間・日次・総容量を制限した。
- 投稿本文と座標の検証、投稿・編集頻度制限を追加した。
- D1のquota/rate加算を単一SQL文にした。
- Vision失敗、キー未設定、上限到達時は公開を許可しないようにした。
- 公開画像はWorker自身も検査し、判定不能時は投稿を非公開へ戻すようにした。
- Push payloadから正確な緯度経度を除去し、タグ経路も投稿者の公開精度を適用した。
- ブラウザからNominatimへ直接送らず、WorkerでIPハッシュ制限、全体制限、キャッシュ、座標丸めを適用した。
- Hotpepper、楽天、画像proxyに入力・回数・応答容量制限を追加した。
- 写真アップロードのHTTPエラーを同期成功扱いせず、同じ投稿ID・写真IDで再試行するようにした。
- Bearer認証が必要なタグ写真を、認証付きfetchからBlob URLへ変換して表示するようにした。
- 外部 `exifr` のバージョンを `7.1.3` に固定した。
- Cloudflare Static Assets用 `_headers` でCSPなどのセキュリティヘッダーを設定した。

## 検証結果

- `node --check src/index.js`: 成功
- `node --check public/*.js`: 全ファイル成功
- DOM ID参照照合: 参照28件、欠落0件
- `git diff --check`: 成功
- `wrangler deploy --dry-run`: 成功
- Wrangler Static Assets: 14ファイル認識
- ローカル `/api/health`: 200
- 未認証 `/api/gsearch`: 401
- 未認証 `/api/vision`: 401
- 未認証 `/api/tags`: 401
- 未認証 `/api/photo/...`: 401
- 静的HTMLレスポンスのCSP、nosniff、DENY、Referrer-Policy、Permissions-Policy、HSTS: 付与を確認

## 残課題と運用上の注意

- `orig`、`view`、`thumb` はクライアントが別々に送るため、改造クライアントからの迂回を防ぐには各画像の検査が必要で、Vision quotaを1写真あたり最大3回消費する。将来はサーバー側で派生画像を生成する構成が望ましい。
- 外部JavaScriptはバージョン固定したが、SRIと完全セルフホスト化は未実施である。
- Nominatimへの送信元IPはWorkerに隠れるが、約11mへ丸めた座標自体はNominatimへ送信される。国土数値情報をD1へ取り込む自前逆ジオコーディングが最終対策である。
- 総容量は安全側の累積上限であり、削除しても現在は枠を戻さない。共有写真を壊さない参照カウント付きR2 GCは別途必要である。
- Cloudflare WAF、Google Cloud APIキー制限、Firebase App Check、Firebase Security Rules、IAM、課金アラートはリポジトリ外の設定なので、デプロイ前に管理画面で確認する。
- 本記録作成時点ではCloudflare本番へのデプロイは行っていない。
