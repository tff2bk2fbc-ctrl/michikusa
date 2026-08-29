# 位置・住所関連データの提供元

更新確認日: 2026-08-29

原本ファイルは容量と再配布条件のため `data/reference-source/` に保存し、GitHubには追加しない。
この文書には、取得元とライセンス判断を再現できる情報だけを残す。

## 取得済み・利用候補

### 国土交通省 国土数値情報「行政区域（N03）」

- 提供者: 国土交通省
- 公式ページ: https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html
- 取得元: https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-2026/N03-20260101_GML.zip
- データ基準日: 2026-01-01
- 用途: 緯度経度が属する市区町村を面で判定し、境界付近や地方部での最近傍点の誤判定を減らす
- 形式: GML / Shape / GeoJSONを含むZIP
- ライセンス: CC BY 4.0
- 注意: 国土地理院の測量成果を原典に含む。加工物の公開・複製方法によって、測量法上の申請要否を確認する
- 保存先: `data/reference-source/mlit-n03/N03-20260101_GML.zip`
- 容量: 803,201,348 bytes
- SHA-256: `1f714fca019e22e6f84012dba420384fc7b49c6ad8bd0a867ab1cfb593a78477`
- ZIP検査: 合格

表示例:

```text
「国土数値情報（行政区域データ）」（国土交通省）を加工して作成
```

### デジタル庁「全国 町字マスター」

- 提供者: デジタル庁
- 公式案内: https://www.digital.go.jp/policies/base_registry_address
- 配布ページ: https://dataset.address-br.digital.go.jp/documents/b80e77a0e2d24e5692be4af885eb3de7/about
- 取得元: https://data.address-br.digital.go.jp/mt_town/mt_town_all.csv.zip
- 最終更新: 2026-07-31 06:30 UTC
- 用途: 町字ID、正式名称、廃止・変更情報の正規化
- 形式: UTF-8 CSV ZIP
- ライセンス: CC BY 4.0（デジタル庁アドレス・ベース・レジストリ利用規約も適用）
- 利用規約: https://www.digital.go.jp/policies/base_registry_address_tos
- 保存先: `data/reference-source/digital-agency-abr/mt_town_all.csv.zip`
- 容量: 11,548,462 bytes
- SHA-256: `c1c1428a08a9b5511080dd5a51870dce8598077f53a9c6cd0fd0a6921d80f75e`
- ZIP検査: 合格
- 結合結果: 既存住所DBの195,130町字に正式名称・町字ID・提供されている郵便番号を関連付け

表示例:

```text
「アドレス・ベース・レジストリ」（デジタル庁）を加工して作成（CC BY 4.0）
```

## すでに保有している利用候補

### 国土交通省 国土数値情報「鉄道（N02）」

- 提供者: 国土交通省
- 手元のファイル: `data/address-source/k8.zip`
- 内容: `N02-25_GML`（2025年版）
- 用途候補: 駅名・路線名による写真の場所表示補助
- ライセンス: 2020年版以降はCC BY 4.0。使用中の2025年版も対象
- 状態: 9,046駅を変換済み。路線名と最寄り駅表示に使用する
- 公式ページ: https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html

### GeoNames 日本データ

- 提供者: GeoNames / Unxos GmbH
- 公式配布: https://download.geonames.org/export/dump/
- 利用条件: https://www.geonames.org/export/
- ライセンス: CC BY 4.0、商用利用可
- 保存先: `data/reference-source/geonames/JP.zip`
- 容量: 4,957,252 bytes
- SHA-256: `8830e6197a8228c8bfcb698f516a39a2e7aa9c8a76c2ecf07903546d4de142c6`
- ZIP検査: 合格
- 取込: 自然地名22,512件、日本語名を確認できた施設名2,371件
- 用途: 山・湖・川・島・公園などの補助表示。位置や最新性を保証せず、住所より優先しない

表示例:

```text
地名データ © GeoNames, CC BY 4.0
```

### 日本語版Wikipedia 座標・記事名ダンプ

