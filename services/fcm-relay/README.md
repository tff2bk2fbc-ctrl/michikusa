# Spota FCM relay（Cloud Run / ADC）

Cloudflare WorkersでGoogleサービスアカウントJSONを保持せずに、Firebase Cloud Messaging HTTP v1を呼ぶための小さな中継です。Cloud Runにサービスアカウントを「実行時に付与」し、GoogleのApplication Default Credentials（ADC）で短期アクセストークンを取得します。秘密鍵ファイルの作成・保存は行いません。

## リクエスト経路

```text
Cloudflare Worker
  └─ HTTPS + timestamp/nonce/HMAC-SHA-256
      └─ Cloud Run（/send）
          └─ ADC（実行時サービスアカウント）
              └─ FCM HTTP v1
```

Workerは最大8台分を1リクエストで送ります。中継は本文16KiB、通知長、dataキー、位置情報・メール・IPなどの機微キーを検証し、無効登録tokenだけを返します。nonceはCloud Runインスタンス内で短時間保持します。複数インスタンス／再起動をまたぐ完全なリプレイ防止が必要になったら、nonceストアをFirestoreまたはCloudflare側のDurable Objectへ移します。

Secret Managerの値は、登録方法によって末尾改行を含むことがあります。Cloud RunとCloudflareはHMAC計算前に外側の空白を除去して同じ値へ正規化します。新規bootstrapでは末尾改行を保存しません。

## Google Cloud側（初回のみ）

次の操作はGoogle Cloudプロジェクト管理権限が必要です。サービスアカウントキーは作りません。

```bash
services/fcm-relay/bootstrap.sh
```

このスクリプトはサービスアカウント（鍵なし）、必要API、Secret Manager secret、最小限のIAM付与を冪等に準備します。既存secretの値は読み出さず、既存secretを自動ローテーションもしません。続けてデプロイします。

## Cloud Runデプロイ

```bash
gcloud run deploy spota-fcm-relay \
  --source services/fcm-relay \
  --region asia-northeast1 \
  --service-account spota-fcm-relay@michikusa-e34df.iam.gserviceaccount.com \
  --allow-unauthenticated \
  --min 0 --max 3 --concurrency 8 --timeout 15 \
  --set-env-vars FIREBASE_PROJECT_ID=michikusa-e34df \
  --set-secrets FCM_RELAY_SHARED_SECRET=spota-fcm-relay-secret:latest
```

`--allow-unauthenticated`はCloudflare WorkerがGoogleのID tokenを発行できないためです。URLを知っているだけでは送信できず、アプリ層のHMACが必須です。Cloud RunのURLを取得したら、本番Workerへ次を設定します（secret投入はCloudflareの新しいWorkerバージョンを作ります）。

```bash
services/fcm-relay/configure-cloudflare.sh "https://...run.app"
```

このスクリプトはSecret Managerの値を表示せず、標準入力でWranglerへ渡します。2つのsecretを1回の`wrangler secret bulk`で設定するため、不要な中間Workerバージョンを作りません。secret登録はWorkerの新しいバージョンを作成するため、セキュリティ審査と実機確認が終わるまで実行しません。

設定後は `/api/health`、ログイン済み端末の `/api/push/test`、通信モニターの順に確認します。FCMの受理だけでは端末受信を意味しないため、実機で「受信・開封・画面確認」まで確認してからリリース判定します。

## ローカル検証

```bash
npm run fcm-relay:test
npm run check
```

ローカルでは`GOOGLE_APPLICATION_CREDENTIALS`を設定して実FCMへ送らず、テストのtokenProviderを差し替えて署名・検証・無効token処理だけを確認します。
