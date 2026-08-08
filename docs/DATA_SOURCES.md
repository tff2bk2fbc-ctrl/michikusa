# 位置・住所関連データの提供元

更新確認日: 2026-08-07

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
- 地域別件数: 北海道5,907、東北11,210、東京11,215、南関東8,817、北関東9,715、中部26,211、近畿19,248、中国・四国12,492、九州・沖縄12,756
- 本番D1投入後の合計DB容量: 969,326,592 bytes。最大は中部259,055,616 bytesで、無料枠500MB未満
- 用途: 周辺記事の軽量索引。D1には記事ID、記事名、整数座標、種別、格子だけを保持し、本文・画像本体は保存しない
- 注意: 日本概略外接矩形に含まれる周辺国などは、N03行政区域面とのpoint-in-polygon判定で除外済み

表示例:

```text
Wikipediaの記事名・位置情報を加工して利用（CC BY-SA 4.0）。各記事の執筆者・履歴・ライセンスは記事リンクから確認できます。
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
- 実装: ブラウザから第三者へ直接送信せず、認証後の`/api/postal-code`で入力検証、応答サイズ制限、24時間キャッシュ、利用者・全体レート制限を行う
- 運用上の注意: 第三者配信とGitHub Pagesの可用性・帯域に依存する。利用増加時はリポジトリをforkし、Cloudflare上で自己ホストする

### 非商用指定の観光・施設・自然地名データ

- 判断: 出典表示をしても非商用条件は解除されないため、取得・利用しない
- 国交省の河川、海岸線、自然公園旧版、鉄道時系列N05など、非商用表示のものは除外する

## 実装前の確認事項

1. 原本をそのまま配信せず、必要な属性と簡略化した形状だけを生成する。
2. アプリ内のライセンス画面に提供者、データ名、URL、加工した旨を表示する。
3. N03は国土地理院への申請要否を、実際の変換・公開方法が決まった段階で確認する。
4. データ更新時は更新日、容量、SHA-256をこの文書へ追記する。
