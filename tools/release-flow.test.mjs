import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = name => readFile(new URL(name, root), 'utf8');

test('feed stays behind authentication and only exposes another user\'s allowed posts', async () => {
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
  assert.match(feed, /p\.user_id=\?1 OR p\.visibility='public'/);
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

test('timeline redraw revokes old photo URLs and aborts stale thumbnail requests', async () => {
  const release = await read('public/release.js');
  const start = release.indexOf('function resetReleasePhotos');
  const end = release.indexOf('/* 地図用サムネイル', start);
  assert.ok(start >= 0 && end > start);

  let resolveResponse;
  const api = () => new Promise(resolve => { resolveResponse = resolve; });
  const revoked = [];
  const objectUrl = {
    createObjectURL(){ return 'blob:new'; },
    revokeObjectURL(value){ revoked.push(value); }
  };
  class TestAbortController {
    constructor(){ this.signal = { aborted: false }; }
    abort(){ this.signal.aborted = true; }
  }
  const helpers = Function('api', 'URL', 'AbortController',
    release.slice(start, end) + ';return {resetReleasePhotos,putRemotePhoto};'
  )(api, objectUrl, TestAbortController);

  const stale = new TestAbortController();
  const screen = {
    isConnected: true,
    __urls: ['blob:old'],
    __photoControllers: [stale],
    __photoGeneration: 0
  };
  helpers.resetReleasePhotos(screen);
  assert.equal(stale.signal.aborted, true);
  assert.deepEqual(revoked, ['blob:old']);
  assert.deepEqual(screen.__urls, []);
  assert.deepEqual(screen.__photoControllers, []);

  const image = {
    isConnected: true,
    src: '',
    classList: { add(){} },
    closest(){ return null; }
  };
  const pending = helpers.putRemotePhoto(image, 'photo-1', screen, 'thumb');
  await Promise.resolve();
  assert.equal(screen.__photoControllers.length, 1);
  const active = screen.__photoControllers[0];
  helpers.resetReleasePhotos(screen);
  assert.equal(active.signal.aborted, true);
  resolveResponse({ ok: true, blob: async () => ({}) });
  await pending;
  assert.deepEqual(revoked, ['blob:old', 'blob:new']);
  assert.equal(image.src, '');
  assert.deepEqual(screen.__photoControllers, []);
});

test('a thumbnail finishing after its image node was replaced is revoked immediately', async () => {
  const release = await read('public/release.js');
  const start = release.indexOf('function resetReleasePhotos');
  const end = release.indexOf('/* 地図用サムネイル', start);
  let resolveResponse;
  const api = () => new Promise(resolve => { resolveResponse = resolve; });
  const revoked = [];
  const helpers = Function('api', 'URL', 'AbortController',
    release.slice(start, end) + ';return {putRemotePhoto};'
  )(
    api,
    { createObjectURL(){ return 'blob:detached'; }, revokeObjectURL(value){ revoked.push(value); } },
    class { constructor(){ this.signal = {}; } abort(){} }
  );
  const screen = { isConnected: true, __urls: [], __photoControllers: [], __photoGeneration: 3 };
  const image = { isConnected: true, src: '', classList: { add(){} }, closest(){ return null; } };
  const pending = helpers.putRemotePhoto(image, 'photo-2', screen, 'thumb');
  await Promise.resolve();
  image.isConnected = false;
  resolveResponse({ ok: true, blob: async () => ({}) });
  await pending;
  assert.deepEqual(revoked, ['blob:detached']);
  assert.deepEqual(screen.__urls, []);
  assert.equal(image.src, '');
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
  assert.match(map, /addSource\('spota-photo',\{[\s\S]*cluster:true,clusterRadius:48,clusterMaxZoom:23,maxzoom:24/);
  assert.match(map, /source:'spota-photo'/);
  assert.match(place, /getSource\('spota-photo'\)/);
  assert.match(map, /clusterProperties:\{photo_count:/);
  assert.match(map, /id:'photo-cluster-count'/);
  assert.match(map, /'text-field':\['to-string',\['get','photo_count'\]\]/);
  assert.match(map, /'text-font':\['Noto Sans Bold'\]/);
  assert.match(map, /'text-font':\['Noto Sans Regular'\]/);
  assert.match(map, /const PHOTO_ZOOM=6/);
  assert.match(map, /const PHOTO_FEATURE_LIMIT=1600/);
  assert.match(map, /const PHOTO_ICON_VISIBLE_LIMIT=36/);
  assert.match(map, /const PHOTO_CLUSTER_VISIBLE_LIMIT=24/);
  assert.match(map, /const PHOTO_ICON_CACHE_LIMIT=72/);
  assert.match(map, /const PHOTO_ICON_CONCURRENCY=3/);
  assert.match(map, /id:'photo-pending'/);
  assert.match(map, /has_photo:\(p\.photo\|\|p\.server_photo_id\)\?1:0/);
  assert.match(map, /id:'mine-ring'[\s\S]*filter:\['!=',\['get','has_photo'\],1\]/);
  assert.match(map, /photoKey\(o\.p,o\.mine\)\+'_c'\+count/);
  assert.match(map, /items\.find\(function\(item\)\{return !!item\.img;\}\)\|\|items\[0\]/);
  assert.match(map, /photo_count:count/);
  assert.match(map, /filter:\['all',\['!',\['has','point_count'\]\],\['==',\['get','ready'\],1\],\['==',\['get','photo_count'\],1\]\]/);
  assert.match(map, /id:'photo-same-cluster'/);
  assert.match(map, /id:'photo-same-cluster-count'/);
  assert.match(map, /id:'photo-group-ic'/);
  assert.match(map, /id:'photo-cluster-a'/);
  assert.match(map, /id:'photo-cluster-a-pending'/);
  assert.match(map, /id:'photo-cluster'[^\n]*minzoom:4/);
  assert.match(map, /id:'photo-same-cluster'[^\n]*minzoom:4/);
  assert.match(map, /id:'photo-group-ic'[^\n]*minzoom:4/);
  assert.match(map, /id:'photo-cluster-a'[^\n]*minzoom:4/);
  assert.match(map, /id:'photo-cluster-count'[\s\S]*?'visibility':'none'/);
  assert.match(map, /id:'photo-same-cluster-count'[\s\S]*?'visibility':'none'/);
  assert.match(map, /id:'photo-cluster'[\s\S]*?'circle-opacity':0,[\s\S]*?'circle-stroke-opacity':0/);
  assert.match(map, /id:'photo-same-cluster'[\s\S]*?\['==',\['get','ready'\],0\]/);
  assert.match(map, /'circle-radius':5/);
  assert.match(map, /'circle-stroke-color':'#F7F7F4'/);
  assert.match(map, /var S=128,H=140,pw=112,ph=120,ring=6,r=26,ox=4,oy=8/);
  assert.match(map, /x\.font='760 22px -apple-system, BlinkMacSystemFont, sans-serif'/);
  assert.match(map, /x\.shadowColor='rgba\(5,5,7,\.30\)';x\.shadowBlur=18;x\.shadowOffsetX=0;x\.shadowOffsetY=4/);
  assert.match(map, /x\.fillStyle='#F7F7F4';roundRect\(x,-10,-10,20,20,4\)/);
  assert.match(map, /var bw=Math\.max\(46,Math\.ceil\(x\.measureText\(label\)\.width\)\+24\),bh=46/);
  assert.match(map, /'icon-size':1/);
  assert.doesNotMatch(map, /if\(map\.getZoom\(\)<PHOTO_ZOOM\)return out/);
  assert.doesNotMatch(map, /list=list\.slice\(0,80\)/);
  assert.match(map, /list=list\.slice\(0,PHOTO_FEATURE_LIMIT\)/);
  assert.match(map, /\(o\.items\.length>1\|\|zoom>=PHOTO_ZOOM\)&&\(o\.img\|\|o\.p\.server_photo_id\)&&b\.contains/);
  assert.match(map, /window\.queueMapPhotoThumb\(o\.p\)/);
  assert.match(map, /schedulePhotoIconPrune\(false\)/);
  assert.match(map, /var ready=desiredPhotoIcons\[key\]&&madeIcons\[key\]\?1:0/);
  assert.match(map, /s\.photo_thumb\|\|s\.photo\|\|''/);
  assert.match(map, /querySourceFeatures\('spota-photo'/);
  assert.match(map, /if\(!meta\.url&&meta\.record&&meta\.record\.server_photo_id[\s\S]*?window\.queueMapPhotoThumb\(meta\.record\)/);
  assert.match(map, /if\(row\.meta\.url\)makeRoundIcon\(/);
  assert.match(map, /削除済み・上限外の記録が持っていたData URL参照を残さない/);
  assert.match(place, /getClusterExpansionZoom\(clusterId\)/);
  assert.match(place, /photo-cluster-a/);
  assert.match(place, /photo-same-cluster/);
  assert.match(place, /photo-pending/);
});

test('map thumbnails are fetched lazily and stay within fixed memory bounds', async () => {
  const map = await read('public/map.js');
  const sync = await read('public/sync.js');
  const release = await read('public/release.js');
  const syncStart = sync.indexOf('async function syncDown');
  const syncEnd = sync.indexOf('let others={}', syncStart);
  const syncDown = sync.slice(syncStart, syncEnd);
  assert.doesNotMatch(syncDown, /queuePhotoRestore\(/);
  assert.doesNotMatch(syncDown, /queueSharedPhoto\(/);
  assert.match(release, /if\(sharedPhotoQueue\.length>=32\)return/);
  assert.match(release, /let sharedPhotoQueue=/);
  assert.match(release, /let mapPhotoAuth=null/);
  assert.match(release, /if\(records\.indexOf\(rec\)<0\)records\.push\(rec\)/);
  assert.match(release, /var pending=sharedPhotoPending\[id\]/);
  assert.match(release, /pending\.records\.indexOf\(rec\)<0/);
  assert.match(release, /while\(sharedPhotoBusy<2&&sharedPhotoQueue\.length\)/);
  assert.match(release, /while\(sharedPhotoOrder\.length>36\)/);
  assert.match(map, /const PHOTO_ICON_VISIBLE_LIMIT=36/);
  assert.match(map, /const PHOTO_CLUSTER_VISIBLE_LIMIT=24/);
  assert.match(map, /const PHOTO_ICON_CACHE_LIMIT=72/);
  assert.match(map, /const PHOTO_ICON_CONCURRENCY=3/);
  assert.match(map, /map\.on\('sourcedata'[\s\S]*sourceId==='spota-photo'&&e\.isSourceLoaded/);
});

test('the same server thumbnail is fetched once and shared across map records', async () => {
  const release = await read('public/release.js');
  const varsStart = release.indexOf('let sharedPhotoQueue');
  const varsEnd = release.indexOf('function releaseDate', varsStart);
  const queueStart = release.indexOf('function queueSharedPhoto');
  const queueEnd = release.indexOf('/* ---------- アルバム', queueStart);
  assert.ok(varsStart >= 0 && varsEnd > varsStart && queueStart >= 0 && queueEnd > queueStart);

  let resolveResponse, calls = 0;
  const helpers = Function('apiAs','authIsCurrent','URL','window',
    release.slice(varsStart, varsEnd) + release.slice(queueStart, queueEnd) +
    ';return {queueSharedPhoto:queueSharedPhoto,state:function(){return {busy:sharedPhotoBusy,pending:Object.keys(sharedPhotoPending).length,order:sharedPhotoOrder.slice()};}};'
  )(
    () => { calls++; return new Promise(resolve => { resolveResponse = resolve; }); },
    () => true,
    {createObjectURL(){return 'blob:shared';},revokeObjectURL(){}},
    {}
  );
  const auth = {uid:'u1',scope:'user_u1',seq:1};
  const a = {server_photo_id:'same-photo'}, b = {server_photo_id:'same-photo'};
  helpers.queueSharedPhoto(a, auth);
  helpers.queueSharedPhoto(b, auth);
  assert.equal(calls, 1, 'duplicate IDs must not start another request');
  assert.equal(helpers.state().pending, 1);
  resolveResponse({ok:true,blob:async () => ({})});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.photo, 'blob:shared');
  assert.equal(b.photo, 'blob:shared');
  assert.equal(a.photo_loading, undefined);
  assert.equal(b.photo_loading, undefined);
  assert.deepEqual(helpers.state().order, ['same-photo']);
});

test('photos remain visible after zoom 6 while decoding stays capped', async () => {
  const source = await read('public/map.js');
  const start = source.indexOf('function photoKey');
  const end = source.indexOf('function refreshPhotoSource', start);
  assert.ok(start >= 0 && end > start);

  const records = Array.from({length: 50}, (_, i) => ({
    id: 'post-'+i, server_photo_id: 'photo-'+i, n: '思い出 '+i,
    lat: 35 + i * .0002, lng: 139 + i * .0002, d: '2026-08-16'
  }));
  const madeIcons = {}, makingIcons = {}, photoIconMeta = {};
  const queued = [], decoded = [];
  const windowMock = {
    queueMapPhotoThumb(rec){ queued.push(rec.id); rec.photo='blob:'+rec.server_photo_id; }
  };
  let zoom = 6.01;
  const mapMock = {
    getZoom(){ return zoom; },
    getBounds(){ return {contains(){ return true; }}; },
    getCenter(){ return {lat:35,lng:139}; }
  };
  const harness = Function(
    'map','visibleOwnSpots','visibleOtherSpots','valid','madeIcons','makingIcons','photoIconMeta','window',
    'PHOTO_FEATURE_LIMIT','PHOTO_ICON_VISIBLE_LIMIT','PHOTO_CLUSTER_VISIBLE_LIMIT','PHOTO_ZOOM','makeRoundIcon',
    'let desiredPhotoIcons={},livePhotoMetaKeys={};'+source.slice(start,end)+
    ';return {photoFeatures:photoFeatures,desired:function(){return desiredPhotoIcons;}};'
  )(
    mapMock,()=>records,()=>[],()=>true,madeIcons,makingIcons,photoIconMeta,windowMock,
    1600,36,24,6,function(url,mine,key){decoded.push(key);madeIcons[key]={used:Date.now()};}
  );

  let features = harness.photoFeatures();
  assert.equal(features.length, 50, 'all coordinates stay in the clustered source');
  assert.equal(queued.length, 36, 'only the nearest visible cap is requested');
  features = harness.photoFeatures();
  assert.equal(decoded.length, 36, 'only capped photos are decoded');
  features = harness.photoFeatures();
  assert.equal(features.filter(f => f.properties.ready === 1).length, 36);

  zoom = 20;
  features = harness.photoFeatures();
  assert.equal(features.filter(f => f.properties.ready === 1).length, 36,
    'already visible photos do not disappear at a larger zoom');
});

test('low zoom repeated locations use A-style photo plus count instead of a large number circle', async () => {
  const source = await read('public/map.js');
  const start = source.indexOf('function photoKey');
  const end = source.indexOf('function refreshPhotoSource', start);
  const records = Array.from({length: 4}, (_, i) => ({
    id: 'same-'+i, server_photo_id: 'same-photo-'+i, n: '同じ場所',
    lat: 35.681236, lng: 139.767125, d: '2026-08-16'
  }));
  const madeIcons = {}, makingIcons = {}, photoIconMeta = {};
  const windowMock = {queueMapPhotoThumb(rec){rec.photo='blob:'+rec.server_photo_id;}};
  const mapMock = {
    getZoom(){ return 4.6; },
    getBounds(){ return {contains(){ return true; }}; },
    getCenter(){ return {lat:35.68,lng:139.77}; }
  };
  const harness = Function(
    'map','visibleOwnSpots','visibleOtherSpots','valid','madeIcons','makingIcons','photoIconMeta','window',
    'PHOTO_FEATURE_LIMIT','PHOTO_ICON_VISIBLE_LIMIT','PHOTO_CLUSTER_VISIBLE_LIMIT','PHOTO_ZOOM','makeRoundIcon',
    'let desiredPhotoIcons={},livePhotoMetaKeys={};'+source.slice(start,end)+';return {photoFeatures:photoFeatures};'
  )(
    mapMock,()=>records,()=>[],()=>true,madeIcons,makingIcons,photoIconMeta,windowMock,
    1600,36,24,6,function(url,mine,key){madeIcons[key]={used:Date.now()};}
  );
  harness.photoFeatures();
  harness.photoFeatures();
  const features = harness.photoFeatures();
  assert.equal(features.length, 1);
  assert.equal(features[0].properties.photo_count, 4);
  assert.equal(features[0].properties.ready, 1);
});

test('daily PhotoKit bridge keeps candidates local until the user accepts', async () => {
  const plugin = await read('native/ios/DailyPhotoPlugin.swift');
  const release = await read('public/release.js');
  assert.match(plugin, /PHPhotoLibrary\.requestAuthorization/);
  assert.match(plugin, /status == \.authorized \|\| status == \.limited/);
  assert.match(plugin, /!asset\.isHidden/);
  assert.match(plugin, /Int\.random\(in: 0\.\.<eligibleCount\)/);
  assert.match(plugin, /longestSide: 1400/);
  assert.match(plugin, /longestSide: 4096/);
  assert.match(plugin, /payload\["id"\] = token/);
  assert.doesNotMatch(plugin, /\["id"\]\s*=\s*asset\.localIdentifier/);
  assert.match(plugin, /defaults\.string\(forKey: StateKey\.token\) == token/);
  assert.match(plugin, /networkAllowed: false/);
  assert.match(plugin, /networkAllowed: true/);
  assert.match(plugin, /name: "discard"/);
  assert.match(plugin, /Array\(seen\.prefix\(30\)\)/);
  assert.doesNotMatch(plugin, /URLSession|URLRequest|https?:\/\//);
  assert.match(release, /id="daily-toggle"/);
});

test('iOS native overlay is reproducible from the GitHub checkout', async () => {
  const scene = await read('native/ios/SceneDelegate.swift');
  const installer = await read('native/ios/apply-to-capacitor.sh');
  assert.match(scene, /rootViewController = SpotaBridgeViewController\(\)/);
  assert.match(installer, /DailyPhotoPlugin\.swift/);
  assert.match(installer, /SpotaBridgeViewController\.swift/);
  assert.match(installer, /UIInterfaceOrientationPortrait/);
  assert.match(installer, /PBXSourcesBuildPhase/);
  assert.match(installer, /File\.write\(path, text\)/);
  assert.doesNotMatch(installer, /require ['"]xcodeproj['"]/);
});

test('photo restore jobs are invalidated across authentication boundaries', async () => {
  const core = await read('public/core.js');
  const sync = await read('public/sync.js');
  assert.match(core, /next!==activeSpotScope[\s\S]{0,220}invalidatePhotoRestoreQueue/);
  assert.match(sync, /function invalidatePhotoRestoreQueue\(\)/);
  assert.match(sync, /restoreGeneration\+\+/);
  assert.match(sync, /controller\.abort\(\)/);
  assert.match(sync, /signal:abortController\.signal/);
  assert.match(sync, /!authIsCurrent\(j\.auth\)/);
});

test('shared photo object URLs are cleared across account boundaries', async () => {
  const core = await read('public/core.js');
  const release = await read('public/release.js');
  assert.match(core, /next!==activeSpotScope[\s\S]{0,100}clearSharedPhotoCache/);
  assert.match(release, /function clearSharedPhotoCache\(\)/);
  assert.match(release, /sharedPhotoGeneration\+\+/);
  assert.match(release, /URL\.revokeObjectURL\(url\)/);
  assert.match(release, /item\.generation!==sharedPhotoGeneration/);
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
  const place = await read('public/place.js');
  const css = await read('public/app.css');
  assert.match(core, /viewingPublic\s*\?\s*'<svg/);
  assert.match(core, /自分の地図へ切り替える/);
  assert.match(native, /getElementById\('map-locate'\)/);
  assert.doesNotMatch(native, /getElementById\('btn-loc'\)/);
  assert.doesNotMatch(data, /件 読み込みました/);
  assert.match(place, /d\.className='drop'/);
  assert.doesNotMatch(place, /d\.innerHTML='<div class="im"/);
  assert.match(css, /\.drop\{[^}]*opacity:0!important/);
  assert.match(css, /\.drop\{[^}]*border:0!important/);
  assert.match(css, /\.drop::after\{[^}]*border:0!important[^}]*opacity:0!important/);
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
