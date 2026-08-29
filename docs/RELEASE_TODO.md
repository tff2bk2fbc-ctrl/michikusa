# Spota リリース前修正リスト

最終更新: 2026-08-29（Asia/Tokyo）

## 認証

- [ ] Firebase Dynamic Links終了対応: iOS／Androidアプリ内でネイティブ認証プラグインが利用できない場合に、WebViewの`signInWithRedirect`へ退避しない。安全に停止してアプリ更新を案内し、Webブラウザ版だけpopup／redirectを許可する。
- [ ] 上記修正後に、Appleログイン、Googleログイン、再認証、ログアウト、アカウント削除を実機で再検証する。
- [ ] 将来メールリンク認証を追加する場合は、Dynamic LinksではなくFirebase HostingドメインとUniversal Links／App Linksを使用する。

## iOS起動

- [x] 最新`main`をXcode用プロジェクトへ再現可能な手順で同期する。`apply-to-capacitor.sh`がリポジトリの`public/`を同期してからネイティブ設定を適用するよう修正済み。
- [x] iOS Simulatorでビルド、インストール、初回起動、再起動を確認する。Xcode 26.4／iPhone 17 Simulatorでビルド・起動・WebView読込に成功し、クラッシュなし。
- [x] WebViewのnavigation完了ではなく、HTMLの初回描画完了合図までネイティブ起動画面を維持する。12秒の安全解除、Reduce Motion対応、初回／再起動の時系列スクリーンショットで白画面なしを確認済み。
- [ ] 署名付き実機で起動時間を再計測する。署名なしDebug Simulatorのクリーンインストール直後に見えたOS側の黒画面は、本番版の値として扱わない。
- [ ] 実機を再起動し、VPN／カスタムDNS／コンテンツフィルタ／Private Relayを一時停止して、既知の正常なWi-FiとUSB接続で再確認する。既存実機ログではアプリのビルド失敗ではなく、WebKit停止とLTE経路のTLS証明書不一致を確認。

## 地図データ

- [x] ローカル原本3,991,500,615 bytesとD1／R2／アプリ実装を照合する。Driveの最終アップロード完了だけはローカルから独立検証できないため、後日ファイル数・容量・ハッシュを照合する。
- [x] Wikipedia 117,571件、国交省N02駅、GeoNamesの公開データを、利用者投稿と分離した`POST /api/map/places`へ接続する。本番D1を使うremote previewで東京・札幌・那覇を確認済み。本番Workerへのdeployは未実施。
- [x] 表示範囲0.35度、最大200件、地域D1選択、client 60回/分・全体2,000回/分のburst制限、厳密な時間・日次・全体D1上限、端末側48セル・1,200地点上限を実装する。binding欠落と未知providerはfail closedにする。
- [ ] OpenStreetMap PBFを、公開地点だけの軽量索引へオフライン変換し、ODbL・非公開地点除外・容量を確認してから接続する。2.5GB原本をWorker／D1／端末から直接読まない。
- [ ] Wikivoyage、JAPAN 47 GO、Wikipedia追加分類ダンプは、変換・重複・帰属・利用条件を確認して段階導入する。

## Google Driveバックアップ接続

- [ ] Google Drive／Google Oneの地図原本フォルダを、管理者専用のバックアップ先として接続する。iOS／AndroidアプリからDriveへ直接接続せず、管理用端末またはサーバー側だけでOAuth認証し、対象フォルダ以外へアクセスできない最小権限にする。OAuth client secret・refresh tokenはGitHubやアプリへ入れず、Secret Manager等で管理する。
- [ ] Drive上のバックアップ完了を、原本125ファイル、3,991,500,670 bytes（55-byte OSM checksumを除くデータ本体は3,991,500,615 bytes）、主要SHA-256、欠落・重複ファイル0件で照合し、結果をmanifestへ保存する。
- [ ] Driveから隔離した一時領域へ復元する試験を行い、原本を上書きせずにファイル数・容量・ハッシュが一致することを確認する。削除・更新は世代管理し、最低1世代前へ戻せるようにする。
- [ ] 将来アプリでDrive由来データを使う場合も、原本を直接配信しない。公開可能な軽量索引へ変換し、Cloudflare Worker／D1／R2を経由して、認証・回数制限・キャッシュ・ライセンス表示を通過したデータだけを返す。
