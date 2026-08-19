#!/usr/bin/env bash
set -euo pipefail

relay_url="${1:-}"
project="${GOOGLE_CLOUD_PROJECT:-michikusa-e34df}"
secret="${FCM_RELAY_SECRET_NAME:-spota-fcm-relay-secret}"
worker="${WRANGLER_WORKER_NAME:-broad-wildflower-9e30}"

if [[ ! "$relay_url" =~ ^https://[^[:space:]]+$ ]]; then
  echo "第1引数にCloud Runの https://...run.app URLを指定してください" >&2
  exit 2
fi
command -v gcloud >/dev/null || { echo "gcloud が見つかりません" >&2; exit 1; }
command -v npx >/dev/null || { echo "npx が見つかりません" >&2; exit 1; }

echo "Cloudflareへ2つのsecretを1回のWorker更新で設定します（Worker: ${worker}）"
# Secretの値はJSONを標準入力へ流すだけで、端末・シェル履歴・引数へ出さない。
gcloud secrets versions access latest --secret="$secret" --project="$project" \
  | RELAY_URL="$relay_url" node --input-type=module -e '
    let raw="";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => raw += chunk);
    process.stdin.on("end", () => process.stdout.write(JSON.stringify({
      FCM_RELAY_URL: process.env.RELAY_URL,
      FCM_RELAY_SHARED_SECRET: raw.trim()
    })));
  ' \
  | npx wrangler secret bulk --name "$worker"
echo "Cloudflare secretの設定が完了しました。secret値はログへ出していません。"
