# Research Trends offline boundary

このディレクトリは、Google Trends alpha、GDELT、Wikimedia等を将来接続するための安全な境界です。現在の実装は合成fixtureと無効adapterだけで、外部通信はありません。

## 使い方

```js
import { createDisabledAdapter, createFixtureAdapter } from './index.mjs';

const pending = createDisabledAdapter({ provider: 'google-trends-alpha' });
const fixture = createFixtureAdapter('search_interest', [/* 合成データ */]);
```

`createDisabledAdapter`は、providerの許諾がない限り固定の`source_not_approved`を返します。`createFixtureAdapter`は場所、ニュース集計、相対検索関心の3種類を正規化し、外部通信を行いません。

## 境界のルール

- 保存できるのは粗粒度の集計値と、出典・ライセンス・期限だけです。
- ユーザーID、投稿ID、本文、URL、トークン、secret、EXIF、正確な緯度経度は拒否します。
- 合成fixtureの出典は`fixture-`、ライセンスは`synthetic-`で始めます。
- Google Trendsの`interest_value`は絶対検索回数ではありません。
- `sample_size`が最小母数未満の集計は`applyMinimumCohort`で抑止します。
- 新しいproviderを追加するときは、このディレクトリに直接HTTPクライアントを置かず、法務・セキュリティ承認後に別collectorへ隔離します。