- 提供者: Wikimedia Foundation / 日本語版Wikipediaの各執筆者
- 公式配布: https://dumps.wikimedia.org/jawiki/latest/
- データ日付: 2026-08-01（2026-08-04生成、2026-08-05チェックサム公開）
- 取得ファイル: `jawiki-latest-geo_tags.sql.gz`、`jawiki-latest-page.sql.gz`
- 保存先: `data/reference-source/wikimedia/`（Git管理対象外）
- 容量: 6,086,941 bytes、169,125,785 bytes
- SHA-1: `1444acec45c1ea1aad8fd474e8e318ad48e7fc8b`、`32ed235f4e50a080a30cba69166827e8046b6ff0`
- 公式SHA-1照合・gzip整合性検査: 合格
- ライセンス: 記事名・記事リンク・記事由来テキストを再利用する場合はCC BY-SA 4.0等の適用条件に従う。画像はファイルごとにライセンスが異なるため、今回のダンプから画像本体を取り込まない
- 解析結果: 全座標314,386件、earthの主座標168,305件、日本概略範囲内121,632ページ、通常名前空間の非リダイレクト記事119,873件
- N03行政区域内へ確定した取込件数: 117,571件。国外・海上・行政区域外2,302件は除外
- ローカル生成SQL: 9地域、合計15,315,341 bytes。各ファイルを一時SQLiteへ読み込み、構文・行投入を検証済み
- 地域別件数: 北海道5,907、東北11,210、東京11,215、南関東8,817、北関東9,715、中部26,211、近畿19,248、中国・四国12,492、九州・沖縄12,756
- 本番D1: 2026-08-29に9地域の`wikipedia_places`を読み取り確認し、地域別件数と合計117,571件が生成結果と完全一致。合計DB容量969,326,592 bytes、最大は中部259,055,616 bytes
- 地図接続: 公開オープンデータ専用`POST /api/map/places`を実装し、本番D1を使うremote previewでWikipedia・N02駅・GeoNamesの範囲検索を確認。本番Workerへのdeployは未実施
- 用途: 周辺記事の軽量索引。D1には記事ID、記事名、整数座標、種別、格子だけを保持し、本文・画像本体は保存しない
- 注意: 日本概略外接矩形に含まれる周辺国などは、N03行政区域面とのpoint-in-polygon判定で除外済み

### 日本語版Wikipedia 分類・別名・Wikidata対応ダンプ（今回追加）

- 取得基準日: 2026-08-01（ダンプの基準日。`latest`から取得し、公式SHA-1で内容を固定。次回更新時は新しい日付とハッシュを別版として保存する）
- 公式配布: https://dumps.wikimedia.org/jawiki/latest/
- 用途: 座標付き記事を観光地・景勝地・店舗・施設などのカテゴリで分類し、リダイレクトを正規タイトルへ統合する。`page_props`の`wikibase_item`は将来のWikidata（CC0構造化データ）との対応に使う
- 保存先: `data/reference-source/wikimedia/`（Git管理対象外）
- 取得ファイルと検査結果:
  - `jawiki-latest-category.sql.gz`: 4,617,838 bytes、SHA-1 `8789a6de6df2d8020caf12164641027075750303`、SHA-256 `579c000c3e114f8fa1e4d81bbecb5a32dbebff7e4e4238c3a22f06947ee890b8`
  - `jawiki-latest-categorylinks.sql.gz`: 175,320,273 bytes、SHA-1 `cdb76797e3e23c65a2a3b35bfd0ef9cacadfe169`、SHA-256 `d05fd9c135254ba02ee6ea6d19a9ef453a6a8a72e1787fc5c08e6a3224bf59d1`
  - `jawiki-latest-redirect.sql.gz`: 13,986,329 bytes、SHA-1 `c8b21875f059df38c7309931b3ff29a95e140f3e`、SHA-256 `eb2f93c8e31ea587de968813e60ee754a66d68e1830ad2d7e62fd122602fe39c`
  - `jawiki-20260801-page_props.sql.gz`: 59,626,394 bytes、SHA-1 `a7a121c88267d43a776f8536c24d392434e925b4`、SHA-256 `9001c07fa2663a25e7ae07711f7e7f6cd6fe92bf11a2f2a8dd71afbb12fb92eb`
- 公式SHA-1照合・gzip整合性検査: 4ファイルすべて合格
- 追加分の圧縮容量: 253,550,834 bytes（約241.8 MiB）。既存の座標・記事名ダンプを再取得していないため重複ダウンロードなし
- ライセンス: カテゴリ・記事名・リダイレクト・プロパティはWikipediaのデータ利用条件（CC BY-SA 4.0等）に従う。`page_props`から参照するWikidata構造化データ自体はCC0だが、Wikidataを別途取得・表示する場合は同データの利用条件と出典を確認する。画像・本文はこの収集では保存しない
- 個人情報・不要な本文: 利用者名、編集履歴、記事本文、画像本体は地図インデックスへ取り込まない

### 日本語版Wikivoyage 観光記事索引

