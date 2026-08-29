# TikTok trend boundary

このディレクトリは、TikTokの一般トレンドを無許可で取得する機能ではありません。
現時点の本番既定値は外部通信なしの `disabled` です。`synthetic_fixture` のみで、集計ロジックと画面に渡す安全なスキーマを検証します。

## 今回できること

- 許可済みのサンプルを「取得サンプル数」「粗い地域キー別のいいね・投稿サンプル」「トレンド原因の仮説」へ集計
- 最小コホート未満の結果を自動的に抑制
- 取得時刻・有効期限・サンプルであることを出力
- raw response、ユーザー識別子、動画ID/URL、本文、コメント、音声テキスト、EXIF、緯度経度を保存しないスキーマを検証

## 今回できないこと

- TikTok内の検索回数の取得
- TikTok全体の投稿数・場所別の全投稿数
- 撮影GPSや市区町村をTikTok APIから確定
- リアルタイムのいいね数
- TikTokのスクレイピング、Creative Centerの自動取得、非公式APIの利用
- 未承認のResearch API／一般トレンドAPIへの接続

TikTok Research APIは研究者向けの審査・承認制であり、通常の商用アプリ向けの一般トレンドAPIではありません。Display APIはOAuth同意したユーザー本人の動画に限定されます。正式な商用ライセンスが取得されるまで、live adapter・Cron・Worker/D1/R2投入は追加しません。

## 実行

```sh
node tools/tiktok-trends/run.mjs tools/tiktok-trends/fixtures/synthetic.json
node --test tools/tiktok-trends/test.mjs
```

出力の `retrieved_sample_count` はTikTokの検索回数ではありません。`trend_cause_hypotheses` は「推定」であり、原因を断定しません。

## 将来の有効化ゲート

次の全てが揃うまで `createDisabledAdapter()` を変更しません。

1. TikTokまたは適法なデータ提供者から、商用利用・自動取得・保存・派生集計・再表示・地域・保持期間を明記した書面許諾
2. 法務・プライバシー（削除・撤回・DPA）確認とTikTokアプリ審査
3. OAuth 2 + PKCE、state、server-side secret、最小scope
4. 本体Worker/DB/PHOTOS R2とは分離したingestorと、公式endpointだけのegress allowlist
5. 日次quota・費用kill switch・backoff・circuit breaker・監査ログ
6. rawデータを同一処理内で破棄し、短いTTLの集計だけを保存する実装と削除テスト
7. セキュリティ部門と法務部門の再承認、stagingでのE2E検証
