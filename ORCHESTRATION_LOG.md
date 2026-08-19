# Codex オーケストレーション記録

更新日: 2026-08-06（Asia/Tokyo）

## 目的

`spota` の単一HTMLを機能別ファイルへ分割し、公開前に問題となる認証、認可、課金DoS、位置情報、画像検査、外部依存の脆弱性を確認・対策する。

## 作業の流れ

1. `CODEX_HANDOFF.md` を確認し、設計原則、読み込み順、既知課題、検証規約を整理した。
2. GitHubの `main` を取得した。引き継ぎに記載された分割版が未反映で、GitHub側は3,072行の単一 `public/index.html` だった。
3. 提供された `files.zip` の13ファイルを検査し、`public/` へ分割版を反映した。
4. 全JavaScriptの構文、DOM ID参照、Service Worker、Cloudflare Workerを検査した。
5. セキュリティ専門担当が読み取り専用レビューを行い、重大度と攻撃経路を整理した。
6. Worker担当とフロント担当を分離して並行実装し、主担当がAPI契約と差分を統合した。
7. 修正後に別担当が再レビューし、分担間の不整合と競合条件を追加検出した。
8. 主担当が再レビュー指摘を修正し、Wranglerのdry-runとローカルHTTP検証を実施した。

## 担当とモデルの使い分け

### 主担当（Codex）

- 引き継ぎとソースの統合
- 分割版の反映
- エージェント間のAPI契約調整
- 認証付きGoogle API呼び出しへの統一
- 写真アップロード再試行、認証画像表示、TOCTOU対策、画像シグネチャ確認
- Cloudflare Static Assets向け `_headers` の追加
- 全体検証、記録、コミット、push

### Workerセキュリティ担当（`gpt-5.6-sol` / high）

- Firebase認証境界
- Photo IDOR/BOLA
- 投稿・画像の容量、件数、頻度、総量制限
- D1 quota/rateカウンタの原子化
- Google Places、Vision、Geminiの保護
- Nominatim中継、キャッシュ、座標丸め
- Push・タグの座標精度
- Hotpepper、楽天、画像proxyの制限
- サーバー側画像モデレーション

### フロントセキュリティ担当（軽量モデル）

- Nominatim直接通信を同一Origin APIへ変更
- Vision判定をfail-closedへ変更
- 有料APIを認証付き `api()` 経由へ変更
- `exifr` のバージョン固定
- JavaScript構文とDOM ID参照の確認

### 独立セキュリティレビュー担当（`sol` 系）

- 初回の脆弱性レビュー
- 修正後の認証・認可・競合・データ消失の再レビュー
- コード変更は行わず、根拠と再現経路を主担当へ報告

## 主な変更

- フロントを `app.css`、`boot.js`、`lazy.js`、`core.js`、`map.js`、`place.js`、`data.js`、`native.js`、`post.js`、`sync.js`、`ui.js`、`sw.js` に分割した。
- Google Places、Vision、Gemini、Push、タグ、写真APIをFirebase認証後へ移動した。
- 写真更新時に `photo_id`、`user_id`、`post_id` を照合し、他ユーザーの写真を更新できないようにした。
- 画像のContent-Lengthと実バイト数、MIME、画像シグネチャ、1投稿枚数、時間・日次・総容量を制限した。写真品質調整後は原本25MB、表示用8MB、サムネイル1.5MB、日次300MB、累積5GBとしている。
- 投稿本文と座標の検証、投稿・編集頻度制限を追加した。
- D1のquota/rate加算を単一SQL文にした。
- Vision失敗、キー未設定、上限到達時は公開を許可しないようにした。
- 公開画像はWorker自身も検査し、判定不能時は投稿を非公開へ戻すようにした。
- Push payloadから正確な緯度経度を除去し、タグ経路も投稿者の公開精度を適用した。
- ブラウザからNominatimへ直接送らず、WorkerでIPハッシュ制限、全体制限、キャッシュ、座標丸めを適用した。
- Hotpepper、楽天、画像proxyに入力・回数・応答容量制限を追加した。
- 写真アップロードのHTTPエラーを同期成功扱いせず、同じ投稿ID・写真IDで再試行するようにした。
- Bearer認証が必要なタグ写真を、認証付きfetchからBlob URLへ変換して表示するようにした。
- 外部 `exifr` のバージョンを `7.1.3` に固定した。
- Cloudflare Static Assets用 `_headers` でCSPなどのセキュリティヘッダーを設定した。

## 検証結果

- `node --check src/index.js`: 成功
- `node --check public/*.js`: 全ファイル成功
- DOM ID参照照合: 参照28件、欠落0件

## 2026-08-18 専門部署体制の新設

ユーザー要望に基づき、実在の人材を採用したと誤認させない形で、Codexオーケストレーション上の仮想専門部署を正式化した。新設・正式化した部署と責任範囲は `docs/DEPARTMENTS.md` に記録している。

- デザイン本部: 写真・地図中心のWeb/iOS/Android体験、デザイントークン、モーション、アクセシビリティ。UI変更の受入条件を作成する。
- 写真メディア・画像基盤室: EXIF GPS、原本/表示用/サムネイル、色空間、圧縮、公開精度、所有者確認、R2/D1整合性。
- iOS/Androidネイティブ室: Appleログイン、APNs/FCM、カメラ/写真/位置情報権限、縦画面、端末ライフサイクル。
- 地図・地理情報室: 初期位置、ピン/サムネイル、クラスタ、ズーム、地図テーマ、逆ジオコーディング。
- バックエンド・データ信頼性室: 写真保存、共有マップ、タイムライン、DM、冪等性、リトライ、migration。
- セキュリティ・プライバシー室: 認証/認可、位置情報、IDOR、APIキー、課金DoS、CSP、依存関係。push前の必須ゲート。
- 品質保証・実機検証室: iPhone/Android実機、権限状態、通信断、クラッシュ、視覚回帰、写真保存を検証する。
- 運用・SRE/コスト室: 起動障害、quota、R2/D1/Firebase使用量、アラート、バックアップ、ロールバック、料金上限。
- 法務・コンプライアンス室、税務・会計・事業管理室: 規約・特商法・ライセンス・個人情報、料金・消費税・従量課金をレビューする。

実在する「ヘッドハンティング」や雇用・委託契約は実施していない。採用が必要な場合は `docs/DEPARTMENTS.md` の能力要件を求人・委託仕様書としてユーザーが契約手続きを行う。必須部署の承認と実機検証が揃わない変更は、今後もpush・デプロイしない。

## 2026-08-18 AI社員の任命

ユーザーの補足により、ヘッドハンティング対象は実在の人材ではなくAI社員であることを確認した。デザイン本部ヘッドとして高性能の専門エージェント `design_director` を任命し、写真・地図中心のWeb/iOS/Android UI、モーション、色、アクセシビリティ、DESIGN.md準拠の初回監査を依頼した。

既存の `legal_review` と `tax_review` はそれぞれ法務・コンプライアンス室、税務・会計・事業管理室のAI社員として継続配置している。主担当Codexがオーケストレーション責任者となり、他部署は必要な作業ごとに専門役へ切り替える。AI社員へ外部サービスの管理者権限、秘密鍵、課金設定、GitHub push、本番デプロイを単独で許可しない。

`design_director` の初回監査結果では、P0をホーム地図、写真追加・保存、地図上の写真表示、長時間ロードに設定した。画面ごとに保持要素・変更要素・変更禁止のAPI/認証/公開範囲/位置精度を記録し、loading・empty・error・offline・権限拒否・再試行・完了を受入条件へ含める。写真はサムネイル、EXIF、色空間、向き、画像メモリを確認し、地図はピン・クラスタ・ズーム・固定ナビ・片手操作・Safe Areaを実機で確認する。デザイン本部の承認単独ではpushを許可せず、QA、セキュリティ、法務/SREの必要なゲートを通す。

## 2026-08-18 通知モニターAPIがないように見える問題の切り分け

