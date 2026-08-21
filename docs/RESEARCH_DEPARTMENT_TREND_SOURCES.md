# リサーチ部：直近検索需要・場所トレンド調査

## 目的

「直近で検索が増えた語」と「場所・地域ごとの関心」を、できるだけ短い時間で広く把握するための調査台帳です。
この文書は調査・比較用であり、外部APIへの接続、スクレイピング、実データの保存、Spota本体への機能追加を行うものではありません。

調査結果をSpotaへ組み込む場合は、取得元ごとに利用規約・ライセンス・保持期間・再表示権限を確認し、法務部門とセキュリティ部門の承認を通します。

## 先に結論

| 優先度 | 候補 | 取得できるもの | 場所の粒度 | 速度 | 現時点の判断 |
| --- | --- | --- | --- | --- | --- |
| P0 | Google Trends API（Alpha） | Google検索トレンド、期間別・地域別の相対関心 | 国・地域・サブ地域 | 高（API承認後） | 最有力。ただし限定テスター申請が必要 |
| P0 | DataForSEO Trends API | Google Search/News/Shoppingのキーワード人気、地域比較 | 国・サブ地域 | 高（Live API） | 有料だが実装しやすい。検索需要の基準値にする |
| P0 | X API Trends | 地域別の現在の話題、トレンド順位 | Xの対応地域 | 高 | 検索数ではなく会話トレンド。原因補助に使う |
| P1 | GDELT DOC 2.0 | ニュース量、急増時点、関連記事、話題の場所 | 国・記事由来の地域 | 非常に高（15分単位） | トレンド原因の検証に有効 |
| P1 | Wikimedia Pageviews API | Wikipedia記事の閲覧数、場所名への関心 | 記事単位。国別集計は別API | 高 | 観光地名の長期・短期関心の補助指標 |
| P1 | JNTO観光統計 | 都道府県訪問率、宿泊者数、訪日客推移 | 都道府県・地域 | 月次・年次 | 商用表示前に利用申請・出典確認 |
| P1 | Creative Center手動調査 | TikTokのハッシュタグ・関連動画・地域人気 | TikTok画面の地域フィルタ | 即時（手動） | 自動取得はしない。精度基準作成に利用 |
| P2 | YouTube Data API | キーワード検索、公開日時、再生・いいね等 | 検索結果の国・言語 | 高 | TikTokの代替ではなく横断比較 |
| P2 | TikTok Business Discovery | 人気ハッシュタグ、トレンド検索語、関連動画 | 国・カテゴリ・期間 | 承認後 | ユーザー指定どおり保留 |
| P3 | TikTok Research API | 承認済み研究向けの公開動画・統計 | 投稿者登録国等 | 遅延あり | 商用・一般トレンド用途では使わない |

## 取得対象の定義

### A. 「検索が多い」の意味を分ける

同じ「検索が多い」でも、実際には別の指標です。

1. 検索クエリの人気：Google Trends等の相対検索関心
2. 現在の話題量：X/GDELT等で急増している話題
3. 投稿量：TikTokやYouTube等で取得できた投稿のサンプル数
4. プラットフォーム内検索回数：非公開であることが多く、公開APIからは取得できない

レポートでは、これらを混ぜずに `metric_type` と `source` を必ず保存します。

### B. 「場所」の意味を分ける

- 検索者の地域
- 投稿者の登録地域
- コンテンツの作者が示した地域
- 記事や投稿に出現する地名
- 実際の撮影地点

公開APIの地域フィルタや作者地域を撮影地点として表示しません。撮影地点が明示されていない場合は、`location_type=mentioned_place` または `location_type=audience_region` と表示します。

## 候補の詳細

### 1. Google Trends API（Alpha）

Google公式が2025年に発表した限定テスター向けAPIです。直近5年のデータ、日・週・月・年の集計、国・サブ地域比較を提供する設計です。

- 長所：検索需要そのものに最も近い
- 長所：地域比較と時系列ができる
- 制約：Alphaで参加者が限定されている
- 制約：絶対検索回数ではなく、原則として相対的な関心指標
- 制約：承認前にアプリへ組み込まない

公式資料：

- https://developers.google.com/search/blog/2025/07/trends-api
- https://developers.google.com/search/apis/trends

### 2. DataForSEO Trends API

Google Search、Google News、Google Shoppingのキーワード人気を、期間・地域・複数語で取得できます。Explore、Subregion Interests、Demography、Merged Dataのエンドポイントがあります。Live方式で、料金は従量課金です。

- 長所：API仕様・認証・課金が明確
- 長所：地域比較を自動化しやすい
- 長所：最大5語の比較が可能
- 制約：TikTokの検索・投稿データではない
- 制約：API費用と利用規約を確認する必要がある

公式資料：

- https://docs.dataforseo.com/v3/dataforseo_trends-overview/
- https://docs.dataforseo.com/v3/keywords_data-dataforseo_trends-explore-live/

### 3. X API Trends

