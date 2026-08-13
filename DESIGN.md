# Spota Design System

Version: 1.0  
Scope: iOS / Android向けWebViewアプリとWeb版  
Status: 今後のUI改修に適用。既存画面を一括置換しない。

## 1. Product character

Spotaは、写真と場所を結びつけて、日常の寄り道や旅の記憶を残すアプリである。

### Design read

写真アプリの透明感、地図アプリの実用性、旅の手帳の私的な温度を、静かな日本語UIでまとめる。

### Experience principles

1. 写真が主役。UIは写真と地図を支える。
2. 地図は背景装飾ではなく、常に操作できる情報面である。
3. 位置情報の公開範囲を、見た目でも誤解させない。
4. 旅情は紙、余白、写真、文言で表現し、スタンプ装飾を乱用しない。
5. 速く起動し、片手で扱え、説明を読まなくても次の操作が分かる。

## 2. Brand words

Use:

- 静か
- 写真的
- 親密
- 編集的
- 地図的
- 少し温かい
- 生活の延長にある旅

Avoid:

- 派手なSNS
- ゲーム的
- 高級ホテル風
- 観光予約サイト風
- 無機質な管理画面
- AI生成テンプレート風

## 3. Foundations

### 3.1 Color

既存のCSS変数を基準とし、色を画面ごとに増やさない。

Light:

- Canvas / paper: `#EFEDE8`
- Surface: `#FFFFFF`
- Primary text: `#111111`
- Secondary text: `#787878`
- Divider: `#E6E4E0`
- Soft control: `#F0F0F0`

Dark:

- Canvas: `#121214`
- Surface: `#1E1E22`
- Primary text: `#F2F2F4`
- Secondary text: `#9E9EA4`
- Divider: `#32323A`
- Soft control: `#2C2C33`

Map-supporting colors:

- Moss: `#2E4A3F`
- Water: `#3C5A72`
- Warm paper: `#F1EFE9`
- Destructive only: existing warning red

Rules:

- 1画面の強いアクセントは原則1色。
- 純粋な紫のグラデーションを既定のブランド表現にしない。
- 写真の上に色付きオーバーレイを置く場合、内容認識を妨げない。
- 色だけで公開範囲や状態を伝えない。文字またはアイコンを併用する。

### 3.2 Typography

System stack:

```css
font-family: -apple-system, BlinkMacSystemFont,
  "Hiragino Sans", "Yu Gothic", "Noto Sans JP",
  system-ui, sans-serif;
```

Rules:

- アプリUIはゴシック体を基本にする。
- 明朝体は旅の記録、日付、写真タイトルなど情緒的な短文に限定する。
- 本文は13px未満にしない。補足情報は11.5pxを下限とする。
- 日本語本文の行間は1.55から1.75。
- 見出しは太さと余白で階層化し、過剰に巨大化しない。
- 長文には `line-break: strict` と `overflow-wrap: anywhere` を検討する。
- 日本語本文へ一律の広い字間を設定しない。英字IDや短いブランド表記のみ許可する。
- 絵文字を恒常的な製品アイコンとして使わない。

Suggested scale:

- Screen title: 22px / 700 / 1.3
- Sheet title: 18px / 700 / 1.35
- Primary body: 15px / 400 / 1.65
- UI body: 13.5px / 400 or 600 / 1.55
- Supporting text: 11.5 to 12px / 400 / 1.6

### 3.3 Spacing

Base unit: 4px.

- Tight: 4 / 8px
- Control gap: 8 / 12px
- Component padding: 12 / 16px
- Section separation: 20 / 24 / 32px
- Screen horizontal inset: 16pxを基本、地図上フローティングUIは12pxまで許可

同じ階層では同じ余白を使う。位置合わせのためだけの個別値を増やさない。

### 3.4 Shape

- Input / regular button: 12px
- Result panel / compact card: 16px
- Bottom sheet: top 20から24px
- Large editorial surface / QR card: 24から28px
- Pill: 検索欄、選択チップ、短い状態表示だけ
- 円形: カメラ、現在地、プロフィール写真など意味のある対象だけ

すべてを角丸カードまたはpillにしない。

### 3.5 Depth

- 地図上の操作部品にだけ、地図から分離するための影を使う。
- 通常のシート内カードは、面色、余白、細い区切りを優先する。
- ガラス表現はボトムナビゲーションなど主要な1要素へ限定する。
- blurを重ねない。低性能端末で操作速度を落とさない。

## 4. Photography

- 投稿詳細では、可能な限り写真を大きく表示する。
- 一覧は同じ比率へ無理に切り抜かず、用途ごとに比率を決める。
- 地図ピンのサムネイルは識別性、詳細画面は鑑賞性を優先する。
- 読み込み中はレイアウト寸法を確保し、表示時の跳ねを防ぐ。
- 原寸画像を同時に多数展開しない。表示用・サムネイルを使い分ける。
- 写真の中央へ文字、pill、ロゴを安易に重ねない。
- ユーザー写真から背景色を抽出する場合も、文字のWCAG AAコントラストを守る。