- ユーザーの実機で通知モニターテストを開始したところ、APIが存在しない旨の表示が出た。
- ローカルの `src/index.js` には、認証後の `POST /api/monitor/run`、`POST /api/monitor/receipt`、`GET /api/monitor/:run_id` が実装されている。通知モニターのクライアント呼び出しも `public/sync.js` とCapacitor同梱版に存在する。
- 本番Workerの読み取り専用確認では、`GET /api/health` が `{"ok":true,"build":"api-43"}`を返した。ローカルソースは`api-44`としているため、Workerが一世代古い。
- 本番の`/sync.js`には`/api/monitor/run`文字列がなく、公開HTMLは`sync.js?v=121`、ローカルHTMLは`sync.js?v=123`だった。アプリ側の新しいUIと、本番Worker・公開資産が同じリリースになっていない。
- `/api/monitor/run`へ認証なしでGETした場合は認証ゲートの401が返る。これはAPI不存在の証拠ではない。実機アプリのPOSTが本番の古いWorkerへ届いた場合、旧Worker側では認証後に該当ルートがなく、404相当になる可能性が高い。
- 結論は、通知許可・Appleログイン・APNs登録の問題ではなく、ローカル実装とCloudflare本番公開のデプロイ不一致である。api-44と同じ静的資産をセキュリティ・QAゲート後に一体で公開する必要がある。
- 今回は本番Worker、GitHub、Cloudflare設定を変更していない。次の公開前に、`/api/health`が`api-44`、公開`sync.js`にモニター呼び出しが存在、認証済み実機で`POST /api/monitor/run`が`device_not_registered`または`fcm_not_configured`等の具体的な状態を返すことを確認する。
## 2026-08-19 リリース前セキュリティ再承認

AIセキュリティ部署がリリースコミットを読み取り専用で再レビューし、GitHub pushとCloudflare反映を`APPROVE`した。通知モニターの認証後配置、`run_id`と`user_id`による所有者制限、日次・読み書き制限、FCM relayのHMAC/timestamp/nonce/body署名、8件/16KiB上限、機微情報拒否、Apple raw nonce、APNs forward、写真所有者照合、Vision fail-closed、EXIF第三者送信なし、秘密鍵・FCM secret・サービスアカウントJSONのGit混入なし、FCM relay依存0件、関連テスト23/23、Wrangler dry-run成功を確認した。

本番反映前の必須作業は、D1 migration `0004_legal_acceptance.sql` → `0005_account_safety_monitor.sql`、Cloudflare secret（`FCM_RELAY_URL`、`FCM_RELAY_SHARED_SECRET`、`GOOGLE_API_KEY`）の存在確認、Worker/Assets一体デプロイ、`/api/health=api-44`確認、実機APNs登録・FCM受付・端末受信・開封・画面確認である。Appleアカウント削除用の再認証は通常ログインと別経路のため、公開後に実機回帰を行う。静的承認は実機通知成功を保証しない。
- `git diff --check`: 成功
- `wrangler deploy --dry-run`: 成功
- Wrangler Static Assets: 14ファイル認識
- ローカル `/api/health`: 200
- 未認証 `/api/gsearch`: 401
- 未認証 `/api/vision`: 401
- 未認証 `/api/tags`: 401
- 未認証 `/api/photo/...`: 401
- 静的HTMLレスポンスのCSP、nosniff、DENY、Referrer-Policy、Permissions-Policy、HSTS: 付与を確認

## 残課題と運用上の注意

- `orig`、`view`、`thumb` はクライアントが別々に送るため、改造クライアントからの迂回を防ぐには各画像の検査が必要で、Vision quotaを1写真あたり最大3回消費する。将来はサーバー側で派生画像を生成する構成が望ましい。
- 外部JavaScriptはバージョン固定したが、SRIと完全セルフホスト化は未実施である。
- Nominatimへの送信元IPはWorkerに隠れるが、約11mへ丸めた座標自体はNominatimへ送信される。国土数値情報をD1へ取り込む自前逆ジオコーディングが最終対策である。
- 総容量5GBは安全側の累積上限であり、削除しても現在は枠を戻さない。共有写真を壊さない参照カウント付きR2 GCは別途必要である。
- Cloudflare WAF、Google Cloud APIキー制限、Firebase App Check、Firebase Security Rules、IAM、課金アラートはリポジトリ外の設定なので、デプロイ前に管理画面で確認する。
- 本記録作成時点ではCloudflare本番へのデプロイは行っていない。

## 2026-08-06 住所データベース着手

- 外部逆ジオコーディングの固定費と位置情報送信を抑えるため、国交省位置参照情報をD1へ取り込む方針を採用した。
- ZIP/Shift-JIS CSVの読込、非代表点・削除行の除外、住所文字列の正規化、整数座標化、約200m格子インデックス、9地域分割、D1投入SQL生成を自動化した。
- 原本と生成SQLを `.gitignore` 対象にし、GitHubへ大容量データをpushしないようにした。
- `/api/reverse` は接続済み住所D1を優先し、未投入・未収録地域のみNominatimへフォールバックする段階移行方式にした。
- この追加作業ではサブエージェントを使用せず、主担当が実装とテストを行った。
- 国交省公式フォームから街区・大字町丁目の最新版を判定する自動取得処理を追加した。利用約款への明示同意フラグがない限り取得しない。
- 大字町丁目CSVは街区CSVと列構成が異なるため、任意列の誤フォールバックを修正した。
- ユーザーの利用約款同意後、2025年度版の街区・大字町丁目を47都道府県、計94 ZIP取得した。全ZIPの整合性検査に成功した。
- 18,071,027代表点を9地域へ変換し、SQLite実容量は全国888MB、最大shardは中部235MBだった。全shardが無料D1の1DB 500MB制限内であることを確認した。
- 9DBすべてで `PRAGMA quick_check` が成功し、東京・霞が関付近の格子検索と住所結合結果を確認した。
# 2026-08-07 公式補助データの取得

- 実行者: Codexメインエージェントのみ（サブエージェント不使用）
- 参照元: 国土交通省、デジタル庁、日本郵便の公式サイト
- 取得: 国土交通省 N03行政区域 2026年版、デジタル庁 全国町字マスター
- 除外: 日本郵便CSV（商用DB組込みの再利用許諾が明確でないため）
- 重複回避: 国土交通省 N02鉄道 2025年版は既存 `k8.zip` を確認し、再取得しなかった
- 検証: 2 ZIPの整合性検査、ファイル容量、SHA-256を確認
- 記録: `docs/DATA_SOURCES.md`

## 2026-08-07 住所・地名機能の拡張

- サブエージェント不使用。主担当がデータ変換、Worker統合、容量・整合性検証を実施した。
- N03の125,130行政区域ポリゴンを約5m許容で簡略化し、D1のSQL文100KB上限内で9地域SQLへ変換した。
- Workerに外接矩形検索、point-in-polygon、市区町村内限定検索、全国導入後の海上判定を追加した。
- 行政区域追加後の最大DBは中部約250MBで、D1の500MB上限内だった。
- デジタル庁ABRを195,130町字へ関連付け、正式名称、町字ID、郵便番号を保持した。
- 鉄道N02・2025年版がCC BY 4.0対象であることを公式ページで確認し、9,046駅を変換した。
- GeoNames日本データをCC BY 4.0の公式配布元から取得し、自然地名22,512件、日本語名を確認できた施設名2,371件を変換した。
- 将来の住居番号・建物単位正式版を追加できる `address_units` 予約スキーマを作成した。未公開データは投入していない。
- 施設の網羅的な検索は既存の認証・quota制限付きGoogle Placesを必要時だけ使用し、非商用の国交省施設データは使わない。

## 2026-08-07 Cloudflare D1本番投入

