/**
 * Research department's provider-neutral, offline aggregation boundary.
 *
 * This module intentionally has no network client and does not import `fetch`.
 * A future provider may be connected only after its licence, retention,
 * display and security gates are recorded. Until then, adapters are either
 * disabled or synthetic fixtures.
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
  'raw_text',
  'text',
  'comment',
  'voice_to_text',
  'latitude',
  'longitude',
  'lat',
  'lng',
  'exact_latitude',
  'exact_longitude',
  'exif',
  'cover_image',
  'access_token',
  'refresh_token',
  'client_secret',
  'api_key',
  'secret',
  'token',
]);

const SOURCE_MODES = new Set(['synthetic_fixture', 'approved_license']);
const CONFIDENCE = new Set(['low', 'medium', 'high']);
const MAX_RECORDS = 10_000;
const MAX_KEY_LENGTH = 96;
const MAX_LABEL_LENGTH = 120;
const MAX_TTL_DAYS = 30;
export const MIN_COHORT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function assertObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_record', message);
  }
}

function assertAllowedKeys(value, allowed, path = '$') {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('unknown_field', `${path}.${key} is not part of the schema`);
  }
}

function assertNoForbiddenKeys(value, path = '$') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      fail('forbidden_field', `${path}.${key} is not allowed in research records`);
    }
    assertNoForbiddenKeys(child, `${path}.${key}`);
  }
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

function safeLabel(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LABEL_LENGTH) {
    fail('invalid_label', `${field} must be a short non-empty label`);
  }
  if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    fail('invalid_label', `${field} contains control characters`);
  }
  return value.trim();
}

function isoDate(value, field) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail('invalid_date', `${field} must be an ISO date`);
  return date.toISOString();
}

function finiteNumber(value, field, { min = -Infinity, max = Infinity } = {}) {
  if (!Number.isFinite(value) || value < min || value > max) {
    fail('invalid_metric', `${field} is outside its allowed range`);
  }
  return value;
}

function nonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
    fail('invalid_metric', `${field} must be a non-negative integer`);
  }
  return value;
}

function provenance(input) {
  const sourceId = safeKey(input.source_id, 'source_id');
  const licenseVersion = safeKey(input.license_version, 'license_version');
  const generatedAt = isoDate(input.generated_at, 'generated_at');
  const expiresAt = isoDate(input.expires_at, 'expires_at');
  const generatedMs = Date.parse(generatedAt);
  const expiresMs = Date.parse(expiresAt);
  if (expiresMs <= generatedMs) fail('invalid_ttl', 'expires_at must be after generated_at');
  if (expiresMs - generatedMs > MAX_TTL_DAYS * DAY_MS) {
    fail('invalid_ttl', `expires_at cannot be more than ${MAX_TTL_DAYS} days after generated_at`);
  }
  return { source_id: sourceId, license_version: licenseVersion, generated_at: generatedAt, expires_at: expiresAt };
}

function sourceMode(mode) {
  if (!SOURCE_MODES.has(mode)) fail('source_mode_not_allowed', 'unsupported source mode');
  return mode;
}

function requireFixtureProvenance(record, mode) {
  if (mode === 'synthetic_fixture') {
    if (!record.source_id.startsWith('fixture-') || !record.license_version.startsWith('synthetic-')) {
      fail('invalid_fixture_provenance', 'synthetic fixtures must use fixture-/synthetic- provenance keys');
    }
  }
}

/** Normalize a public place master record. Coordinates are deliberately coarse. */
export function normalizePlaceRecord(input, { mode = 'synthetic_fixture' } = {}) {
  assertObject(input, 'place record must be an object');
  assertNoForbiddenKeys(input);
  assertAllowedKeys(input, new Set([
    'place_id', 'name', 'normalized_name', 'prefecture', 'municipality', 'category',
    'coarse_lat', 'coarse_lng', 'source_id', 'license_version', 'generated_at', 'expires_at', 'source_mode',
  ]));
  const normalizedMode = sourceMode(mode);
  const p = provenance(input);
  requireFixtureProvenance(p, normalizedMode);
  const coarseLat = finiteNumber(input.coarse_lat, 'coarse_lat', { min: -90, max: 90 });
  const coarseLng = finiteNumber(input.coarse_lng, 'coarse_lng', { min: -180, max: 180 });
  const roundedLat = Number(coarseLat.toFixed(1));
  const roundedLng = Number(coarseLng.toFixed(1));
  if (roundedLat !== coarseLat || roundedLng !== coarseLng) {
    fail('coordinate_too_precise', 'place coordinates must already be rounded to one decimal place');
  }
  return Object.freeze({
    place_id: safeKey(input.place_id, 'place_id'),
    name: safeLabel(input.name, 'name'),
    normalized_name: safeKey(input.normalized_name, 'normalized_name'),
    prefecture: safeLabel(input.prefecture, 'prefecture'),
    municipality: safeLabel(input.municipality, 'municipality'),
    category: safeKey(input.category, 'category'),
    coarse_lat: roundedLat,
    coarse_lng: roundedLng,
    ...p,
    source_mode: normalizedMode,
  });
}

