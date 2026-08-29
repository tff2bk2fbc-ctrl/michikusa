# 地図オープンデータ接続・iOS起動検証報告

検証日: 2026-08-29（Asia/Tokyo）

## 結論

- 最新ソースはiPhone 17／iOS 26.4 Simulatorでビルド、インストール、起動、WebViewのmain frame読込に成功した。クラッシュは再現しなかった。WebViewのnavigation完了ではなく、HTMLが2回の描画機会を終えた合図を待ってネイティブ起動画面を外すよう修正し、アプリ側の白画面の挟まりを解消した。
- 実際のXcodeプロジェクトへ、リポジトリの最新`public/`を同期済み。同期前に存在した6ファイルの差異と`operator.js`欠落は解消した。
- Wikipedia座標索引は本番9地域D1にすでに入っていた。合計117,571件で、生成予定件数と全地域で一致した。
- ただし従来の表示APIはこの索引を読んでいなかった。公開オープンデータ専用APIを追加し、Wikipedia・国交省N02駅・GeoNamesを表示範囲だけ取得できるようにした。
- OpenStreetMapの2.5GB PBFとWikivoyageは、まだ地図表示へ入れていない。原本を直接配信せず、ライセンス・非公開地点・容量を検査する軽量変換が必要である。
- この報告時点ではGitHub pushとCloudflare本番deployは行っていない。

## オーケストレーションと参照ソース

### iOS起動担当

参照:

- `native/ios/AppDelegate.swift`
- `native/ios/SpotaBridgeViewController.swift`
- `native/ios/apply-to-capacitor.sh`
- `/Users/shigematsutomoki/michikusa-app/ios/App/App.xcodeproj`
- Xcode Run resultと端末の既存OSログ

Simulatorでは現行Xcodeプロジェクトと、最新`main`を完全同期した一時プロジェクトの両方を検証した。両方とも起動した。実機の既存ログでは、WebKitのNetworking／WebContent／GPU起動に約27〜31秒かかり、WebContentが応答不能になっていた。同じ実行でGoogle系通信がLTE経路のTLS証明書不一致により失敗していた。署名、Bundle ID、provisioning、Apple Sign In、Push entitlementには起動阻害の証拠がなかった。

### 地理データ棚卸担当

ローカル原本は125ファイル、3,991,500,670 bytes（55-byte OSMチェックサムを含む）。主な内訳:

- OpenStreetMap PBF: 2,502,520,532 bytes
- 国交省N03: 803,201,348 bytes
- Wikipedia関連: 428,788,303 bytes
- 国交省住所原本: 239,835,815 bytes
- デジタル庁ABR: 11,548,462 bytes
- GeoNames JP: 4,957,252 bytes
- Wikivoyage: 648,903 bytes

Google One／Driveは非公開バックアップ用途であり、アプリの実行時データベースではない。最終アップロードの全件完了は、このローカル環境から独立確認できていない。アプリはDrive ID、共有URL、OAuth credentialを持たない。

### 地図接続・セキュリティ担当

参照:

- `src/index.js`
- `src/lib/map-places.js`
- `public/data.js`
- `wrangler.jsonc`
- 9地域D1の`wikipedia_places`／`nearby_places`
- `tools/wikimedia/build.mjs`
- `tools/places/build.mjs`

旧`POST /api/places`は主D1のlegacy `places`を読む。由来・公開可否を現在のmigrationだけでは完全に再構成できないため、新しいオープンデータと混ぜなかった。新しい`POST /api/map/places`は、利用者投稿を含まない3提供元だけを返す。

## 本番D1確認値

| 地域 | Wikipedia件数 |
|---|---:|
| 北海道 | 5,907 |
| 東北 | 11,210 |
| 東京 | 11,215 |
| 南関東 | 8,817 |
| 北関東 | 9,715 |
| 中部 | 26,211 |
| 近畿 | 19,248 |
| 中国・四国 | 12,492 |
| 九州・沖縄 | 12,756 |
| 合計 | 117,571 |

生成済み117,571座標を全件走査し、Workerの地域選択表が正しいD1を選ぶか検証した。北方・伊豆小笠原・離島を含め、補正後の未カバーは0件。

## 実装した保護

- POST JSON本文だけで範囲を受け、位置をURL・ブラウザ履歴へ残さない。
- 本文上限512 bytes。
- 表示範囲は縦横0.35度以下。
- 応答は最大200地点。
- D1へ触る前に、clientごと60回/分、全体2,000回/分のCloudflare burst limiterを通す。binding欠落時はfail closedで停止する。
- 後段D1の厳密な上限として、clientごと時間600回・日5,000回、全体日200,000回で停止する。期限切れカウンターは日次処理で削除する。
- 地域範囲と交差するD1だけを選び、Wikipediaの全9DB一斉読取を避ける。
- SQLは格子索引と正確な座標範囲を併用し、各DBにも`LIMIT`を付ける。
- Wikipediaテーブルが未投入の地域は、その提供元だけ空にして他の公開データを継続する。
- 利用者投稿、主D1のlegacy `places`、Google Drive、写真R2、秘密情報を読まない。
- 提供元はSQLとmapperの両方で`jawiki`／`geonames`／`mlit-n02`だけに限定し、未知の提供元を国交省扱いしない。提供元IDとURLを保持して3者を区別する。
- クライアントはID、名称、緯度、経度で重複を抑止し、48セル・1,200地点を超えた地図データを破棄する。