- 実行者: Codexメインエージェントのみ（この工程ではサブエージェント不使用）。
- 既存のアプリDB `michikusa-db` は変更せず、住所専用D1を9地域分作成した。
- 9DBすべてをAPACへ配置し、Cloudflare公式のリモート投入コマンドでSQLを投入した。
- 全国18,071,027住所代表点を投入し、各DBの `PRAGMA quick_check` がすべて `ok` であることを確認した。
- 本番D1の住所件数は、北海道314,935、東北1,289,879、東京220,220、南関東1,636,609、北関東3,140,492、中部4,987,820、近畿2,622,316、中国・四国1,673,636、九州・沖縄2,185,120。
- 投入後サイズは、北海道24.01MB、東北74.97MB、東京16.22MB、南関東84.17MB、北関東157.25MB、中部256.84MB、近畿137.18MB、中国・四国91.07MB、九州・沖縄117.48MB。すべてD1無料枠の1DB 500MB上限内である。
- 東京DBで行政区域6,904件、ABR町字5,327件、駅9,046件、自然地名22,512件、施設2,371件を確認した。
- 霞が関の検索で `東京都 / 千代田区 / 霞が関二丁目 / 町字ID 0002002` を確認した。
- Workerへ9つのD1 bindingを追加した。同時外部接続上限6本を超えないよう、行政区域検索は6DBと3DBに分け、区域確定後は該当DBだけを検索する。
- 大容量の原本、SQLite、生成SQLは `.gitignore` 対象のままとし、GitHubにはコード、スキーマ、変換ツール、出典記録だけを保存する。
- D1作成・データ投入・検査まで完了。本記録追記時点では、GitHubへの統合およびCloudflare Workerの本番反映は未実施。
- push前にGitHubの `main` が22コミット先行していることを検出し、最新版を取得して住所DB実装をrebaseした。
- 最新版で認証前へ戻っていたVision・通知・タグ操作、有料API、写真ID所有者検査などは、セキュリティ対策版を基準に復元した。
- 最新UIが追加したWikipedia周辺記事APIは、IPハッシュ単位の回数制限とD1キャッシュを付けて統合した。
- フロントのVision呼出しをBearer認証付きへ戻し、タグ写真も認証fetchとBlob URLで表示するようにした。
- 写真同期は同じ投稿ID・写真IDで安全に再試行し、表示用2,560px・JPEG品質0.90、サムネイル512px・品質0.82を維持した。
- 統合後の版はフロント `v77`、Worker `api-26`、Service Worker cache `spota-v4` とした。
- 統合後に全JavaScript構文、重複関数、差分空白、住所変換テスト9件を再検査し、Wrangler dry-runで静的ファイル14件、D1 10 binding、R2、Assets、Firebase変数を確認した。

## 2026-08-08 Wikipedia全国索引の事前解析

- Wikimedia公式ダンプから座標6,086,941 bytes、記事名169,125,785 bytesだけを取得し、約4.8GBの記事本文ダンプと画像本体は取得しなかった。
- 2ファイルのSHA-1を公式チェックサムと照合し、gzip整合性検査にも合格した。
- 全件をメモリへ載せず、座標候補ページIDだけを保持して記事名ダンプをストリーミング結合する解析ツールを追加した。
- 全座標314,386件のうち、earthの主座標168,305件、日本概略範囲内121,632ページ、通常名前空間の非リダイレクト記事119,873件を確認した。
- D1へ保存する記事ID・記事名・整数座標・種別・格子の生データ量は約6.9MBと推定した。索引を含めても数十MB規模の見込みである。
- この段階ではD1・R2への本番投入、Worker変更、commit、pushは行っていない。
- N03行政区域ポリゴンで候補を再判定し、117,571件を9地域へ確定、国外・海上・区域外2,302件を除外した。
- 地域別件数は北海道5,907、東北11,210、東京11,215、南関東8,817、北関東9,715、中部26,211、近畿19,248、中国・四国12,492、九州・沖縄12,756。
- 生成SQLは全国約15.3MB、単独SQLite実容量は全国約10.2MB、最大の中部は約2.2MBだった。
- Cloudflare再認証後、9地域すべてのD1へ投入した。各地域の件数が生成結果と一致し、全DBの `PRAGMA quick_check` が `ok` であることを確認した。
- 投入後の9DB合計は969,326,592 bytes、最大の中部は259,055,616 bytes（無料枠500MBの約52%）。
- WorkerへD1優先の周辺Wikipedia検索を追加した。9DBを同時接続上限に合わせて6+3へ分け、距離順・半径内最大60件を返し、未投入時だけ既存Wikipedia APIへフォールバックする。
- Wrangler remote previewで本番D1を接続し、`api-27` と東京駅周辺60件を `source: jawiki-dump` で取得した。東京ステーションギャラリー35m、東京駅44mを確認した。
- remote previewの初回Wikipedia応答は約3.5秒だった。Wikipedia取得は地図表示後の補助データ読込であり、起動必須経路には追加していない。今後、本番計測に基づき地域DBルーティングとキャッシュを調整する。

## 2026-08-08 片手ズーム復旧

- `ZOOM_HANDOFF.md` を確認し、350ms長押し、移動許容10px、上方向で拡大、速度連動3.5〜12.5段階、8ms振動、`touchcancel`復旧という仕様を維持した。
- 実装は残っていたが、MapLibreと同じイベント伝播段階で処理しており、実機で長押しズームが取りこぼされる可能性があった。
- `touchstart`、`touchmove`、`touchend`、`touchcancel`をキャプチャ段階で監視し、ズーム成立後の`touchmove`だけをMapLibreへ渡さないようにした。
- `map.dragPan.disable()`と`enable()`を必ず対にし、2本指・指を離す・OSによる中断で通常操作へ戻す。
- 右端のズーム目盛りを7px、z-index 65、輪郭・影付きへ変更して視認性を上げた。
- フロント版を`v79`、Service Worker cacheを`spota-v6`へ更新した。

## 2026-08-13 公開前の整合性・セキュリティ修正

- 主担当に加え、攻撃者視点のコード監査、Cloudflare/D1・R2境界の監査、写真アプリUIの監査を別モデルへ分担し、結果を主担当がソース上で再確認してから実装した。
- IndexedDBの思い出と写真指紋をFirebase UID単位へ分離した。ログアウト時は直前のアカウントの端末データを画面から即座に外し、別アカウントへ表示・同期しない。
- 同期開始時のFirebaseトークンとUIDを処理全体へ固定した。Vision・投稿作成・R2の3種アップロードの途中でログアウトや別アカウントへの切替が起きても、新しいユーザーのトークンへ乗り換えない。
- 旧版の所有者不明な未同期データは自動移行せず、ログイン本人が明示的に選んだ場合だけ現在のアカウントへ取り込む。
- 削除はD1の所有者確認付きDELETE成功後に端末から消す。通信失敗時は端末側を残し、同期による復活や削除済みの誤表示を避ける。
- 削除は記録1件単位の確認画面に変更し、写真ライブラリの元写真が残ることを明示した。D1の削除カーソルと端末tombstoneを追加し、別端末にも削除を同期する。中断した削除は次回ログイン時に安全に再試行する。
- 投稿画面に投稿単位の公開範囲を表示・保存し、プロフィールの既定公開範囲はPATCH成功後だけ表示を切り替える。失敗時は以前の設定へ戻す。
- タグ一覧と受諾時に、削除・公開日時・公開範囲・現在のフレンド関係・双方向ブロックを再確認する。非公開投稿への新規タグ付けも拒否する。
- タグ受諾はD1上で1要求だけが受諾IDを取得できる原子的claimを追加し、最終認可・投稿作成・写真参照・accepted更新をD1 batchへまとめた。並列受諾による重複投稿を防ぐ。
- 投稿一覧APIは1回最大100件、通常地図範囲は緯度経度各20度以内、アカウントごと毎時600回へ制限した。座標と先頭写真IDを単一SQLで取得し、投稿数に比例して増えていたD1追加照会を廃止した。
- クラウドから戻した本人投稿はR2の認証済みサムネイルを最大2並列で復元する。アカウント切替中に旧リクエストが完了しても、新アカウントへ混入しない再検査を追加した。
- 本人専用のカーソル付き全履歴APIを追加し、現在の地図範囲外も100件ずつバックグラウンド復元する。全画面viewerを開いた時だけ認証付き`view`画像を取得し、閉じるとBlob URLを解放する。
- プロフィールと場所一覧の小枠では原寸Data URLを直接展開せず、端末内512pxプレビューを使う。原本は投稿表示・クラウド保存用に保持する。
- アルバム取込は同一場所グループの先頭1枚だけを保存して全枚数を処理済みにしていた。選択した各写真を保存し、保存成功した写真だけを処理済みにする方式へ修正した。
- アルバムのクラウド同期は各写真を同時発火せず、`syncUp`の直列キューを1回だけ起動して有料API・R2への瞬間的な集中を避ける。
- フロントを`v91`、Workerを`api-33`、Service Worker cacheを`spota-v18`へ更新し、古いJSが先に表示され続ける問題を避けた。
- 写真GETへ毎時600回・日次3,000回のユーザー上限を追加した。アップロードの回数判定はbody読込前へ移し、サーバー側Vision再検査は公開配信する`view`と`thumb`に限定して25MB原本のbase64化を廃止した。
- soft deleteから30日後、現役投稿が参照していないR2画像だけをCronで最大100件ずつ回収する参照安全なGCを追加した。
- 公開範囲と同じ画面で、フレンド・一般公開それぞれの位置精度（正確／約500m／約2km／位置なし）を確認・変更できるようにした。投稿画面にも実際の位置精度を表示する。
- 全フロントJavaScriptとService Workerの構文検査、Worker構文検査、住所・行政区域テスト9件、`git diff --check`が成功した。本記録時点ではcommit・push・本番デプロイは行っていない。

