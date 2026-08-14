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
