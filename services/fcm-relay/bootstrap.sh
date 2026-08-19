#!/usr/bin/env bash
set -euo pipefail

project="${GOOGLE_CLOUD_PROJECT:-michikusa-e34df}"
account_id="${FCM_RELAY_SERVICE_ACCOUNT_ID:-spota-fcm-relay}"
account="${FCM_RELAY_SERVICE_ACCOUNT:-${account_id}@${project}.iam.gserviceaccount.com}"
secret="${FCM_RELAY_SECRET_NAME:-spota-fcm-relay-secret}"

command -v gcloud >/dev/null || { echo "gcloud が見つかりません" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl が見つかりません" >&2; exit 1; }
gcloud config set project "$project" >/dev/null
gcloud services enable run.googleapis.com secretmanager.googleapis.com fcm.googleapis.com

if ! gcloud iam service-accounts describe "$account" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$account_id" --display-name="Spota FCM relay (keyless)"
fi
gcloud projects add-iam-policy-binding "$project" \
  --member="serviceAccount:${account}" --role="roles/firebasecloudmessaging.admin" >/dev/null

if ! gcloud secrets describe "$secret" >/dev/null 2>&1; then
  # Secretの値は標準出力へ出さず、JSON鍵も作らない。
  openssl rand -base64 32 | gcloud secrets create "$secret" --data-file=- >/dev/null
fi
gcloud secrets add-iam-policy-binding "$secret" \
  --member="serviceAccount:${account}" --role="roles/secretmanager.secretAccessor" >/dev/null
echo "bootstrap complete: ${account} / ${secret}"