## 2026-08-14 写真EXIF位置情報の選択フロー

- サブエージェント不使用。主担当が既存の写真選択、Capacitor Camera、地図上の位置選択フローを読み合わせて実装した。
- 単枚の写真選択後、`exifr`でEXIF GPSを読み、緯度・経度の範囲を検証するようにした。
- GPSがある場合は「写真の位置を使う／地図から選ぶ」を確認し、前者はEXIF座標へピンを置く。後者は現在地へフォールバックせず、地図タップまたはピン移動を必須にした。
- GPSがない場合も現在地を自動採用せず、地図上で写真の場所を選ぶモードへ進めるようにした。
- Capacitorでは`dataUrl`だけでなくURIから元画像Blobを取得し、プラグインが返すEXIF GPSも補助的に読む方式へ変更した。ネイティブ側の変換でGPSが失われる可能性を下げた。
- フロント版を`v92`、Service Worker cacheを`spota-v19`へ更新した。
- `public/native.js`、`public/place.js`、`public/boot.js`の構文検査、`npm run check`（9件）、`git diff --check`が成功した。

## 2026-08-14 写真追加の緊急回帰修正

- 主担当に加え、回帰原因、写真追加の画面遷移、Capacitor 8 Camera互換性を3担当へ並行監査させた。各担当はコードを編集せず、主担当が指摘を再現して統合した。
- 直前に変更した`resultType: uri`では、iOS WebViewが一時URIを`fetch`できない場合に例外を握り潰し、カメラ・ライブラリの両方が`null`で終了していた。動作実績のある`dataUrl`へ戻し、GPSはCamera pluginが別途返すEXIFから直接取得する方式にした。
- 本番のContent Security Policyも`capacitor://`画像の読込を遮断していた。Worker応答と静的ヘッダーの`img-src`・`connect-src`へ`capacitor:`を追加し、一括取込のネイティブ画像URLも安全に読めるようにした。
- GPSなしの`null`が`Number(null) === 0`により有効な座標`0,0`と誤判定される不具合を修正し、緯度・経度の存在確認後だけ数値変換するようにした。
- ネイティブでは外部`exifr`の読込を待たずに次の画面へ進み、ブラウザでは待機を4秒で打ち切って手動位置選択へ進む。写真読込・権限エラーも無言で終了させない。
- アルバム一括取込では、Capacitorが各写真について返したEXIFをFileへ保持し、変換後画像からEXIFが消えても撮影座標と撮影日を自動判定できるようにした。画像URL欠落・HTTP失敗も枚数として通知する。
- GPSなしまたは写真の位置を使わない場合は、地図タップかドラッグで場所を選ぶ。ドラッグ用ピンのpointer eventを有効にした。
- 単枚のライブラリ入力から`multiple`を外し、複数写真はアルバム機能へ分離した。
- `tools/photo-flow.test.mjs`を追加し、Data URL受取、EXIF保持、カメラ・ライブラリから追加画面へ進むこと、GPSなし判定、Capacitor EXIF座標変換、CSP、一括取込のEXIF経路を自動検査する。全16テストが成功した。
- フロント版を`v93`、Service Worker cacheを`spota-v20`、Worker API版を`api-34`へ更新した。

## 2026-08-14 地図スタイル読込順序の回帰修正

- 本番画面のスタックトレース`map.js:284`をローカルの`afterStyle`と照合した。地図styleがキャッシュから先に戻ると、後続の`native.js`が宣言する`locDone`と`goHome`を読込前に参照する競合が原因だった。
- `map.js`から`native.js`の変数を直接参照する処理を廃止した。地図側は準備完了フラグを設定し、ネイティブ側は公開した初期化関数を使うため、どちらのファイルが先に完了しても現在地取得を一度だけ開始できる。
- 遅延実行する`autoLoad`にも存在確認を追加し、同種の読込順序エラーを防いだ。
- 回帰テストを2件追加し、フロント版を`v94`、Service Worker cacheを`spota-v21`へ更新した。

## 2026-08-14 リリース前大型更新・第1段階

- ユーザー提供の手書きPDFを全ページ画像化して読み取り、個人地図と公開地図、投稿公開範囲、アルバム、同一地点写真、公開プロフィール、タイムライン、タグ検索、日次発見を要件へ整理した。
- サブエージェントは使用せず、主担当がPDF、Taste Skill、Spota固有`DESIGN.md`、iOS HIG、Webアクセシビリティの順で監査した。
- 既存の地図、写真追加、5つの下部操作、公開範囲、位置精度、フレンド地図、全画面viewerは保持した。
- ログイン後は「みんなの地図」を初期表示し、公開投稿だけを描くようにした。「自分の地図」は非公開を含む本人の全記録だけを描く。写真は常に本人の地図へ保存され、公開を選んだものだけが公開地図にも現れる。
- 同一地点の複数写真は地図ピンの枚数表示と場所シートのまとめ表示へ接続した。公開写真のサムネイルは認証付きで最大2並列、メモリ上24枚までに制限した。
- 既存投稿を使うアルバム、公開・フレンド投稿を使うタイムライン、場所・本文・タグ検索、日替わりの「きょうの景色」、公開プロフィールと写真グリッドを追加した。
- 新しいfeed APIも認証後に配置し、private投稿を除外、双方向ブロックを再確認、位置精度変換後の座標だけを返す。プロフィールbioは本人または公開設定済みの場合だけ返す。
- 公開写真と位置公開を分離した。位置精度が「位置なし」の公開写真はプロフィールとタイムラインには残すが、APIは座標を返さず地図にも描画しない。
- 保存先がまだない「いいね」「コメント」「チャット」「プロフィール画像変更」は、実装済みに見せる仮ボタンを置かず、D1設計と認可を伴う次段階へ分離した。資料内で保留指定の音楽・サブスクも追加していない。
- 360pxと390pxのiPhone幅で地図、アルバム、タイムライン空状態を目視確認し、横はみ出しなし、主要タッチ領域44px以上、ブラウザエラー0件を確認した。
- 全フロントとWorkerの構文検査、住所・行政区域・写真フロー・公開地図の合計22テスト、`git diff --check`が成功した。Wrangler dry-runでも21個の静的ファイル、10個のD1、R2、2個のRate Limiter、AssetsのバインドとWorker bundleを検証した。本記録時点ではcommit・push・本番デプロイは行っていない。

