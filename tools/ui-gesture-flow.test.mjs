import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const root=new URL('../',import.meta.url);
const read=name=>readFile(new URL(name,root),'utf8');

function contrast(foreground,background){
  const luminance=hex=>{
    const channels=hex.match(/[0-9a-f]{2}/gi).map(value=>parseInt(value,16)/255)
      .map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);
    return .2126*channels[0]+.7152*channels[1]+.0722*channels[2];
  };
  const a=luminance(foreground),b=luminance(background);
  return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
}

function classes(){
  const values=new Set();
  return {
    add(...names){names.forEach(name=>values.add(name));},
    remove(...names){names.forEach(name=>values.delete(name));},
    toggle(name,force){if(force===undefined)force=!values.has(name);force?values.add(name):values.delete(name);return force;},
    contains(name){return values.has(name);}
  };
}

function style(){
  const values={};
  return {
    setProperty(name,value){values[name]=String(value);},
    getPropertyValue(name){return values[name]||'';},
    values
  };
}

class Target {
  constructor(){this.listeners={};this.classList=classes();this.style=style();this.dataset={};this.attrs={};}
  addEventListener(type,handler){(this.listeners[type]||(this.listeners[type]=[])).push(handler);}
  dispatch(type,event={}){
    event.currentTarget=this;
    event.preventDefault=event.preventDefault||function(){event.defaultPrevented=true;};
    event.stopImmediatePropagation=event.stopImmediatePropagation||function(){event.immediateStopped=true;};
    for(const handler of this.listeners[type]||[]){handler(event);if(event.immediateStopped)break;}
    return event;
  }
  setAttribute(name,value){this.attrs[name]=String(value);}
  removeAttribute(name){delete this.attrs[name];}
}

async function gestureHarness(){
  const source=await read('public/gestures.js');
  let clock=0;
  const windowTarget=new Target();
  const navItems=new Target();
  navItems.getBoundingClientRect=()=>({left:0,top:0,width:350,height:66});
  const lens=new Target();
  lens.animate=()=>({cancel(){}});lens.getAnimations=()=>[];
  const pill=new Target();pill.querySelector=selector=>selector==='i'?lens:null;
  const bar=new Target();bar._capture=null;
  bar.querySelector=selector=>selector==='#pill'?pill:null;
  bar.setPointerCapture=id=>{bar._capture=id;};
  bar.hasPointerCapture=id=>bar._capture===id;
  bar.releasePointerCapture=id=>{if(bar._capture===id)bar._capture=null;};
  const items=Array.from({length:5},(_,index)=>{
    const item=new Target();item.parentElement=navItems;item.index=index;item.actionCount=0;
    item.getBoundingClientRect=()=>({left:index*70,top:0,width:70,height:66});
    item.closest=selector=>selector==='.nav-btn,.cam'?item:null;
    item.focus=()=>{item.focused=true;};
    item.click=()=>{
      const event=bar.dispatch('click',{target:item});
      if(!event.defaultPrevented&&!event.immediateStopped)item.actionCount++;
    };
    return item;
  });
  bar.querySelectorAll=selector=>selector==='.nav-btn,.cam'?items:[];

  const mapHost=new Target();
  const mapHandlers={};
  const map={on(type,handler){mapHandlers[type]=handler;}};
  const document={getElementById(id){return id==='fabs'?bar:id==='map'?mapHost:null;}};
  const window=Object.assign(windowTarget,{
    document,performance:{now:()=>clock},matchMedia:()=>({matches:false}),__michikusaMap:map,
    SpotaMotion:{haptic(){window.haptics=(window.haptics||0)+1;return Promise.resolve(true);}}
  });
  const context={window,document,performance:window.performance,requestAnimationFrame:fn=>fn(),Math,Number,String,Object,Date,Promise};
  vm.createContext(context);vm.runInContext(source,context);
  function pointer(target,type,x,y,id=1){return target.dispatch(type,{target:items[0],pointerId:id,pointerType:'touch',isPrimary:true,button:0,clientX:x,clientY:y,key:''});}
  return {window,bar,items,lens,pill,mapHost,mapHandlers,setClock(value){clock=value;},pointer};
}

test('本番HTMLは既存の5操作順を維持して新しいジェスチャーを最後に読み込む',async()=>{
  const html=await read('public/index.html');
  assert.match(html,/id="btn-timeline" data-i="0"[\s\S]*id="btn-bulk" data-i="1"[\s\S]*id="btn-cam" data-i="2"[\s\S]*id="btn-lib" data-i="3"[\s\S]*id="btn-me" data-i="4"/);
  assert.match(html,/id="pill" aria-hidden="true"><i><\/i><\/div>/);
  assert.ok(html.indexOf('/release.js?v=128')<html.indexOf('/gestures.js?v=129'));
});

