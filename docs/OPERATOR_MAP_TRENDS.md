# 地図上部の急上昇ワード運用

この機能は、外部サイトを自動取得するものではありません。運営者が確認した急上昇ワードを最大3件まで手動で公開し、地図検索欄の上に表示します。

## 公開される情報

一般のアプリ利用者へ返すのは、次の3項目だけです。

- 表示順
- 表示名
- タップ時に検索する語

確認元、確認日、運営者Firebase UID、監査履歴は公開APIから返しません。端末からGoogle Trendsや他の外部サービスへ自動接続する処理もありません。

## 初回の運営者設定

`migrations/0006_operator_map_trends.sql` を本番D1へ適用しただけでは、誰も運営者になりません。安全側の初期状態です。

1. Firebase Console の **Authentication → Users** で、自分のアカウントの **User UID** をコピーする。
2. Cloudflare Dashboard の **Workers & Pages → broad-wildflower-9e30 → D1 → michikusa-db → Console** を開く。
3. 次の `YOUR_FIREBASE_UID` だけを自分のUIDへ置き換えて実行する。

```sql
INSERT INTO trend_admins (firebase_uid, role, enabled, created_at, revoked_at)
VALUES ('YOUR_FIREBASE_UID', 'trend_editor', 1, unixepoch('now') * 1000, NULL)
ON CONFLICT(firebase_uid) DO UPDATE SET
  role='trend_editor', enabled=1, revoked_at=NULL;
```

Firebase UIDはメールアドレスではありません。Appleのメール非公開設定やメールアドレス変更の影響を受けない、Firebaseが発行した識別子を使います。

権限を止めるときは、次を実行します。

```sql
UPDATE trend_admins
SET enabled=0, revoked_at=unixepoch('now') * 1000
WHERE firebase_uid='YOUR_FIREBASE_UID';
```

## 使い方

運営者許可リストに登録されたアカウントでログインすると、プロフィールの **編集** を開いた先にだけ **運営者 → 急上昇ワード** が表示されます。通常の利用者にはこの入口は表示されず、APIを直接呼んでも403になります。

各枠で設定する内容は次の通りです。

- **地図に表示する言葉**: 検索欄の上に見せる短い言葉
- **タップ時に検索する言葉**: タップ時に地図検索へ渡す語
- **確認日**: 運営者がトレンドを確認した日
- **確認元**: 運営用の記録。一般利用者には非公開

空欄の枠は公開されません。3枠すべてを空欄にして保存すると、急上昇ワード帯そのものを非表示にできます。

## セキュリティ境界

```text
通常利用者
  └─ GET /api/public/map-trends
       └─ 最大3件の表示名・検索語だけ

ログイン済み運営者
  └─ Firebase ID token の署名・期限・発行元・audience検証
       └─ D1 trend_admins のFirebase UID照合
            └─ GET / PUT /api/admin/map-trends
                 └─ 保存操作を map_trend_audit に記録
```

管理者判定をクライアントのメールアドレス、URL、隠しボタン、リクエスト本文の `admin=true` に依存させてはいけません。
