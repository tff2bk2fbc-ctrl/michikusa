import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = name => readFile(new URL(name, root), 'utf8');

test('feed stays behind authentication and excludes private posts', async () => {
  const source = await read('src/index.js');
  const auth = source.indexOf('const me = await authenticate(request, env)');
  const route = source.indexOf('p === "/api/feed"');
  assert.ok(auth >= 0 && route > auth, 'feed route must be registered after authentication');
  const start = source.indexOf('async function listFeed');
  const end = source.indexOf('async function coordsFor', start);
  const feed = source.slice(start, end);
  assert.match(feed, /p\.visibility='public'/);
  assert.match(feed, /p\.visibility='friends'/);
  assert.doesNotMatch(feed, /p\.visibility='private'/);
  assert.match(feed, /const c=await coordsFor\(env,r\)/);
  assert.match(feed, /NOT EXISTS \(\s*SELECT 1 FROM blocks/);
});

test('map audience keeps private memories off the public map', async () => {
  const core = await read('public/core.js');
  const map = await read('public/map.js');
  assert.match(core, /mapAudience==='mine'\?spots:spots\.filter\(function\(p\)\{return p\.visibility==='public';\}\)/);
  assert.match(core, /filter\(function\(p\)\{return p\.visibility==='public';\}\)/);
  assert.match(map, /visibleOwnSpots\(\)/);
  assert.match(map, /visibleOtherSpots\(\)/);
});

test('release UI uses real routes and does not advertise unsaved social actions', async () => {
  const html = await read('public/index.html');
  const release = await read('public/release.js');
  assert.match(html, /id="map-scope"/);
  assert.match(html, /release\.js\?v=/);
  assert.match(release, /api\('\/api\/feed/);
  assert.match(release, /api\('\/api\/posts\?user=/);
  assert.doesNotMatch(release, />\s*(いいね|コメント|チャット)\s*</);
});

test('profile post response contains authorized thumbnail identifiers', async () => {
  const source = await read('src/index.js');
  const start = source.indexOf('async function listProfilePosts');
  const end = source.indexOf('async function listFeed', start);
  const profile = source.slice(start, end);
  assert.match(profile, /AS photo_id/);
  assert.match(profile, /photo_id:r\.photo_id\|\|null/);
  assert.match(profile, /map_available:!!c/);
  assert.doesNotMatch(profile, /if\(!c\)continue/);
  assert.match(profile, /profile\.id===me\.id\|\|profile\.profile_public/);
});