## 2026-08-15 写真中心のモーションと待機表示

- 主担当がユーザー提供の`filmo-interactions.html`、`filmo-loading.html`、`filmo-motion.html`を基準に、Spota固有`DESIGN.md`、Motion Design、Taste Design、Webアクセシビリティの各ルールを照合して実装した。
- 400msを超えた読込時だけ、画面を暗転・遷移・操作遮断せず、中央に96pxのカメラ表示を出す。複数通信の並行カウントと`try/finally`による確実な終了処理を追加した。
- タイムラインの引っ張り更新は中央カメラを使わず、24pxの通常円形スピナーだけを表示する。いいねとフォローはサーバー応答前に反映し、失敗時だけ元へ戻す。
- 写真保存時の地図への着地、現在地から広がる3本の波紋、地図写真から詳細画面への遷移、いいねとフォローの短い反応を追加し、`prefers-reduced-motion`時は静止表示へ切り替える。
- 390×844の実ブラウザで、中央待機表示の背景が透明かつ`pointer-events:none`、更新スピナーが検索欄より上、いいね・フォローに中央待機表示が出ないことを確認した。ブラウザコンソールエラーは0件だった。
- セキュリティ担当は初回監査で、タイムライン再描画時の旧Blob URLと進行中サムネイル通信の蓄積を検出して`BLOCK`した。主担当が再描画・画面閉鎖時の全URL解放、旧通信のAbortController中止、切断画像・旧世代URLの即時解放を追加した。
- 修正後、旧URL解放、旧通信中止、世代不一致、切断画像の即時解放を実行型テストで再現した。全76テストと`git diff --check`が成功し、セキュリティ担当は新規外部通信先、認証・認可変更、CSP緩和、秘密情報、XSS経路がないことを再確認して`APPROVE`した。
- フロント版を`v115`、Service Worker cacheを`spota-v41`へ更新した。本記録をpush前の監査証跡とする。

## 2026-08-15 承認済みモーションプレビューへの忠実再実装

- ユーザー承認済みの`spota-filmo-motion-preview.html`を唯一の基準とし、実装済み画面との差異を数値と実ブラウザ表示の両方で監査した。既存の画面構成、API、認証、公開範囲、位置精度、ナビゲーションは変更していない。
- 400msを超えた読込時だけ表示する中央カメラを、プレビュー通り96pxの外周、44pxの本体、16pxの中央、2.2秒の琥珀色チャージに統一した。画面暗転・画面切替・操作遮断は行わない。
- 写真の地図着地を150pxサムネイル、2.5秒の多段移動、白いカメラフラッシュ、シャッター押下、着地点の58pxリングまで再現した。
- 現在地から広がる波紋を2.4秒の3本構成にし、開始差を0秒・0.8秒・1.6秒として継続表示した。動きを減らすOS設定では停止する。
- 地図写真から詳細への遷移を1.9秒へ統一し、写真の拡大、背景の減光、下部パネルの上昇、既存viewer操作部のフェードをプレビューの時間差へ合わせた。
- タイムラインの更新は係数0.45、最大90px、発火56pxに統一した。更新中は中央カメラを出さず、24pxの通常円形スピナーだけを表示し、更新後の先頭カードを0.55秒で着地させる。
- いいねは76pxハート、0.95秒、粒子0.8秒、件数ロール0.4秒へ合わせた。連続操作時の`24→25→24`でも古いタイマーが表示を上書きしないようにした。フォローは44px以上の操作領域、0.45秒のラベル切替、0.4秒のチェック描画へ合わせた。
- 実ブラウザを360×780、390×844、412×915で確認し、横はみ出し0、コンソールエラー0を確認した。中央カメラの透明背景、写真着地150px、波紋3本の時間・遅延・無限反復、詳細遷移の途中状態を計測した。
- 通信先を監査し、追加された外部通信はないことを確認した。全78テスト、`git diff --check`が成功した。セキュリティ担当は秘密情報、CSP、認証・認可、公開範囲、位置精度、XSS、二重送信、タイマー・Blob解放を再確認し`APPROVE`した。
- フロント版を`v116`、Service Worker cacheを`spota-v42`へ更新した。本記録をpush前の監査証跡とする。

## 2026-08-15 指定7項目の本番再現・写真地図描画の実機回帰修正

- ユーザー提示のGitHub Desktop 3.6.3 URLはアプリ本体の配布ZIPでありSpotaのソースではないため、コード流用元にはしていない。ユーザーが承認済みの`outputs/spota-filmo-motion-preview.html`と、元資料`filmo-interactions.html`、`filmo-loading.html`、`filmo-motion.html`を唯一の見た目・時間値の基準にした。
- 既存のSpota地図、API、認証、公開範囲、位置精度、5項目ナビゲーションは保持し、指定された7項目だけを監査・実装した。Taste Designは情報設計を変えず、写真を主役にする寸法・余白・動きの整合確認にのみ使用した。
- 400msを超えた処理だけに96pxの待機カメラを出し、発火元を「初回地図ロード」「初回現在地取得」「サーバー写真の詳細取得」の3系統へ限定した。短い保存、いいね、通知、タイムライン更新には中央カメラを出さない。
- 地図ロードはMapLibreの`style.load`後に写真レイヤーを登録し、最初の`idle`で待機表示を閉じる。初回現在地は成功・拒否・失敗の全経路を`finally`で閉じる。写真詳細は認証済み`/api/photo/:id/view`のBlob取得完了後だけviewerを開き、失敗時は既存サムネイルへ安全に戻す。
- 地図写真を承認プレビューと同じ54×62px、写真48px、白枠3px、角丸15px、白い尾10pxの2倍密度Canvasへ変更した。写真あり記録では通常ピンを重ねず、画像準備中は専用の小点を残す。
- 近接写真と同一座標の写真を、46px黒円、白枠3px、白い14px数字へ統一した。MapLibreの数値`text-field`と存在しない既定フォントが写真ソース全体を無効化していたため、`to-string`と実在する`Noto Sans Bold / Regular`を明示した。写真専用ソースを`spota-photo`へ分離し、`clusterMaxZoom:23 / maxzoom:24`で最大ズームでも同一地点の数字を保持する。
- いいねは90px領域内の76pxハート0.95秒、白粒子7個0.8秒、小ハート0.8秒、件数0.4秒へ合わせた。実ブラウザで10アニメーションの同時発火、`24→25`、失敗時のロールバックを確認した。
- Playwrightで360×800、390×844、412×915を検証し、写真サムネイル、近接4枚の「4」、同一地点2枚の「2」、通常ピンとの二重描画0件を確認した。850msの写真取得では460ms時点で待機カメラだけが表示され、取得後にBlob写真viewerが開くことを確認した。900msの地図遅延と850msの初回GPS遅延でも、ラベルと終了状態を実測した。
- 新規ブラウザ状態でフロント`v120`の地図準備完了、待機表示終了、コンソールエラー0・警告0を確認した。全JavaScript構文検査、`git diff --check`、Wrangler 4.123.0 dry-run（静的34ファイル、D1×10、R2、Rate Limiter、Assets）が成功した。
- セキュリティ担当は初回監査で、写真詳細の取得中に閉じる・ログアウト・アカウント変更・別写真を開くと旧認証通信が残り得る競合を検出して`BLOCK`した。主担当はpending通信をAbortController、serial、現在認証、20秒timeoutで管理し、close時の通信中止と待機終了、Blob URL解放、表示後の隣接写真通信の中止を追加した。
- 「pending中に閉じる」「pending中のアカウント変更」「写真A→Bの並行open」「応答しない通信のtimeoutとloader終了」の4ケースを実行型テストへ追加した。全82テスト成功後、セキュリティ担当はサーバー認可、公開範囲、位置精度、新規通信先、CSP、秘密情報、XSSを再確認して`APPROVE`し、この差分のpushを許可した。
- フロント版を`v120`、Service Worker cacheを`spota-v46`へ更新した。本記録をpush前の監査証跡とする。

