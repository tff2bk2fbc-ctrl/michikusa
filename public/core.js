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
const PROFILE_ICONS=['pin','camera','mountain','tree','star','moon','wave','flower'];
const PROFILE_ICON_LABELS={pin:'記憶のピン',camera:'カメラ',mountain:'山',tree:'木',star:'星',moon:'月',wave:'波',flower:'花'};
const ASK={'喫茶':['何を飲んだ / 食べた？','クリームソーダ'],'食':['何を食べた？','味玉らーめん'],
  '酒':['何を飲んだ？','レモンサワー'],'湯':['ひとこと','外気浴の椅子が最高'],
  '社':['どう撮った？','夕方、参道から'],'園':['どう撮った？','桜、朝いちばん'],
  '景':['どう撮った？','対岸から、日没20分前'],'本':['ひとこと','2階の奥がいい'],
  '宿':['どんな宿だった？','露天風呂つき／朝ごはんが良い']};
function ask(c){return ASK[c]||['ひとこと',''];}
const HP_CAT={G001:'酒',G002:'酒',G011:'酒',G012:'酒',G014:'喫茶'};

let spots=[], pois=[], placing=null, dropM=null, meM=null, askSeq=0;
/*
 * みんなの地図は公開投稿だけ、自分の地図は自分の全記録だけを描く。
 * 投稿自体は常に自分の記録として保存され、公開を選んだものだけが
 * みんなの地図にも現れる。ログイン前は端末内の記録を失ったように
 * 見せないため、自分の地図から始める。
 */
let mapAudience='mine';
let night=(function(){
  try{var saved=localStorage.getItem('mk_color_mode');if(saved)return saved==='dark';}catch(e){}
  var h=new Date().getHours();return h<6||h>=18;
})();
let is3D=true;
document.body.classList.toggle('dark',night);

function esc(s){return String(s==null?'':s).replace(/[<>&"]/g,function(c){
  return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c];});}
function setTip(t,kind){var e=document.getElementById('tip');e.textContent=t;e.style.opacity='1';
  // kind は処理結果を確定した呼び出し側だけが指定する。未指定の文言は
  // 通知だけに留め、成功演出を推測して誤表示しない。
  if(kind&&window.SpotaMotion&&typeof window.SpotaMotion.tipFeedback==='function')window.SpotaMotion.tipFeedback(kind);
  clearTimeout(setTip.t);setTip.t=setTimeout(function(){e.style.opacity='0';},4200);}
function valid(p){return p&&isFinite(p.lat)&&isFinite(p.lng)&&Math.abs(p.lat)<=90&&Math.abs(p.lng)<=180;}
function nid(){return 'p'+Date.now().toString(36)+Math.random().toString(36).slice(2,7);}
function el(h){var d=document.createElement('div');d.innerHTML=h.trim();return d.firstElementChild;}
function profileIconSvg(name){
  var paths={
    pin:'<path d="M12 21s6-5.7 6-11a6 6 0 1 0-12 0c0 5.3 6 11 6 11Z"/><circle cx="12" cy="10" r="2.2"/>',
    camera:'<path d="M4 7.5h4l1.4-2h5.2l1.4 2h4v11H4Z"/><circle cx="12" cy="13" r="3.2"/>',
    mountain:'<path d="m3.5 18 6.2-10 3.1 4.6 2-3 5.7 8.4Z"/><path d="m7.9 11 1.8 1.5 1.3-1"/>',
    tree:'<path d="M12 4 7 11h2l-3 4.5h4.3V20h3.4v-4.5H18L15 11h2Z"/>',
    star:'<path d="m12 3 2.5 5.8 6.2.6-4.7 4.1 1.4 6.1-5.4-3.2-5.4 3.2 1.4-6.1-4.7-4.1 6.2-.6Z"/>',
    moon:'<path d="M18.5 15.7A8 8 0 0 1 8.3 5.5a7 7 0 1 0 10.2 10.2Z"/>',
    wave:'<path d="M3 14c2.1 0 2.1-2.5 4.2-2.5s2.1 2.5 4.2 2.5 2.1-2.5 4.2-2.5 2.1 2.5 4.4 2.5"/><path d="M4.5 18c1.7 0 1.7-2 3.4-2s1.7 2 3.4 2 1.7-2 3.4-2 1.7 2 3.4 2"/>',
    flower:'<circle cx="12" cy="12" r="2"/><path d="M12 10c-3.8-1.2-3.6-5.7 0-6 3.6.3 3.8 4.8 0 6Zm2 2c1.2-3.8 5.7-3.6 6 0-.3 3.6-4.8 3.8-6 0Zm-2 2c3.8 1.2 3.6 5.7 0 6-3.6-.3-3.8-4.8 0-6Zm-2-2c-1.2 3.8-5.7 3.6-6 0 .3-3.6 4.8-3.8 6 0Z"/>'
  };
  var key=PROFILE_ICONS.indexOf(name)>=0?name:'pin';
  return '<svg class="profile-symbol" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+paths[key]+'</svg>';
}
function visibleOwnSpots(){
  return mapAudience==='mine'?spots:spots.filter(function(p){return p.visibility==='public';});
}
function visibleOtherSpots(){
  if(mapAudience!=='public')return [];
  try{
    return Object.keys(others||{}).map(function(k){return others[k];})
      .filter(function(p){return p.visibility==='public';});
  }catch(e){return [];}
}
function refreshMapAudienceUI(){
  var button=document.getElementById('btn-map-scope');if(!button)return;
  var viewingPublic=mapAudience==='public';
  var icon=viewingPublic
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="3.7"/><path d="M4.8 20c.6-3.4 3.2-5.5 7.2-5.5s6.6 2.1 7.2 5.5"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M3.8 12h16.4M12 3.5c2.1 2.3 3.2 5.2 3.2 8.5S14.1 18.2 12 20.5M12 3.5C9.9 5.8 8.8 8.7 8.8 12s1.1 6.2 3.2 8.5"/></svg>';
  button.dataset.scope=mapAudience;
  button.classList.toggle('public-map',viewingPublic);
  button.setAttribute('aria-pressed',String(viewingPublic));
  button.setAttribute('aria-label',viewingPublic?'自分の地図へ切り替える':'みんなの地図へ切り替える');
  button.innerHTML=icon;
}
function setMapAudience(mode,quiet){
  if(mode!=='mine'&&mode!=='public')return;
  mapAudience=mode;refreshMapAudienceUI();
  if(typeof render==='function')render(true);
  if(mode==='public'&&typeof syncDown==='function')syncDown();
  if(!quiet)setTip(mode==='public'?'みんなの地図':'自分の地図');
}

