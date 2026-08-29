# Feature connector registry

`index.mjs` は、Spotaの新しい外部機能を接続する前の安全ゲートです。既定ではネットワークを発生させず、サービスごとの状態、データ種別、接続モードを一か所で管理します。

## 現在の扱い

- `connected/live`: 既存のCloudflare APIやFirebase/FCMなど、すでにアプリの認証済み経路で運用しているもの。
- `connected/backup-only`: Google Drive。原本バックアップとしてのみ使い、モバイルへDrive権限を渡さない。
- `staged/offline`: OSM、Wikidata/Wikimedia。ダウンロード済み原本からサーバー側で軽量索引を作る段階。
- `staged/live`: Japanese Wikipedia Action API。認証済みWorkerのPOST検索へ接続済みで、実機確認と本番deploy前のレビューを残している。
- `pending-*` / `deferred`: Google Trends、SerpApi、X、YouTube、JAPAN 47 GO、DataForSEO、GDELT。許諾・資格情報・quota・費用条件が確定するまで外部通信を開始しない。
- `blocked/disabled`: TikTokの横断トレンド。非公式APIやスクレイピングは行わない。

## 接続を有効化する条件

外部サービスを有効化する前に、サービスの書面許諾、保存・派生・表示条件、quota・費用上限、削除同期、egress allowlist、Secrets設定、法務・セキュリティレビューを完了してください。`canConnect()` の `allowLive` と `approved` はサーバー側でのみ与え、クライアントのUIフラグから渡さないでください。

このレジストリは接続準備と誤接続防止を目的とし、APIキーを保管せず、外部APIを呼び出しません。
