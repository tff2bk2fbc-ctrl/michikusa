import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateTrendSamples, createDisabledAdapter, createFixtureAdapter, normalizeSample } from './index.mjs';

const base = {
  source_id: 'fixture-source',
  license_version: 'synthetic-v1',
  coarse_region: 'demo-region',
  topic_key: 'demo-topic',
  bucket_start: '2026-08-10T00:00:00.000Z',
  bucket_end: '2026-08-24T00:00:00.000Z',
  created_at: '2026-08-20T00:00:00.000Z',
  like_count: 10,
  share_count: 2,
  view_count: 100,
  signal_keys: ['demo-signal'],
};

test('disabled adapter never produces a live source', async () => {
  const adapter = createDisabledAdapter();
  const result = await adapter.collect();
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'source_not_approved');
  assert.deepEqual(result.records, []);
});
test('fixture adapter accepts only normalized synthetic records', async () => {
  const adapter = createFixtureAdapter([base]);
  const result = await adapter.collect();
  assert.equal(result.status, 'fixture');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].source_mode, 'synthetic_fixture');
});

test('forbidden identity, raw content and precise location fields are rejected', () => {
  for (const field of ['username', 'video_id', 'caption', 'latitude', 'access_token']) {
    assert.throws(() => normalizeSample({ ...base, [field]: 'blocked' }), /not allowed/);
  }
});

test('aggregate returns sample labels and deterministic cause hypotheses', () => {
  const samples = Array.from({ length: 5 }, (_, index) => ({
    ...base,
    created_at: `2026-08-${String(20 + (index % 2)).padStart(2, '0')}T00:00:00.000Z`,
    like_count: 10 + index,
  }));
  const result = aggregateTrendSamples(samples, { generatedAt: '2026-08-21T00:00:00.000Z' });
  assert.equal(result.schema_version, 'tiktok-trend-sample.v1');
  assert.equal(result.search_proxy[0].metric, 'retrieved_sample_count');
  assert.equal(result.place_like_and_post_samples[0].coarse_region, 'demo-region');
  assert.equal(result.trend_cause_hypotheses[0].cause_category, 'co-occurring_signal');
  assert.equal(result.storage_policy.raw_records_persisted, false);
});

test('small cohorts are suppressed instead of presented as a trend', () => {
  const result = aggregateTrendSamples([base], { generatedAt: '2026-08-21T00:00:00.000Z' });
  assert.equal(result.search_proxy[0].suppressed, true);
  assert.equal(result.place_like_and_post_samples[0].suppressed, true);
  assert.deepEqual(result.trend_cause_hypotheses, []);
});

test('invalid source mode cannot be enabled accidentally', () => {
  assert.throws(() => normalizeSample(base, { mode: 'live_tiktok' }), /unsupported source mode/);
});
