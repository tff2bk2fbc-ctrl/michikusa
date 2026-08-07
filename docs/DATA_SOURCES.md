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

## 今回取得しないもの

### 日本郵便 郵便番号CSV

- 提供者: 日本郵便株式会社
- 公式ページ: https://www.post.japanpost.jp/service/search/zipcode/download/
- 判断: ダウンロードは可能だが、サイト規約は事前承諾なしの複製・改変・公開・再利用を制限している。
  商用アプリのデータベースへ組み込む許諾が明確になるまで取得・利用しない
- 代替: デジタル庁の「町字・郵便番号変換表」の正式性・更新状況を確認してから検討する

### 非商用指定の観光・施設・自然地名データ

- 判断: 出典表示をしても非商用条件は解除されないため、取得・利用しない
- 国交省の河川、海岸線、自然公園旧版、鉄道時系列N05など、非商用表示のものは除外する

## 実装前の確認事項

1. 原本をそのまま配信せず、必要な属性と簡略化した形状だけを生成する。
2. アプリ内のライセンス画面に提供者、データ名、URL、加工した旨を表示する。
3. N03は国土地理院への申請要否を、実際の変換・公開方法が決まった段階で確認する。
4. データ更新時は更新日、容量、SHA-256をこの文書へ追記する。
