/* ============================================================
   サーバーとの同期

   これまでは端末の中だけに置いていた。
   Safariは7日開かないと消してしまうので、思い出が消える。
   ログインしたら、サーバーへ預けて、どの端末からでも戻るようにする。
   ============================================================ */

/* 写真をサーバーへ。原本と表示用を別々に持つ */
async function uploadPhoto(auth,postId,photoId,dataUrl){
  try{
    var blob=await (await fetch(dataUrl)).blob();
    var pid=photoId;
    async function put(kind,body,type){
      var r=await apiAs(auth,'/api/photo?post_id='+encodeURIComponent(postId)+
        '&photo_id='+encodeURIComponent(pid)+'&kind='+kind,
        {method:'PUT',headers:{'Content-Type':type},body:body});
      if(!r.ok)throw new Error('photo upload '+r.status);
    }
    // 原本
    await put('orig',blob,blob.type||'image/jpeg');
    // 表示用（軽くしたもの）
    var view=await resize(dataUrl,2560,.90);
    if(view){
      var vb=await (await fetch(view)).blob();
      await put('view',vb,'image/jpeg');
    }
    var th=await resize(dataUrl,512,.82);
    if(th){
      var tb=await (await fetch(th)).blob();
      await put('thumb',tb,'image/jpeg');
    }
    return true;
  }catch(e){ return false; }
}
function resize(dataUrl,max,q){
  return new Promise(function(res){
    var im=new Image();
    im.onload=function(){
      var sc=Math.min(1,max/Math.max(im.width,im.height));
      var cv=document.createElement('canvas');
      cv.width=Math.round(im.width*sc); cv.height=Math.round(im.height*sc);
      var cx=cv.getContext('2d'); cx.imageSmoothingQuality='high';
      cx.drawImage(im,0,0,cv.width,cv.height);
      res(cv.toDataURL('image/jpeg',q));
    };
    im.onerror=function(){res(null);};
    im.src=dataUrl;
  });
}

/* 小さな一覧では原本を展開せず、端末内プレビューだけを使う。 */
async function ensureLocalThumb(rec){
  if(!rec||!rec.photo||rec.photo_thumb||rec.photo_is_thumb||rec.thumb_building)return;
  rec.thumb_building=1;
  try{
    var th=await resize(rec.photo,512,.82);
    if(th){rec.photo_thumb=th;delete rec.thumb_building;await dbPut('spots',rec);}
  }catch(e){}
  delete rec.thumb_building;
}
function prepareSpotThumbs(){
  spots.filter(function(p){return p&&p.photo&&!p.photo_thumb&&!p.photo_is_thumb;})
    .slice(-3).forEach(ensureLocalThumb);
}

/* 1件をサーバーへ送る */
async function pushOne(rec){
  try{
    var auth=await captureAuth();
    if(!auth||rec.owner_scope!==auth.scope)return false;
    // 他人に見せるものは、先に写真を確かめる
    if(rec.photo && rec.visibility!=='private'){
      try{
        var vr=await apiAs(auth,'/api/vision',{method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({image:String(rec.photo)})});
        if(!vr.ok)throw new Error('moderation unavailable');
        var vj=await vr.json();
        if(!vj || vj.ok!==true)throw new Error('moderation rejected');
      }catch(e){
        rec.visibility='private';
        if(authIsCurrent(auth))setTip('写真を確認できないため、自分だけの記録にしました');
      }
    }
    if(!rec.server_id){
      var r=await apiAs(auth,'/api/posts',{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          title:rec.n, category:rec.c, tag:rec.tag||'', place_name:rec.place||'',
          lat:rec.lat, lng:rec.lng,
          taken_at:rec.d?Date.parse(rec.d):null,
          visibility:rec.visibility||null
        })});
      if(!r.ok)return false;
      var j=await r.json();
      rec.server_id=j.id;
      rec.visibility=j.visibility;
      await dbPut('spots',rec);
    }
    if(rec.photo){
      rec.server_photo_id=rec.server_photo_id||nid();
      await dbPut('spots',rec);
      if(!(await uploadPhoto(auth,rec.server_id,rec.server_photo_id,rec.photo)))return false;
    }
    rec.synced=1;
    await dbPut('spots',rec);
    return true;
  }catch(e){ return false; }
}

/* まだ送っていないものをまとめて送る */
let syncing=false;
async function syncUp(){
  if(!fbUser||syncing)return;
  var startedScope=activeSpotScope;
  var todo=spots.filter(function(s){return !s.synced&&s.owner_scope===activeSpotScope;});
  if(!todo.length)return;
  syncing=true;
  setTip('思い出をサーバーへ預けています…（'+todo.length+'件）');
  var ok=0;
  for(var i=0;i<todo.length;i++){ if(await pushOne(todo[i]))ok++; }
  syncing=false;
  setTip(ok?(ok+'件を預けました'):'預けられませんでした');
  render(true);
  if(fbUser&&activeSpotScope!==startedScope)setTimeout(syncUp,0);
}

