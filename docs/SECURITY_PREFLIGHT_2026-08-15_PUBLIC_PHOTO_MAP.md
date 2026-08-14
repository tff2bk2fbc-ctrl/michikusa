# Security preflight — public photo sync and map thumbnails (2026-08-15)

## 判定

**SECURITY APPROVE — commit / push 可能**

今回の差分に、認証・所有者確認の迂回、新しい第三者送信先、秘密情報の追加、公開範囲の強制変更は確認されなかった。現時点では未push。

## 対象

- `public/sync.js` — 高品質JPEGを3段階へ変換してR2へ再試行可能な形で保存し、旧版の欠損写真を自動再送
- `src/index.js` — 一時的な画像モデレーション失敗の自動再判定
- `public/map.js`, `public/place.js` — 写真サムネイル、画面距離クラスタ、クラスタ展開
- `public/native.js` — iOS取得画像を4096px以内へ抑制
- キャッシュ識別子とアセット版をv104へ更新

## 外部通信の確認

1. 写真・投稿は従来の同一オリジンWorker APIへFirebase Bearer認証付きで送る。新しい送信先は追加していない。
2. R2はWorker binding経由のみで、公開バケットURLを追加していない。
3. 公開・フレンド写真の安全確認はWorkerからGoogle Cloud Visionへ送る。APIキーは`env.GOOGLE_API_KEY`から読み、クライアントや差分へ埋め込んでいない。
4. OpenFreeMapの地図配信、Firebase認証、既存CSP・ローカル配信済みMapLibreとSRIは変更していない。
5. 差分に新しいURL、WebSocket、Cookie保存、`innerHTML`、`eval`、トークン出力はない。

## 認可・公開範囲

1. 写真PUTは認証後のみ実行し、投稿所有者、写真所有者、投稿IDを照合する（`src/index.js:985-1005`）。
2. 原本は本人だけ、表示用とサムネイルは投稿の公開範囲・フレンド関係・ブロック・公開時刻・モデレーション結果を確認して返す（`src/index.js:1114-1148`）。
3. Visionの一時障害中は投稿の希望公開範囲を勝手に変更しない一方、画像は`moderation_state='ok'`になるまで他人へ返さない。最大6回の再判定を行う（`src/index.js:2850-2898`）。
4. 不適切判定だけは投稿を非公開へ倒す。タイムライン、地図、共有リンクも安全確認済みの写真IDだけを返す。
5. 「みんな」「フレンド」「自分だけ」の選択は維持され、既存投稿を一括公開する変更はない。

## 入力・課金DoS対策

1. クライアントは保存版4096px/品質94%、表示版2560px/品質90%、サムネイル512px/品質82%のJPEGを生成し、サムネイル→表示版→保存版の順に送る（`public/sync.js:27-42`）。Canvas再生成によりサーバー保存版からEXIFを除去する。
2. Workerは実ボディを原本25MB、表示用8MB、サムネイル1.5MBで打ち切り、MIMEと画像シグネチャも照合する（`src/index.js:1008-1030`）。
3. 写真は1投稿12枚、1時間80リクエスト、1日300MB、1ユーザー累計5GBで制限する。
4. Visionはユーザーごとの時・日上限と全体月間上限を維持する。再試行は15分ごと最大5件、各写真最大6回で打ち切る。
5. エラーログはURL、高精度座標、改行、長文を除去し、認証情報や画像本文を保存しない。
6. 旧版でD1投稿だけが同期済みになった場合は、本人の端末内写真と本人の投稿IDだけを照合して未同期へ戻す。他人の投稿・写真IDを書き換える経路は追加していない。

## 検証結果

- `npm run check` — 48 tests passed
- `git diff --check` — passed
- Cloudflare Worker `wrangler deploy --dry-run` — passed（D1/R2/Rate Limit bindings解決済み）
- iOS Simulator build（署名なし）— `BUILD SUCCEEDED`
- ブラウザ診断 — サムネイル生成1/1成功、読込失敗0、MapLibreエラー0
- ネイティブ同梱`public/` — Web版v104の変更対象と一致

## 残る運用条件

- 本番へ反映されるのはmainへpushしてCloudflare自動デプロイが完了した後。
- 全員の地図へ出るのは、ユーザーが公開範囲「みんな」を選び、安全確認が完了した写真だけ。
- 本番認証を使った別アカウント間の最終確認は、デプロイ後に実機2アカウントで行う。
