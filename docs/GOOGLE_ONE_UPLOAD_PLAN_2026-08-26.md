# Google One（Drive）保管準備（2026-08-26、OSM追補 2026-08-27）

## 目的

地図データの原本をGoogle OneのDrive領域へ長期保管し、GitHub・D1・R2の容量を圧迫しないようにする。Google Oneはアプリの本番配信ストレージではなく、原本のバックアップ／再生成用の保管先として扱う。

## アップロード対象

ローカルの次の既存ディレクトリを、コピーや再圧縮をせずにアップロードする。

```text
data/address-source/
data/reference-source/mlit-n03/
data/reference-source/digital-agency-abr/
data/reference-source/geonames/
data/reference-source/wikimedia/
data/reference-source/wikivoyage/
data/reference-source/openstreetmap/
```

Finderの`.DS_Store`、`node_modules`、`.env`、APIキー、サービスアカウント鍵、ユーザー写真、未完了ダウンロードは対象外にする。

2026-08-27時点のアップロード対象合計は、Finderメタデータとチェックサム管理ファイルを除いて**3,991,500,615 bytes（約3.99 GB、3.72 GiB）**である。OpenStreetMap PBF本体を含み、チェックサム管理ファイル55 bytesは別途保管する。

## Drive側のフォルダ構成

Google Driveのマイドライブ直下に、次のフォルダを作成する。

```text
Spota-MapData/
└── raw/
    └── 2026-08-27/
        ├── address-source/
        └── reference-source/
```

`raw/2026-08-27/`は読み取り専用の原本スナップショットとして扱い、更新版は同じフォルダへ上書きせず、新しい日付フォルダへ保存する。ライセンス台帳と容量記録は、次のファイルを同じスナップショットに置く。

- `docs/DATA_SOURCES.md`
- `docs/DATA_COLLECTION_2026-08-26.md`
- このファイル

## 重複を避ける手順

1. 既存のDriveフォルダ名とスナップショット日付を確認する。
2. 同じ日付の原本が存在する場合、SHA-256を比較して同一ならアップロードしない。
3. 異なる日付の版は、更新差分を確認するため別スナップショットとして保存する。
4. すべてのアップロード完了後、Drive上のファイル数・合計バイト数・主要ファイルのSHA-256を照合する。
5. 照合が完了するまでローカル原本を削除しない。

現時点の全`data/`ファイルのSHA-256完全一致重複は0件である。異なる提供元に同一地点が載る意味的重複は原本から削除せず、変換時に提供元ID・リダイレクト・座標・カテゴリで統合する。

## 推奨アップロード方法

5MBを超えるファイルは、Google Drive APIの再開可能（resumable）アップロードを使う。ネットワークが切れても途中から再開でき、今回のN03やWikipedia記事名ダンプに適している。Google公式ドキュメントでも、大きなファイルや接続断の可能性が高い場合はresumable uploadを推奨している。

参照: https://developers.google.com/workspace/drive/api/guides/manage-uploads

Drive APIを使う場合は、次の原則を守る。

- OAuth 2.0で本人のGoogleアカウントに明示同意する
- `drive.file`など最小スコープを優先する
- アクセストークン、OAuthクライアントシークレットをGitHub・D1・ログへ保存しない
- リクエストの再試行は指数バックオフで行う
- アップロード先フォルダIDを固定し、任意フォルダへの書き込みを許可しない
- 完了後にファイルID、サイズ、SHA-256だけを台帳へ記録し、トークンは記録しない

ブラウザのDrive画面から手動アップロードする場合も、同じフォルダ構成を作り、アップロード完了後に容量とファイル数を確認する。大容量の全体ZIPを新たに作る方法は、原本とZIPの二重保管になるため採用しない。

## 公開範囲と安全確認

- `Spota-MapData`は「制限付き（自分のみ）」にする。
- 「リンクを知っている全員」への共有は設定しない。
- Googleアカウントで2段階認証を有効にする。
- Google OneのDrive領域に置いた原本を、アプリのクライアントから直接参照しない。
- 本番アプリがデータを読む必要がある場合は、許可済みデータだけをR2／専用配信へ変換し、Driveはバックアップ専用にする。

## 除外データ

- 非商用指定または利用条件が確定していないデータ
- Wikipedia/Wikivoyageの本文・履歴・画像本体
- TikTok、X、YouTube、Google Trends等の規約未確定な横断データ
- APIキー、FCM秘密、サービスアカウント鍵、OAuthトークン
- Spota利用者の写真・EXIF・正確な位置情報

## 保管後の利用方針

Driveに置いた原本は、ローカルの変換処理で必要な属性だけを抽出し、次へ分配する。

- 住所検索・行政区域判定: D1用のコンパクトな属性索引
- 地図の大量Geometry: R2／PMTiles等の読み取り配信形式
- 観光・自然地名: 出典・ライセンス・取得日付きの検索索引
- 原本: Google One（Drive）の日付付きスナップショット

原本をそのままD1へ投入したり、Google Driveの認証情報をアプリへ埋め込んだりしない。
