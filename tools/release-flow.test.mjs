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

test('release UI uses authenticated social routes and persisted actions', async () => {
  const html = await read('public/index.html');
  const release = await read('public/release.js');
  assert.match(html, /id="btn-map-scope"/);
  assert.match(html, /id="btn-notifications"/);
  assert.match(html, /id="btn-messages"/);
  assert.match(html, /release\.js\?v=/);
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  assert.match(release, /socialJson\('\/api\/feed',\{method:'POST'/);
  assert.doesNotMatch(release, /\/api\/feed\?/);
  assert.match(release, /socialJson\('\/api\/posts\?user=/);
  assert.match(release, /\/api\/notifications/);
  assert.match(release, /\/api\/conversations/);
  assert.match(release, /client_operation_id:nid\(\)/);
  assert.match(release, /data-like/);
  assert.match(release, /data-comments/);
  assert.match(release, /data-flash/);
  assert.match(release, /encodeURIComponent\(p\.id\)\+'\/flash/);
});

test('PDF map header and iPhone viewport rules stay fixed', async () => {
  const html = await read('public/index.html');
  const css = await read('public/app.css');
  const release = await read('public/release.js');
  const top = html.slice(html.indexOf('<div class="top">'), html.indexOf('<div class="results"'));
  assert.ok(top.indexOf('class="q"') < top.indexOf('id="btn-map-scope"'));
  assert.ok(top.indexOf('id="btn-map-scope"') < top.indexOf('id="btn-notifications"'));
  assert.ok(top.indexOf('id="btn-notifications"') < top.indexOf('id="btn-messages"'));
  assert.match(release, /mapAudience==='mine'\?'public':'mine'/);
  assert.match(css, /\.pill\{[^}]*background:transparent;box-shadow:none/s);
  assert.match(css, /\.timeline-search input\{[^}]*font-size:16px/s);
  assert.match(css, /\.comment-form input,.message-form textarea\{[^}]*font-size:16px/s);
  assert.match(css, /\.release-screen\{[^}]*overflow-x:hidden/s);
});

test('initial map never falls back to the former Ueno coordinate', async () => {
  const map = await read('public/map.js');
  const native = await read('public/native.js');
  assert.doesNotMatch(map, /center:\[139\.7745,35\.7150\]/);
  assert.doesNotMatch(map, /localStorage\.getItem\('spota_last_location'/);
  assert.doesNotMatch(native, /localStorage\.setItem\('spota_last_location'/);
  assert.match(map, /localStorage\.removeItem\('spota_last_location'/);
  assert.match(map, /center:\[138\.2529,36\.2048\],zoom:4\.6/);
  assert.match(native, /permission\.location==='granted'/);
  assert.match(native, /map\.jumpTo\(\{center:\[138\.2529,36\.2048\],zoom:4\.6/);
});

test('sensitive map bounds and timeline queries stay out of request URLs', async () => {
  const sync = await read('public/sync.js');
  const release = await read('public/release.js');
  const worker = await read('src/index.js');
  assert.match(sync, /apiAs\(auth,'\/api\/posts\/query',\{method:'POST'/);
  assert.doesNotMatch(sync, /\/api\/posts\?s=/);
  assert.match(release, /socialJson\('\/api\/feed',\{method:'POST'/);
  assert.doesNotMatch(release, /\/api\/feed\?/);
  assert.match(worker, /p === "\/api\/posts\/query" && request\.method === "POST"/);
  assert.match(worker, /p === "\/api\/feed" && request\.method === "POST"/);
  assert.match(worker, /const handle = String\(url\.searchParams\.get\("user"\) \|\| ""\)\.trim\(\)/);
  assert.match(worker, /return respond\(await listProfilePosts\(handle, url, env, me\)\)/);
  assert.match(worker, /async function listMapPosts/);
});

test('photo sync requires both derived variants before marking a record synced', async () => {
  const sync = await read('public/sync.js');
  const uploadStart = sync.indexOf('async function uploadPhoto');
  const uploadEnd = sync.indexOf('function resize', uploadStart);
  const upload = sync.slice(uploadStart, uploadEnd);
  assert.match(upload, /if\(!view\)throw new Error\('view resize failed'\)/);
  assert.match(upload, /if\(!th\)throw new Error\('thumb resize failed'\)/);
  assert.match(upload, /await put\('view'/);
  assert.match(upload, /await put\('thumb'/);
});

test('photo sync creates bounded JPEG variants before the first server write', async () => {
  const sync = await read('public/sync.js');
  const start = sync.indexOf('async function uploadPhoto');
  const end = sync.indexOf('function resize', start);
  const upload = sync.slice(start, end);
  assert.match(upload, /resize\(dataUrl,4096,\.94\)/);
  assert.ok(upload.indexOf("await put('thumb'") < upload.indexOf("await put('view'"));
  assert.ok(upload.indexOf("await put('view'") < upload.indexOf("await put('orig'"));
  assert.doesNotMatch(upload, /await put\('orig',blob,blob\.type/);
  assert.doesNotMatch(upload, /fetch\((?:th|view|archive)\)/);
  assert.match(sync, /function dataUrlBlob\(dataUrl\)/);
  assert.match(sync, /new Blob\(\[bytes\],\{type:'image\/jpeg'\}\)/);
});

test('JPEG data URLs become uploadable Blobs without a CSP-governed fetch', async () => {
  const sync = await read('public/sync.js');
  const start = sync.indexOf('function dataUrlBlob');
  const end = sync.indexOf('function resize', start);
  const source = sync.slice(start, end);
  const convert = Function('atob', 'Blob', 'Uint8Array', source + ';return dataUrlBlob;')(
    atob, Blob, Uint8Array
  );
  const blob = convert('data:image/jpeg;base64,/9j/2Q==');
  assert.equal(blob.type, 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0xff, 0xd8, 0xff, 0xd9]);
  assert.throws(() => convert('data:image/png;base64,iVBORw0KGgo='), /jpeg data invalid/);
});

test('legacy posts with a missing server photo are returned to the upload queue', async () => {
  const sync = await read('public/sync.js');
  assert.match(sync, /rec\.synced=0;rec\.photo_synced=0/);
  assert.match(sync, /existing\.sync_error='server photo missing'/);
  assert.match(sync, /local\.sync_error='server photo missing'/);
  assert.match(sync, /if\(missingUploads.*setTimeout\(syncUp,500\)/);
  assert.match(sync, /rec\.photo_synced=1/);
});

test('photo upload accepts chunked WebView requests and enforces the actual body size', async () => {
  const worker = await read('src/index.js');
  const start = worker.indexOf('async function putPhoto');
  const end = worker.indexOf('/** GET /api/photo/', start);
  const upload = worker.slice(start, end);
  assert.match(upload, /const declaredHeader = request\.headers\.get\("Content-Length"\)/);
  assert.doesNotMatch(upload, /画像サイズを確認できません.*411/);
  assert.match(upload, /bytes\.byteLength > maxBytes/);
  assert.match(upload, /readBodyLimited\(request, maxBytes\)/);
  assert.match(upload, /validImageBytes\(bytes, ct\)/);
  assert.match(worker, /async function readBodyLimited\(request, maxBytes\)/);
});

test('timeline is reachable without changing the fixed five-item home nav', async () => {
  const sync = await read('public/sync.js');
  const release = await read('public/release.js');
  assert.match(sync, /id="timeline-guest"/);
  assert.match(sync, /openSocialHub\('timeline'\)/);
  assert.match(release, /id="profile-timeline"/);
});

test('map click resolution uses a stable record identity instead of place name', async () => {
  const map = await read('public/map.js');
  const place = await read('public/place.js');
  assert.match(map, /rid:String\(p\.id\|\|p\.server_id\|\|p\.spot\|\|''\)/);
  assert.match(place, /function recordForFeature/);
  assert.match(place, /String\(x\.id\|\|x\.server_id\|\|x\.spot\|\|''\)===rid/);
  assert.doesNotMatch(place, /visibleOwnSpots\(\)\.filter\(function\(x\)\{return x\.n===f\.properties\.n;/);
});

test('map photos keep a fallback pin and use screen-distance clustering', async () => {
  const map = await read('public/map.js');
  const place = await read('public/place.js');
  const featureStart = map.indexOf('function fcOf');
  const featureEnd = map.indexOf('let lastSig', featureStart);
  const normalFeatures = map.slice(featureStart, featureEnd);
  assert.doesNotMatch(normalFeatures, /big&&mine&&p\.photo/);
  assert.match(map, /addSource\('photo',\{[\s\S]*cluster:true,clusterRadius:48,clusterMaxZoom:22/);
  assert.match(map, /id:'photo-cluster-count'/);
  assert.match(map, /point_count_abbreviated/);
  assert.match(map, /filter:\['all',\['!',\['has','point_count'\]\],\['==',\['get','ready'\],1\]\]/);
  assert.doesNotMatch(map, /if\(map\.getZoom\(\)<PHOTO_ZOOM\)return out/);
  assert.match(place, /getClusterExpansionZoom\(clusterId\)/);
});

test('temporary moderation failures stay hidden and are retried instead of changing audience', async () => {
  const worker = await read('src/index.js');
  const start = worker.indexOf('async function putPhoto');
  const end = worker.indexOf('/** GET /api/photo/', start);
  const upload = worker.slice(start, end);
  assert.match(upload, /moderation === "bad"/);
  assert.doesNotMatch(upload, /moderation !== "ok"/);
  assert.match(worker, /async function retryErroredPhotoModeration/);
  assert.match(worker, /ph\.moderation_state='error'/);
  assert.match(worker, /photo_moderation_retry_/);
  assert.match(worker, /retryErroredPhotoModeration\(env\)/);
});

test('external place providers and image proxy are not callable at runtime', async () => {
  const worker = await read('src/index.js');
  const data = await read('public/data.js');
  const map = await read('public/map.js');
  for (const route of ['/api/img','/api/hotpepper','/api/rakuten','/api/wiki','/api/gsearch']) {
    assert.doesNotMatch(worker, new RegExp(route.replaceAll('/', '\\/')));
    assert.doesNotMatch(data, new RegExp(route.replaceAll('/', '\\/')));
  }
  assert.doesNotMatch(map, /SERVER\+'\/api\/img/);
});

test('profile sheet follows the PDF dismissal gesture and the home nav stays at five actions', async () => {
  const html = await read('public/index.html');
  const release = await read('public/release.js');
  const css = await read('public/app.css');
  for (const id of ['map-locate','btn-timeline','btn-bulk','btn-cam','btn-lib','btn-me'])
    assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /id="btn-loc"/);
  assert.doesNotMatch(html, /id="btn-social"/);
  assert.match(release, /bindTimelineRefresh/);
  assert.match(release, /pointermove/);
  assert.match(release, /function bindProfileDismiss/);
  assert.match(release, /panel\.offsetHeight\*\.30\|\|vy>900/);
  assert.match(release, /cancelAnimationFrame\(raf\)/);
  assert.match(css, /\.profile-panel/);
  assert.match(css, /touch-action:none/);
  assert.match(css, /\.timeline-refresh-hint/);
});

test('map controls follow the requested audience icon, transparent place marker, and silent loading', async () => {
  const core = await read('public/core.js');
  const data = await read('public/data.js');
  const native = await read('public/native.js');
  const css = await read('public/app.css');
  assert.match(core, /viewingPublic\s*\?\s*'<svg/);
  assert.match(core, /自分の地図へ切り替える/);
  assert.match(native, /getElementById\('map-locate'\)/);
  assert.doesNotMatch(native, /getElementById\('btn-loc'\)/);
  assert.doesNotMatch(data, /件 読み込みました/);
  assert.match(css, /\.drop \.im\{[^}]*background:transparent!important/);
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

test('map library is delivered from the same origin and startup guards the map instance', async () => {
  const html = await read('public/index.html');
  const core = await read('public/core.js');
  const ui = await read('public/ui.js');
  const worker = await read('src/index.js');
  const lazy = await read('public/lazy.js');
  assert.match(html, /\/vendor\/maplibre-gl-4\.7\.1\.min\.js/);
  assert.match(html, /\/vendor\/maplibre-gl-4\.7\.1\.min\.css/);
  assert.doesNotMatch(html, /cdnjs\.cloudflare\.com\/ajax\/libs\/maplibre-gl/);
  await read('public/vendor/maplibre-gl-4.7.1.min.js');
  await read('public/vendor/maplibre-gl-4.7.1.min.css');
  assert.doesNotMatch(worker, /MAPLIBRE_VENDOR|mapLibreVendor/);
  assert.doesNotMatch(lazy, /cdnjs|jsdelivr|unpkg|gstatic/);
  assert.match(core, /liveMap=window\.__michikusaMap/);
  assert.match(ui, /liveMap=window\.__michikusaMap/);
});