/* ---------- 端末内の保存 ---------- */
let db=null, dbOpenPromise=null;
let dbLastError='';
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
  var q=indexedDB.open('michikusa',4);
  q.onupgradeneeded=function(){var d=q.result;
    if(!d.objectStoreNames.contains('spots'))d.createObjectStore('spots',{keyPath:'id'});
    if(!d.objectStoreNames.contains('meta'))d.createObjectStore('meta',{keyPath:'k'});
    if(!d.objectStoreNames.contains('seen'))d.createObjectStore('seen',{keyPath:'id'});
    if(!d.objectStoreNames.contains('deleted'))d.createObjectStore('deleted',{keyPath:'id'});
    if(!d.objectStoreNames.contains('album_order'))d.createObjectStore('album_order',{keyPath:'key'});};
  q.onsuccess=function(){db=q.result;db.onversionchange=function(){try{db.close();}catch(e){}db=null;dbOpenPromise=null;};r(true);};q.onerror=function(){r(false);};
  setTimeout(function(){if(!db)r(false);},4000);}catch(e){r(false);}});
  return dbOpenPromise;
}
function tx(s,m){return db.transaction(s,m).objectStore(s);}
function dbPut(s,v){return new Promise(function(r){if(!db)return r(false);
  try{
    if(s==='spots'&&!v.owner_scope)v.owner_scope=activeSpotScope;
    // request.success は、書き込みトランザクションの確定より先に発火する。
    // iOSの容量超過では、その後transactionがabortしても従来は成功扱いになっていた。
    var transaction=db.transaction(s,'readwrite'),settled=false;
    transaction.objectStore(s).put(v);
    function fail(e){
      if(settled)return;settled=true;
      var err=transaction.error||(e&&e.target&&e.target.error)||e;
      dbLastError=String(err&&err.name||err&&err.message||'IndexedDB write failed').slice(0,80);
      r(false);
    }
    transaction.oncomplete=function(){if(settled)return;settled=true;dbLastError='';r(true);};
    transaction.onerror=fail;transaction.onabort=fail;
  }catch(e){dbLastError=String(e&&e.name||e&&e.message||'IndexedDB write failed').slice(0,80);r(false);}});}
/*
 * Album order is stored separately from photo records. Reordering must never
 * serialize up to 120 original images again: only the small owner/id/month/order
 * rows are committed in one transaction.
 */
