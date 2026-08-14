# Security preflight — photo upload and portrait patch (2026-08-15)

## 判定

**SECURITY APPROVE — push を許可**

今回の差分に、認証 bypass、所有者確認の削除、新しい外部送信先、秘密情報の追加は確認されなかった。

## 対象

- `src/index.js` — 写真PUTのサイズ判定を実バイト基準へ変更、チャンク転送を上限付きで読み取る処理を追加
- `public/sync.js` — 写真アップロード失敗時に同期成功と扱わず、再試行可能な状態を維持
- `public/app.css` — 置きピンの円と疑似要素を完全透明化
- `public/index.html`, `public/boot.js`, `public/sw.js` — v103へ更新し、古いキャッシュを避ける
- iOS `Info.plist`, `AppDelegate.swift` — 縦画面のみ許可

## 確認項目

1. `/api/photo` は従来どおりFirebase認証後に実行され、投稿所有者と写真ID・投稿IDを照合する。
2. `Content-Length` がないWKWebView/HTTP2のチャンク転送を受け付けるが、実ボディは原本25MB、表示用8MB、サムネイル1.5MBで打ち切る。
3. MIME、画像シグネチャ、ユーザー単位の回数・日次容量・累積容量制限、公開画像のモデレーションは維持される。
4. 差分に新しい `fetch`、WebSocket、外部URL、認証情報、APIキー、トークンは追加されていない。
5. CSS変更は置きピンの描画だけで、DOM ID、API、公開範囲、位置精度を変更していない。
6. iOSはiPhone/iPadとも `UIInterfaceOrientationPortrait` のみを許可する。

## 検証結果

- `npm run check` — 44 tests passed
- `git diff --check` — passed
- Xcode Simulator build（`CODE_SIGNING_ALLOWED=NO`）— `BUILD SUCCEEDED`
- ビルド済みInfo.plist — iPhone/iPadともPortraitのみ
- ネイティブ同梱 `public/` — Web版のv103ファイルと一致

## 本番反映

GitHubの `main` へPush後、Cloudflareの自動デプロイ完了を確認するまで本番は旧版のまま。デプロイ後にv103と写真PUTの実機確認を行う。