X公式APIには、地域別トレンドとパーソナライズドトレンドがあります。X APIは従量課金プランで提供され、`/2/trends/by/woeid/:id` またはユーザー向けの `/2/users/personalized_trends` が文書化されています。

- 長所：現在の話題を短い間隔で把握できる
- 長所：地域ごとの話題比較ができる
- 制約：検索需要ではなく、X上の話題トレンド
- 制約：Xアカウント・プラン・OAuthが必要
- 制約：トレンド順位をTikTokの人気順位として扱えない

公式資料：

- https://docs.x.com/x-api/overview
- https://docs.x.com/x-api/trends/personalized-trends/introduction
- https://docs.x.com/x-api/fundamentals/rate-limits

### 4. GDELT DOC 2.0

ニュース記事を対象に、話題量の急増・関連記事・時系列を取得できます。72時間未満の期間では15分単位のタイムラインを利用できます。ニュースの急増時点と関連記事を、トレンド原因の候補として扱います。

- 長所：短時間の急増検知に強い
- 長所：急増時に何の記事が寄与したか追える
- 長所：場所や国を含むニュース分析に向く
- 制約：TikTokや検索エンジンのデータではない
- 制約：ニュース報道量をトレンド原因の証拠と断定しない

公式資料：

- https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
- https://gdeltcloud.com/api-docs

### 5. Wikimedia Pageviews API

Wikipedia記事のページビューを日次・月次などで取得できます。観光地・駅・祭り・施設の記事名の関心変化を、検索トレンドの補助指標にできます。

- 長所：公開APIで利用しやすい
- 長所：日本語Wikipediaを対象にできる
- 長所：長期比較と急増検知に使える
- 制約：Wikipediaを見た数であり、検索回数ではない
- 制約：記事がない場所は測れない
- 制約：記事の存在・編集状況にバイアスがある

公式資料：

- https://wikimedia.org/api/rest_v1/
- https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/reference/page-views.html

### 6. JNTO観光統計

訪日外客数、都道府県別訪問率、地域別宿泊者数などを提供します。検索やSNSの代替ではありませんが、観光需要の現実値と照合できます。

- 長所：公的な観光統計
- 長所：地域比較の基準値になる
- 制約：月次・年次で、リアルタイムではない
- 制約：ダウンロード時に利用申請が必要なデータがある
- 制約：アプリ再配布時は出典・利用条件を確認する

公式資料：

- https://statistics.jnto.go.jp/
- https://statistics.jnto.go.jp/en/graph/
- https://www.jnto.go.jp/statistics/data/visitors-statistics/

### 7. YouTube Data API

公式APIの `search.list` でキーワード、公開日時、言語、`regionCode` を指定して動画を検索できます。動画単位の再生数・いいね等は別の `videos.list` で取得します。

- 長所：公式APIで実装しやすい
- 長所：公開日時や動画統計を扱える
- 制約：検索結果はYouTubeの関連度であり、検索回数ではない
- 制約：`regionCode` は視聴可能地域であり撮影場所ではない
- 制約：YouTubeをTikTokの代替値として表示しない

公式資料：

- https://developers.google.com/youtube/v3/docs/search/list
- https://developers.google.com/youtube/v3/docs

### 8. TikTok Creative Center（手動）

TikTok公式のCreative Centerでは、ハッシュタグのトレンド、関連動画、地域人気、期間フィルタなどを手動で確認できます。

- 長所：TikTok上のトレンドを直接確認できる
- 長所：調査の正解基準として使える
- 制約：公開された安定APIとしては確認できない
- 制約：自動ブラウザ操作・内部API呼び出し・スクレイピングはしない

公式資料：

- https://ads.tiktok.com/resources/help/article/how-to-use-trends?lang=en
- https://ads.tiktok.com/help/article/creative-center?lang=en

## GitHub候補

### 採用候補（コードを取り込まず、参照のみ）

