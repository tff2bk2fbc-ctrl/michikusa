# オーケストレーション記録 2026-08-15

## 固定した入力

- ユーザー提供PDF `名称未設定のノート 2.pdf`
- 今回の明示指示: 検索横の地球儀・通知・メッセージ、透明なタップ表示、プロフィールアイコン変更、タイムライン倍率修正、上野初期表示廃止、いいね・コメント・共有、push前セキュリティ承認
- Git基準: `f68d016`

## 担当分離

| 担当 | 役割 | 初回判定 | 対応 |
|---|---|---|---|
| 主担当 Codex | 仕様固定、実装、統合、テスト | — | 他担当は編集禁止とし、指摘を主担当が再現して反映 |
| Tesla / デザイン監査 | PDFと今回指示だけで配置・導線を確認 | BLOCK | 指示外だった投稿カテゴリ9アイコンを削除。再監査でDESIGN APPROVE |
| Godel / 攻撃者視点監査 | 認証、認可、位置、写真、ソーシャル、iOS runtime | BLOCK → SECURITY APPROVE | 旧正確位置の永続化、写真variant同期、timeline導線、Push遷移、共有表示、同名地点解決、friend申請制限、geocode cache-hit制限を修正 |
| Sagan / Cloudflare・通信監査 | 全外部接続、Secrets、D1/R2、CSP/CORS、logging、DoS | BLOCK → SECURITY APPROVE | 座標・検索語POST化、GET bypass閉鎖、meta CSP、share/global limits、native再同期、Cloudflare Rate Limiting bindingを実施 |

## 実装の要点

- 検索欄の右を地球儀、通知、メッセージの順に固定。
- 下部操作を現在地、思い出、カメラ、写真、プロフィールの5つに固定。
- 地球儀で自分/みんなの地図を切替。
- 下部tap pillと地図配置マーカーの面を透明化。
- iOSが入力欄を自動拡大しないよう全入力を16px以上にし、release画面の横overflowを禁止。
- 上野の固定初期座標を削除し、中立の日本全体表示へ変更。
- 正確な現在地を端末へ保存せず、位置許可取消時は現在地マーカーを破棄して中立表示へ戻す。
- プロフィールアイコンは監査済み内蔵SVG 8種だけを選択し、APIとD1でもallowlist制約。
- タイムラインへlike、comment、follow、shareと短いtap animationを接続。
- 地図範囲・タイムライン検索語・逆引き座標をGET URLではなくPOST本文へ移動。
- 公開用写真はview/thumb両方の生成とupload成功後だけ同期完了。
- external runtimeを最小化し、CSPをWorker headerとiOS同梱HTMLの両方へ設定。
- フレンドAPIをmethod固定し、読取・書込burst、利用者日次、全体日次、未回答総数で制限。同一pending再送は友情行を書き換えない。
- geocodeはcache参照前にもclient単位60回/分の制限を通し、cache hitによるWorker呼出し増幅を防止。

## 検証と承認

- DESIGN APPROVE: 取得済み
- 自動テスト: 42件合格（method 405、pending再送writeなし、日次429、cache hit 429を含む）
- Cloudflare dry-run: 成功（`GEOCODE_RATE_LIMITER`を含む全bindingを確認）
- iOS: repo / native / iOS同梱assets一致、Simulator Debug build成功
- D1 migration: `0002_profile_icon.sql`適用済み。`profile_icon TEXT NOT NULL DEFAULT 'pin'`をremoteで確認
- SECURITY APPROVE: Godel、Saganの2担当から独立承認を取得

## 禁止事項

- Secret値、Authorization、写真、正確な座標を監査ログへ載せない。
- 監査中にcommit・push・本番deployを行わない。
- どちらかのセキュリティ担当がBLOCKなら、修正後に両方を再監査する。

## 追加オーケストレーション: 写真地図・1日1枚・ソーシャル操作

### 固定した要件

- EXIF位置情報がnative metadataに無い場合も、画像本体を再解析する。
- カメラ、写真ボタン、アルバムから利用者が意図して追加した写真は、スワイプを挟まず追加する。
- スワイプは、明示同意後に端末内で1日1回選ばれるランダム候補だけに使う。
- 地図はズーム12以降で写真サムネイルを表示し、近接写真と完全同地点は件数でまとめる。
- いいね、コメント、Flashを認証済みAPIとD1へ接続する。
- iPhone/iPadを縦画面に固定する。
- セキュリティ部と独立受入QAの両方が許可するまでcommit・pushしない。

### 担当と停止判断

| 担当 | 役割 | 検出した停止事項 | 解決 |
|---|---|---|---|
| 主担当 Codex | 実装、統合、Cloudflare・iOS検証 | — | 指摘ごとに修正し、最新版をXcodeの実際の梱包先まで同期 |
| Carson / セキュリティ部 | 認証境界、PhotoKit、画像通信、API、秘密値 | 旧Bearerを持つ写真復元キュー、JSON body上限、共有blob cache、like濫用 | scope/generation検査、AbortController、stream byte上限、cache破棄、日次・全体上限と通知dedupe |
| Kierkegaard / 受入QA | ユーザー操作、日次候補、地図表示、GitHub再現性、実機収録 | 日次失敗再予約漏れ、iCloud-only候補停滞、seen枯渇、installer依存、Xcode梱包先不一致 | 2時間再予約、候補skip、巡回再開、gem不要installer、正しいCapacitor copyへ修正 |
| Raman / ソーシャル監査 | いいね、コメント、FlashのUI/API/D1接続 | 自分の投稿から操作へ到達しにくい | ownerの投稿を認可条件付きfeedへ含め、SQLite実保存テストを追加 |

### 最終実装

- 日次候補のPhotoKit asset IDはJavaScriptへ渡さず、native側の匿名UUID tokenで一回だけ引き換える。
- 候補プレビューはiCloud通信を禁止し、「使う」の後だけ原寸取得を許可する。
- 読めない候補は端末内履歴へ移して2時間後に別候補を試す。小規模ライブラリを一巡した翌日は、直近1枚を避けて新しい巡回を開始する。
- アカウント切替時は写真復元キューを破棄し、通信中の旧アカウント取得を中止する。
- 地図用写真は同時2通信、待機40件を上限とし、全件を順次復元する。
- サムネイルの準備前は代替ピンを残し、準備後は円形写真を表示する。重なりは総写真数の数字で表示する。
- WorkerのJSON読込はstream中にbyte上限を適用し、過大bodyを展開前に413で停止する。
- likeの状態変更は利用者日次200回・全体日次200,000回を上限とし、unlike/re-likeで通知を再生成しない。
- GitHubのnative overlayにSwift 3ファイル、SceneDelegate、gem不要の冪等installer、手順書を含めた。

### 最終検証

- 自動テスト: 70 / 70 合格。
- `git diff --check`: 合格。
- Cloudflare Workers dry-run: 33 assets、162.13 KiB、全D1/R2/Rate Limiter binding解決。
- installer: 未適用プロジェクトへ適用後、2回目を実行しても重複なし。pbxprojとplistの構文検査合格。
- Web 9資産: repository、native root public、`ios/App/App/public`、build成果物まで一致。
- Swift 3資産: repositoryとXcode配置が一致。
- iOS Simulator: build、install、launch成功。
- 接続iPhone: signed build、install、`com.damo.michikusa` launch成功。
- 縦画面設定と写真利用目的のplist表示を確認。
- セキュリティ部: Critical 0 / High 0 / Medium 0、push許可。
- 独立受入QA: blocker 0、push許可。
