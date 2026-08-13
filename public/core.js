/* ============================================================
   土台

   設定・共通の道具・端末内の保存。
   ほかのファイルは、ここにあるものを使う。
   ============================================================ */
if(typeof maplibregl==='undefined') showErr('地図の読み込みに失敗しました');

/* アプリとして動くとき、/api は自分自身を指してしまう。
   そのため、サーバーの場所をはっきり書いておく */
const SERVER = (location.protocol==='http:'||location.protocol==='https:')
  ? '' : 'https://broad-wildflower-9e30.j4hrd7zdgc.workers.dev';

const STYLE='https://tiles.openfreemap.org/styles/liberty';
const CATS=['喫茶','食','酒','湯','宿','社','園','景','本'];
const ASK={'喫茶':['何を飲んだ / 食べた？','クリームソーダ'],'食':['何を食べた？','味玉らーめん'],
  '酒':['何を飲んだ？','レモンサワー'],'湯':['ひとこと','外気浴の椅子が最高'],
  '社':['どう撮った？','夕方、参道から'],'園':['どう撮った？','桜、朝いちばん'],
  '景':['どう撮った？','対岸から、日没20分前'],'本':['ひとこと','2階の奥がいい'],
  '宿':['どんな宿だった？','露天風呂つき／朝ごはんが良い']};
function ask(c){return ASK[c]||['ひとこと',''];}
const HP_CAT={G001:'酒',G002:'酒',G011:'酒',G012:'酒',G014:'喫茶'};

let spots=[], pois=[], placing=null, dropM=null, meM=null, askSeq=0;
let night=(function(){
  try{var saved=localStorage.getItem('mk_color_mode');if(saved)return saved==='dark';}catch(e){}
  var h=new Date().getHours();return h<6||h>=18;
})();
let is3D=true;
document.body.classList.toggle('dark',night);

function esc(s){return String(s==null?'':s).replace(/[<>&"]/g,function(c){
  return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c];});}
function setTip(t){var e=document.getElementById('tip');e.textContent=t;e.style.opacity='1';
  clearTimeout(setTip.t);setTip.t=setTimeout(function(){e.style.opacity='0';},4200);}
function valid(p){return p&&isFinite(p.lat)&&isFinite(p.lng)&&Math.abs(p.lat)<=90&&Math.abs(p.lng)<=180;}
function nid(){return 'p'+Date.now().toString(36)+Math.random().toString(36).slice(2,7);}
function el(h){var d=document.createElement('div');d.innerHTML=h.trim();return d.firstElementChild;}

/* ---------- 端末内の保存 ---------- */
let db=null, dbOpenPromise=null;
const GUEST_SCOPE=(function(){
  try{
    var v=localStorage.getItem('mk_guest_scope');
    if(!v){v='guest_'+nid();localStorage.setItem('mk_guest_scope',v);}
    return v;
  }catch(e){return 'guest_session';}
})();
let activeSpotScope=GUEST_SCOPE;
let spotScopeSwitch=0;
function spotScope(user){return user&&user.uid?'user_'+user.uid:GUEST_SCOPE;}
function openDB(){
  if(db)return Promise.resolve(true);
  if(dbOpenPromise)return dbOpenPromise;
  dbOpenPromise=new Promise(function(r){try{
  if(!window.indexedDB)return r(false);
  var q=indexedDB.open('michikusa',3);
  q.onupgradeneeded=function(){var d=q.result;
    if(!d.objectStoreNames.contains('spots'))d.createObjectStore('spots',{keyPath:'id'});
    if(!d.objectStoreNames.contains('meta'))d.createObjectStore('meta',{keyPath:'k'});
    if(!d.objectStoreNames.contains('seen'))d.createObjectStore('seen',{keyPath:'id'});
    if(!d.objectStoreNames.contains('deleted'))d.createObjectStore('deleted',{keyPath:'id'});};
  q.onsuccess=function(){db=q.result;r(true);};q.onerror=function(){r(false);};
  setTimeout(function(){if(!db)r(false);},4000);}catch(e){r(false);}});
  return dbOpenPromise;
}
function tx(s,m){return db.transaction(s,m).objectStore(s);}
function dbPut(s,v){return new Promise(function(r){if(!db)return r(false);
  try{
    if(s==='spots'&&!v.owner_scope)v.owner_scope=activeSpotScope;
    var q=tx(s,'readwrite').put(v);q.onsuccess=function(){r(true);};q.onerror=function(){r(false);};
  }catch(e){r(false);}});}
function dbDel(s,k){return new Promise(function(r){if(!db)return r(false);
  try{var q=tx(s,'readwrite').delete(k);q.onsuccess=function(){r(true);};q.onerror=function(){r(false);};}catch(e){r(false);}});}
function dbAll(s){return new Promise(function(r){if(!db)return r([]);
  try{var q=tx(s,'readonly').getAll();q.onsuccess=function(){r(q.result||[]);};q.onerror=function(){r([]);};}catch(e){r([]);}});}
function dbGet(s,k){return new Promise(function(r){if(!db)return r(null);
  try{var q=tx(s,'readonly').get(k);q.onsuccess=function(){r(q.result||null);};q.onerror=function(){r(null);};}catch(e){r(null);}});}

/* 端末データはログイン中のアカウントだけを表示・同期する。 */
async function activateSpotScope(user){
  var seq=++spotScopeSwitch, next=spotScope(user);
  activeSpotScope=next;
  spots=[];
  if(typeof others!=='undefined')others={};
  if(typeof closeSheet==='function')closeSheet();
  if(typeof closeViewer==='function')closeViewer();
  var inbox=document.getElementById('inbox');if(inbox)inbox.remove();
  if(typeof render==='function'&&map&&map.getSource&&map.getSource('mine'))render(true);
  await openDB();
  var all=await dbAll('spots');
  var tombstones={};(await dbAll('deleted')).forEach(function(t){
    if(t.owner_scope===next)tombstones[t.server_id]=1;
  });
  if(seq!==spotScopeSwitch)return spots;
  spots=all.filter(function(p){
    return valid(p)&&p.owner_scope===next&&!tombstones[p.server_id];
  });
  if(typeof others!=='undefined')others={};
  if(typeof render==='function'&&map&&map.getSource&&map.getSource('mine'))render(true);
  if(typeof prepareSpotThumbs==='function')setTimeout(prepareSpotThumbs,0);
  return spots;
}