/* サーバーから取り込む。他人のぶんも含む */
let fetching=false;
var restoreQueue=[], restoring=0;
function blobDataUrl(blob){return new Promise(function(resolve,reject){
  var rd=new FileReader();rd.onload=function(){resolve(rd.result);};rd.onerror=reject;rd.readAsDataURL(blob);
});}
function queuePhotoRestore(rec,photoId,auth){
  if(!photoId||rec.photo||rec.photo_restoring||(rec.photo_retry_at||0)>Date.now())return;
  rec.photo_restoring=1;restoreQueue.push({rec:rec,id:photoId,auth:auth});runPhotoRestore();
}
function runPhotoRestore(){
  while(restoring<2&&restoreQueue.length){
    var job=restoreQueue.shift();restoring++;
    (async function(j){try{
      var r=await apiAs(j.auth,'/api/photo/'+encodeURIComponent(j.id)+'/thumb');
      if(!r.ok)throw new Error('photo '+r.status);
      var data=await blobDataUrl(await r.blob());
      if(j.rec.owner_scope!==activeSpotScope)return;
      j.rec.photo=data;j.rec.photo_is_thumb=1;j.rec.server_photo_id=j.id;delete j.rec.photo_restoring;
      await dbPut('spots',j.rec);render(true);
    }catch(e){
      delete j.rec.photo_restoring;j.rec.photo_retry_at=Date.now()+10*60*1000;dbPut('spots',j.rec);
    }finally{restoring--;runPhotoRestore();}})(job);
  }
}
async function syncDeletions(auth){
  if(!auth)return {};
  var metaKey='delete_cursor|'+auth.scope;
  var meta=await dbGet('meta',metaKey),cursor=meta&&meta.v||'0:',removed={};
  for(var page=0;page<5;page++){
    var r=await apiAs(auth,'/api/posts/deletions?cursor='+encodeURIComponent(cursor));
    if(!r.ok)break;
    var j=await r.json();
    for(var i=0;i<(j.deleted||[]).length;i++){
      var row=j.deleted[i],tombId=auth.scope+'|'+row.id;
      await dbPut('deleted',{id:tombId,server_id:row.id,owner_scope:auth.scope,state:'confirmed',at:row.deleted_at});
      var local=spots.filter(function(x){return x.server_id===row.id&&x.owner_scope===auth.scope;});
      for(var q=0;q<local.length;q++)await dbDel('spots',local[q].id);
      removed[row.id]=1;
    }
    cursor=j.cursor||cursor;await dbPut('meta',{k:metaKey,v:cursor});
    if(!j.has_more)break;
  }
  if(Object.keys(removed).length&&authIsCurrent(auth)){
    spots=spots.filter(function(x){return !removed[x.server_id];});render(true);
  }
  return removed;
}
async function retryPendingDeletes(auth){
  var all=await dbAll('deleted');
  var pending=all.filter(function(t){
    return t.owner_scope===auth.scope&&t.state==='pending'&&(t.retry_at||0)<=Date.now();
  });
  for(var i=0;i<pending.length;i++){
    var t=pending[i];
    try{
      var r=await apiAs(auth,'/api/posts/'+encodeURIComponent(t.server_id),{method:'DELETE'});
      if(!r.ok&&r.status!==404)throw new Error('delete '+r.status);
      var records=(await dbAll('spots')).filter(function(p){return p.owner_scope===auth.scope&&p.server_id===t.server_id;});
      for(var q=0;q<records.length;q++)await dbDel('spots',records[q].id);
      t.state='confirmed';await dbPut('deleted',t);
    }catch(e){
      t.retry_at=Date.now()+10*60*1000;t.tries=(t.tries||0)+1;await dbPut('deleted',t);
    }
  }
}
async function syncOwnArchive(auth){
  if(!authIsCurrent(auth))return;
  var key='archive_cursor|'+auth.scope,initial='9007199254740991:zzzzzzzz';
  var meta=await dbGet('meta',key),cursor=meta&&meta.v||initial,hasMore=false,failed=false,added=0,photoLoads=0;
  for(var page=0;page<5&&authIsCurrent(auth);page++){
    var r=await apiAs(auth,'/api/posts/mine?cursor='+encodeURIComponent(cursor));
    if(!r.ok){failed=true;break;}
    var j=await r.json();hasMore=!!j.has_more;
    var tombstones={};(await dbAll('deleted')).forEach(function(t){
      if(t.owner_scope===auth.scope)tombstones[t.server_id]=1;
    });
    for(var i=0;i<(j.posts||[]).length;i++){
      var p=j.posts[i];if(tombstones[p.id])continue;
      var existing=spots.filter(function(x){return x.server_id===p.id&&x.owner_scope===auth.scope;})[0];
      if(existing){
        if(!existing.photo&&p.photo_id&&photoLoads<3){queuePhotoRestore(existing,p.photo_id,auth);photoLoads++;}
        continue;
      }
      var rec={id:nid(),server_id:p.id,synced:1,n:p.title,c:p.category,
        tag:p.tag||'',place:p.place_name||'',lat:p.lat,lng:p.lng,
        d:p.taken_at?new Date(p.taken_at).toISOString().slice(0,10):'',
        photo:'',visibility:p.visibility,server_photo_id:p.photo_id||null,owner_scope:auth.scope};
      if(await dbPut('spots',rec)){
        if(authIsCurrent(auth))spots.push(rec);
        if(p.photo_id&&photoLoads<3){queuePhotoRestore(rec,p.photo_id,auth);photoLoads++;}
        added++;
      }
    }
    cursor=j.cursor||cursor;await dbPut('meta',{k:key,v:cursor});
    if(!hasMore)break;
  }
  if(added&&authIsCurrent(auth))render(true);
  if(failed)return;
  if(!hasMore){await dbPut('meta',{k:key,v:initial});return;}
  if(authIsCurrent(auth))setTimeout(function(){syncOwnArchive(auth);},1500);
}
async function syncDown(){
  if(!fbUser||fetching)return;
  fetching=true;
  var auth=null,startedScope=activeSpotScope,startedUid=fbUser.uid;
  try{
    auth=await captureAuth();if(!auth)return;
    startedScope=auth.scope;startedUid=auth.uid;
    await syncDeletions(auth);
    var b=map.getBounds();
    var r=await apiAs(auth,'/api/posts?s='+b.getSouth()+'&w='+b.getWest()+
      '&n='+b.getNorth()+'&e='+b.getEast()+'&limit=100');
    if(!r.ok)return;
    var j=await r.json();
    if(!fbUser||fbUser.uid!==startedUid||activeSpotScope!==startedScope)return;
    var tombstones={};(await dbAll('deleted')).forEach(function(t){
      if(t.owner_scope===auth.scope)tombstones[t.server_id]=1;
    });
    var mineIds={}; spots.forEach(function(s){ if(s.server_id)mineIds[s.server_id]=s; });
    var added=0;
    (j.posts||[]).forEach(function(p){
      if(p.mine){
        if(tombstones[p.id])return;
        if(mineIds[p.id]){
          if(!mineIds[p.id].photo&&p.photo_id)queuePhotoRestore(mineIds[p.id],p.photo_id,auth);
          return;
        }
        var rec={id:nid(),server_id:p.id,synced:1,n:p.title,c:p.category,
          tag:p.tag||'',place:p.place_name||'',lat:p.lat,lng:p.lng,
          d:p.taken_at?new Date(p.taken_at).toISOString().slice(0,10):'',
          photo:'',visibility:p.visibility,server_photo_id:p.photo_id||null};
        rec.owner_scope=activeSpotScope;
        spots.push(rec); dbPut('spots',rec);if(p.photo_id)queuePhotoRestore(rec,p.photo_id,auth);added++;
      }else{
        // 他人の思い出。地図には出すが端末には残さない
        var k=p.id;
        if(others[k])return;
        others[k]={n:p.title,c:p.category,lat:p.lat,lng:p.lng,
          gname:(p.author&&p.author.name?p.author.name+' の思い出':''),
          tag:p.tag||'',author:p.author,precision:p.precision,friend:true};
        added++;
      }
    });
    if(added)render(true);
    await syncDeletions(auth);
  }catch(e){}finally{
    fetching=false;
    if(fbUser&&(fbUser.uid!==startedUid||activeSpotScope!==startedScope))setTimeout(syncDown,0);
  }
}
let others={};