## 実データ試験

ローカルWorkerをCloudflareの本番D1へremote preview接続し、東京、札幌、那覇の3範囲をPOSTした。

- 3件ともHTTP 200。
- Wikipediaと国交省N02は3範囲すべてで取得。
- GeoNamesは東京・那覇で取得。
- 応答の提供元表示、安定ID、記事URL、最大件数を確認。
- テストによる本番変更は回数カウンターだけで、地理データ行は更新していない。

## iOSへ反映した修正

- `apply-to-capacitor.sh`が、対象の`appId=com.damo.michikusa`と`webDir=public`を先に照合してから、リポジトリ`public/`をCapacitor rootへ`rsync --delete`する。
- Swiftのthread-safeな`static let`を使い、UIApplicationがdelegateを保持した後の`willFinishLaunching`でFirebase default appを一度だけ初期化する。AppDelegate proxyが有効な状態を保ちつつ、plugin初期化順への依存を除去した。
- LaunchScreenと同じ`Splash`画像をWebViewより前面に保持し、`boot.js`がparser完了後に2回の描画機会を終えた合図を返してから0.2秒で外す。合図が来ない場合も12秒で必ず外れ、画面へ閉じ込めない。Reduce Motion時はフェードを省略する。表示中は背後へのタッチとVoiceOver焦点を遮断し、「Spotaを読み込んでいます」だけを読み上げ、解除時にWebViewへフォーカスを移す。
- `spota.caf`が存在する場合、Xcode Resourcesへ自動登録。
- 誤って貼り付けられていた改行付き表示名設定を`spota`へ正規化。
- 修正後のXcode buildは`BUILD SUCCEEDED`。Simulator起動PIDを取得し、main frame読込完了、Firebase未初期化警告なし、WebKit応答不能なしを確認。クリーンインストールと再起動を1・2・3・5・6・9・12秒で撮影し、ネイティブ起動画面からHTML起動画面、初回設定画面までの間に白画面が入らないことを確認した。
- 最終ログのWebView navigation基準値はfirst visual layout 0.433秒、first meaningful paint 1.413秒、load event 0.729秒、subresources finished 3.242秒。署名なしDebug Simulatorのクリーンインストール直後は、アプリUIが現れる前にOS側の黒画面が数秒あったため、App Store版の起動性能とは分けて扱い、署名付き実機で再計測する。

Simulatorの署名なしbuildではKeychain／APNs entitlement警告が出る。これは`CODE_SIGNING_ALLOWED=NO`の検証条件によるもので、署名付き実機の起動障害を示すものではない。

## 未完了・次の作業

1. 実機を削除せずに再起動し、VPN・カスタムDNS・コンテンツフィルタ・Private Relayを一時停止、正常Wi-FiとUSB接続でXcode起動を再確認する。署名付き実機で起動時間も再計測する。
2. OSM PBFを固定バージョンのストリーミング変換器で処理し、公開名称、許可タグ、代表点、提供元IDだけの軽量索引を生成する。`access=private/no`、連絡先、編集者情報、不要なタグ、raw geometryは除外する。
3. Google One／Driveのバックアップをファイル数、総byte、主要SHA-256で照合する。
4. `nearby_places`が現在9地域へ同じ33,929件を複製しているため、次回再構築時に1地点1地域へ分割し、D1容量を回収する。

## セキュリティ二重検査

一次検査と独立した二次検査で、当初は新APIの短時間burst制限不足をHigh、未知providerの誤帰属とiOS同期対象の確認不足をMediumとしてpushを停止した。client/globalの2段burst limiter、D1前fail-closed、provider二重allowlist、日次counter cleanup、Capacitor `appId`／`webDir` preflightを追加して再検査した。

- Critical: 0
- High: 0（1件を修正して解消）
- Medium: 0（2件を修正して解消）
- 秘密情報の新規混入: 0
- Google Drive／Cloud Storageへの端末直結: 0
- FCM relay依存監査: 脆弱性0
- `npm run check`: 129/129成功
- Wrangler dry-run: 新API、9地域D1、client/global rate limiterを含め成功

Cloudflare Rate Limitingは拠点単位かつeventually consistentで、全世界で厳密な「global」値ではない。厳密な日次全体上限は後段のD1 atomic counterが担う。残余リスクとして記録するが、push blockerではない。二重検査の最終判定は`APPROVE`。この報告時点では、ユーザーの明示的なpush指示がないためcommit／push／本番deployは行っていない。
