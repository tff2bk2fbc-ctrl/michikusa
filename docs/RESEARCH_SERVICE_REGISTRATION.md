# リサーチサービス登録台帳

最終更新: 2026-08-21（Asia/Tokyo）

この台帳は、トレンド調査で候補にしたサービスの登録状態と、登録前に必要な判断を記録するものです。登録できたことと、本番接続・APIキー利用が許可されたことは別です。

## 登録・接続の判断

| サービス | 登録URL | 登録だけ | APIキー発行/利用 | 今回の扱い |
| --- | --- | --- | --- | --- |
| Google Trends API alpha | [公式申請](https://developers.google.com/search/apis/trends) | 申請送信済み | 承認後に別審査 | 承認待ち |
| DataForSEO Trends | [公式登録](https://app.dataforseo.com/register) | 無料登録・メール確認 | 試用残高と従量課金。Secret管理が必要 | 承認前は保留 |
| SerpApi | [無料登録](https://serpapi.com/users/sign_up?plan=free) | 無料枠あり | APIキー発行。月額プランへの変更を禁止して確認 | 承認前は保留 |
| GDELT Cloud | [公式登録](https://gdeltcloud.com/auth/sign-up) | メール/Google登録 | APIキー発行。料金・クォータを確認 | 承認前は保留 |
| GDELT Project | [公式API案内](https://www.gdeltproject.org/) | アカウント不要 | User-Agent等の利用条件を守る | 登録不要、接続は別審査 |
| Wikimedia/Wikidata | [利用ポリシー](https://www.mediawiki.org/wiki/Wikimedia_APIs/Access_policy) | アカウント不要 | User-Agent必須。OAuthは必要時のみ | 登録不要、接続は別審査 |
| YouTube Data API | [Google Cloud Console](https://console.cloud.google.com/apis/library/youtube.googleapis.com) | 既存Google Cloudプロジェクトを利用可能 | API有効化/APIキー発行。キー制限が必要 | 既存プロジェクトで保留 |
| X API | [Developer Console](https://console.x.com/) | Xログイン・開発者申請 | 従量課金、Developer Agreement、credentials | 支払い・規約確認まで保留 |
| JAPAN 47 GO | [提供元](https://kankou-data.nihon-kankou-dx.info/) | 問い合わせ/契約が必要 | 提供条件・料金を個別確認 | 問い合わせ前に保留 |
| JNTO/観光庁統計 | [JNTO統計](https://statistics.jnto.go.jp/) | データセットごとに確認 | APIではなく利用条件・出典確認 | 登録不要の範囲で台帳化 |

## 今回自動で進めていない理由

1. DataForSEOは登録時に試用残高が付与され、APIを実行すると残高を消費します。現在の本番接続承認前に資格情報を発行すると、保管・漏えい・誤実行の管理対象が増えます。
2. SerpApiは無料枠がありますが、Google Trendsデータの保存・派生集計・再表示について、サービス規約とGoogle側の条件を確認する必要があります。
3. GDELT CloudもAPIキー発行後は、料金・クォータ・保存範囲を確認してからcollectorへ接続する必要があります。
4. Xは従量課金とDeveloper Agreementがあるため、費用上限と利用目的を決めずに登録・credentials発行を行いません。
5. YouTubeは既存のGoogle CloudプロジェクトへAPIを有効化できますが、キー発行・クォータ消費・YouTubeの表示/削除規則を確認してから実施します。

## ユーザー操作が必要なもの

- DataForSEO：登録メールの認証、Terms/Privacyへの同意、支払い方法を追加するかどうかの判断
- SerpApi：メールまたはGoogleでの登録、Termsへの同意、Freeのままにする確認
- GDELT Cloud：メール認証、APIキー生成の明示操作
- X：Xアカウントでの開発者申請、利用目的、Developer Agreement、課金設定
- YouTube：Google Cloud ConsoleでAPI有効化とAPIキー制限の確認
- JAPAN 47 GO：商用利用・保存・派生集計・再表示の問い合わせ

## 登録後の必須保管ルール

- APIキー、Basic認証、OAuth secretはGitHub、モバイルアプリ、D1、R2、ログへ保存しない
- Cloudflare SecretまたはGoogle Secret Managerだけに置く
- 登録直後にキーを本番Workerへ設定しない
- `provider + query + region + period` の重複を止める
- 日次・月次の費用上限とkill switchを先に設定する
- 外部APIのrawレスポンスを保存せず、許可された集計値だけを保存する
- 規約終了・削除要求時に派生データまで削除できるようにする

## 次の判断

Google Trends alphaの承認通知を待つ間は、無料・無通信のfixtureとschemaだけを維持します。承認後、次の順で1サービスずつステージング審査します。

1. Google Trends alpha（承認された場合）
2. DataForSEO（商用利用・再表示・保存条件を契約確認後）
3. GDELT集計（記事本文・画像を保存しない）
4. Wikimedia/Wikidata（User-Agent・ライセンス表示を整備）
5. SerpApi、X、YouTubeは必要性と費用を再評価