## 2026-08-16 A案の写真集合表示・低ズーム省メモリ化

- ユーザーが選択したA案を基準に、複数写真を56×60pxの代表写真と右上23pxの件数バッジで表示した。11px相当の白文字、2px相当の白枠、13px角丸、10pxの尾を2倍密度Canvasで描き、単一写真では件数を出さない。
- ズーム6付近で写真が消える原因だった「現在の表示範囲だけを抽出し、中央から近い80件へ毎回切り詰める」処理を廃止した。写真の座標・件数は最大1,600地点まで安定した順序でGeoJSONへ保持し、MapLibreのクラスタリングへ渡す。
- 低ズームでは写真画像を一枚もデコードせず、座標と合計件数だけを黒丸へ描く。ズーム12以上になった時だけ、画面内36写真と画面内24クラスターを上限にA案サムネイルを生成する。
- 元画像デコードは最大3並列、MapLibreへ登録するCanvas画像は最大72個に制限した。写真ピン1個のImageDataは128×140×4 bytes（約70KiB）のため、登録画像のCPU側生データは概算約4.9MiBを上限とする。低ズームへ戻ると座標データを維持したまま登録画像と待機キューを0へ解放する。
- 画像解放を`setData`より先に行うと旧フレームが削除済みiconを参照することを実ブラウザで検出した。軽量データ更新後120ms待ってから解放する順序へ直し、MapLibreのmissing image警告が出ないことを再確認した。
- 390×844の実ブラウザへ480件を投入し、ズーム5.9と6.1の双方で合計480件、生成画像0、表示クラスター維持を確認した。ズーム14では生成35個、A案クラスター7、同一地点A案1、失敗0。低ズームへ戻した後は生成画像0、待機0、overlay0へ戻った。
- 1,600件の負荷試験では低ズームの生成画像0、ズーム14で画面内写真36、集合24、生成画像61に収まり、移動後もLRU上限72を超えなかった。既存API、認証、公開範囲、位置精度、外部通信先は変更していない。
- 全JavaScript構文検査と全82テスト、`git diff --check`が成功した。360×780、390×844、412×915の実ブラウザで横はみ出し0、A案の寸法、ズーム往復、画像解放を確認した。
- CapacitorのWeb資産をローカルのiOSプロジェクトへ同期し、iOS Simulator向けDebugビルドが成功した。Wrangler 4.123.0のdry-runでも静的34ファイル、D1×10、R2、Rate Limiter、Assetsのバインドを維持していることを確認した。
- セキュリティ監査では、新しい外部通信先、API、認証・認可変更、CSP緩和、秘密情報、HTML注入経路がないことを確認した。写真の読込元は既存の同一オリジン／Worker制限を維持し、差分のpushを`APPROVE`した。
- フロント版を`v121`、Service Worker cacheを`spota-v47`へ更新した。本記録をpush前の監査証跡とする。

## 2026-08-16 A案再実装・ズーム消失とiOS反映ミスの是正

- ユーザー提示のGitHub Desktop 3.6.3 URLはソースコードではなくインストーラZIPのため、再現元に使用していない。ユーザー承認済みの`outputs/spota-cluster-number-options.html`のA案を唯一の数値基準とした。
- `v121`が実機で変わって見えなかった主原因を4点特定した。単写真表示がズーム12以上に限定されていたこと、サーバー記録が`server_photo_id`のみで表示候補にならなかったこと、MapLibre Workerのクラスタ計算を固定70msだけ待っていたこと、GitHubリポジトリのWeb資産とXcodeのCapacitor同梱資産が一致していなかったことである。
- A案は写真56×60px、外側領域64×70px、白枠3px、角丸13px、尾10px、バッジ23px以上、白枠2px、数字11px相当、写真影0 2px 9px rgba(5,5,7,.30)を2倍密度Canvasで再現した。読込待ちの小丸がカード下からはみ出す差異も、ready時は透明化して解消した。
- 個別写真の開始ズームを6へ下げ、ズーム6.01から20へ上げても選択済み36枚が消えない実行テストを追加した。座標は最大1,600地点を安定して保持する。
- サーバー写真は、画面内候補になった時だけ既存の認証付き`/api/photo/:id/thumb`を使う。同じ写真IDは1通信にまとめて複数レコードへ結果を共有する。待機32件、同時2通信、Blob URL 36件、Canvas画像72件、画面内単写真36件、集合24件、デコード3並列を上限とした。アカウント変更時は待機列とBlob URLを無効化・解放する。
- MapLibreの`sourcedata`完了通知でクラスタ代表写真を再評価し、遅い端末でも固定時間の経過だけで打ち切らないようにした。認証が写真ソースより後に準備された場合は、認証確定後に一度だけ再描画する。
- iOS Simulatorに同一地点4枚と2枚の検証データを一時投入し、A案の写真カード、右上の`4`・`2`、余分な大数字丸の非表示、写真読込・MapLibre登録エラー0件を目視確認した。検証データと診断表示は最終ビルドから完全に除去した。
- 全86テスト、JavaScript構文検査、`git diff --check`、iOS Simulator Debugビルドが成功した。リポジトリ、ネイティブアプリの`public`、Xcode同梱`public`、ビルト済み`App.app/public`の`index.html`・`map.js`・`release.js`・`sync.js`・`sw.js`をSHA-256相当で一致確認した。
- セキュリティ再監査で、新規外部送信先、CSP緩和、認証前API、公開範囲・位置精度の変更、秘密情報、HTML注入経路がないことを確認した。写真GETは既存の所有者・public/friends/private・ブロック・モデレーション・回数制限を経由する。
- フロント版を`v122`、Service Worker cacheを`spota-v48`へ更新した。ユーザーの「完全に一致するまでpushしない」指示に従い、本記録追記時点でcommit、push、Cloudflareデプロイはいずれも行っていない。

## 2026-08-17 初回起動・規約同意・一度限りのログアウト

- サブエージェントは使用せず、主担当がMobile App Design、iOS HIG、Forms、Content Design、Touch/Keyboard、Live Region、Taste、Color Contrast、Light/Dark、Playwright、Security Best Practices、Cloudflare Workers/D1の各手順を順に適用した。
- 初回起動を「説明、通知、写真・カメラ、位置、規約同意、ログイン、利用者IDとアイコン」の7段階に分けた。権限は説明後の本人操作でだけ要求し、各権限はスキップ可能にした。
- 利用規約とプライバシーポリシーを現行実装に合わせて作成し、同意した文書版と時刻を端末および認証後のD1へ記録する経路を追加した。サーバーは現行版への同意だけを受理する。
- この初回案内版では既存ログインを一度だけ解除し、途中位置を規約版ごとのキーへ分離して最初の説明画面から開始する。push tokenと認証だけを解除し、投稿、写真、IndexedDB、サーバーアカウントは削除しない。
- 同意前の地図style、tile、現在地、周辺データ、同期を遅延させた。390×844の実ブラウザで同意前の動的外部/API通信0件、完了後の地図通信開始、地図ready、コンソールエラー0件を確認した。
- セキュリティ監査で、任意の文字列を規約版としてD1へ記録できる問題と、削除依頼を公開GitHub Issuesへ誘導する問題を検出した。前者は現行版の完全一致検証、後者は個人情報を公開Issueへ書かない注意と非公開窓口の公開前必須化により修正した。
- 全91テスト、Wrangler dry-run、iOS Simulator Debug buildが成功した。本番D1 migration、commit、push、Cloudflare deploy、実アカウントの投稿・DM・いいね・通知・フラッシュ通信テストは行っていない。

## 2026-08-17 Appleログイン・削除・通報・本番通信モニター

