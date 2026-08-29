/**
 * TikTok trend analysis boundary for Spota.
 *
 * This module deliberately contains no network client.  The only supported
 * inputs are synthetic fixtures or an already-approved, privacy-minimized
 * provider adapter.  A future provider must hand this module aggregate-safe
 * records; raw TikTok responses, identifiers, captions, URLs and coordinates
 * must never cross this boundary.
 */

const FORBIDDEN_KEYS = new Set([
  'username',
  'open_id',
  'user_id',
  'video_id',
  'video_url',
  'url',
  'caption',
  'description',
  'comment',
  'voice_to_text',
  'latitude',
  'longitude',
  'lat',
  'lng',
  'exif',
  'cover_image',
  'access_token',
  'refresh_token',
  'client_secret',
]);

const ALLOWED_SOURCE_MODES = new Set(['synthetic_fixture', 'approved_license']);
const MAX_RECORDS = 20_000;
const MAX_KEY_LENGTH = 96;
const MIN_COHORT = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function finiteNonNegative(value, field) {
  if (!Number.isFinite(value) || value < 0) {
    fail('invalid_metric', `${field} must be a finite non-negative number`);
  }
  return Math.min(Math.floor(value), 2_147_483_647);
}

function safeKey(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_KEY_LENGTH) {
    fail('invalid_key', `${field} must be a short non-empty key`);
  }
  if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(value)) {
    fail('invalid_key', `${field} contains unsupported characters`);
  }
  return value;
}

function isoDate(value, field) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail('invalid_date', `${field} must be an ISO date`);
  return date.toISOString();
}

function assertNoForbiddenKeys(value, path = '$') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      fail('forbidden_field', `${path}.${key} is not allowed in a trend record`);
    }
    assertNoForbiddenKeys(child, `${path}.${key}`);
  }
}

/**
 * Normalize a privacy-minimized record.  `coarse_region` and `topic_key` are
 * opaque, server-owned keys; they are not accepted as free-form user text.
 */
export function normalizeSample(input, { mode = 'synthetic_fixture' } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid_record', 'sample must be an object');
  }
  assertNoForbiddenKeys(input);
  if (!ALLOWED_SOURCE_MODES.has(mode)) fail('source_mode_not_allowed', 'unsupported source mode');

  const sourceId = safeKey(input.source_id, 'source_id');
  const licenseVersion = safeKey(input.license_version, 'license_version');
  const coarseRegion = safeKey(input.coarse_region, 'coarse_region');
  const topicKey = safeKey(input.topic_key, 'topic_key');
  const bucketStart = isoDate(input.bucket_start, 'bucket_start');
  const bucketEnd = isoDate(input.bucket_end, 'bucket_end');
  const createdAt = isoDate(input.created_at, 'created_at');
  if (Date.parse(bucketEnd) <= Date.parse(bucketStart)) {
    fail('invalid_date_range', 'bucket_end must be after bucket_start');
  }
  if (Date.parse(createdAt) < Date.parse(bucketStart) || Date.parse(createdAt) >= Date.parse(bucketEnd)) {
    fail('created_outside_bucket', 'created_at must be inside the declared bucket');
  }

  const signals = Array.isArray(input.signal_keys) ? input.signal_keys : [];
  if (signals.length > 8) fail('too_many_signals', 'at most eight signal keys are allowed');
  const signalKeys = [...new Set(signals.map((key) => safeKey(key, 'signal_key')))];

  return Object.freeze({
    source_id: sourceId,
    license_version: licenseVersion,
    coarse_region: coarseRegion,
    bucket_start: bucketStart,
    bucket_end: bucketEnd,
    topic_key: topicKey,
    created_at: createdAt,
    like_count: finiteNonNegative(input.like_count ?? 0, 'like_count'),
    share_count: finiteNonNegative(input.share_count ?? 0, 'share_count'),
    view_count: finiteNonNegative(input.view_count ?? 0, 'view_count'),
    signal_keys: Object.freeze(signalKeys),
    source_mode: mode,
  });
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.floor((sorted[middle - 1] + sorted[middle]) / 2);
}

function ratio(current, previous) {
  if (previous === 0) return current > 0 ? Number.POSITIVE_INFINITY : 1;
  return current / previous;
}

function confidence(sampleSize, independentSignals, growth) {
  if (sampleSize >= 50 && independentSignals >= 2 && growth >= 2) return 'high';
  if (sampleSize >= 20 && independentSignals >= 1 && growth >= 1.5) return 'medium';
  return 'low';
}

function ensureCohort(summary, fieldName) {
  if (summary.sample_size < MIN_COHORT) {
    return {
      ...summary,
      suppressed: true,
      suppression_reason: 'minimum_cohort',
    };
  }
  return summary;
}

/**
 * Aggregate only safe, normalized samples.  Counts are retrieved-sample
 * counts, never TikTok-wide search volume or total post counts.
 */