- [Google Trends API Alpha公式資料](https://developers.google.com/search/apis/trends)
- [DataForSEO公式ドキュメント](https://docs.dataforseo.com/v3/dataforseo_trends-overview/)
- [GDELT DOC API公式資料](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/)
- [Wikimedia Analytics API](https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/documentation/getting-started.html)
- [YouTube公式API仕様](https://developers.google.com/youtube/v3/docs/search/list)
- [X公式API仕様](https://docs.x.com/x-api/overview)
- [日本イベント公開データの例：event-japan](https://github.com/code4fukui/event-japan)

### 参照のみ（本番接続しない）

- [pytrends](https://github.com/GeneralMills/pytrends)：Google Trends非公式ラッパー。2025年4月にアーカイブ済みで、仕様変更・429・保守停止のリスクがある
- [pytrends-modern](https://github.com/yiromo/pytrends-modern)：非公式・ブラウザ依存。Googleの規約とアクセス制限を別途確認する

非公式ライブラリは、リサーチ部の比較資料として参照するだけにし、Spotaの本番コードへ追加しません。

## 推奨する高速リサーチ構成

```text
Google Trends API Alpha / DataForSEO
    ├─ 検索需要・地域別関心
X API Trends
    ├─ 現在の話題・地域差
GDELT DOC
    ├─ ニュース急増・原因候補
Wikimedia Pageviews
    ├─ 場所名・観光地名の関心補助
JNTO / MLIT / event-japan
    ├─ 公的観光需要・開催イベント
Creative Center手動確認
    └─ TikTokトレンドの検証用基準値
```

### 統合指標

各ソースを混同しないため、次の集計値を別々に保存します。

```text
source_id
metric_type
keyword_or_place
coarse_region
time_bucket
rank_or_score
sample_size
freshness_seconds
license_version
confidence
expires_at
```

「場所が流行している」と判断する場合は、最低2つ以上の独立ソースが一致した時だけ候補として表示します。例えば、Google検索関心の急増だけでは断定せず、GDELTニュース量、Wikimediaページビュー、イベント情報のいずれかを組み合わせます。

## リサーチ部の速度制約

最速化は、無制限にリクエストを増やすことではなく、取得回数を減らして再利用することで達成します。

- 取得はCron/Queueのバッチに限定
- 同じ条件はTTLキャッシュを再利用
- 1回のリクエストで最大比較数までまとめる
- 地域・期間・カテゴリはサーバー側のallowlist
- ページ数・期間幅・同時実行数を制限
- 429/5xxは指数バックオフ、再試行回数を固定
- 取得結果は粗粒度の集計だけを保存
- APIごとに日次・月次の費用上限を設定
- 絶対検索数と相対人気を別フィールドにする
- 取得日時とデータ遅延を必ず表示

## セキュリティ・法務ゲート

次のいずれかを満たさない候補は、本番接続しません。

1. 公式APIであり、対象データと利用目的が規約上許可されている
2. 正規データ提供者から、保存・派生集計・アプリ表示の許諾を書面で得ている
3. 個人識別子、原文、動画ID、正確な位置を集計DBへ保存しない
4. Secretをクライアント、Git、ログ、平文Worker変数へ置かない
5. APIごとの利用量、費用、削除、失効、再試行を監査できる
6. 取得データをTikTokの検索数・撮影地点・全投稿数と誤表示しない

このブランチでは、上記のゲートを満たすまで外部fetch、SDK導入、Secret設定、Cron有効化、D1/R2投入を行いません。

## ブランチの状態

- ブランチ：`research/trend-source-scan`
- 変更内容：調査台帳のみ
- 外部通信コード：追加なし
- APIキー・Secret：追加なし
- 実データ：追加なし
- Spota本体への結合：なし
- セキュリティ審査：候補台帳段階。実装前に再審査が必要

## 候補別の事前審査結果（2026-08-21）

セキュリティ部のレビューにより、現時点で許可される範囲は合成fixture、no-networkのアダプター設計、取得元・ライセンス台帳の作成までとする。APIキー発行、ライブリクエスト、実データのD1/R2保存、Cron有効化は、提供元の規約と保存・派生集計・再表示の許諾を確認するまで停止する。

| 候補 | 判定 | 採用できる範囲 | 主な注意 |
|---|---|---|---|
| 公式 Google Trends API alpha | 条件付き許可 | 相対検索関心、期間・地域比較 | 限定alpha。絶対検索数ではない。承認・商用保存条件を確認する |
| DataForSEO Trends | 条件付き許可 | 検索・ニュース等の相対指標 | 契約、DPA、二次表示権、最低入金、重複課金対策が必要 |
| GDELT | 集計限定で許可 | ニュース言及量、地域、テーマ、tone | 本文・画像・長文snippetは保存・再表示しない |
| Wikidata／Wikimedia Pageviews | 条件付き許可 | 地名マスター、観光地候補、閲覧数の補助指標 | WikidataはCC0。本文・画像は別ライセンス。bot方針と出典を守る |
| 観光庁・国・自治体オープンデータ | データ単位で許可 | POI、統計、GIS、観光地マスター | PDL1.0対象外、第三者写真、ロゴ、別規約データを除外 |
| X／YouTube／Reddit | 現用途は停止 | プラットフォーム単独の表示を個別再審査 | 横断いいね・投稿数・原因スコアは作らない |
| SerpApi／pytrends／非公式TikTok取得 | 本番不採用 | なし | スクレイピング・内部API依存・規約または安定性の問題 |

### ライブ接続の解除条件

1. 商用利用、キャッシュ、派生集計、アプリ表示、再配布、地域、保存期限、削除義務を文書で確認する。
2. 本体とは別のCollector Worker／D1に分離し、写真R2・ユーザーDBへのbindingを与えない。
3. Secret、egress allowlist、固定バッチ、費用上限、429/5xx再試行、kill switch、削除・refreshを実装する。
4. 正確GPS、EXIF、ユーザーID、投稿本文、動画IDを送信・保存せず、粗粒度の集計値だけを保存する。
5. no-network fixture、secret scan、SSRF、重複課金、ログredaction、削除処理を検証し、法務・セキュリティの再承認を受ける。
