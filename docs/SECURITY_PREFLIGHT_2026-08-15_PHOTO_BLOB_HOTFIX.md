# Security preflight — photo Blob conversion hotfix (2026-08-15)

## 判定

**SECURITY APPROVE — commit / push可能**

公開写真保存がWorkerへ到達する前に失敗していたため、CSPに遮断される`fetch(data:image/...)`を端末内のBase64→Blob変換へ置き換えた。CSPの緩和、新しい外部通信先、認証・認可処理の変更はない。

## 本番調査の証拠

- 本番Workerは`api-40`を配信済み。
- 直近3件の投稿はいずれもD1へ作成されたが、写真行、thumb、view、origはすべて0件。
- `/api/photo`冒頭で必ず増える写真リクエストカウンターも作成されていない。
- したがってR2、D1写真INSERT、Visionより前のクライアント変換段階で停止していた。
- `public/sync.js`は最初の写真PUTより前に`fetch(data:image/jpeg;base64,...)`を実行していたが、`connect-src`は`data:`を許可していない。

調査時にユーザーID、投稿ID、座標、写真名、画像本文は表示・記録していない。

## 変更内容

- `public/sync.js:36-42` — thumb、view、archiveのBlob化から`fetch`を除去。
- `public/sync.js:49-57` — JPEGのdata URLだけを許可し、`atob`と`Uint8Array`で端末内変換。
- `public/boot.js`, `public/index.html`, `public/sw.js` — v105 / cache v31へ更新。
- iOS同梱`public/`へ同じ変更を同期。

## セキュリティ確認

1. `connect-src`へ`data:`を追加せず、既存CSPを弱めていない。
2. data URLのMIMEは`image/jpeg;base64`へ固定し、他形式・不正形式を拒否する。
3. 変換されたBlobは既存のFirebase Bearer認証付き同一オリジンAPIだけへ送信する。
4. Worker側の所有者照合、画像シグネチャ、サイズ・回数・容量制限、Visionモデレーション、R2非公開bindingを維持する。
5. 新しいURL、第三者通信、Cookie、Web Storage、DOM挿入、動的コード実行、秘密情報を追加していない。
6. エラー表示には画像本文・認証トークンを含めない。

## 検証結果

- `npm run check` — 49 tests passed
- JPEG data URL→Blobのバイト一致テスト — passed
- PNG・不正data URLの拒否テスト — passed
- `git diff --check` — passed
- `wrangler deploy --dry-run` — passed
- Web版とiOS同梱版の変更ファイル一致 — passed

## デプロイ後の確認

v105取得後に未同期写真を自動再送し、本番D1でthumb/view/origが各1件作成されることを確認する。別アカウントへの表示は、公開範囲とVision判定完了後に確認する。
