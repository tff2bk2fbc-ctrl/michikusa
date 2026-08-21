# リサーチ部：実装状況と次の作業

最終更新: 2026-08-21（Asia/Tokyo）

## 今回完了した項目

- [x] 場所マスターの共通schemaを追加（`research-place.v1`）
- [x] GDELTのニュース量・原因候補用schemaを追加（`research-news-aggregate.v1`）
- [x] Google Trends alphaを受け入れるための相対関心schemaを追加（`research-search-interest.v1`）
- [x] 外部通信なしの合成fixtureを追加
- [x] Google Trends alphaの待機adapterを無効状態で用意
- [x] APIキー、ユーザー識別子、投稿ID、本文、URL、EXIF、正確な座標をschemaで拒否
- [x] `source_id`、`license_version`、生成時刻、期限を必須化
- [x] 期限を最大30日に制限
- [x] 公開前の最小母数を20件にし、少数集計を抑止
- [x] fixture adapterへネットワーク関数を渡しても呼び出さない回帰テストを追加

実装場所:

- `tools/research-trends/index.mjs`
- `tools/research-trends/fixtures/synthetic.json`
- `tools/research-trends/test.mjs`

実行:

```sh
node --test tools/research-trends/test.mjs
```

## まだ実行していない項目

- [ ] Google Trends alphaの承認メールを受領する
- [ ] 承認後に、利用規約・保存・派生集計・アプリ表示の許可範囲を保存する
- [ ] providerごとの法務・セキュリティ再審査を完了する
- [ ] 本番用とは別のcollector Worker／別D1を設計する
- [ ] Cloudflare Secretへ認証情報を登録する（承認前は登録しない）
- [ ] 固定allowlist、quota ledger、Retry-After、circuit breaker、kill switchを実装する
- [ ] ステージングで401/429/5xx、重複課金、TTL削除、ログredactionを検証する
- [ ] 実データを保存する前に、法務・セキュリティ・運用の三者承認を取る
- [ ] 承認後にのみprovider adapter、Cron、D1 migrationを有効化する

## 意図的に行っていないこと

- Google Trends、GDELT、TikTok、SerpApi等へのライブHTTPリクエスト
- APIキーやOAuth secretの取得・保存
- Spota本体のD1/R2への調査データ投入
- TikTokのスクレイピング、非公式APIの接続
- 実在ユーザー、投稿本文、動画ID、画像、EXIF、正確な位置の保存
- Cronや公開routeの有効化

## データの表示ルール

Google Trendsの値は絶対検索回数ではなく、providerが定義した相対関心値として扱います。GDELTはニュース量、Wikimediaはページビューであり、SNS人気や現地混雑とは表示しません。異なる指標を合算するときは、`metric_type`、取得時刻、対象期間、出典、信頼度を併記します。

## Google Trends alphaの状態

申請は送信済みで、現在は「承認された場合に通知する」状態です。承認まではadapterを`source_not_approved`で停止します。承認後も、まずステージングで少量・固定条件の取得を行い、実データ保存や一般公開を先に有効化しません。
