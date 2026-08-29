# Spota 新機能・外部サービス接続状況レポート（2026-08-27）

## 追補（2026-08-28）

Google Trends alphaはユーザーから承認済みとの連絡を受けたが、専用の限定ドキュメント、endpoint、資格情報がこの作業環境では確認できていないため、接続ゲートは引き続き無効にしている。Wikipedia Action APIは公式仕様に基づくWorker側のステージング接続を追加した。

## 結論

今回の確認では、外部サービスを無条件に本番アプリへ直結せず、データ収集・保管・アプリ配信を分離する方針を維持する。OpenStreetMapを含む地図原本はローカル検証済みで、Google One（Drive）へ非公開バックアップを進めている。住所関連データのDrive保存は完了し、OSMを含む参照データはアップロード継続中である。

アプリから直接使える状態になっているのは、既存のCloudflare Worker/D1/R2、Firebase認証・通知基盤、既存の住所・行政区域・自然地名の索引である。Wikipediaの座標索引はローカル生成とSQL検証まで完了したが、D1本番投入はまだ行っていない。今回取得したOSM PBFや新規のトレンドAPIも、まだアプリの公開経路へ接続していない。

今回、外部APIの誤接続を防ぐ `tools/feature-connectors/` の接続レジストリを追加した。これはネットワークを発生させず、既存経路・バックアップ・オフライン索引・承認待ち・接続禁止をコード上で区別する安全ゲートである。テストは7/7成功し、SerpApiやTikTokなど承認前のサービスが `allowLive=true` を渡されても有効化されないことを確認した。

追加情報として、Wikipediaの公式Action APIを認証済みWorkerの `POST /api/wiki/search` に接続した。検索語はJSON本文で受け取りURLやブラウザ履歴へ残さず、80文字、結果は最大5件、1ユーザー1時間60回・全体1日5,000回に制限し、エッジキャッシュ（10分）を使う。WikimediaのUser-Agent、`maxlag=5`、gzip、429/503のRetry-After、8秒タイムアウト、64KiB応答上限、chunked応答のストリーム中断、リダイレクト拒否を実装している。取得するのは日本語Wikipediaのタイトル、ページID、公開座標、帰属表示用URLだけで、本文・画像・利用者情報・検索語はレスポンスへ含めない。APIは認証後のサーバーからのみ呼び出す。公式APIへ「上野公園」の1回限りの読み取りスモークテストを実行し、3件の結果と先頭座標（35.7133, 139.7764）の抽出に成功した。API境界テストは8/8成功した。Worker設定の`WIKIPEDIA_API_STATE`は既定値`disabled`で、`staging`または`live`をサーバー側で明示するまで外部通信を拒否する。

Workerのdry-runバンドルにも `/api/wiki/search` と固定された `ja.wikipedia.org/w/api.php` が含まれることを確認し、バンドル構文チェックを通過した。セキュリティ部の指摘に対応して、検索語はGETのURLではなくPOST本文で受け、chunked応答は64KiB到達時点で中断する。まだ本番deployは行っていない。

## 接続済み・利用可能

### Spota既存基盤

- Cloudflare Worker、D1、R2: 認証済みアプリAPIの既存経路として運用中
- Firebase Authentication: Appleログインを含む既存認証経路
- Firebase Cloud Messaging/FCM relay: iOSのFCMトークン登録後の通知経路を既存実装
- 住所・行政区域・自然地名: 変換済みの軽量索引をアプリ側から利用する設計
- Wikipedia/Wikivoyage: 座標・記事名・カテゴリ・リダイレクトを使う索引設計。本文・画像本体は取り込まない

### 地図原本の収集・検証

- OpenStreetMap日本全国PBF: `japan-260824.osm.pbf`を取得済み
- サイズ: 2,502,520,532 bytes
- 公式MD5一致: `14d74648e3dee67bb0249c380e97c5cc`
- SHA-256: `55b1f06f3bbdcac08196d9183c91b37dfe8db1dcb944607b90cf90fa10ee9813`
- 形式: OpenStreetMap Protocolbuffer Binary Format（PBF）
- ODbL 1.0の帰属・データベース共有条件を確認し、出典情報を台帳へ追加済み
- 取得原本の合計: 3,991,500,615 bytes（チェックサム管理ファイルとFinderメタデータを除く）