## 5. Map

- 検索、現在地、カメラ、写真ピンが同時に競合しない視覚階層にする。
- 地図ラベルを不透明なUIで必要以上に覆わない。
- 写真ピンはズームに応じて密度を調整する。
- 公開精度が概略の場合、正確な地点に見える表現を使わない。
- 相手の地図へ移動した状態は、誰の地図かを一時表示する。
- 片手ズーム開始領域には恒常的な大きな枠を表示しない。初回説明と触覚・動きで伝える。

## 6. Components

### Buttons

- 1画面の主ボタンは原則1つ。
- 破壊操作は主ボタンと同じ外観にしない。
- アイコンだけのボタンは44x44px以上のタッチ領域とアクセシブル名を持つ。
- ボタン文言は動詞で始める。例: 「写真を追加」「地図を開く」。

### Sheets

- シート冒頭に目的が分かるタイトルを置く。
- 閉じる動作、スワイプ、背景タップの挙動を統一する。
- 重要な選択結果をシートを閉じる前に確認できるようにする。
- キーボード表示時に主操作が隠れない。

### Empty and error states

- 原因と次の行動を短く示す。
- 装飾イラストで空間を埋めない。
- 技術用語、API名、内部IDを通常ユーザーへ出さない。

### QR profile

- ユーザー写真のコラージュは個性の表現として使う。
- QR周囲には十分な白い余白を保つ。
- 写真、ロゴ、装飾をQRのデータ領域へ重ねない。
- 「相手の地図を開く」と「フレンド申請」を別操作として明示する。

## 7. Motion

- Motion intensity: 2 / 5。控えめで、操作結果を説明するためだけに使う。
- 通常遷移: 180から300ms。
- Bottom sheet: 300から420ms。指の動きと連続する easing を使う。
- 写真のフェードは短くし、地図操作中の大きなアニメーションを避ける。
- `prefers-reduced-motion`を尊重する。
- 常時脈動、無意味な浮遊、装飾だけのparallaxを使わない。

## 8. Accessibility and native behavior

- 通常文字はWCAG AAを目標とする。
- タッチ領域は原則44x44px以上。
- Safe Areaを全画面で守る。
- フォント拡大時にボタン文言を切らない。
- hoverだけに依存しない。
- フォーカス表示を単純に消さない。
- 入力欄には適切な `autocomplete`、`inputmode`、`enterkeyhint` を使う。
- iOSとAndroidの戻る、キーボード、共有シートの自然な挙動を優先する。

## 9. Anti-AI rules

Do not:

- AI紫、青紫mesh、発光blobを既定案にする。
- 同じ大きさのカードを3つ並べて画面を埋める。
- 意味のない英大文字、連番、バージョン、座標を装飾として置く。
- 何でもglass、gradient、pill、shadowにする。
- 写真の代わりに抽象図形を大量配置する。
- 必要のないダッシュボード、統計カード、バッジを発明する。
- Instagram、TikTok、YAMAP等の固有UIをそのまま複製する。
- 実装していない機能を美観のためだけに表示する。
- 既存のDOM ID、API、フォーム名を、見た目の都合で黙って変更する。

## 10. Redesign workflow

1. 対象画面を実機幅で確認する。
2. 現在の情報構造、主要操作、保持すべき固有表現を列挙する。
3. この文書とTaste Skillに照らして問題を監査する。
4. 一度に1つの主要画面を改修する。
5. 360px前後のiPhone幅とAndroid幅、明暗テーマを確認する。
6. キーボード、Safe Area、スクロール、片手操作を確認する。
7. 起動時間、画像メモリ、地図FPSを悪化させていないか確認する。

## 11. Pre-flight checklist

- [ ] 写真または地図が主役になっている。
- [ ] 主操作が1つに見える。
- [ ] 日本語が不自然に小さい、広い字間、窮屈な行間になっていない。
- [ ] 角丸、影、glass、gradientを理由なく増やしていない。
- [ ] 位置精度と公開範囲が誤解されない。
- [ ] 44pxのタッチ領域とSafe Areaを守っている。
- [ ] light / dark双方で階層とコントラストが保たれる。
- [ ] 写真の読み込みとメモリ負荷を確認した。
- [ ] 360px前後の実機幅で文字切れがない。
- [ ] AI生成テンプレート特有の禁止表現がない。
- [ ] URL、API、ID、認証、公開仕様を意図せず変更していない。

## 12. Reference policy

この仕様はSpota固有であり、下記資料のブランドデザインを再現するものではない。

参考:

- Taste Skill: anti-slop規則とredesign audit
- awesome-design-md-jp: 日本語UIのDESIGN.md形式とCJK typography
- TRAVELER'S COMPANY: 写真を主役にした旅・記録の方向性
- YAMAP: 地図中心サービスとしての実用性
- FUJIFILM: 写真の扱いと信頼感
- 暮しの手帖: 日本語の編集的な読みやすさ

各資料は非公式の観察・参考資料を含む。商標、ロゴ、固有コンポーネント、固有配色は複製しない。