test('横スワイプは速度を投影して隣の操作を一度だけ実行する',async()=>{
  const h=await gestureHarness();
  h.setClock(0);h.pointer(h.bar,'pointerdown',50,40);
  h.setClock(48);h.pointer(h.bar,'pointermove',-12,42);
  h.setClock(82);h.pointer(h.bar,'pointerup',-26,42);
  assert.equal(h.window.SpotaGestures.navigation.getIndex(),1);
  assert.equal(h.items[1].actionCount,1);
  assert.equal(h.items[0].actionCount,0);
  assert.equal(h.window.haptics,1);
  assert.equal(h.bar.classList.contains('is-dragging'),false);
});

test('縦移動とpointercancelはタブを変更せず操作も実行しない',async()=>{
  const h=await gestureHarness();
  h.setClock(0);h.pointer(h.bar,'pointerdown',48,40);
  h.setClock(50);h.pointer(h.bar,'pointermove',51,108);
  h.setClock(70);h.pointer(h.bar,'pointerup',51,108);
  assert.equal(h.window.SpotaGestures.navigation.getIndex(),0);
  assert.equal(h.items.reduce((sum,item)=>sum+item.actionCount,0),0);
  h.setClock(100);h.pointer(h.bar,'pointerdown',48,40,2);
  h.setClock(130);h.pointer(h.bar,'pointermove',-20,41,2);
  h.setClock(140);h.pointer(h.bar,'pointercancel',-20,41,2);
  assert.equal(h.window.SpotaGestures.navigation.getIndex(),0);
  assert.equal(h.bar.classList.contains('is-dragging'),false);
});

test('地図ドラッグ後だけclickを210ms抑止し、通常タップは残す',async()=>{
  const h=await gestureHarness();
  h.setClock(0);h.pointer(h.mapHost,'pointerdown',100,100,9);
  h.setClock(30);h.pointer(h.window,'pointermove',116,102,9);
  h.setClock(50);h.pointer(h.window,'pointerup',116,102,9);
  assert.equal(h.window.SpotaGestures.mapTapAllowed(),false);
  h.setClock(261);assert.equal(h.window.SpotaGestures.mapTapAllowed(),true);
  h.setClock(300);h.pointer(h.mapHost,'pointerdown',100,100,10);
  h.setClock(340);h.pointer(h.window,'pointerup',103,102,10);
  assert.equal(h.window.SpotaGestures.mapTapAllowed(),true);
});

test('地図クリックの安全ガードは位置確定より先に評価される',async()=>{
  const place=await read('public/place.js');
  const start=place.indexOf("map.on('click',function(e){");
  const guard=place.indexOf('SpotaGestures.mapTapAllowed',start);
  const placing=place.indexOf('if(placing){ movePlacing',start);
  assert.ok(start>=0&&guard>start&&placing>guard);
});

test('Liquid Glassと選択抑止は入力可能性・Reduce Motion・強制色を保つ',async()=>{
  const css=await read('public/app.css');
  assert.match(css,/body,body \*\{[^}]*user-select:none[^}]*touch-callout:none/);
  assert.match(css,/input,textarea,select,\[contenteditable="true"\][^{]*\{[^}]*user-select:text/);
  assert.match(css,/\.fabs\{[^}]*left:16px[^}]*min-height:76px[^}]*blur\(24px\)[^}]*saturate\(1\.75\)/s);
  assert.match(css,/\.fabs::after\{[^}]*--glass-glow-shift/s);
  assert.match(css,/\.bc svg\{[^}]*filter:none/);
  assert.match(css,/@media \(prefers-reduced-motion:reduce\)[\s\S]*\.pill>i\{transform:none!important\}/);
  assert.match(css,/@media \(forced-colors:active\)[\s\S]*\.fabs[^}]*background:Canvas/);
});

test('主要な本文・補助文字トークンはライトとダークでWCAG AAを満たす',()=>{
  assert.ok(contrast('#111111','#EFEDE8')>=4.5);
  assert.ok(contrast('#626262','#EFEDE8')>=4.5);
  assert.ok(contrast('#626262','#FFFFFF')>=4.5);
  assert.ok(contrast('#F2F2F4','#121214')>=4.5);
  assert.ok(contrast('#9E9EA4','#121214')>=4.5);
  assert.ok(contrast('#F2F2F4','#1E1E22')>=4.5);
});

test('新しいジェスチャーは通信・コード実行・HTML注入を追加しない',async()=>{
  const source=await read('public/gestures.js');
  assert.doesNotMatch(source,/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|postMessage\s*\(/);
  assert.doesNotMatch(source,/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function/);
});

test('起動エラーはHTMLとして解釈せずtextContentで表示する',async()=>{
  const boot=await read('public/boot.js');
  const start=boot.indexOf('function showErr');
  const end=boot.indexOf('function dump',start);
  const block=boot.slice(start,end);
  assert.match(block,/title\.textContent=/);
  assert.match(block,/document\.createTextNode/);
  assert.doesNotMatch(block,/innerHTML|insertAdjacentHTML|outerHTML/);
});