/* ============================================================
   届いたタグ

   フレンドがタグ付けすると、ここに出る。
   受け取れば、同じ思い出が自分の地図にも載る。
   ============================================================ */
async function checkTags(){
  if(!fbUser)return;
  try{
    var auth=await captureAuth();if(!auth)return;
    var r=await apiAs(auth,'/api/tags');
    if(!r.ok)return;
    var j=await r.json();
    if(!authIsCurrent(auth))return;
    var t=(j.tags||[])[0];
    if(!t)return;
    showInbox(t,auth);
  }catch(e){}
}

function showInbox(t,auth){
  var box=document.getElementById('inbox');
  if(!box){
    box=el('<div class="inbox" id="inbox"></div>');
    document.body.appendChild(box);
  }
  box.innerHTML='<div class="r">'+
    '<img id="ib-img">'+
    '<div class="t"><b>'+esc(t.from.name)+' がタグ付けしました</b>'+
    '<span>'+esc(t.title||t.place_name||'')+'</span></div></div>'+
    '<div class="b"><button id="ib-no">いらない</button>'+
    '<button class="y" id="ib-yes">自分の思い出にする</button></div>';
  box.classList.add('on');

  if(t.photo_id){
    apiAs(auth,'/api/photo/'+encodeURIComponent(t.photo_id)+'/thumb')
      .then(function(r){if(!r.ok)throw new Error('photo '+r.status);return r.blob();})
      .then(function(blob){
        var im=box.querySelector('#ib-img');if(!im)return;
        var u=URL.createObjectURL(blob);im.onload=function(){URL.revokeObjectURL(u);};im.src=u;
      }).catch(function(){});
  }

  async function reply(take){
    if(!authIsCurrent(auth)){box.remove();return;}
    box.classList.remove('on');
    try{
      var r=await apiAs(auth,'/api/tags/accept',{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({post_id:t.post_id, take:take})});
      var j=await r.json();
      if(take&&j.ok){
        setTip('自分の思い出になりました');
        syncDown();
        map.easeTo({center:[t.lng,t.lat],zoom:16.4,duration:800});
      }
    }catch(e){}
    setTimeout(checkTags,600);      // 次があれば続けて出す
  }
  box.querySelector('#ib-yes').onclick=function(){ reply(true); };
  box.querySelector('#ib-no').onclick=function(){ reply(false); };
}

/* ============================================================
   ログイン
   ============================================================ */
const FB={apiKey:"AIzaSyAJFFjRk6zvAA_L9-1O7Y7Q43Yw86QQtxM",
  authDomain:"michikusa-e34df.firebaseapp.com",projectId:"michikusa-e34df",
  storageBucket:"michikusa-e34df.firebasestorage.app",
  messagingSenderId:"1058235183759",appId:"1:1058235183759:web:8d0741be89ad707c07b6fa"};
let fbUser=null,meP=null;
let authChangeSeq=0;

/* 旧版の未同期データは、自動で新しいアカウントへ送らず本人に確認する。 */
async function migrateOwnedLegacy(auth){
  var all=await dbAll('spots');
  var legacy=all.filter(function(p){return !p.owner_scope&&p.synced&&p.server_id;});
  var migrated=0;
  for(var at=0;at<legacy.length;at+=99){
    var batch=legacy.slice(at,at+99),ids=batch.map(function(p){return p.server_id;});
    try{
      var r=await apiAs(auth,'/api/posts/ownership',{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:ids})});
      if(!r.ok)continue;
      var j=await r.json(),owned={};(j.ids||[]).forEach(function(id){owned[id]=1;});
      for(var i=0;i<batch.length;i++)if(owned[batch[i].server_id]){
        batch[i].owner_scope=auth.scope;if(await dbPut('spots',batch[i]))migrated++;
      }
    }catch(e){}
  }
  if(migrated&&authIsCurrent(auth))await activateSpotScope(auth.user);
}

async function offerLegacySpots(user,auth){
  var all=await dbAll('spots');
  var candidates=all.filter(function(p){
    return valid(p)&&!p.synced&&(!p.owner_scope||p.owner_scope===GUEST_SCOPE);
  });
  if(!candidates.length)return false;
  return new Promise(function(resolve){
    var settled=false;
    function finish(value){if(settled)return;settled=true;resolve(value);}
    var s=showSheet('<div class="grab"></div><div class="pad" style="padding-top:20px">'+
      '<div style="font-size:19px;font-weight:700;margin-bottom:8px">この端末の思い出</div>'+
      '<div style="font-size:13px;color:var(--dim);line-height:1.8;margin-bottom:18px">'+
      candidates.length+'件の未保存の思い出があります。現在のアカウントへ取り込みますか？</div>'+
      '<button class="btn" id="legacy-yes">このアカウントへ取り込む</button>'+
      '<button class="btn g" id="legacy-no" style="margin-top:8px">あとで</button></div>',
      function(){finish(false);});
    s.querySelector('#legacy-no').onclick=function(){finish(false);closeSheet();};
    s.querySelector('#legacy-yes').onclick=async function(){
      var button=this;button.disabled=true;button.textContent='取り込んでいます…';
      if(!authIsCurrent(auth)){finish(false);closeSheet();return;}
      var moved=0;
      for(var i=0;i<candidates.length;i++){
        candidates[i].owner_scope=spotScope(user);candidates[i].synced=0;
        if(await dbPut('spots',candidates[i]))moved++;
      }
      finish(true);closeSheet();await activateSpotScope(user);
      setTip(moved===candidates.length?moved+'件を取り込みました':moved+'件を取り込み、'+(candidates.length-moved)+'件は失敗しました');
    };
  });
}