## Google One（Drive）接続・保管状況

### 完了

- `Spota-MapData/raw/2026-08-27/`の保存構成を作成
- Googleアカウントは`kouya.sgechan@gmail.com`
- Drive共有設定は変更せず、自分のみアクセスできる状態を維持
- 住所関連データ106ファイル、約228.7MBのアップロード完了

### 継続中

- `reference-source`へN03、アドレス・ベース・レジストリ、GeoNames、Wikipedia/Wikivoyage、OpenStreetMap等19ファイルをアップロード中
- OSM PBFは2.5GBのため、Drive側の処理に時間がかかる
- ブラウザのアップロードタブは引き継ぎ状態で維持している
- 最終確認時点ではDriveが「8個のアイテムをアップロード中（1個は更新できませんでした）」と表示し、N03は288MB/766MB（38%）まで進行していた。その後、失敗項目の再試行を一度だけ実行し、現在は「9個のアイテムをアップロード中」、N03の表示は同じ38%である。Drive側の「ファイルを読み取れません」は完了後に再試行・チェックサム照合する。重複アップロードは開始していない。

### アプリとの連携方式

DriveをiOS/Androidクライアントへ直接公開しない。Google OAuthトークンをアプリへ配布すると、漏えい時に地図原本全体へアクセスされるためである。採用する経路は次のとおり。

```text
Google One（原本バックアップ）
  → 管理者のみ実行できるサーバー側インポート
  → 必要なタグ・名称・概略座標だけ抽出
  → R2/PMTilesまたは軽量検索索引
  → Cloudflare Worker API
  → Spotaアプリ
```

Google Driveからのインポートを自動化する場合は、OAuth refresh tokenをCloudflare Secret等へ保存し、モバイル・GitHub・D1・ログへ出さない。Driveの原本はアプリの実行時データではなく、再生成用バックアップとして扱う。

## 登録済み・接続待ちのサービス

| サービス | 現状 | アプリ接続 | 次の条件 |
| --- | --- | --- | --- |
| Google Trends API（alpha） | ユーザーから承認済みとの連絡あり。ただし専用endpoint・資格情報・保存条件は未確認 | 未接続 | 招待先の限定ドキュメント、endpoint、資格情報、保存・派生集計・表示条件を確認してからSecretへ設定 |
| SerpApi | 無料アカウントへ登録・ログイン済み | 未接続 | Google Trendsデータの商用保存・派生・表示許諾の確認、APIキーをSecretへ設定、予算上限 |
| X API | 開発者コンソールを開いている。credentials発行状況は未確定 | 未接続 | use case承認、pay-per-use上限、削除同期、規約上の集計制限の確認 |
| YouTube Data API | Google CloudのAPI画面を確認済み。キー発行・アプリ設定は未完了 | 未接続 | APIキーを作成し、HTTPリファラ／API制限、quota、保存期間、表示要件を確定 |
| JAPAN 47 GO | 観光情報データ利用の問い合わせフォームを送信済み | 未接続 | 返信・利用許諾・提供形式・更新頻度・商用再利用条件の確認 |
| DataForSEO | 登録・課金設定は保留 | 未接続 | 商用保存・派生・再表示・DPA・最低入金額を確認してから判断 |
| GDELT Cloud | 画面確認のみ。Spotaへの採用は保留 | 未接続 | ニュース集計を原因候補として使う場合の表示方針と費用を確定 |
| Wikipedia Action API | 認証済みWorkerの `/api/wiki/search` をローカル実装済み | ステージングのみ | 実機検索確認、帰属表示、運用監視を確認してから本番deploy |

## 仕様上の保留・接続しないもの

### TikTokの横断トレンド取得

非公式API、画面スクレイピング、Creative Centerの自動収集はアプリへ接続しない。Research APIは商用ユーザー向けの一般トレンド用途として利用できず、Display APIは同意した本人の動画に限定される。地域投稿数、直近投稿の総いいね数、全体ランキングを推定する接続は、書面許諾がない限り実装しない。

### Google Driveの直接公開

Driveフォルダを「リンクを知っている全員」に設定したり、クライアントへ共有URLを埋め込んだりしない。Driveは原本保管に限定し、アプリ配信はWorker/R2等の認証・レート制限可能な経路で行う。

