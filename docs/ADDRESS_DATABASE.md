# 住所データベース構築

国土交通省「位置参照情報」のCSVまたは配布ZIPから、Cloudflare D1へ投入できる地域別SQLを生成する。

## データを置く場所

自分でダウンロードしたZIPは展開せず、次へ置く。

```text
data/address-source/
```

このディレクトリと生成物は `.gitignore` 対象であり、GitHubへpushされない。

### 自動ダウンロード

今回必要なのは、国土交通省「位置参照情報」の最新版2種類である。

- 大字・町丁目レベル（全国）
- 街区レベル（都市計画区域相当）

通常の「国土数値情報」にある道路・施設・行政区域ポリゴンは初期版には不要。

自動取得は、国土交通省の[利用規約](https://nlftp.mlit.go.jp/ksj/other/agreement.html)と
ダウンロード画面に表示される位置参照情報利用約款を確認し、同意する場合だけ実行する。

```bash
npm run address:download -- --accept-mlit-terms
```

スクリプトは各都道府県の最新版を公式フォームから確認し、サーバーに負荷をかけないよう
間隔を空けて `data/address-source/` へ保存する。規約同意フラグがない場合は一切ダウンロードしない。

## 変換

```bash
npm run address:build
npm run boundary:build
npm run address:enrich
npm run places:build
```

結果は `generated/address-db/` に出力される。

- `manifest.json`: 地域別の件数とSQL容量
- `hokkaido.sql` など: D1投入用SQL

処理内容:

1. ZIPを一時ディレクトリへ展開する。
2. Shift-JIS CSVをストリーム処理する。
3. 削除行と非代表点を除外する。
4. 県・市区町村・町字を別表にして文字列の重複を除く。
5. 緯度経度を100万倍の整数として保存する。
6. 約200m格子の検索キーを作る。
7. 9地域に分割し、インデックスはデータ投入後に作成する。
8. N03行政区域を簡略化し、境界内の市区町村へ候補を限定する。
9. デジタル庁町字マスターの正式名称・町字ID・郵便番号を別表で関連付ける。
10. 鉄道N02とGeoNamesの商用利用可能な地名を最寄り場所候補へ追加する。

## 注意

- 初回は東京都のZIPだけで変換し、`manifest.json` と実際のD1容量を確認する。
- 無料D1は1DB 500MBまでなので、生成SQLのファイルサイズだけでなく投入後のDBサイズを確認する。
- 出典表示とデータ年度は公開元の利用条件に従う。
- 原本CSVや生成SQLをGitHubへ追加しない。
- 行政区域・町字マスターなど補助データの提供元、ライセンス、取得記録は
  [`DATA_SOURCES.md`](./DATA_SOURCES.md) を参照する。

## D1を接続する

最初は東京都だけで試す。Cloudflareで住所専用D1を作成して `tokyo.sql` を投入し、
Workerへ次のbinding名で接続する。

```text
ADDR_TOKYO
```

地域ごとのbinding名は次のとおり。

```text
ADDR_HOKKAIDO
ADDR_TOHOKU
ADDR_TOKYO
ADDR_SOUTH_KANTO
ADDR_NORTH_KANTO
ADDR_CHUBU
ADDR_KINKI
ADDR_CHUGOKU_SHIKOKU
ADDR_KYUSHU_OKINAWA
```

接続済みDBに候補があれば `/api/reverse` は自前データを返す。該当データがない場合だけ
Nominatimへフォールバックするため、全国分を一度に導入する必要はない。

各地域DBへは、同じshard名のSQLを次の順で投入する。

```text
{shard}.sql
{shard}.boundaries.sql
{shard}.abr.sql
{shard}.places.sql
```

全国9 DBへ行政区域が導入済みの場合、どの行政区域にも属さない座標は海上として返し、
隣接自治体や外部Nominatimへ誤って送らない。

## 2026-08-07 全国最新版の実測

国交省の2025年度版（街区 `24.0a`、大字町丁目 `19.0b`）94 ZIPを取得・検証した。

| shard | 代表点数 | SQLite実容量 |
|---|---:|---:|
| hokkaido | 314,935 | 16 MB |
| tohoku | 1,289,879 | 62 MB |
| tokyo | 220,220 | 10 MB |
| south_kanto | 1,636,609 | 75 MB |
| north_kanto | 3,140,492 | 145 MB |
| chubu | 4,987,820 | 235 MB |
| kinki | 2,622,316 | 122 MB |
| chugoku_shikoku | 1,673,636 | 77 MB |
| kyushu_okinawa | 2,185,120 | 101 MB |
| 合計 | 18,071,027 | 888 MB |

全shardが無料D1の1DB 500MB制限内で、合計も無料枠5GB以内。住所DB9個と既存アプリDB1個で、
無料プランの10DB上限をちょうど使用する。
