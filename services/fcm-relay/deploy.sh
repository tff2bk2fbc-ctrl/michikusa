#!/usr/bin/env bash
set -euo pipefail

project="${GOOGLE_CLOUD_PROJECT:-michikusa-e34df}"
region="${GOOGLE_CLOUD_REGION:-asia-northeast1}"
service="${FCM_RELAY_SERVICE:-spota-fcm-relay}"
account="${FCM_RELAY_SERVICE_ACCOUNT:-spota-fcm-relay@${project}.iam.gserviceaccount.com}"
secret="${FCM_RELAY_SECRET_NAME:-spota-fcm-relay-secret}"

command -v gcloud >/dev/null || { echo "gcloud が見つかりません" >&2; exit 1; }
gcloud config set project "$project" >/dev/null
gcloud run deploy "$service" \
  --source "$(cd "$(dirname "$0")/../.." && pwd)/services/fcm-relay" \
  --region "$region" \
  --service-account "$account" \
  --allow-unauthenticated \
  --min 0 --max 3 --concurrency 8 --timeout 15 \
  --set-env-vars "FIREBASE_PROJECT_ID=$project" \
  --set-secrets "FCM_RELAY_SHARED_SECRET=${secret}:latest"

gcloud run services describe "$service" --region "$region" \
  --format='value(status.url)'