## 接続時の共通セキュリティ条件

1. APIキー、OAuth code、refresh token、サービスアカウント鍵をGitHub・アプリ・D1・ログへ保存しない。
2. 外部APIはサーバー側からのみ呼び、許可済みホスト・endpoint・fieldをallowlist化する。
3. ユーザーの正確なGPS、EXIF、写真原本、ユーザー名、コメント本文をトレンド収集サービスへ送らない。
4. 取得データは必要最小限の集計値だけを保存し、source、license、取得時刻、TTL、削除方法を記録する。
5. quota、同時実行数、ページ数、応答サイズ、月額費用にハード上限とkill switchを設定する。
6. 実装後は外部通信先、秘密アクセス、認証・認可、429/5xx、削除・期限切れ、ログ秘匿を検証する。
7. セキュリティ部門・法務・必要に応じてSREの承認後にのみcommit、deploy、pushする。

Wikipedia APIの接続では、Wikimedia公式のUser-Agent、直列アクセス、`maxlag`、429時のRetry-After、キャッシュ方針を適用した（[Wikimedia API access policy](https://www.mediawiki.org/wiki/Wikimedia_APIs/Access_policy)、[API etiquette](https://www.mediawiki.org/wiki/API:Etiquette/en)）。

## セキュリティ部門の再レビュー

今回追加した接続レジストリは、外部通信・Secret読み取り・本番設定変更を行わないため、ローカルの準備コードとして承認された。未承認のサービスは、`allowLive=true` と `approved=true` を同時に渡しても、レジストリ上の `connected/live` にならない限り接続不可である。

このレジストリは、将来のcollectorから `assertConnectable()` を呼ぶためのゲートであり、既存・将来のすべてのcollectorへ自動適用されるものではない。collectorを実装する際は、ゲート呼び出し、Secretsのサーバー限定、egress allowlist、quota・TTL・削除、ログ秘匿を個別に検証し、セキュリティ部門の再承認を得る。

## 次の作業

1. DriveのOSMを含む19ファイルのアップロード完了を確認する。
2. Drive上のファイル数、合計容量、OSMのMD5/SHA-256を照合する。
3. OSM PBFから`amenity`、`shop`、`tourism`、`natural`等を抽出し、名称・カテゴリ・概略座標・出典だけの軽量索引を作成する。
4. 軽量索引をR2/PMTilesまたは専用Workerへ配置し、D1へ大量Geometryを投入しない。
5. Google Trends alpha、SerpApi、X、YouTube、JAPAN 47 GOは、各サービスの承認・規約・quota確定後に、別collectorとして段階的に接続する。
6. 接続ごとにstaging検証とセキュリティレビューを行い、結果が通るまで本番pushしない。

## 変更・公開状況

- 本レポートは接続状況を記録するための文書であり、APIキーやOAuthトークンを含まない。
- `tools/feature-connectors/index.mjs` と `tools/feature-connectors/test.mjs` を追加した。レジストリは既存の本番ルートを変更せず、接続準備と誤接続防止だけを担当する。
- OSM原本およびその他の地図原本は`.gitignore`対象で、GitHubへpushしない。
- Wikipedia APIのWorker側接続コード、接続ゲート、テストを追加したが、今回の作業ではCloudflare本番deploy、GitHub push、未承認サービスのAPI接続は行っていない。Google Driveへのバックアップアップロードは、ユーザー承認済みの非公開保存として完了した。

## Wikipedia座標索引（ステップ2）のローカル検証

- 日本概略範囲内の非リダイレクト記事119,873件を抽出し、N03行政区域ポリゴン内の117,571件だけを9地域へ割り当てた。
- 国外・海上・行政区域外の2,302件は除外した。
- 生成SQLは合計15,315,341 bytes。9ファイルを個別の一時SQLiteへ読み込み、構文と行投入を検証済み。
- 生成SQLは`generated/address-db/`に置くが`.gitignore`対象であり、GitHubには含めない。D1本番投入と公開UIからの利用は、ステージングでの認証・帰属表示確認後に行う。
- OSM PBFはチェックサム検証済みだが、現在の環境に固定版PBFパーサーがないため、軽量索引の生成は未実施。原本をそのままD1へ投入しない。
