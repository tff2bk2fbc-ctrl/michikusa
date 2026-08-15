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

async function loadViewerHarness(){
  const source = await read('public/place.js');
  const start = source.indexOf('let viewerEl=null;');
  const ready = source.indexOf('function openViewerReady', start);
  const close = source.indexOf('function closeViewer', ready);
  const end = source.indexOf('/* ============================================================\n   場所のシート', close);
  assert.ok(start >= 0 && ready > start && close > ready && end > close);

  const state = { uid: 'account-a', scope: 'user_account-a', seq: 1 };
  const waits = new Set(), requests = [], revoked = [], opened = [], timers = new Map();
  let waitSerial = 0, timerSerial = 0, blobSerial = 0;
  class TestAbortController {
    constructor(){
      const listeners = [];
      this.signal = {
        aborted: false,
        addEventListener(name,fn){ if(name === 'abort')listeners.push(fn); }
      };
      this._listeners = listeners;
    }
    abort(){
      if(this.signal.aborted)return;
      this.signal.aborted = true;
      this._listeners.forEach(fn => fn());
    }
  }
  const context = {
    window: { SpotaMotion: {
      beginWait(){ const id=++waitSerial;waits.add(id);return id; },
      endWait(id){ waits.delete(id); }
    } },
    document: { activeElement: null },
    fbUser: { uid: state.uid },
    captureAuth: async () => ({ uid: state.uid, scope: state.scope, seq: state.seq, token: 'test-token' }),
    authIsCurrent: auth => !!(auth && context.fbUser && auth.uid === state.uid &&
      auth.scope === state.scope && auth.seq === state.seq),
    apiAs(auth,path,opt){
      let resolve,reject;
      const promise = new Promise((res,rej) => { resolve=res;reject=rej; });
      const request = { auth, path, signal: opt&&opt.signal, resolve, reject };
      requests.push(request);
      if(request.signal)request.signal.addEventListener('abort',() => reject(Object.assign(new Error('aborted'),{name:'AbortError'})));
      return promise;
    },
    URL: {
      createObjectURL(){ return 'blob:test-'+(++blobSerial); },
      revokeObjectURL(value){ revoked.push(value); }
    },
    AbortController: TestAbortController,
    setTimeout(fn,ms){ const id=++timerSerial;timers.set(id,{fn,ms});return id; },
    clearTimeout(id){ timers.delete(id); },
    encodeURIComponent, Object, Error, Promise, Array, String
  };
  vm.createContext(context);
  const prefix = source.slice(start, ready);
  const closeFunction = source.slice(close, end);
  vm.runInContext(prefix+
    '\nfunction openViewerReady(){opened.push(Array.prototype.slice.call(arguments));}\n'+closeFunction,
    vm.createContext(Object.assign(context,{opened}))
  );
  async function flush(){ for(let i=0;i<8;i++)await Promise.resolve(); }
  function changeAccount(uid){
    state.uid=uid;state.scope='user_'+uid;state.seq++;
    context.fbUser={uid};
  }
  return { context, waits, requests, revoked, opened, timers, flush, changeAccount };
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

test('写真詳細の取得中に閉じると通信と待機表示を中止し、後から開かない', async () => {
  const h=await loadViewerHarness();
  h.context.openViewer(['thumb-a'],0,'','','','',[],['photo-a']);
  await h.flush();
  assert.equal(h.requests.length,1);assert.equal(h.waits.size,1);
  h.context.closeViewer();await h.flush();
  assert.equal(h.requests[0].signal.aborted,true);
  assert.equal(h.waits.size,0);assert.equal(h.opened.length,0);
});

test('写真詳細の取得中にアカウントが変わると旧認証の写真を開かない', async () => {
  const h=await loadViewerHarness();
  h.context.openViewer(['thumb-a'],0,'','','','',[],['photo-a']);
  await h.flush();
  h.changeAccount('account-b');
  h.context.closeViewer();await h.flush();
  assert.equal(h.requests[0].signal.aborted,true);
  assert.equal(h.waits.size,0);assert.equal(h.opened.length,0);
});

test('写真Aの取得中に写真Bを開くとAだけを中止してBだけを表示する', async () => {
  const h=await loadViewerHarness();
  h.context.openViewer(['thumb-a'],0,'','','','',[],['photo-a']);await h.flush();
  h.context.openViewer(['thumb-b'],0,'','','','',[],['photo-b']);await h.flush();
  assert.equal(h.requests.length,2);
  assert.equal(h.requests[0].signal.aborted,true);
  h.requests[1].resolve({ok:true,blob:async()=>({})});await h.flush();
  assert.equal(h.opened.length,1);
  assert.equal(h.opened[0][1],0);
  assert.equal(h.opened[0][10],'blob:test-1');
  assert.equal(h.waits.size,0);
});

test('応答しない写真通信は20秒で中止して待機表示を必ず終了する', async () => {
  const h=await loadViewerHarness();
  h.context.openViewer(['thumb-a'],0,'','','','',[],['photo-a']);await h.flush();
  const timeout=[...h.timers.values()].find(item=>item.ms===20000);
  assert.ok(timeout);timeout.fn();await h.flush();
  assert.equal(h.requests[0].signal.aborted,true);
  assert.equal(h.waits.size,0);assert.equal(h.opened.length,0);
});

test('本番UIはFilmo動作を追加し、更新と即時反応を分離する', async () => {
  const [html, css, release, native, post, place, map] = await Promise.all([
    read('public/index.html'), read('public/app.css'), read('public/release.js'),
    read('public/native.js'), read('public/post.js'), read('public/place.js'), read('public/map.js')
  ]);
  assert.match(html, /id="spota-wait" hidden aria-hidden="true"/);
  assert.ok(html.indexOf('/motion.js?v=120') < html.indexOf('/map.js?v=120'));
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
  assert.match(map, /beginWait\('地図を読み込んでいます'\)/);
  assert.match(map, /map\.once\('style\.load',function\(\)\{ setTimeout\(afterStyle,0\); \}\)/);
  assert.doesNotMatch(map, /map\.once\('styledata'/);
  assert.match(native, /initial&&window\.SpotaMotion\?window\.SpotaMotion\.beginWait\('現在地を取得しています'\)/);
  assert.match(place, /beginWait\('写真を読み込んでいます'\)/);
  assert.doesNotMatch(post, /SpotaMotion\.beginWait/);
  assert.doesNotMatch(release, /SpotaMotion\.beginWait/);
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
  assert.match(css, /@keyframes likeFlash\{0%,100%\{transform:scale\(1\)\}28%\{transform:scale\(\.7\)\}58%\{transform:scale\(1\.3\)\}\}/);
  assert.match(css, /timelineCountRoll \.4s cubic-bezier\(\.22,\.61,\.36,1\)/);
  assert.match(css, /\.timeline-like-heart\{[^}]*width:90px;height:90px;display:grid;place-items:center/s);
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