function albumOrderKey(scope,id){return String(scope)+'\u001f'+String(id);}
function dbPutAlbumOrdersAtomic(records,expectedScope){return new Promise(function(resolve){
  if(!db||!Array.isArray(records)||!records.length||records.length>120||
      !expectedScope||expectedScope!==activeSpotScope||!db.objectStoreNames.contains('album_order'))return resolve(false);
  var clean=[],ids=Object.create(null),orders=Object.create(null),month='';
  for(var i=0;i<records.length;i++){
    var record=records[i]||{},id=String(record.id||''),scope=String(record.owner_scope||''),
      monthKey=String(record.month_key||''),order=Number(record.order);
    if(!id||id.length>256||scope!==expectedScope||scope!==activeSpotScope||
        !/^(?:none|\d{4}-\d{2})$/.test(monthKey)||!Number.isInteger(order)||order<0||order>=records.length||
        ids[id]||orders[order]||(month&&month!==monthKey))return resolve(false);
    ids[id]=1;orders[order]=1;month=monthKey;
    clean.push({key:albumOrderKey(scope,id),id:id,owner_scope:scope,month_key:monthKey,order:order});
  }
  var transaction,settled=false;
  function fail(e){
    if(settled)return;settled=true;
    var err=(transaction&&transaction.error)||(e&&e.target&&e.target.error)||e;
    dbLastError=String(err&&err.name||err&&err.message||'IndexedDB write failed').slice(0,80);
    resolve(false);
  }
  try{
    transaction=db.transaction('album_order','readwrite');
    var store=transaction.objectStore('album_order');
    clean.forEach(function(value){store.put(value);});
    transaction.oncomplete=function(){if(settled)return;settled=true;dbLastError='';resolve(true);};
    transaction.onerror=fail;transaction.onabort=fail;
  }catch(e){fail(e);}
});}
function dbFailureReason(){
  return /QuotaExceeded/i.test(dbLastError)?'端末の保存容量が不足しています':
    (dbLastError?'端末保存エラー: '+dbLastError:'端末へ保存できませんでした');
}
function dbDel(s,k){return new Promise(function(r){if(!db)return r(false);
  try{var q=tx(s,'readwrite').delete(k);q.onsuccess=function(){r(true);};q.onerror=function(){r(false);};}catch(e){r(false);}});}
function dbAll(s){return new Promise(function(r){if(!db)return r([]);
  try{var q=tx(s,'readonly').getAll();q.onsuccess=function(){r(q.result||[]);};q.onerror=function(){r([]);};}catch(e){r([]);}});}
function dbGet(s,k){return new Promise(function(r){if(!db)return r(null);
  try{var q=tx(s,'readonly').get(k);q.onsuccess=function(){r(q.result||null);};q.onerror=function(){r(null);};}catch(e){r(null);}});}
window.dbPutAlbumOrdersAtomic=dbPutAlbumOrdersAtomic;

/* 端末データはログイン中のアカウントだけを表示・同期する。 */
async function activateSpotScope(user){
  var seq=++spotScopeSwitch, next=spotScope(user);
  if(next!==activeSpotScope){
    if(window.SpotaMotion&&typeof window.SpotaMotion.dismissUndo==='function')window.SpotaMotion.dismissUndo();
    if(typeof window.clearSharedPhotoCache==='function')window.clearSharedPhotoCache();
    if(typeof window.invalidatePhotoRestoreQueue==='function')window.invalidatePhotoRestoreQueue();
  }
  activeSpotScope=next;
  spots=[];
  if(typeof others!=='undefined')others={};
  if(typeof closeSheet==='function')closeSheet();
  if(typeof closeViewer==='function')closeViewer();
  var inbox=document.getElementById('inbox');if(inbox)inbox.remove();
  var liveMap=window.__michikusaMap;
  if(typeof render==='function'&&liveMap&&liveMap.getSource&&liveMap.getSource('mine'))render(true);
  await openDB();
  var all=await dbAll('spots'),albumOrders=await dbAll('album_order');
  var tombstones={};(await dbAll('deleted')).forEach(function(t){
    if(t.owner_scope===next)tombstones[t.server_id]=1;
  });
  if(seq!==spotScopeSwitch)return spots;
  spots=all.filter(function(p){
    return valid(p)&&p.owner_scope===next&&!tombstones[p.server_id];
  });
  var orderById=Object.create(null);albumOrders.forEach(function(row){
    if(row&&row.owner_scope===next)orderById[String(row.id||'')]=row;
  });
  spots.forEach(function(p){
    var row=orderById[String(p.id||'')],month=String(p.d||'').slice(0,7)||'none';
    if(row&&row.month_key===month&&Number.isInteger(row.order)&&row.order>=0)p.album_order=row.order;
    else delete p.album_order;
  });
  if(typeof others!=='undefined')others={};
  liveMap=window.__michikusaMap;
  if(typeof render==='function'&&liveMap&&liveMap.getSource&&liveMap.getSource('mine'))render(true);
  if(typeof prepareSpotThumbs==='function')setTimeout(prepareSpotThumbs,0);
  return spots;
}