/** Normalize GDELT-like aggregate signals without retaining article content. */
export function normalizeNewsAggregate(input, { mode = 'synthetic_fixture' } = {}) {
  assertObject(input, 'news aggregate must be an object');
  assertNoForbiddenKeys(input);
  assertAllowedKeys(input, new Set([
    'coarse_region', 'topic_key', 'bucket_start', 'bucket_end', 'article_count',
    'sample_size', 'tone_average', 'cause_category', 'confidence',
    'source_id', 'license_version', 'generated_at', 'expires_at', 'source_mode',
  ]));
  const normalizedMode = sourceMode(mode);
  const p = provenance(input);
  requireFixtureProvenance(p, normalizedMode);
  const bucketStart = isoDate(input.bucket_start, 'bucket_start');
  const bucketEnd = isoDate(input.bucket_end, 'bucket_end');
  if (Date.parse(bucketEnd) <= Date.parse(bucketStart)) fail('invalid_date_range', 'bucket_end must be after bucket_start');
  const sampleSize = nonNegativeInteger(input.sample_size, 'sample_size');
  const articleCount = nonNegativeInteger(input.article_count, 'article_count');
  if (articleCount > sampleSize) fail('invalid_metric', 'article_count cannot exceed sample_size');
  const confidence = input.confidence;
  if (!CONFIDENCE.has(confidence)) fail('invalid_confidence', 'confidence must be low, medium or high');
  return Object.freeze({
    coarse_region: safeKey(input.coarse_region, 'coarse_region'),
    topic_key: safeKey(input.topic_key, 'topic_key'),
    bucket_start: bucketStart,
    bucket_end: bucketEnd,
    article_count: articleCount,
    sample_size: sampleSize,
    tone_average: finiteNumber(input.tone_average, 'tone_average', { min: -100, max: 100 }),
    cause_category: safeKey(input.cause_category, 'cause_category'),
    confidence,
    ...p,
    source_mode: normalizedMode,
  });
}

/** Normalize a relative search-interest record. It is not an absolute search count. */
export function normalizeSearchInterest(input, { mode = 'synthetic_fixture' } = {}) {
  assertObject(input, 'search-interest record must be an object');
  assertNoForbiddenKeys(input);
  assertAllowedKeys(input, new Set([
    'keyword_key', 'coarse_region', 'time_bucket', 'interest_value', 'interest_scale',
    'sample_size', 'confidence', 'source_id', 'license_version', 'generated_at', 'expires_at', 'source_mode',
  ]));
  const normalizedMode = sourceMode(mode);
  const p = provenance(input);
  requireFixtureProvenance(p, normalizedMode);
  const sampleSize = nonNegativeInteger(input.sample_size, 'sample_size');
  if (!CONFIDENCE.has(input.confidence)) fail('invalid_confidence', 'confidence must be low, medium or high');
  return Object.freeze({
    keyword_key: safeKey(input.keyword_key, 'keyword_key'),
    coarse_region: safeKey(input.coarse_region, 'coarse_region'),
    time_bucket: safeKey(input.time_bucket, 'time_bucket'),
    interest_value: finiteNumber(input.interest_value, 'interest_value', { min: 0 }),
    interest_scale: safeKey(input.interest_scale, 'interest_scale'),
    sample_size: sampleSize,
    confidence: input.confidence,
    ...p,
    source_mode: normalizedMode,
  });
}

function freezeRecords(records) {
  return Object.freeze(records.map((record) => Object.freeze({ ...record })));
}

function adapterResult(status, code, records, message) {
  return Object.freeze({
    status,
    code,
    records: freezeRecords(records),
    ...(message ? { message } : {}),
  });
}

/** No-op production boundary until a provider has written approval. */
export function createDisabledAdapter({ provider = 'unapproved' } = {}) {
  const providerKey = safeKey(provider, 'provider');
  return Object.freeze({
    async collect() {
      return adapterResult('blocked', 'source_not_approved', [], `${providerKey} is disabled until its licence and security gates are approved.`);
    },
  });
}

/** Offline-only adapter. It ignores any transport argument and never calls fetch. */
export function createFixtureAdapter(kind, records) {
  if (!Array.isArray(records)) fail('invalid_fixture', 'fixture records must be an array');
  if (records.length > MAX_RECORDS) fail('too_many_records', `maximum ${MAX_RECORDS} records`);
  const normalizer = {
    place: normalizePlaceRecord,
    news: normalizeNewsAggregate,
    search_interest: normalizeSearchInterest,
  }[kind];
  if (!normalizer) fail('invalid_kind', 'unsupported research fixture kind');
  const safeRecords = freezeRecords(records.map((record) => normalizer(record, { mode: 'synthetic_fixture' })));
  return Object.freeze({
    async collect() {
      return adapterResult('fixture', 'synthetic_only', safeRecords);
    },
  });
}

/** Public trend output must not present a sub-cohort as a trend. */
export function applyMinimumCohort(records, { minimum = MIN_COHORT } = {}) {
  if (!Array.isArray(records)) fail('invalid_records', 'records must be an array');
  if (!Number.isInteger(minimum) || minimum < 1 || minimum > 1_000) fail('invalid_cohort', 'invalid minimum cohort');
  return Object.freeze(records.map((record) => {
    assertObject(record, 'aggregate must be an object');
    const sampleSize = record.sample_size;
    if (!Number.isInteger(sampleSize) || sampleSize < 0) fail('invalid_metric', 'sample_size must be a non-negative integer');
    return Object.freeze(sampleSize < minimum
      ? { ...record, suppressed: true, suppression_reason: 'minimum_cohort' }
      : { ...record, suppressed: false });
  }));
}

export function hasForbiddenFields(value) {
  try {
    assertNoForbiddenKeys(value);
    return false;
  } catch (error) {
    if (error?.code === 'forbidden_field') return true;
    throw error;
  }
}

export const schemas = Object.freeze({
  place: 'research-place.v1',
  news: 'research-news-aggregate.v1',
  search_interest: 'research-search-interest.v1',
});