/* 部品が用意できてから、ログインの仕組みを立ち上げる */
window.initAuth=function(){
  if(typeof firebase==='undefined')return;
  if(window.__authReady)return;
  window.__authReady=1;
  try{
    firebase.initializeApp(FB);
    try{ firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL); }catch(e){}

    firebase.auth().onAuthStateChanged(async function(u){
      var authSeq=++authChangeSeq;
      fbUser=u;meP=null;var b=document.getElementById('btn-me');
      if(!b)return;
      await activateSpotScope(u);
      if(authSeq!==authChangeSeq)return;
      if(u){
        b.innerHTML='<b>'+esc((u.displayName||'?').trim().charAt(0))+'</b>';
        var auth=await captureAuth(u);
        if(!auth||authSeq!==authChangeSeq)return;
        await retryPendingDeletes(auth);
        if(!authIsCurrent(auth)||authSeq!==authChangeSeq)return;
        await activateSpotScope(u);
        var profile=await loadMe(auth);
        if(!authIsCurrent(auth)||authSeq!==authChangeSeq)return;
        meP=profile;
        await migrateOwnedLegacy(auth);
        await offerLegacySpots(u,auth);
        if(!authIsCurrent(auth)||authSeq!==authChangeSeq)return;
        syncUp();syncDown().then(function(){syncOwnArchive(auth);});askHandle();setupPush();checkTags();
      }else{
        b.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>';
        meP=null;
      }
    });

    firebase.auth().getRedirectResult().then(function(r){
      if(r&&r.user) setTip('ログインしました');
    }).catch(function(e){
      if(e&&e.code&&e.code!=='auth/no-auth-event') setTip('ログイン失敗: '+e.code);
    });
  }catch(e){}
};

async function api(path,opt){
  opt=opt||{}; var h=Object.assign({},opt.headers||{});
  if(fbUser)h['Authorization']='Bearer '+(await fbUser.getIdToken());
  return fetch(SERVER+path,Object.assign({},opt,{headers:h}));
}
async function captureAuth(user){
  var u=user||fbUser;if(!u)return null;
  var token=await u.getIdToken();
  return {user:u,uid:u.uid,token:token,scope:spotScope(u),seq:authChangeSeq};
}
function authIsCurrent(auth){
  return !!(auth&&fbUser&&fbUser.uid===auth.uid&&activeSpotScope===auth.scope&&auth.seq===authChangeSeq);
}
function apiAs(auth,path,opt){
  if(!auth||!auth.token)return Promise.reject(new Error('auth context required'));
  opt=opt||{};var h=Object.assign({},opt.headers||{});h.Authorization='Bearer '+auth.token;
  return fetch(SERVER+path,Object.assign({},opt,{headers:h}));
}
async function loadMe(auth){
  try{var r=await apiAs(auth,'/api/me');if(r.ok)return await r.json();}catch(e){}
  return null;
}
document.getElementById('btn-me').onclick=async function(){
  if(typeof firebase==='undefined'){
    setTip('準備しています…');
    await need('firebase');
    if(window.initAuth)initAuth();
    await new Promise(function(r){setTimeout(r,300);});   // 状態が定まるのを少し待つ
  }
  openMe();
};



/* ============================================================
   ログイン

   アプリの中では別窓（ポップアップ）が開けないので、
   画面ごと移って戻ってくる方式にする。
   ============================================================ */

/* ============================================================
   はじめてのID

   ログインした直後に一度だけ尋ねる。
   あとから変えられない（配ったQRやリンクが死ぬため）ので、
   決める前にそのことを伝える。
   ============================================================ */
let askingHandle=false;

async function askHandle(){
  if(askingHandle)return;
  if(!fbUser||!meP||meP.handle)return;
  askingHandle=true;

  var base=(fbUser.displayName||'').replace(/[^A-Za-z0-9_]/g,'').slice(0,12).toLowerCase();
  var s=showSheet('<div class="grab"></div><div class="pad" style="padding-top:20px">'+
    '<div style="font-size:19px;font-weight:700;margin-bottom:8px">あなたのIDを決めます</div>'+
    '<div style="font-size:13px;color:var(--dim);line-height:1.85;margin-bottom:18px">'+
      'フレンドはこのIDであなたを見つけます。<br>'+
      '<b style="color:var(--warn)">あとから変えられません。</b>よく考えて決めてください。</div>'+
    '<input class="fld" id="h-in" placeholder="例：damo" autocomplete="off" '+
      'autocapitalize="none" spellcheck="false" value="'+esc(base)+'">'+
    '<div id="h-msg" style="font-size:12px;color:var(--dim);line-height:1.7;'+
      'min-height:34px;margin-bottom:4px">英数字と _ で、3〜20文字</div>'+
    '<button class="btn" id="h-ok">このIDにする</button></div>');

  var inp=s.querySelector('#h-in'), msg=s.querySelector('#h-msg'), ok=s.querySelector('#h-ok');

  function check(){
    var v=inp.value.trim();
    if(!/^[A-Za-z0-9_]{3,20}$/.test(v)){
      msg.textContent='英数字と _ で、3〜20文字にしてください';
      msg.style.color='var(--dim)';
      ok.disabled=true; return false;
    }
    msg.textContent='@'+v+' でよければ、下のボタンを押してください';
    msg.style.color='var(--dim)';
    ok.disabled=false; return true;
  }
  inp.oninput=check; check();

  ok.onclick=async function(){
    if(!check())return;
    var v=inp.value.trim();
    ok.disabled=true; ok.textContent='確かめています…';
    try{
      var auth=await captureAuth();if(!auth)throw new Error('auth required');
      var r=await apiAs(auth,'/api/me',{method:'PATCH',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({handle:v})});
      var j=await r.json().catch(function(){return {};});
      if(!authIsCurrent(auth)){askingHandle=false;return;}
      if(r.status===409){
        msg.textContent=(j.code==='taken')
          ? 'そのIDは既に使われています。別のものを入れてください'
          : (j.error||'そのIDは使えません');
        msg.style.color='var(--warn)';
        ok.disabled=false; ok.textContent='このIDにする';
        inp.focus(); inp.select();
        return;
      }
      if(!r.ok){
        msg.textContent=j.error||'保存できませんでした';
        msg.style.color='var(--warn)';
        ok.disabled=false; ok.textContent='このIDにする';
        return;
      }
      meP.handle=v;
      askingHandle=false;
      closeSheet();
      setTip('@'+v+' に決まりました');
    }catch(e){
      msg.textContent='通信できませんでした';
      msg.style.color='var(--warn)';
      ok.disabled=false; ok.textContent='このIDにする';
    }
  };
  setTimeout(function(){inp.focus();},380);
}

