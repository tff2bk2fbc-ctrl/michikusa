import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = name => readFile(new URL(name, root), 'utf8');

test('album reorder is local, bounded, keyboard accessible, and atomic', async () => {
  const core = await read('public/core.js');
  const release = await read('public/release.js');
  const css = await read('public/app.css');
  assert.match(core, /indexedDB\.open\('michikusa',4\)/);
  assert.match(core, /createObjectStore\('album_order',\{keyPath:'key'\}\)/);
  assert.match(core, /function dbPutAlbumOrdersAtomic\(records,expectedScope\)/);
  assert.match(core, /records\.length>120/);
  assert.match(core, /scope!==expectedScope\|\|scope!==activeSpotScope/);
  assert.match(core, /db\.transaction\('album_order','readwrite'\)/);
  assert.match(core, /window\.dbPutAlbumOrdersAtomic=dbPutAlbumOrdersAtomic/);
  assert.match(release, /ALBUM_REORDER_LIMIT=120/);
  assert.match(release, /function albumOrderRows\(list,key,scope\)/);
  assert.match(release, /data-album-edit/);
  assert.match(release, /data-album-save/);
  assert.match(release, /data-album-cancel/);
  assert.match(release, /setPointerCapture/);
  assert.match(release, /pointercancel/);
  assert.match(release, /lostpointercapture/);
  assert.match(release, /ArrowLeft/);
  assert.match(release, /ArrowRight/);
  assert.match(release, /event\.key==='Home'/);
  assert.match(release, /event\.key==='End'/);
  assert.match(release, /SpotaMotion\.showUndo\('アルバムの順番を保存しました'/);
  assert.match(release, /dbPutAlbumOrdersAtomic\(rows,scope\)/);
  assert.match(release, /editing\?' disabled aria-hidden="true"/);
  assert.doesNotMatch(release, /dbPutSpotsAtomic/);
  assert.match(css, /\.album-reorder-controls button\{[^}]*min-height:44px/);
  assert.match(css, /\.album-section\.is-editing \.album-photo\{pointer-events:none\}/);
  assert.match(css, /box-shadow:inset 0 0 0 7px #0A0A0B,inset 0 0 0 10px var\(--focus\)/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /forced-colors:active/);
});

test('album order store sanitizes small rows and rejects a foreign owner at runtime', async () => {
  const core = await read('public/core.js');
  const context = {
    location: { protocol: 'https:' }, maplibregl: {}, showErr() {},
    localStorage: { getItem() { return null; }, setItem() {} },
    document: { body: { classList: { toggle() {} } }, getElementById() { return null; } },
    setTimeout() { return 0; }, clearTimeout() {}, console
  };
  context.window = context;
  vm.runInNewContext(core + '\n;globalThis.__setAlbumDb=(scope,value)=>{activeSpotScope=scope;db=value;};globalThis.__putAlbumOrders=dbPutAlbumOrdersAtomic;', context);

  let transaction;
  const writes = [];
  const fakeDb = {
    objectStoreNames: { contains(name) { return name === 'album_order'; } },
    transaction(name, mode) {
      assert.equal(name, 'album_order');assert.equal(mode, 'readwrite');
      transaction = { error: null, objectStore() { return { put(value) { writes.push(value); } }; } };
      return transaction;
    }
  };
  context.__setAlbumDb('user_a', fakeDb);
  const pending = context.__putAlbumOrders([
    { id: 'one', owner_scope: 'user_a', month_key: '2026-09', order: 0, photo: 'data:image/jpeg;base64,large' },
    { id: 'two', owner_scope: 'user_a', month_key: '2026-09', order: 1, photo: 'data:image/jpeg;base64,large' }
  ], 'user_a');
  transaction.oncomplete();
  assert.equal(await pending, true);
  assert.equal(writes.length, 2);
  assert.deepEqual(Object.keys(writes[0]).sort(), ['id','key','month_key','order','owner_scope']);
  assert.equal('photo' in writes[0], false);

  const transactionCount = writes.length;
  assert.equal(await context.__putAlbumOrders([
    { id: 'three', owner_scope: 'user_b', month_key: '2026-09', order: 0 }
  ], 'user_a'), false);
  assert.equal(writes.length, transactionCount);
});

test('empty album screen renders without dereferencing a missing control', async () => {
  const release = await read('public/release.js');
  const context = {
    window: null, console, spots: [], mapAudience: 'mine', fbUser: null,
    activeSpotScope: 'guest_test', spotScopeSwitch: 1,
    document: { getElementById() { return null; }, activeElement: null },
    refreshMapAudienceUI() {}, setTimeout() { return 0; }, clearTimeout() {},
    requestAnimationFrame(fn) { fn(); return 1; },
    dailyEnabled() { return false; }, setDailyPhotoEnabled: async () => true,
    esc(value) { return String(value ?? '').replace(/[<>&"]/g, ''); }
  };
  context.window = context;
  vm.runInNewContext(release, context);
  const controls = {
    '#album-import': {}, '#daily-toggle': {}
  };
  const host = {
    innerHTML: '',
    querySelector(selector) { return controls[selector] || null; },
    querySelectorAll() { return []; }
  };
  context.renderAlbumHome({ isConnected: true }, host);
  assert.match(host.innerHTML, /まだ写真がありません/);
  assert.equal(typeof controls['#album-import'].onclick, 'function');
  assert.equal(typeof controls['#daily-toggle'].onclick, 'function');
});