- サブエージェントは使用せず、主担当がApple/Firebase公式仕様、Cloudflare Workers/D1、iOS HIG、Forms、Live Region、Touch/Keyboard、Content Design、Security Best Practicesを順に照合した。機能の出典は `public/sync.js`、`public/onboarding.js`、`public/native.js`、`public/release.js`、`src/index.js`、`migrations/0005_account_safety_monitor.sql` である。
- Appleログインを初回案内とプロフィールへ追加した。iOSはCapacitor Firebase Authentication、WebはFirebase OAuthProviderを使い、GitHubから再現するentitlementとXcode capabilityを `native/ios/apply-to-capacitor.sh` に追加した。
- アプリ内アカウント削除へ10分以内の再認証、Apple token revocation、確認語、回数制限、Firebase Auth削除、D1 cascade、共有R2 object保護、50件単位の再開可能な削除、削除済みID tokenによる再作成防止を追加した。
- 投稿・利用者通報へ認証、閲覧認可、理由allowlist、500文字上限、1日20件、操作IDの重複防止を追加した。通報UIは非所有投稿だけに表示する。
- 専用botによる通信モニターを追加した。投稿、DM、いいね、Flash、アプリ内通知、FCM Pushを実データ経路で作り、15分後にモニター所有artifactだけを削除する。別利用者のモニターいいねを消す競合は最終監査で検出し、対象投稿単位へ修正した。
- Pushの成功判定をFCM受付、端末受信、通知開封、画面上の目視確認に分けた。FCM service accountはproject一致と鍵形式を検証し、通知payloadへ正確な座標や端末tokenを含めない。
- 本番D1を586,021 bytesでバックアップ後、`0004_legal_acceptance.sql` と `0005_account_safety_monitor.sql` を適用した。6テーブル、通報表の2列、外部キー違反0件を確認した。
- 実行時だけ発生するアカウント削除job IDの未定義参照を最終監査で検出し、明示的なUUID生成と回帰検査を追加した。FCM OAuth交換も生成RSA鍵を使った実行型テストへ追加した。
- `FCM_SERVICE_ACCOUNT` はCloudflareに未登録、本番D1のpush tokenは0件、物理iPhoneは未接続である。このためコードとD1は承認したが、実機Push通知とGitHub pushによる自動公開は承認していない。外部設定後、通信モニターの4段階確認が完了してから判定を更新する。

## 2026-08-17 FCM鍵レス中継の自動化準備

- ユーザーが選択した「サービスアカウントキーを作らない」方針を、Cloudflare WorkerからGoogle FCMへ直接秘密鍵署名する旧経路ではなく、Cloud Runの実行時サービスアカウント（ADC）へ分離した。Cloudflare側にはGoogle秘密鍵を置かず、WorkerはCloud RunへHMAC-SHA-256署名付きHTTPSだけを送る。
- Workerの通知上限（1宛先日100件、全体時間上限、最大8端末）を維持し、Cloud Run側でも本文16KiB、最大8メッセージ、通知長、dataキー、緯度経度・メール・IP等の機微キーを検証する。timestamp（5分以内）とnonceの再利用を拒否し、無効FCM登録tokenだけをD1削除対象として返す。
- `services/fcm-relay/` にCloud Run用のNode 22イメージ、Google Auth Library、Dockerfile、Secret Manager注入用のデプロイ手順、再現可能な`deploy.sh`を追加した。サービスアカウントJSON、APNs鍵、FCMアクセストークンをファイル・Git・Wrangler varsへ保存しない。
- セキュリティ担当は、旧`FCM_SERVICE_ACCOUNT`経路の削除、HTTPS URL強制、HMAC署名、リプレイ、本文上限、機微data拒否、FCM `UNREGISTERED`の限定削除を検証し`APPROVE`した。Cloud RunはHMACなしでは送信処理へ到達できないが、複数インスタンス／再起動をまたぐnonce完全防止は将来Durable ObjectまたはFirestoreへ移行する課題として記録した。
- `npm audit --prefix services/fcm-relay --omit=dev` は0件、FCM relay単体3テスト、既存を含む全101テスト、JavaScript構文検査が成功した。Google Cloud CLIはこのMacに未インストールだったため、サービスアカウント作成、Secret Manager、Cloud Runデプロイ、Cloudflare secret投入、Worker公開は実行していない。
- 現在の公開判定は、コード・テスト`APPROVE`、Google Cloud外部設定`BLOCK`、実機Push確認`BLOCK`、GitHub push／Cloudflare公開`BLOCK`。`services/fcm-relay/README.md`の順でGoogle Cloud設定と実機4段階確認を終えた後に再審査する。
- secret値を画面へ表示・コピーせず、Secret Managerから標準入力でCloudflareへ渡す`services/fcm-relay/configure-cloudflare.sh`を追加した。`wrangler secret put`はWorker公開を発生させるため、審査前には実行しない。
- Googleアカウント`kouya.sgechan@gmail.com`でCloud CLIを認証し、`michikusa-e34df`へBilling account `012CFB-8F591F-CC46B6`をリンクした（請求に関わるためユーザー明示許可済み）。サービスアカウント`spota-fcm-relay`、`roles/firebasecloudmessaging.admin`、Secret Manager version 1を作成した。
- Cloud Run source deployの不足権限を、Computeサービスアカウントへ`roles/run.builder`、ソースバケットへ対象限定の`roles/storage.objectViewer`として追加し、revision `spota-fcm-relay-00002-t9w`を`asia-northeast1`へデプロイした。`GET /health`は200、署名なし`POST /send`は401で、HMACゲートが実稼働していることを確認した。
- Cloudflare secret登録（`FCM_RELAY_URL` / `FCM_RELAY_SHARED_SECRET`）、Worker公開、GitHub push、実機Pushはまだ実行していない。secret登録はWorker新バージョンを作るため、法務・セキュリティ条件の最終確認後に行う。
- Cloud Run URLとSecret Managerの値を`configure-cloudflare.sh`から標準入力でCloudflareへ渡し、`FCM_RELAY_URL` / `FCM_RELAY_SHARED_SECRET`を1回のsecret bulk更新で登録した。secret一覧に名前だけが存在することを確認し、値は表示・保存していない。本番`/api/health`は`api-43`で応答し、GitHub push前のためWorkerソースはまだ`api-44`へ更新していない。

## 2026-08-17 請求時開示方式への規約更新・法務／税務二重レビュー開始

- ユーザーの自宅住所を公開リポジトリへ直接記載せず、運営者情報（住所・電話番号を含む）を請求があった場合に請求窓口から遅滞なく提供する方式へ、`public/terms.html` と `public/privacy.html` を更新した。運営者名と請求窓口はページ上に明示し、公開GitHub Issuesには個人情報を書かない注意を維持した。
- 日本には「税務省」という名称の省がないため、税務レビューは財務省所管の国税庁の公式資料を基準にする。法務レビューは法務省、個人情報保護委員会、消費者庁の公式資料を基準にする。各担当が独立して検討した後、主担当が根拠と実装差分を相互照合して最終判定する。
- 特定商取引法の課金開始条件、個人情報保護法上の「本人の知り得る状態」、請求窓口の対応時間、バーチャルオフィスの利用条件、収益化時の税務記録を、公開前に二重チェックする。法務・税務レビューが完了するまでcommit・pushは行わない。
- 法務担当の結論は、無料版における請求時開示方式を文書上`APPROVE`、有料販売とSpota全体の個人情報保護法対応を`BLOCK`とした。運用上は正確な住所・電話番号の安全な保管、毎営業日の窓口監視、遅滞ない回答、個人情報の開示・訂正・削除等の内部手続、外部サービスの処理データ・契約主体・処理国・保存期間・削除方法の確認が必要である。根拠は個人情報保護委員会FAQ Q9-1/Q9-26、通則ガイドライン、消費者庁の通信販売広告Q&A、法務省の定型約款資料とした。
- 税務担当の結論は、現在完全無料である限り住所の常時公開は税務上の即時必須事項ではなく、請求時開示方式を維持可能とした。無料期間からAPI、クラウド、ドメイン、Apple/Google費用等の請求書・利用明細・支払日・取引先・用途・外貨換算を保存し、課金・広告開始前に販売主体、税込総額、返金、消費税、インボイス、国外役務の区分を確定する必要がある。根拠は国税庁・財務省の適格請求書、電子帳簿保存、所得区分、消費税、国外役務資料とした。
- 二重レビュー後も、物理iPhoneでのFCM受信・開封・目視確認、請求窓口の実運用、外部サービスのデータ処理確認が未完了のため、セキュリティゲートは`BLOCK`のままとした。今回の規約変更差分、102テスト、npm audit 0件、Wrangler dry-runは成功しているが、commit・push・Cloudflare本番公開は実行していない。

