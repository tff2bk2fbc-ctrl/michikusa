import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = name => readFile(new URL(name, root), 'utf8');
const waitFor = ms => new Promise(resolve => setTimeout(resolve, ms));

function classList(){
  const values = new Set();
  return {
    add(...names){ names.forEach(name => values.add(name)); },
    remove(...names){ names.forEach(name => values.delete(name)); },
    contains(name){ return values.has(name); }
  };
}

function loadMotion(){
  const overlay = {
    hidden: true, classList: classList(), attrs: {}, offsetWidth: 96,
    setAttribute(name,value){ this.attrs[name] = value; }
  };
  const status = { textContent: '' };
  const document = {
    getElementById(id){ return id === 'spota-wait' ? overlay : id === 'spota-wait-status' ? status : null; },
    body: { appendChild() {} },
    createElement(){ return {}; }
  };
  const window = { document, matchMedia: () => ({ matches: false }), innerWidth: 390, innerHeight: 844 };
  const context = { window, document, setTimeout, clearTimeout, Promise, Number, String, Object, Math, isFinite };
  vm.createContext(context);
  return read('public/motion.js').then(source => {
    vm.runInContext(source, context);
    return { motion: window.SpotaMotion, overlay, status };
  });
}

test('待機カメラは400ms未満の処理では表示しない', async () => {
  const { motion, overlay } = await loadMotion();
  const token = motion.beginWait('写真を読み込んでいます');
  await waitFor(120);
  motion.endWait(token);
  await waitFor(320);
  assert.equal(overlay.hidden, true);
  assert.equal(overlay.classList.contains('is-running'), false);
});

test('待機カメラは400msを超えた時だけ中央へ表示して完了時に閉じる', async () => {
  const { motion, overlay, status } = await loadMotion();
  const token = motion.beginWait('写真を読み込んでいます');
  await waitFor(430);
  assert.equal(overlay.hidden, false);
  assert.equal(overlay.attrs['aria-hidden'], 'false');
  assert.equal(overlay.classList.contains('is-running'), true);
  assert.equal(status.textContent, '写真を読み込んでいます');
  motion.endWait(token);
  assert.equal(overlay.hidden, true);
  assert.equal(overlay.attrs['aria-hidden'], 'true');
  assert.equal(status.textContent, '読み込みが完了しました');
});

test('本番UIはFilmo動作を追加し、更新と即時反応を分離する', async () => {
  const [html, css, release, native, post, place] = await Promise.all([
    read('public/index.html'), read('public/app.css'), read('public/release.js'),
    read('public/native.js'), read('public/post.js'), read('public/place.js')
  ]);
  assert.match(html, /id="spota-wait" hidden aria-hidden="true"/);
  assert.ok(html.indexOf('/motion.js?v=115') < html.indexOf('/map.js?v=115'));
  assert.match(css, /\.spota-wait\{[^}]*background:transparent;pointer-events:none/s);
  assert.match(css, /spotaCharge 2\.2s/);
  assert.match(css, /\.timeline-refresh-hint\.refreshing \.timeline-refresh-spinner\{animation:timelineSpin 1s linear infinite\}/);
  assert.match(release, /renderTimeline\(screen,state\.host,state\.query,state\.mode,0,true\)/);
  assert.match(release, /socialJson\('\/api\/feed',[\s\S]*,!refreshing\)/);
  assert.match(release, /paint\(next,wasCount\+\(next\?1:-1\)\)/);
  assert.match(release, /paint\(next\);if\(next&&window\.SpotaMotion\)/);
  assert.match(native, /SpotaMotion\.pulseLocation\(d\)/);
  assert.match(post, /SpotaMotion\.photoLanding\(rec\.photo,rec\.lng,rec\.lat\)/);
  assert.match(place, /SpotaMotion\.viewerTransition\(v,previousFocus,track\.children\[idx\]\)/);
});

test('新しいモーションは外部通信先を追加しない', async () => {
  const motion = await read('public/motion.js');
  assert.doesNotMatch(motion, /fetch\(|XMLHttpRequest|WebSocket|https?:\/\//);
});
