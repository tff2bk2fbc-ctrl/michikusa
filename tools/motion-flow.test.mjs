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
  assert.ok(html.indexOf('/motion.js?v=127') < html.indexOf('/map.js?v=127'));
  assert.match(css, /\.spota-wait\{[^}]*background:transparent;pointer-events:none/s);
  assert.match(css, /spotaCharge 2\.2s/);
  assert.match(css, /\.timeline-refresh-hint\.refreshing \.timeline-refresh-spinner\{display:block;animation:timelineSpin 1s linear infinite\}/);
  assert.match(release, /renderTimeline\(screen,state\.host,state\.query,state\.mode,0,true\)/);
  assert.match(release, /socialJson\('\/api\/feed',[\s\S]*,!refreshing\)/);
  assert.match(release, /var j=await socialJson\('\/api\/posts\/'[\s\S]*paint\(j\.liked,j\.count\)/);
  assert.match(release, /await socialJson\('\/api\/follows\/'[\s\S]*paint\(next\);if\(next&&window\.SpotaMotion\)/);
  assert.match(release, /var sheet=showSheet\('[\s\S]*comment-sheet-body/);
  assert.doesNotMatch(release, /makeReleaseScreen\('コメント'/);
  assert.match(release, /commentInert\.push\(node\)/);
  assert.match(release, /node\.inert=true/);
  assert.match(release, /event\.key!=='Tab'/);
  assert.match(release, /event\.shiftKey&&document\.activeElement===first/);
  assert.match(release, /document\.activeElement===last/);
  assert.match(css, /\.comment-sheet-shell\{[^}]*height:min\(72dvh,680px\)[^}]*max-height:calc\(100dvh/s);
  assert.doesNotMatch(release, /else if\(window\.SpotaMotion\)window\.SpotaMotion\.restartClass\(b,'like-burst'/);
  assert.match(native, /SpotaMotion\.pulseLocation\(d\)/);
  assert.match(native, /SpotaMotion\.locateStart\(locateButton\)/);
  assert.match(native, /SpotaMotion\.locateStart\(button\)/);
  assert.ok(native.includes("d.innerHTML='<i class=\"current-location-dot\"></i><i class=\"current-location-ring\"></i>';"));
  assert.doesNotMatch(native, /current-location-ring"><\/i>\+'<i class="current-location-ring/);
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
  assert.match(css, /spotaLocationPulse \.72s cubic-bezier\(\.22,\.61,\.36,1\) 1 both/);
  assert.doesNotMatch(css, /current-location-ring:nth-child\(3\)/);
  assert.doesNotMatch(css, /current-location-ring:nth-child\(4\)/);
  assert.match(css, /\.spota-map-crossfade\{[^}]*pointer-events:none/s);
  assert.match(css, /\.spota-map-crossfade\.is-leaving\{[^}]*transition:opacity \.24s/s);
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
  const [motion, options] = await Promise.all([read('public/motion.js'),read('public/motion-50-options.js')]);
  assert.doesNotMatch(motion, /fetch\(|XMLHttpRequest|WebSocket|https?:\/\//);
  assert.doesNotMatch(options, /fetch\(|XMLHttpRequest|WebSocket|https?:\/\//);
});

test('採用番号とMotion 50は本番の既存機能へ接続される', async () => {
  const [html, motion, post, css, preview] = await Promise.all([
    read('public/index.html'), read('public/motion.js'), read('public/post.js'),
    read('public/app.css'), read('public/motion-50-options.html')
  ]);
  [1,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,22,27,28,29,30,31,32,41,43,44,45,46,47,48,49,50]
    .forEach(id => assert.match(motion,new RegExp('(?:^|[,\\s])'+id+':')));
  assert.match(motion, /function bindHold\(/);
  assert.match(motion, /haptic\(options\.style\|\|'rigid'/);
  assert.match(motion, /bindHold\(camera,null,\{duration:520,style:'rigid',intensity:\.9\}\)/);
  assert.doesNotMatch(css, /\.motion-holding[^{]*\{[^}]*stroke-dash/s);
  assert.match(post, /<span>use<\/span><span>it\.<\/span>/);
  assert.match(post, /<span>pass<\/span><span>it\.<\/span>/);
  assert.match(post, /thresholdHit/);
  assert.match(preview, /A\. Diagonal Verdict/);
  assert.match(preview, /B\. Corner Split/);
  assert.match(preview, /C\. Editorial Wipe/);
  assert.match(html, /id="btn-timeline"[\s\S]*id="btn-bulk"[\s\S]*id="btn-cam"[\s\S]*id="btn-lib"[\s\S]*id="btn-me"/);
});

test('保存・共有・プロフィール・共有写真の演出は実処理の結果後だけ発火する', async () => {
  const [core, motion, post, release, css] = await Promise.all([
    read('public/core.js'), read('public/motion.js'), read('public/post.js'),
    read('public/release.js'), read('public/app.css')
  ]);
  assert.match(core, /setTip\(t,kind\)/);
  assert.match(core, /tipFeedback\(kind\)/);
  assert.match(motion, /function avatarTransition\(origin,target\)/);
  assert.match(motion, /function saveSuccess\(node\)/);
  assert.match(motion, /function shareLaunch\(node\)/);
  assert.match(motion, /function sharedPhotoReveal\(node\)/);
  assert.match(motion, /function photoError\(node\)/);
  assert.match(motion, /function locateStart\(node\)/);
  assert.match(motion, /function showUndo\(message,undo,options\)/);
  assert.match(motion, /typeof undo!=='function'/);
  assert.match(post, /saveSuccess\(document\.getElementById\('btn-cam'\)\)/);
  assert.match(post, /setTip\('残しました','success'\)/);
  assert.match(post, /setTip\([^;]+,'error'\)/);
  assert.match(release, /img\.decode\(\)/);
  assert.ok(release.indexOf("await img.decode()") < release.indexOf('sharedPhotoReveal(img)'));
  assert.match(release, /sharePost\(posts\[Number\(b\.dataset\.share\)\],b\)/);
  assert.match(release, /shareLaunch\(source\)[\s\S]*await navigator\.share\(/);
  assert.match(release, /shareError\.name==='AbortError'/);
  assert.match(release, /if\(b\.disabled\)return;b\.disabled=true/);
  assert.match(release, /openPublicProfile\(b\.dataset\.profile,b\)/);
  assert.match(release, /avatarTransition\(origin,avatar\)/);
  assert.match(release, /showUndo\('アイコンを変更しました',async function/);
  assert.match(release, /profile_icon:previous/);
  assert.match(css, /\.tip\.motion-tip-success\{animation:tipSuccess/);
  assert.match(css, /\.tip\.motion-tip-error\{animation:tipError/);
  assert.match(css, /\.cam\.motion-save-confirm\{animation:motionSaveConfirm/);
  assert.match(css, /img\.motion-shared-photo\{animation:motionSharedPhoto/);
  assert.match(css, /img\.motion-photo-error\{animation:motionPhotoError/);
  assert.match(css, /\.motion-undo-toast\{[^}]*backdrop-filter/s);
});
