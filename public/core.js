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
let night=(function(){var h=new Date().getHours();return h<6||h>=18;})();
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
let db=null;
function openDB(){return new Promise(function(r){try{
  if(!window.indexedDB)return r(false);
  var q=indexedDB.open('michikusa',2);
  q.onupgradeneeded=function(){var d=q.result;
    if(!d.objectStoreNames.contains('spots'))d.createObjectStore('spots',{keyPath:'id'});
    if(!d.objectStoreNames.contains('meta'))d.createObjectStore('meta',{keyPath:'k'});
    if(!d.objectStoreNames.contains('seen'))d.createObjectStore('seen',{keyPath:'id'});};
  q.onsuccess=function(){db=q.result;r(true);};q.onerror=function(){r(false);};
  setTimeout(function(){if(!db)r(false);},4000);}catch(e){r(false);}});}
function tx(s,m){return db.transaction(s,m).objectStore(s);}
function dbPut(s,v){return new Promise(function(r){if(!db)return r(false);
  try{var q=tx(s,'readwrite').put(v);q.onsuccess=function(){r(true);};q.onerror=function(){r(false);};}catch(e){r(false);}});}
function dbDel(s,k){return new Promise(function(r){if(!db)return r(false);
  try{var q=tx(s,'readwrite').delete(k);q.onsuccess=function(){r(true);};q.onerror=function(){r(false);};}catch(e){r(false);}});}
function dbAll(s){return new Promise(function(r){if(!db)return r([]);
  try{var q=tx(s,'readonly').getAll();q.onsuccess=function(){r(q.result||[]);};q.onerror=function(){r([]);};}catch(e){r([]);}});}