function doLogin(){
  if(typeof firebase==='undefined'){ setTip('ログインの部品がありません'); return; }
  var pv=new firebase.auth.GoogleAuthProvider();
  pv.setCustomParameters({prompt:'select_account'});

  // アプリの中では、画面を移さずにその場で済ませる
  var FA=plugin('FirebaseAuthentication');
  if(isApp&&FA){
    setTip('ログインしています…');
    FA.signInWithGoogle().then(function(r){
      // 受け取った証をこちら側にも渡す
      var tok=r&&r.credential&&r.credential.idToken;
      var acc=r&&r.credential&&r.credential.accessToken;
      if(!tok&&!acc){ setTip('ログインできませんでした'); return; }
      var cred=firebase.auth.GoogleAuthProvider.credential(tok||null,acc||null);
      return firebase.auth().signInWithCredential(cred);
    }).then(function(){
      setTip('ログインしました');
    }).catch(function(e){
      var c=(e&&(e.code||e.message))||e;
      if(/cancel/i.test(String(c)))return;      // 自分でやめた場合
      setTip('ログイン失敗: '+c);
    });
    return;
  }

  if(isApp){
    // 部品が無い場合は、画面遷移で
    firebase.auth().signInWithRedirect(pv).catch(function(e){
      setTip('ログイン失敗: '+(e&&e.code||e));
    });
    return;
  }

  firebase.auth().signInWithPopup(pv).catch(function(e){
    if(e&&/popup|blocked|cancel/i.test(e.code||'')){
      firebase.auth().signInWithRedirect(pv);
    }else{
      setTip('ログイン失敗: '+(e&&e.code||e));
    }
  });
}

/** ログアウト。アプリのときは両方から出る */
function doLogout(){
  var FA=plugin('FirebaseAuthentication');
  if(isApp&&FA){ try{ FA.signOut(); }catch(e){} }
  fbUser=null;meP=null;activateSpotScope(null);
  try{ firebase.auth().signOut(); }catch(e){}
  setTip('ログアウトしました');
}

