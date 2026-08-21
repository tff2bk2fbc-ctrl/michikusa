import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  applyMinimumCohort,
  createDisabledAdapter,
  createFixtureAdapter,
  hasForbiddenFields,
  normalizeNewsAggregate,
  normalizePlaceRecord,
  normalizeSearchInterest,
  schemas,
} from './index.mjs';

const provenance = {
  source_id: 'fixture-test',
  license_version: 'synthetic-v1',
  generated_at: '2026-08-21T00:00:00.000Z',
  expires_at: '2026-08-28T00:00:00.000Z',
};

const place = {
  ...provenance,
  place_id: 'fixture-place',
  name: '合成スポット',
  normalized_name: 'synthetic-place',
  prefecture: '合成県',
  municipality: '合成市',
  category: 'scenic',
  coarse_lat: 35.6,
  coarse_lng: 139.7,
};

const news = {
  ...provenance,
  coarse_region: 'synthetic-region',
  topic_key: 'synthetic-topic',
  bucket_start: '2026-08-20T00:00:00.000Z',
  bucket_end: '2026-08-21T00:00:00.000Z',
  article_count: 10,
  sample_size: 20,
  tone_average: 2.5,
  cause_category: 'event_signal',
  confidence: 'medium',
};

const interest = {
  ...provenance,
  keyword_key: 'synthetic-keyword',
  coarse_region: 'synthetic-region',
  time_bucket: '2026-W34',
  interest_value: 42,
  interest_scale: 'provider_relative',
  sample_size: 20,
  confidence: 'medium',
};

test('synthetic fixture file is data-only and has no network-bearing fields', async () => {
  const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/synthetic.json', import.meta.url), 'utf8'));
  assert.equal(fixture.places.length, 2);
  assert.equal(fixture.news.length, 1);
  assert.equal(fixture.search_interest.length, 1);
  assert.equal(hasForbiddenFields(fixture), false);
  for (const [kind, records] of Object.entries({
    place: fixture.places,
    news: fixture.news,
    search_interest: fixture.search_interest,
  })) {
    const result = await createFixtureAdapter(kind, records).collect();
    assert.equal(result.records.length, records.length);
  }
});

test('each offline fixture adapter normalizes its schema', async () => {
  for (const [kind, record] of [['place', place], ['news', news], ['search_interest', interest]]) {
    const result = await createFixtureAdapter(kind, [record]).collect({
      fetch() { throw new Error('network must never be called'); },
    });
    assert.equal(result.status, 'fixture');
    assert.equal(result.code, 'synthetic_only');
    assert.equal(result.records.length, 1);
  }
  assert.deepEqual(schemas, {
    place: 'research-place.v1',
    news: 'research-news-aggregate.v1',
    search_interest: 'research-search-interest.v1',
  });
});

test('disabled adapter is explicit and returns no records', async () => {
  const result = await createDisabledAdapter({ provider: 'google-trends-alpha' }).collect();
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'source_not_approved');
  assert.deepEqual(result.records, []);
});

test('identity, raw content, secrets and precise coordinates are rejected', () => {
  for (const field of ['username', 'video_id', 'caption', 'access_token', 'latitude', 'exif']) {
    assert.throws(() => normalizeSearchInterest({ ...interest, [field]: 'blocked' }), /not allowed/);
  }
  assert.throws(() => normalizePlaceRecord({ ...place, coarse_lat: 35.6123 }), /one decimal/);
});

test('unknown fields and missing provenance cannot cross the boundary', () => {
  assert.throws(() => normalizeNewsAggregate({ ...news, unexpected: true }), /not part of the schema/);
  const { source_id: _source, ...missingSource } = interest;
  assert.throws(() => normalizeSearchInterest(missingSource), /source_id must be/);
});

test('relative interest is not mislabeled as an absolute search count', () => {
  const normalized = normalizeSearchInterest(interest);
  assert.equal(normalized.interest_scale, 'provider_relative');
  assert.equal(Object.hasOwn(normalized, 'absolute_search_count'), false);
});

test('small cohorts are suppressed before public presentation', () => {
  const result = applyMinimumCohort([
    { metric: 'synthetic', sample_size: 3 },
    { metric: 'synthetic', sample_size: 20 },
  ]);
  assert.equal(result[0].suppressed, true);
  assert.equal(result[1].suppressed, false);
});

test('TTL is bounded to prevent stale research data from persisting indefinitely', () => {
  assert.throws(() => normalizeSearchInterest({
    ...interest,
    expires_at: '2026-09-30T00:00:00.000Z',
  }), /30 days/);
});
