# リサーチ部：実装状況と次の作業

最終更新: 2026-08-26（Asia/Tokyo）

## Wikipedia Action API（2026-08-29 追加）

- [x] 日本語Wikipediaの公式Action APIを認証済みWorkerの`POST /api/wiki/search`へ接続
- [x] 検索語をPOST本文で受け、80文字・最大5件・512 bytes本文に制限
- [x] 1ユーザー1時間60回、全体1日5,000回、10分キャッシュ、8秒タイムアウト、64KiB応答上限
- [x] `User-Agent`、`Api-User-Agent`、`maxlag=5`、429/503の`Retry-After`、リダイレクト拒否を設定
- [x] タイトル・ページID・4桁小数へ丸めた公開座標・記事URL・帰属情報だけを返し、本文・画像・利用者情報は取得しない
- [x] `WIKIPEDIA_API_STATE`をサーバー側ゲートとして追加（既定`disabled`、`staging`/`live`のみ許可）
- [x] 公式APIのモック境界テスト8/8、Worker関連回帰テスト30/30、全回帰テスト113/113
- [ ] 本番有効化前に、Cloudflare stagingで認証済み200・未認証401・GET405・429・ログ秘匿・UI帰属表示を実機確認

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
- [ ] SerpApiを無料枠のままステージング接続し、検索関心・急上昇検索の精度を検証する
- [ ] SerpApiのAPIキーをCloudflare Secretへ登録する（キーの値はチャット・GitHub・モバイルへ出さない）
- [ ] SerpApiの月250検索枠を超えない日次quota、キャッシュ、kill switchを設定する
- [x] YouTube APIキー（`spota-youtube-server`）をCloudflare Secretへ登録する（値はチャット・GitHub・モバイル・D1/R2・ログへ出さない）
- [ ] YouTube APIキーをWorkerコードから参照する前に、quota・allowlist・cache・kill switch・ログredactionを実装する
- [ ] YouTube Data APIのquota、表示要件、削除・認可撤回の反映条件を確認し、承認後に別collectorで最小限の検証を行う

## 意図的に行っていないこと

- Google Trends、GDELT、TikTok、SerpApi等へのライブHTTPリクエスト
- APIキーやOAuth secretの取得・保存
- SerpApiへのライブHTTPリクエスト、APIキーのSpota本体への設定
- Spota本体のD1/R2への調査データ投入
- TikTokのスクレイピング、非公式APIの接続
- 実在ユーザー、投稿本文、動画ID、画像、EXIF、正確な位置の保存
- YouTube APIへのライブHTTPリクエスト、APIキーのSpota本体への設定
- Cronや公開routeの有効化

## データの表示ルール

Google Trendsの値は絶対検索回数ではなく、providerが定義した相対関心値として扱います。GDELTはニュース量、Wikimediaはページビューであり、SNS人気や現地混雑とは表示しません。異なる指標を合算するときは、`metric_type`、取得時刻、対象期間、出典、信頼度を併記します。

## SerpApiの保留状態

SerpApiのFreeプラン登録は完了しています。ダッシュボード上の無料枠は月250検索、現在の使用量は0件です。APIキーは発行済みですが、値はリポジトリ・モバイル・D1・R2・ログへ保存せず、Spotaにも未接続です。今後、無料枠で精度を確認する必要が生じた場合のみ、Cloudflare Secretへ登録し、固定キーワード・固定地域・短い期間のステージング取得を行います。

取得候補は次の2系統に分けます。

- `google_trends_trending_now`: 「今、何が流行っているか」の候補発見
- `google_trends`: 指定した場所やキーワードの時系列・地域別の相対検索関心の検証

いずれも絶対的な検索人数や観光客数ではありません。利用開始前に、保存・派生集計・アプリ内再表示の条件を法務・セキュリティで再確認します。

## Google Trends alphaの状態

申請は送信済みで、現在は「承認された場合に通知する」状態です。承認まではadapterを`source_not_approved`で停止します。承認後も、まずステージングで少量・固定条件の取得を行い、実データ保存や一般公開を先に有効化しません。
