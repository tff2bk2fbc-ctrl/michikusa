# Security preflight: Liquid Glass UI / gestures

監査日: 2026-09-02

対象ブランチ: `main`、既存コミット `45b2ff4` からの未コミット差分のみ
判定: **今回の差分は push 可（条件付き承認）**

## 1. 監査範囲

今回の差分として、次のファイルだけを確認した。

- `public/app.css`
- `public/boot.js`
- `public/index.html`
- `public/place.js`
- `public/sw.js`
- `public/ui.js`
- `public/gestures.js`
- `package.json`
- `tools/release-flow.test.mjs`
- `tools/ui-gesture-flow.test.mjs`

対象外の既存コードは、今回の判定を混同しないよう「既知残存課題」として末尾に分離した。

## 2. 確認結果

### 2.1 外部通信

`public/gestures.js` には、外部通信を発生させる処理がない。

以下を追加していないことを確認した。

- `fetch`
- `XMLHttpRequest`
- `WebSocket`
- `sendBeacon`
- `postMessage`
- 外部URLへの遷移

新しいジェスチャーは、ボトムバーの表示状態、ポインター状態、地図クリック抑止状態だけを扱う。認証、公開範囲、位置情報、APIリクエスト、写真データの送信には触れていない。

### 2.2 DOM注入とコード実行

`public/gestures.js` に、次の危険な処理はない。

- `innerHTML`
- `outerHTML`
- `insertAdjacentHTML`
- `document.write`
- `eval`
- `new Function`

ボトムバーのレンズは、既存のHTMLに追加した固定要素 `<i>` を参照してCSSプロパティを変更する方式である。動的にユーザー入力やAPI応答をHTMLとして解釈しない。

`public/boot.js` の今回の変更では、起動エラーの表示を `innerHTML` から `textContent` 相当のDOM構築へ変更している。エラーメッセージやスタックがHTMLとして解釈されないことをテストで確認した。

### 2.3 秘密値・認証情報

今回の差分に、APIキー、Firebase秘密値、IDトークン、FCMトークン、パスワード、秘密鍵、OAuthリフレッシュトークンの追加はない。

`public/gestures.js` は認証コンテキストやlocalStorageへアクセスしない。`public/index.html` の追加スクリプトも同一オリジンの `/gestures.js?v=129` だけである。

### 2.4 CSP・セキュリティヘッダー

既存の `script-src 'self'` に適合する同一オリジンの外部スクリプトを追加している。インラインスクリプト、`unsafe-eval`、外部script sourceの追加はない。

既存のサーバー側防御は今回の差分で弱められていない。

- `src/index.js` の静的レスポンスCSP
- `public/_headers` のCSP
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy`
- `Permissions-Policy`
- `Strict-Transport-Security`
- 同一オリジン等に限定されたCORS

`public/sw.js` のキャッシュ名更新はキャッシュ世代の切り替えだけで、通信先やキャッシュ対象の許可範囲を広げていない。

### 2.5 地図ドラッグ抑止

`public/gestures.js:23-60` は、地図上のポインター移動量が8px以上になった場合、またはMapLibreの `dragstart` が発生した場合に移動状態を記録する。移動終了後210msだけ `mapTapAllowed()` をfalseにし、`public/place.js:410` の場所選択処理より前にガードする。

したがって、地図をドラッグした直後の合成クリックが、意図しない位置確定へ到達しない。通常の短いタップは移動量が8px未満なら許可される。

このガードはクライアント側の誤タップ防止であり、認証・公開範囲・サーバー認可の代替ではない。写真保存や公開判定は既存どおりサーバー側の認証と公開範囲判定に依存する。

### 2.6 Reduced Motion・アクセシビリティ

`public/gestures.js:13` が `prefers-reduced-motion` を確認し、レンズの伸縮・回転アニメーションを無効化する。`public/app.css` にもReduced Motion時の補正がある。

選択抑止は次の入力可能領域を例外としている。

- `input`
- `textarea`
- `select`
- `[contenteditable="true"]`
- 規約本文

既存の44px以上の操作領域と、キーボードの矢印キー・Home・Endによるボトムバー操作は維持されている。強制色モードの境界線も今回のCSSに含まれている。

## 3. テスト

実行済み:

```text
node --test tools/ui-gesture-flow.test.mjs
9 tests passed, 0 failed
```

依頼元報告による全体チェック:

```text
npm run check
144 tests passed, 0 failed
```

`tools/ui-gesture-flow.test.mjs` では、次を確認している。

- 既存5操作の順序を維持
- 横スワイプで隣の操作を一度だけ実行
- 縦移動とpointercancelで操作を実行しない
- 地図ドラッグ後だけクリックを210ms抑止
- 通常タップを維持
- 地図クリックガードが位置確定より前にある
- 入力可能領域、Reduced Motion、強制色の規則
- 新ジェスチャーからの外部通信・コード実行・HTML注入がない
- 起動エラーがHTMLとして解釈されない

## 4. 既知残存課題（今回未導入）

以下は今回の差分では追加・変更していない既存処理であり、今回のLiquid Glass UI / ジェスチャー実装に起因するものではない。

### 4.1 写真ビューのURL文字列連結

- `public/place.js:81-96`
- `public/post.js:526-534`

既存コードに、写真URLをHTML文字列へ直接連結する箇所が残っている。通常の内部写真Data URLや既存のサーバー画像だけを前提にしているが、端末内保存データや将来のAPI応答が改ざんされた場合に属性注入の余地がある。

推奨対応は別タスクで、画像URLのプロトコル・オリジンallowlist検証後に `img.src` プロパティへ設定すること。今回の差分はこの箇所を導入しておらず、今回のpushを阻止する新規重大リスクとは判定しない。ただし、公開前のセキュリティ改善 backlog として残す。

### 4.2 `el()` のHTMLパーサー

`public/core.js:50` の `el(h)` はHTML文字列を解釈する既存ヘルパーである。今回の `gestures.js` では使用していない。今後UIを追加する場合、API値・ユーザー入力・localStorage値を未エスケープで渡さないこと。

## 5. Push gate

次の条件を満たす場合に限り、今回の差分をpushしてよい。

1. `npm run check` が再実行して成功する。
2. `git diff --check` が成功する。
3. `public/gestures.js` の内容が今回監査したものから変わっていない。
4. 新しい外部通信、秘密値、危険なDOM sinkが追加されていない。
5. 390×844相当の実機幅を基準に、地図ドラッグ直後の誤タップ抑止と通常タップの維持を自動テストする。
6. 横スワイプ、縦スワイプ、タップ、キーボード操作を自動テストし、既存ハンドラーが一度だけ実行されることを確認する。
7. 承認済みプロトタイプとの比較とCSS検査で、Light / Dark / Reduced Motion / Forced Colors のフォールバックを確認する。

以上を満たしたため、今回の未コミット差分についてセキュリティ面のpush判定は **承認** とする。実機固有の触覚の重さと光学表現はデプロイ後確認項目であり、認可・通信・データ保護のpush判定を妨げない。既知残存課題の写真URL連結は重要な改善対象だが、今回未導入であり、このUI差分のpushを止める重大度ではない。