- 提供者: Wikimedia Foundation / 日本語版Wikivoyageの各執筆者
- 公式配布: https://dumps.wikimedia.org/jawikivoyage/latest/
- ダンプ基準日: 2026-08-01
- 保存先: `data/reference-source/wikivoyage/`（Git管理対象外）
- 取得ファイル: `category.sql.gz`（12,988 bytes）、`categorylinks.sql.gz`（196,749 bytes）、`geo_tags.sql.gz`（18,115 bytes）、`page.sql.gz`（217,018 bytes）、`page_props.sql.gz`（189,281 bytes）、`redirect.sql.gz`（11,514 bytes）、`jawikivoyage-20260801-sha1sums.txt`（3,238 bytes）
- 圧縮容量: 648,903 bytes。各ダンプは公式SHA-1一覧と照合し、gzip検査に合格
- 用途: 観光ルート・地域記事の候補名、カテゴリ、座標、別名をWikipedia記事とは別の観光文脈で補完する。本文・画像・編集者情報は保存しない
- ライセンス: Wikivoyage記事由来のデータはWikimediaの利用条件（原則CC BY-SA等）に従い、アプリ内に提供元・ダンプ日・記事リンクを表示する。画像は個別ライセンスが異なるため取得しない

表示例:

```text
Wikipediaの記事名・位置情報を加工して利用（CC BY-SA 4.0）。各記事の執筆者・履歴・ライセンスは記事リンクから確認できます。
```

### OpenStreetMap日本（Geofabrik抽出）

- 提供者: OpenStreetMap contributors。Geofabrikが日本範囲を抽出・配布
- 公式配布ページ: https://download.geofabrik.de/asia/japan.html
- ファイル: `japan-260824.osm.pbf`
- 取得日: 2026-08-27（Geofabrik更新日時: 2026-08-25 03:36:57 GMT）
- 保存先: `data/reference-source/openstreetmap/`（Git管理対象外）
- 容量: 2,502,520,532 bytes
- MD5: `14d74648e3dee67bb0249c380e97c5cc`
- SHA-256: `55b1f06f3bbdcac08196d9183c91b37dfe8db1dcb944607b90cf90fa10ee9813`
- 形式検査: OpenStreetMap Protocolbuffer Binary Format（PBF）として合格。公式MD5とファイルサイズを照合済み
- 用途: `amenity`（店舗・飲食店等）、`shop`、`tourism`、`natural`などのタグから、地図上の観光・店舗・景観候補を抽出する原本。現時点ではローカル原本のみ検証済みで、Driveの最終保存完了は未照合、R2・D1・アプリには未接続。必要属性だけの軽量索引をオフライン生成してから配信する
- ライセンス: Open Database License (ODbL) 1.0。派生データの公開時はOpenStreetMapへの帰属、変更の明示、ODbLのデータベース共有条件を確認する。原本に含まれるタグ・Geometryを第三者データと混同せず、各索引行へ出典を保持する

表示例:

```text
© OpenStreetMap contributors（データ提供: Geofabrik、ODbL 1.0）。加工して作成。
```

## 今回取得しないもの

### 日本郵便 郵便番号データ / jp-postal-code-api

- 原データ提供者: 日本郵便株式会社
- 原データ公式ページ: https://www.post.japanpost.jp/service/search/zipcode/download/
- API実装・配信: https://github.com/ttskch/jp-postal-code-api
- エンドポイント: `https://jp-postal-code-api.ttskch.com/api/v1/{郵便番号}.json`
- API実装ライセンス: MIT
- 原データ条件: 日本郵便は郵便番号データについて著作権を主張せず、自由な配布を認めている
- 更新: GitHub Actionsにより原則毎日更新
- みちくさでの用途: 郵便番号から住所候補を取得する補助検索。逆ジオコーディング精度の基礎データには使用しない
- 実装: ブラウザから第三者へ直接送信せず、認証後の`POST /api/postal-code`で入力検証、応答サイズ制限、24時間キャッシュ、利用者・全体レート制限を行う
- プライバシー: 郵便番号をURL・クエリ文字列へ含めず、256バイト以下のJSON本文で受け取る。上流にはFirebaseトークン、ユーザーID、IP、写真、GPSを転送しない
- 防御設定: キャッシュ確認前にCloudflare Rate Limiting bindingでユーザー毎分30回・全体毎分1,000回を制限し、D1で毎時・毎日上限も検査。上流5秒タイムアウト、外部文字列の危険文字除去も実施
- 運用上の注意: 第三者配信とGitHub Pagesの可用性・帯域に依存する。利用増加時はリポジトリをforkし、Cloudflare上で自己ホストする

### 非商用指定の観光・施設・自然地名データ

- 判断: 出典表示をしても非商用条件は解除されないため、取得・利用しない
- 国交省の河川、海岸線、自然公園旧版、鉄道時系列N05など、非商用表示のものは除外する

## 実装前の確認事項

1. 原本をそのまま配信せず、必要な属性と簡略化した形状だけを生成する。
2. アプリ内のライセンス画面に提供者、データ名、URL、加工した旨を表示する。
3. N03は国土地理院への申請要否を、実際の変換・公開方法が決まった段階で確認する。
4. データ更新時は更新日、容量、SHA-256をこの文書へ追記する。