export function aggregateTrendSamples(samples, {
  generatedAt = new Date().toISOString(),
  expiresInDays = 7,
} = {}) {
  if (!Array.isArray(samples)) fail('invalid_samples', 'samples must be an array');
  if (samples.length > MAX_RECORDS) fail('too_many_records', `maximum ${MAX_RECORDS} records`);
  const normalized = samples.map((sample) => normalizeSample(sample, { mode: sample.source_mode || 'synthetic_fixture' }));
  const now = isoDate(generatedAt, 'generated_at');
  const expiresAt = new Date(Date.parse(now) + Math.max(1, Math.min(expiresInDays, 30)) * DAY_MS).toISOString();
  const byTopic = new Map();
  const byRegion = new Map();
  const bySignal = new Map();

  for (const sample of normalized) {
    const topic = byTopic.get(sample.topic_key) || { records: [], signals: new Map() };
    topic.records.push(sample);
    for (const signal of sample.signal_keys) topic.signals.set(signal, (topic.signals.get(signal) || 0) + 1);
    byTopic.set(sample.topic_key, topic);

    const region = byRegion.get(sample.coarse_region) || { records: [], signals: new Map() };
    region.records.push(sample);
    for (const signal of sample.signal_keys) region.signals.set(signal, (region.signals.get(signal) || 0) + 1);
    byRegion.set(sample.coarse_region, region);

    for (const signal of sample.signal_keys) {
      const signalBucket = bySignal.get(signal) || { records: [] };
      signalBucket.records.push(sample);
      bySignal.set(signal, signalBucket);
    }
  }

  const searchProxy = [...byTopic.entries()].map(([topicKey, group]) => ensureCohort({
    metric: 'retrieved_sample_count',
    topic_key: topicKey,
    sample_size: group.records.length,
    retrieved_post_sample_count: group.records.length,
    share_of_retrieved_sample: normalized.length ? Number((group.records.length / normalized.length).toFixed(4)) : 0,
    source_mode: group.records[0]?.source_mode || 'synthetic_fixture',
  }, 'topic_key')).sort((a, b) => b.retrieved_post_sample_count - a.retrieved_post_sample_count);

  const recentLikesAndPosts = [...byRegion.entries()].map(([coarseRegion, group]) => {
    const likes = group.records.map((record) => record.like_count);
    const previous = group.records.filter((record) => Date.parse(record.created_at) < Date.parse(now) - 7 * DAY_MS);
    const recent = group.records.filter((record) => Date.parse(record.created_at) >= Date.parse(now) - 7 * DAY_MS);
    const recentLikes = recent.reduce((sum, record) => sum + record.like_count, 0);
    const previousLikes = previous.reduce((sum, record) => sum + record.like_count, 0);
    const growth = ratio(recentLikes, previousLikes);
    const independentSignals = [...group.signals.values()].filter((count) => count >= 2).length;
    return ensureCohort({
      metric: 'coarse_region_sample',
      coarse_region: coarseRegion,
      sample_size: group.records.length,
      recent_post_sample_count: recent.length,
      like_sum: recentLikes,
      like_median: median(likes),
      share_sum: recent.reduce((sum, record) => sum + record.share_count, 0),
      view_sum: recent.reduce((sum, record) => sum + record.view_count, 0),
      recent_like_growth_ratio: Number.isFinite(growth) ? Number(growth.toFixed(4)) : null,
      source_mode: group.records[0]?.source_mode || 'synthetic_fixture',
    }, 'coarse_region');
  }).sort((a, b) => (b.like_sum || 0) - (a.like_sum || 0));

  const causes = [...byRegion.entries()].map(([coarseRegion, group]) => {
    const recent = group.records.filter((record) => Date.parse(record.created_at) >= Date.parse(now) - 7 * DAY_MS);
    const previous = group.records.filter((record) => Date.parse(record.created_at) < Date.parse(now) - 7 * DAY_MS);
    const recentCount = recent.length;
    const previousCount = previous.length;
    const growth = ratio(recentCount, previousCount);
    const signalEntries = [...group.signals.entries()].sort((a, b) => b[1] - a[1]);
    const topSignal = signalEntries[0]?.[0] || null;
    const independentSignals = signalEntries.filter(([, count]) => count >= 2).length;
    const category = topSignal ? 'co-occurring_signal' : growth >= 1.5 ? 'post_burst' : 'insufficient_signal';
    return ensureCohort({
      coarse_region: coarseRegion,
      cause_category: category,
      cause_signal_key: topSignal,
      evidence: {
        recent_post_sample_count: recentCount,
        previous_post_sample_count: previousCount,
        recent_post_growth_ratio: Number.isFinite(growth) ? Number(growth.toFixed(4)) : null,
        independent_signal_count: independentSignals,
      },
      confidence: confidence(group.records.length, independentSignals, Number.isFinite(growth) ? growth : 2),
      statement: '推定要因です。取得できたサンプルに基づくもので、TikTok全体の原因を断定しません。',
      sample_size: group.records.length,
    }, 'coarse_region');
  }).filter((item) => !item.suppressed);

  const result = {
    schema_version: 'tiktok-trend-sample.v1',
    source_notice: 'TikTok全体の検索回数・投稿総数ではなく、許可済みサンプルの集計です。',
    freshness: {
      generated_at: now,
      expires_at: expiresAt,
      stale_after_days: 7,
    },
    search_proxy: searchProxy,
    place_like_and_post_samples: recentLikesAndPosts,
    trend_cause_hypotheses: causes,
    storage_policy: {
      raw_records_persisted: false,
      identifiers_persisted: false,
      precise_location_persisted: false,
      minimum_cohort: MIN_COHORT,
    },
  };
  assertNoForbiddenKeys(result);
  return result;
}

/**
 * Default production adapter.  It intentionally makes no network request;
 * a live TikTok provider is blocked until a written commercial license and a
 * second security/legal review are recorded.
 */
export function createDisabledAdapter() {
  return Object.freeze({
    async collect() {
      return Object.freeze({
        status: 'blocked',
        code: 'source_not_approved',
        records: Object.freeze([]),
        message: 'TikTokの一般トレンド取得は、承認済みライセンスがないため無効です。',
      });
    },
  });
}

export function createFixtureAdapter(records) {
  if (!Array.isArray(records)) fail('invalid_fixture', 'fixture records must be an array');
  const safeRecords = Object.freeze(records.map((record) => normalizeSample(record, { mode: 'synthetic_fixture' })));
  return Object.freeze({
    async collect() {
      return Object.freeze({ status: 'fixture', code: 'synthetic_only', records: safeRecords });
    },
  });
}
