# Spota Data Atlas MCP App PoC

Spotaの運営者向けに、匿名化されたデータ品質の集計だけを表示するMCP AppのローカルPoCです。Spota本体のWorker、Firebase認証、D1、R2、写真投稿APIには接続しません。

## セキュリティ境界

- 初期データ源は `data/atlas-fixture.json` のサンプル集計だけです。
- `atlas-summary` と `atlas-details` の2つの読み取り専用ツールだけを登録します。
- 写真原本、サムネイル、EXIF、正確な緯度経度、ユーザーID、R2キー、署名URL、通知トークン、秘密情報は扱いません。
- UIから外部URLへ直接通信しません。CSPの `connectDomains`、`resourceDomains`、`frameDomains` は空です。
- HTTPモードはループバック（127.0.0.1）だけで待ち受け、`SPOTA_ATLAS_OPERATOR_TOKEN` が未設定なら起動しません。
- HTTPのOriginは `SPOTA_ATLAS_ALLOWED_ORIGIN` と完全一致した場合だけ許可します。CORSワイルドカードは使いません。
- 本番のOAuth、MFA、RBAC、D1/R2接続は未実装です。このPoCを公開環境へデプロイしないでください。

## 依存関係

依存はすべて完全なバージョンで固定します。初回取得は、必ずライフサイクルスクリプトを無効にしてから行ってください。

```sh
npm ci --ignore-scripts
npm audit --omit=dev
npm run build
npm test
```

`package-lock.json` の変更はセキュリティレビュー対象です。依存更新では、全推移依存のライセンス、integrity、lifecycle script、脆弱性を再確認します。

## ローカル実行

```sh
npm ci --ignore-scripts
npm run build

# MCPホストがstdioを使う場合
npm run start:stdio

# HTTP確認をする場合（別のローカルターミナルで）
export SPOTA_ATLAS_OPERATOR_TOKEN='ローカル専用の長いランダム値'
export SPOTA_ATLAS_ALLOWED_ORIGIN='http://127.0.0.1:8080'
npm start
```

HTTPモードは外部公開を想定していません。実ホストへ接続する前に、ホストごとのOAuth 2.1 PKCE、MFA、scope、監査ログ、CSP、キャッシュ、終了処理の適合試験が必要です。

HTTPクライアントがOriginを送らない場合は、互換性を確認したうえで次のフラグを明示的に設定してください。ブラウザ接続では設定せず、`SPOTA_ATLAS_ALLOWED_ORIGIN` の完全一致を使います。

```sh
export SPOTA_ATLAS_ALLOW_ORIGINLESS_HTTP='1'
```

トークンは32バイト以上の暗号学的乱数を使用してください。短い文字列ではHTTPサーバーは起動しません。