## 2026-08-17 実機Push確認（自動化可能範囲の実行）

- ユーザーの「3」を、(A)自動実行できる静的・サーバー検証、(B)実機画面が必要な検証に分解した。外部ユーザーへ通知を送る操作は行わず、安全な読み取り・拒否確認だけを実行した。
- 自動検証は、`npm run check` 102/102、`git diff --check`、FCM relayの`npm audit`脆弱性0件、Cloud Run `/health` 200、署名なし`/send` 401、本番Worker `/api/health` 200（build `api-43`）、iOS entitlement／capability静的検査、秘密鍵ファイル0件、Wrangler dry-run成功となった。
- Cloudflare D1の`push_tokens`件数は読み取り専用SELECTを実行したが、端末のAPI認可エラー`7403`で取得できなかった。既存監査記録の0件を上書きせず、今回の操作によるD1変更はない。
- Xcode 26.4で、ユーザーの`/Users/shigematsutomoki/michikusa-app/ios/App/App.xcodeproj`を署名なしSimulator向けにビルドし、`BUILD SUCCEEDED`を確認した。Booted iPhone 17 Pro Simulatorへインストールし、`com.damo.michikusa`の起動まで成功した。署名付き実機ビルド、APNs登録、通知許可、受信・開封・画面目視はユーザーのiPhone操作が必要で自動化対象外とした。
- 結論: 自動化可能な範囲は完了。実機4段階（FCM受付・端末受信・開封・目視）の結果が得られるまで、セキュリティ担当のpush許可は`BLOCK`。commit、GitHub push、Cloudflare本番公開は実行していない。

## 2026-08-17 Appleログイン失敗の切り分け

- 利用者からAppleログイン失敗の報告を受け、iOS capability、Bundle ID、FirebaseAuthenticationのApple provider list、GoogleService-Info.plist、Web資産のiOS同梱差分を確認した。Team IDは`Q4684PUCF7`、Bundle IDは`com.damo.michikusa`で、ソースとローカルXcodeプロジェクトの静的設定は一致している。
- 失敗原因を画面から特定できなかったため、Appleの認証コードだけを表示する診断を追加した。トークン・メール・URL・生のAppleエラー本文は表示しない。キャンセル時はログインボタンを再有効化する。
- `npm run check`は103/103成功、iOS Simulator Debug buildは成功、`public/sync.js`と`public/onboarding.js`はiOS同梱版と一致した。
- 次回の実機操作で表示されるコード（例: `auth/operation-not-allowed`、`auth/invalid-credential`、`apple/1000`）を受け取り、Firebase ConsoleまたはApple Developer設定の具体的な修正箇所を確定する。まだGitHub push、Cloudflare本番公開、実機通知送信は行っていない。

## 2026-08-17 Apple nonce不一致の修正

- 実機スクリーンショットで`auth/missing-or-invalid-nonce`を確認した。Apple Developer／Firebaseの外部設定ではなく、ネイティブFirebase認証後にWeb SDKでも同じcredentialを使っていた二重認証が直接原因だった。
- `FA.signInWithApple({skipNativeAuth:true})`へ変更し、AppleのネイティブUIで得たraw nonce付きcredentialをWeb SDKへ一度だけ渡すようにした。これによりnonceの消費済み再利用を防ぐ。
- ソース、ルートWeb資産、iOS同梱Web資産を一致させ、エラーコード表示とキャンセル後の再試行も維持した。`npm run check` 103/103、iOS Simulator Debug build成功。
- 次の確認は、Xcodeでアプリを再ビルドして実機でAppleログインを再試行すること。成功確認前のGitHub push、Cloudflare本番公開、実機通知送信は行っていない。

## 2026-08-17 通知オンなのに通信モニターが開始できない切り分け

- Appleログイン成功後、「アプリの通知はオンだが、通知が許可されていないため通信モニターが起動しない」という実機報告を受けた。
- 通知許可、APNs端末登録、認証済み`POST /api/push/token`によるD1保存は別段階である。旧実装は全失敗をboolean `false`へ潰していたため、設定オンでも発生するAPNs登録失敗・サーバー保存失敗・タイムアウトを誤って同じ文言で表示していた。
- `public/native.js`、`/Users/shigematsutomoki/michikusa-app/public/native.js`、`/Users/shigematsutomoki/michikusa-app/ios/App/App/public/native.js`を構造化結果へ変更した。`permission_denied`、`registration_error`、`registration_timeout`、`token_save_failed`、`plugin_unavailable`等を区別し、`registrationError` listenerを`register()`より前に設定した。成功時だけ`{ok:true,code:'registered'}`を返す。
- サーバー保存がHTTP非成功または通信例外なら、通知設定ではなくサーバー登録の失敗として表示する。APNs token、メール、URL、生のOSエラーはUI・ログへ出さない。8秒以内にtokenが来ない場合はタイムアウトとしてアプリ再起動を案内する。
- `public/sync.js`およびiOS同梱版2箇所の通信モニターは構造化結果の`ok`を確認してから`/api/monitor/run`を呼ぶよう変更した。設定オンなのに登録未完了の状態でテスト投稿・DM・通知を作らない。
- 失敗時は秘密情報を含まない固定コード（`permission_denied`、`registration_error`、`token_save_failed`等）を画面へ添え、次の切り分けで同じ誤表示を繰り返さないようにした。
- `npm run check`: 104/104成功。`git diff --check`成功。3つの`native.js`と3つの`sync.js`一致確認。Xcode Simulator Debug build: `** BUILD SUCCEEDED **`。
- 実機APNs受信、D1 token保存、FCM受付、通知開封、画面目視はまだ完了していない。GitHub push／Cloudflare本番公開は行わず、再ビルドした実機でモニターを再試行して新しいエラーコードまたは4段階成功結果を記録してからセキュリティ判定を更新する。

## 2026-08-18 `registration_timeout`の根本原因修正

- 実機で`registration_timeout`が発生したため、Capacitor Push Notificationsの公式iOS実装要求とプロジェクトのAppDelegateを照合した。
- `AppDelegate.swift`に、iOSのAPNsコールバックをCapacitorのNotificationCenterイベントへ転送する2メソッドが欠落していた。通知許可がオンでもtoken／失敗イベントがJavaScriptへ届かないため、8秒でタイムアウトしていた。
- `native/ios/AppDelegate.swift`を追加し、`native/ios/apply-to-capacitor.sh`から生成アプリへ適用するようにした。ローカル`/Users/shigematsutomoki/michikusa-app/ios/App/App/AppDelegate.swift`にも同じ処理を反映した。
- `didRegisterForRemoteNotificationsWithDeviceToken`は`capacitorDidRegisterForRemoteNotifications`へ、失敗コールバックは`capacitorDidFailToRegisterForRemoteNotifications`へ転送する。これで成功時はtoken保存へ進み、失敗時は`registration_error`を明示できる。
- `npm run check`: 104/104成功。Xcode Simulator Debug build: `** BUILD SUCCEEDED **`。途中の容量不足は一時ビルド（合計4.8GB）だけを整理して解消した。リポジトリとiOS同梱JavaScriptのソースは削除していない。
- 実機で修正後アプリを再ビルドしてAPNs tokenと通信モニター4段階を確認するまで、GitHub push／Cloudflare本番公開／セキュリティ最終許可は保留する。
