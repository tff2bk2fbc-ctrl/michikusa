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
  class MiniElement {
    constructor(){ this.children=[];this.parentNode=null;this.style={};this._text='';this.isConnected=true;this.offsetWidth=18; }
    set textContent(value){ this._text=String(value);this.children=[]; }
    get textContent(){ return this.children.length?this.children.map(child => child.textContent).join(''):this._text; }
    appendChild(child){ child.parentNode=this;this.children.push(child);return child; }
    querySelector(){ return this.children[0] || null; }
    querySelectorAll(){ return this.children.slice(); }
    remove(){ this.isConnected=false;if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(child => child!==this); }
  }
  const overlay = {
    hidden: true, classList: classList(), attrs: {}, offsetWidth: 96,
    setAttribute(name,value){ this.attrs[name] = value; }
  };
  const status = { textContent: '' };
  const document = {
    getElementById(id){ return id === 'spota-wait' ? overlay : id === 'spota-wait-status' ? status : null; },
    body: { appendChild() {} },
    createElement(){ return new MiniElement(); }
  };
  const window = { document, matchMedia: () => ({ matches: false }), innerWidth: 390, innerHeight: 844 };
  const context = { window, document, setTimeout, clearTimeout, requestAnimationFrame: callback => callback(), Promise, Number, String, Object, Math, isFinite };
  vm.createContext(context);
  return read('public/motion.js').then(source => {
    vm.runInContext(source, context);
    return { motion: window.SpotaMotion, overlay, status, MiniElement };
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
  assert.ok(html.indexOf('/motion.js?v=116') < html.indexOf('/map.js?v=116'));
  assert.match(css, /\.spota-wait\{[^}]*background:transparent;pointer-events:none/s);
  assert.match(css, /spotaCharge 2\.2s/);
  assert.match(css, /\.timeline-refresh-hint\.refreshing \.timeline-refresh-spinner\{display:block;animation:timelineSpin 1s linear infinite\}/);
  assert.match(release, /renderTimeline\(screen,state\.host,state\.query,state\.mode,0,true\)/);
  assert.match(release, /socialJson\('\/api\/feed',[\s\S]*,!refreshing\)/);
  assert.match(release, /paint\(next,wasCount\+\(next\?1:-1\)\)/);
  assert.match(release, /paint\(next\);if\(next&&window\.SpotaMotion\)/);
  assert.match(native, /SpotaMotion\.pulseLocation\(d\)/);
  assert.match(post, /SpotaMotion\.photoLanding\(rec\.photo,rec\.lng,rec\.lat\)/);
  assert.match(place, /SpotaMotion\.viewerTransition\(v,previousFocus,track\.children\[idx\]\)/);
});

test('本番の7モーションは承認済みプレビューの数値を使う', async () => {
  const [motion, css, release] = await Promise.all([
    read('public/motion.js'), read('public/app.css'), read('public/release.js')
  ]);
  assert.match(css, /\.motion-photo-drop\{[^}]*width:150px;height:150px/s);
  assert.match(css, /spotaCameraFlash \.5s cubic-bezier\(\.22,\.61,\.36,1\)/);
  assert.match(motion, /duration:2500,easing:'cubic-bezier\(\.22,\.61,\.36,1\)'/);
  assert.match(css, /spotaLocationPulse 2\.4s cubic-bezier\(\.22,\.61,\.36,1\) infinite/);
  assert.match(css, /nth-child\(3\)\{animation-delay:\.8s\}/);
  assert.match(css, /nth-child\(4\)\{animation-delay:1\.6s\}/);
  assert.match(motion, /duration:1900,easing:'cubic-bezier\(\.22,\.61,\.36,1\)'/);
  assert.match(css, /spotaCharge 2\.2s/);
  assert.match(release, /Math\.min\(90,dy\*\.45\)/);
  assert.match(release, /distance>=56/);
  assert.match(css, /timelineBigHeart \.95s cubic-bezier\(\.34,1\.56,\.64,1\)/);
  assert.match(css, /likeFlash \.8s cubic-bezier\(\.34,1\.56,\.64,1\)/);
  assert.match(css, /transition:color \.45s cubic-bezier\(\.22,\.61,\.36,1\)/);
});

test('いいね件数は通信失敗が早く返ってもロールバック値で止まる', async () => {
  const { motion, MiniElement } = await loadMotion();
  const count = new MiniElement();
  count.textContent = '24';
  motion.rollNumber(count, 25);
  assert.equal(count.children.at(-1).textContent, '25');
  motion.rollNumber(count, 24);
  assert.equal(count.children.at(-1).textContent, '24');
  await waitFor(440);
  assert.equal(count.children.length, 1);
  assert.equal(count.children[0].textContent, '24');
});

test('新しいモーションは外部通信先を追加しない', async () => {
  const motion = await read('public/motion.js');
  assert.doesNotMatch(motion, /fetch\(|XMLHttpRequest|WebSocket|https?:\/\//);
});