function openMe(){
  var html='<div class="grab"></div><div class="pad" style="padding-top:18px">';
  if(!fbUser){
    html+='<div style="font-size:19px;font-weight:700;margin-bottom:8px">ログイン</div>'+
      '<div style="font-size:13.5px;color:var(--dim);line-height:1.8;margin-bottom:18px">'+
      '思い出がこの端末から離れて残るようになります。機種を変えても戻ってきます。<br>'+
      'フレンドと見せあうこともできます。</div>'+
      '<button class="btn" id="g">Googleでログイン</button>'+
      '<button class="btn g" id="x" style="margin-top:8px">あとで</button></div>';
    var s0=showSheet(html);
    s0.querySelector('#x').onclick=closeSheet;
    s0.querySelector('#g').onclick=function(){ closeSheet(); doLogin(); };
    return;
  }

  var st=(meP&&meP.settings)||{};
  var unsynced=spots.filter(function(s){return !s.synced;}).length;
  var profilePhotos=spots.filter(function(p){
    return p&&(p.photo_thumb||(p.photo&&p.photo_is_thumb));
  }).slice(-3).reverse();
  var profileStrip=[0,1,2].map(function(i){
    var p=profilePhotos[i];
    return p?('<img src="'+esc(p.photo_thumb||p.photo)+'" alt="">'):'<i></i>';
  }).join('');
  html+='<div class="me-profile">'+
    '<div class="me-head"><div><div class="me-title">'+esc(fbUser.displayName||'プロフィール')+'</div>'+
    '<div class="me-meta">'+spots.length+' の思い出'+(unsynced?('　未保存 '+unsynced+'件'):'　すべて保存済み')+'</div></div>'+
    '<button class="me-close" id="x" aria-label="プロフィールを閉じる">×</button></div>'+
    '<div class="me-strip" aria-label="最近の思い出">'+profileStrip+'</div>'+
    '<button class="me-row" id="fr"><b>フレンド</b><small>QR・申請を見る　›</small></button>'+

    '<div class="me-section">あなたのID</div>'+
    ((meP&&meP.handle)
      ? ('<div class="fld" style="opacity:.7">@'+esc(meP.handle)+'</div>'+
         '<div style="font-size:11.5px;color:var(--dim);margin-top:-4px;line-height:1.7">'+
         'IDは変更できません。</div>')
      : ('<button class="btn" id="h-set">IDを決める</button>'+
         '<div style="font-size:11.5px;color:var(--dim);margin-top:6px;line-height:1.7">'+
         'フレンドはこのIDであなたを探します。</div>'))+

    '<div class="me-section">地図</div>'+
    '<div class="chips" id="seg-color" role="radiogroup" aria-label="地図の表示モード">'+
      '<button class="chip '+(!night?'on':'')+'" data-v="light" role="radio" aria-checked="'+(!night)+'">ライト</button>'+
      '<button class="chip '+(night?'on':'')+'" data-v="dark" role="radio" aria-checked="'+night+'">ダーク</button></div>'+

    '<div class="me-section">新しい思い出をだれに見せるか</div>'+
    '<div class="chips" id="seg-vis" role="radiogroup" aria-label="新しい思い出の公開範囲">'+
      [['private','自分だけ'],['friends','フレンド'],['public','みんな']].map(function(o){
        var on=(st.default_visibility||'private')===o[0];
        return '<button class="chip '+(on?'on':'')+'" data-v="'+o[0]+'" role="radio" aria-checked="'+on+'">'+o[1]+'</button>';
      }).join('')+'</div>'+

    '<div class="me-section">フレンドに見せる位置</div>'+
    '<div class="chips" id="seg-fprec" role="radiogroup" aria-label="フレンドへ共有する位置精度">'+
      [['exact','正確'],['approx','約500m'],['area','約2km'],['hidden','位置なし']].map(function(o){
        var on=(st.friend_precision||'approx')===o[0];
        return '<button class="chip '+(on?'on':'')+'" data-v="'+o[0]+'" role="radio" aria-checked="'+on+'">'+o[1]+'</button>';
      }).join('')+'</div>'+

    '<div class="me-section">みんなに見せる位置</div>'+
    '<div class="chips" id="seg-pprec" role="radiogroup" aria-label="一般公開する位置精度">'+
      [['exact','正確'],['approx','約500m'],['area','約2km'],['hidden','位置なし']].map(function(o){
        var on=(st.public_precision||'area')===o[0];
        return '<button class="chip '+(on?'on':'')+'" data-v="'+o[0]+'" role="radio" aria-checked="'+on+'">'+o[1]+'</button>';
      }).join('')+'</div>'+

    '<div class="me-section">郵便番号から住所を調べる</div>'+
    '<div class="postal-search"><input class="fld" id="postal-input" inputmode="numeric" '+
      'autocomplete="postal-code" maxlength="8" placeholder="例：100-0014">'+
      '<button class="btn g" id="postal-search">検索</button></div>'+
    '<div class="postal-results" id="postal-results" aria-live="polite"></div>'+


    '<div class="me-section">アカウント</div>'+
    '<button class="me-row" id="push-test">通知を試す<small>›</small></button>'+
    '<button class="me-row" id="out" style="color:var(--warn)">ログアウト</button></div></div>';

  var s=showSheet(html);
  s.querySelector('#x').onclick=closeSheet;
  s.querySelector('#fr').onclick=function(){openFriends();};
  s.querySelector('#out').onclick=function(){ doLogout(); closeSheet(); };
  var pt=s.querySelector('#push-test');
  if(pt)pt.onclick=async function(){
    pt.textContent='送っています…';
    try{
      var r=await api('/api/push/test',{method:'POST'});
      var j=await r.json();
      setTip(j.sent?('通知を送りました（'+j.sent+'件）'):'届け先がありません。通知を許可してください');
    }catch(e){ setTip('送れませんでした'); }
    pt.textContent='通知を試す';
  };

  var hset=s.querySelector('#h-set');
  if(hset)hset.onclick=function(){ closeSheet(); askingHandle=false; askHandle(); };

  var postalInput=s.querySelector('#postal-input');
  var postalButton=s.querySelector('#postal-search');
  var postalResults=s.querySelector('#postal-results');
  if(postalInput&&postalButton&&postalResults){
    postalInput.oninput=function(){
      var digits=postalInput.value.replace(/\D/g,'').slice(0,7);
      postalInput.value=digits.length>3?digits.slice(0,3)+'-'+digits.slice(3):digits;
    };
    postalButton.onclick=async function(){
      var code=postalInput.value.trim();
      postalResults.replaceChildren();
      if(!/^\d{3}-?\d{4}$/.test(code)){
        postalResults.textContent='郵便番号を7桁で入力してください。'; return;
      }
      postalButton.disabled=true; postalButton.textContent='検索中…';
      try{
        var r=await api('/api/postal-code',{method:'POST',
          headers:{'Content-Type':'application/json'},body:JSON.stringify({postalCode:code})});
        var j=await r.json();
        if(!r.ok)throw new Error(j.error||'検索できませんでした');
        (j.addresses||[]).forEach(function(row){
          var a=row&&row.ja||{};
          var address=[a.prefecture,a.address1,a.address2,a.address3,a.address4].filter(Boolean).join('');
          if(!address)return;
          var item=document.createElement('button');
          item.type='button'; item.className='postal-result'; item.textContent=address;
          item.onclick=async function(){
            try{ await navigator.clipboard.writeText(address); setTip('住所をコピーしました'); }
            catch(e){ setTip(address); }
          };
          postalResults.appendChild(item);
        });
        if(!postalResults.childNodes.length)postalResults.textContent='住所が見つかりませんでした。';
      }catch(e){ postalResults.textContent=e.message||'検索できませんでした。'; }
      postalButton.disabled=false; postalButton.textContent='検索';
    };
    postalInput.onkeydown=function(e){ if(e.key==='Enter'){e.preventDefault();postalButton.click();} };
  }

  var th=s.querySelector('#seg-color');
  if(th) Array.prototype.forEach.call(th.querySelectorAll('.chip'),function(b){
    b.onclick=function(){
      Array.prototype.forEach.call(th.querySelectorAll('.chip'),function(x){x.classList.remove('on');x.setAttribute('aria-checked','false');});
      b.classList.add('on');b.setAttribute('aria-checked','true');
      if(window.setColorMode)window.setColorMode(b.dataset.v);
    };
  });

  [['seg-vis','default_visibility'],['seg-fprec','friend_precision'],['seg-pprec','public_precision']].forEach(function(pair){
    var box=s.querySelector('#'+pair[0]); if(!box)return;
    Array.prototype.forEach.call(box.querySelectorAll('.chip'),function(b){
      b.tabIndex=b.classList.contains('on')?0:-1;
      b.onclick=async function(){
        var prior=(meP&&meP.settings&&meP.settings[pair[1]])||'private';
        Array.prototype.forEach.call(box.querySelectorAll('.chip'),function(x){x.disabled=true;});
        var body={}; body[pair[1]]=b.dataset.v;
        try{
          var auth=await captureAuth();if(!auth)throw new Error('auth required');
          var r=await apiAs(auth,'/api/me',{method:'PATCH',
            headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
          if(!r.ok)throw new Error('save '+r.status);
          if(!authIsCurrent(auth))return;
          if(meP&&meP.settings)meP.settings[pair[1]]=b.dataset.v;
          Array.prototype.forEach.call(box.querySelectorAll('.chip'),function(x){
            var on=x===b;x.classList.toggle('on',on);x.setAttribute('aria-checked',String(on));x.tabIndex=on?0:-1;
          });
          setTip('設定を保存しました');
        }catch(e){
          Array.prototype.forEach.call(box.querySelectorAll('.chip'),function(x){
            var on=x.dataset.v===prior;x.classList.toggle('on',on);x.setAttribute('aria-checked',String(on));x.tabIndex=on?0:-1;
          });
          setTip('保存できませんでした。設定は変更していません');
        }
        Array.prototype.forEach.call(box.querySelectorAll('.chip'),function(x){x.disabled=false;});
      };
    });
    box.onkeydown=function(e){
      if(['ArrowLeft','ArrowRight','Home','End'].indexOf(e.key)<0)return;
      var buttons=Array.prototype.slice.call(box.querySelectorAll('.chip'));
      var i=buttons.indexOf(document.activeElement),next=e.key==='Home'?0:e.key==='End'?buttons.length-1:
        (i+(e.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
      e.preventDefault();buttons[next].focus();buttons[next].click();
    };
  });
}

/* ============================================================
   QRコード

   目の前にいる相手なら、IDを打つより早い。
   作るのも読むのも自前でやる（外の部品に頼らない）。
   ============================================================ */

/* --- 作る側 ---
   規格どおりのQRには誤り訂正が要る。自前で書くと読めないものができるので、
   実績のある部品に任せる。届かない場合は、外の画像づくりに頼る。 */
async function qrInto(el2,text,px){
  el2.innerHTML='<div style="font-size:12px;color:var(--dim)">QRを作っています…</div>';
  await need('qrcode');

  function byLib(){
    try{
      if(typeof QRCode==='undefined')return false;
      el2.innerHTML='';
      new QRCode(el2,{text:text,width:px,height:px,colorDark:'#000000',
        colorLight:'#FFFFFF',correctLevel:QRCode.CorrectLevel.M});
      var out=el2.querySelector('canvas,img');
      if(out){ out.style.borderRadius='10px'; out.style.display='block'; }
      return !!out;
    }catch(e){ return false; }
  }

  // フレンド情報を外部QR生成サービスへ送らず、失敗時はID入力へ案内する。
  if(!byLib()) el2.innerHTML='<div style="font-size:12px;color:var(--dim);line-height:1.8">'+
    'QRを作れませんでした。<br>下のIDを直接入れてもらってください。</div>';
}

/* --- 見せる --- */
function openMyQR(){
  var hd=(meP&&meP.handle)||'';
  if(!hd){
    setTip('先に自分のIDを決めてください');
    return;
  }
  var url=(SERVER||location.origin)+'/?add='+encodeURIComponent(hd);
  var name=(meP&&meP.display_name)||hd;
  var tiles=''; for(var ti=0;ti<12;ti++)tiles+='<i></i>';
  var s=showSheet('<div class="qr-profile"><div class="qr-collage">'+tiles+'</div><div class="qr-veil"></div>'+
    '<div class="qr-glass"><div class="qr-avatar">●</div><div class="qr-name">'+esc(name)+'</div>'+
    '<div class="qr-handle">SPOTA · @'+esc(hd)+'</div><div class="qr-box" id="qrbox"></div></div>'+
    '<div class="qr-actions"><button class="btn" id="share">リンクを送る</button>'+
    '<button class="btn" id="copy">コピー</button></div>'+
    '<button class="btn g" id="x" style="position:relative;margin-top:10px">とじる</button></div>');
  var photos=spots.filter(function(p){return p.photo_thumb||p.photo;}).slice(-12).reverse();
  var collageTiles=Array.prototype.slice.call(s.querySelectorAll('.qr-collage i'));
  (async function(){
    // 原寸を並べず、小さな背景用画像を1枚ずつ作ってメモリの山を避ける。
    for(var i=0;i<photos.length&&i<collageTiles.length;i++){
      if(!collageTiles[i].isConnected)return;
      var thumb=await resize(photos[i].photo_thumb||photos[i].photo,260,.68);
      if(!thumb)continue;
      var im=document.createElement('img'); im.src=thumb; im.alt='';
      collageTiles[i].replaceChildren(im);
    }
  })();
  qrInto(s.querySelector('#qrbox'),url,220);
  s.querySelector('#x').onclick=closeSheet;
  s.querySelector('#copy').onclick=function(){
    if(navigator.clipboard)navigator.clipboard.writeText(url).then(function(){setTip('リンクをコピーしました');});
    else setTip(url);
  };
  s.querySelector('#share').onclick=function(){
    if(navigator.share){
      navigator.share({title:'フレンドになりませんか',text:'@'+hd,url:url}).catch(function(){});
    }else if(navigator.clipboard){
      navigator.clipboard.writeText(url);
      setTip('リンクをコピーしました');
    }
  };
}

async function openFriendMap(hd){
  if(!fbUser){setTip('先にログインしてください');return;}
  setTip('@'+hd+' の地図を読み込んでいます…');
  try{
    var auth=await captureAuth();if(!auth)throw new Error('ログインが必要です');
    var r=await apiAs(auth,'/api/posts?user='+encodeURIComponent(hd)+'&limit=100');
    var j=await r.json();
    if(!authIsCurrent(auth))return;
    if(!r.ok)throw new Error(j.error||'地図を開けませんでした');
    var rows=(j.posts||[]).filter(function(p){return !p.mine;});
    if(!rows.length){setTip('表示できる思い出はまだありません');return;}
    others={};
    rows.forEach(function(p){
      others[p.id]={n:p.title,c:p.category,lat:p.lat,lng:p.lng,
        gname:(p.author&&p.author.name?p.author.name+' の思い出':''),
        tag:p.tag||'',author:p.author,precision:p.precision,friend:true};
    });
    closeSheet(); render(true);
    var bounds=new maplibregl.LngLatBounds();
    rows.forEach(function(p){bounds.extend([p.lng,p.lat]);});
    if(rows.length===1)map.easeTo({center:[rows[0].lng,rows[0].lat],zoom:15.5,duration:850});
    else map.fitBounds(bounds,{padding:54,maxZoom:15.5,duration:900});
    setTip('@'+hd+' の地図を表示しました');
  }catch(e){setTip(e.message||'地図を開けませんでした');}
}

/* --- 読み取ったあと --- */
async function addByHandle(hd){
  if(!hd)return;
  if(!fbUser){ setTip('先にログインしてください'); return; }
  if(meP&&meP.handle===hd){ setTip('自分のIDです'); return; }
  var r=await api('/api/friends/request',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({handle:hd})});
  var j=await r.json();
  if(j.error){ setTip(j.error); return; }
  setTip(j.status==='accepted'?('@'+hd+' とフレンドになりました'):('@'+hd+' に申請しました'));
  syncDown();
}

/* リンクから開かれたとき */
(function(){
  var m=location.search.match(/[?&]add=([^&]+)/);
  if(!m)return;
  var hd=decodeURIComponent(m[1]);
  var t=setInterval(function(){
    if(!fbUser)return;
    clearInterval(t);
    var s=showSheet('<div class="grab"></div><div class="pad" style="padding-top:18px">'+
      '<div style="font-size:18px;font-weight:700;margin-bottom:8px">@'+esc(hd)+'</div>'+
      '<div class="qr-map-intro">公開されている思い出を地図で見るか、フレンド申請できます。</div>'+
      '<button class="btn" id="open-map">相手の地図を開く</button>'+
      '<button class="btn" id="ok">申請する</button>'+
      '<button class="btn g" id="x" style="margin-top:8px">やめる</button></div>');
    s.querySelector('#x').onclick=closeSheet;
    s.querySelector('#open-map').onclick=function(){openFriendMap(hd);};
    s.querySelector('#ok').onclick=function(){ closeSheet(); addByHandle(hd); };
  },1200);
  setTimeout(function(){clearInterval(t);},20000);
})();

/* ============================================================
   フレンド
   ============================================================ */
async function openFriends(){
  var s=showSheet('<div class="grab"></div><div class="pad" style="padding-top:18px">'+
    '<div style="font-size:19px;font-weight:700;margin-bottom:14px">フレンド</div>'+
    '<div id="fbody" style="font-size:13px;color:var(--dim)">読み込んでいます…</div>'+
    '</div>');
  var body=s.querySelector('#fbody');
  var r=await api('/api/friends');
  if(!r.ok){body.textContent='読み込めませんでした';return;}
  var j=await r.json();

  var html='<button class="btn" id="b-qr" style="margin-bottom:10px">わたしのQRを見せる</button>'+
    '<div style="display:flex;gap:8px;margin-bottom:6px">'+
    '<input class="fld" id="f-add" placeholder="相手のID" style="margin:0">'+
    '<button class="btn" id="b-add" style="width:auto;padding:0 18px;margin:0">申請</button></div>'+
    '<div style="font-size:11.5px;color:var(--dim);margin-bottom:18px;line-height:1.7">'+
    'お互いが承認すると、相手が設定した位置精度で思い出が見えるようになります。</div>';

  if((j.incoming||[]).length){
    html+='<div class="lab">届いている申請</div>';
    j.incoming.forEach(function(u){
      html+='<div class="post" style="align-items:center"><div class="av2"></div>'+
        '<div class="b"><b>'+esc(u.display_name||u.handle||'')+'</b>'+
        '<span>@'+esc(u.handle||'')+'</span></div>'+
        '<button class="chip on" data-ok="'+esc(u.id)+'" style="flex:0 0 auto">承認</button></div>';
    });
  }

  html+='<div class="lab" style="margin-top:18px">フレンド '+((j.friends||[]).length)+'人</div>';
  if((j.friends||[]).length){
    j.friends.forEach(function(u){
      html+='<div class="post" style="align-items:center"><div class="av2"></div>'+
        '<div class="b"><b>'+esc(u.display_name||u.handle||'')+'</b>'+
        '<span>@'+esc(u.handle||'')+'</span></div></div>';
    });
  }else{
    html+='<div class="empty" style="padding:16px 0">まだいません。<br>'+
      '相手のIDを入れて申請してみてください。</div>';
  }
  html+='<button class="btn g" id="back" style="margin-top:18px">もどる</button>';
  body.innerHTML=html;

  body.querySelector('#back').onclick=openMe;
  body.querySelector('#b-qr').onclick=openMyQR;
  body.querySelector('#b-add').onclick=async function(){
    var v=body.querySelector('#f-add').value.trim().replace(/^@/,'');
    if(!v){setTip('相手のIDを入れてください');return;}
    var rr=await api('/api/friends/request',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({handle:v})});
    var jj=await rr.json();
    if(jj.error){setTip(jj.error);return;}
    setTip(jj.status==='accepted'?'フレンドになりました':'申請しました');
    openFriends();
  };
  Array.prototype.forEach.call(body.querySelectorAll('[data-ok]'),function(b){
    b.onclick=async function(){
      await api('/api/friends/accept',{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({user_id:b.dataset.ok})});
      setTip('フレンドになりました');
      openFriends(); syncDown();
    };
  });
}
