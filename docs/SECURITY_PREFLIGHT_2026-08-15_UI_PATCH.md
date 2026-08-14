# Security preflight — UI patch (2026-08-15)

## 判定

**SECURITY APPROVE — push を許可**

今回の差分に、認証 bypass、外部APIの追加、秘密情報の追加、未検証URLへの遷移、または新しいユーザー入力のHTML挿入は確認されなかった。

## 対象

- `public/index.html` — 現在地ボタンとタイムラインボタンの配置、ビルド番号更新
- `public/core.js` — 自分／みんなの地図アイコン切替
- `public/native.js` — 現在地ボタンの接続先変更
- `public/data.js` — 件数トーストの削除
- `public/release.js` — タイムラインの下方向更新
- `public/app.css` — 透明マーカーと更新表示
- `public/boot.js`, `public/sw.js` — 古いキャッシュを残さない版更新

## 確認項目

1. 新しい `fetch`、WebSocket、認証処理、API route は追加されていない。
2. `refreshMapAudienceUI()` の `innerHTML` は固定されたSVG文字列だけを設定しており、URL・API応答・ストレージ値は入らない。
3. タイムラインの更新は既存の `renderTimeline()` を再利用し、既存の認証済み `/api/feed` 呼び出し以外の通信を発生させない。
4. プル更新は画面左端24pxを開始対象から除外し、iOSの戻るジェスチャーを奪わない。
5. 差分内に秘密鍵・アクセストークン・サービスアカウント情報は追加されていない。
6. 既存のCSP、認証、写真アクセス制御、レート制限は変更していない。

## 検証結果

- `npm run check` — 43 tests passed
- `git diff --check` — passed
- Xcode Simulator build (`CODE_SIGNING_ALLOWED=NO`) — `BUILD SUCCEEDED`
- 差分対象のJavaScript `node --check` — passed
- 秘密情報パターンの差分スキャン — 新規検出なし

## 既存設定に関する注意

Firebaseのブラウザ設定はクライアント識別子として既存コードに置かれている。今回追加されたものではない。Firebase／Google Cloud側でAPIキーのアプリ・API・ドメイン制限を継続確認し、サーバー専用秘密情報は引き続きCloudflare Secretsへ置く。
