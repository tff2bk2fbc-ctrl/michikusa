/* ============================================================
   サーバーとの同期

   これまでは端末の中だけに置いていた。
   Safariは7日開かないと消してしまうので、思い出が消える。
   ログインしたら、サーバーへ預けて、どの端末からでも戻るようにする。
   ============================================================ */

/* 写真をサーバーへ。原本と表示用を別々に持つ */
async function uploadPhoto(auth,postId,photoId,dataUrl){
  try{
    var pid=photoId,moderationState='not-required';
    async function put(kind,body,type){
      var r=await apiAs(auth,'/api/photo?post_id='+encodeURIComponent(postId)+
        '&photo_id='+encodeURIComponent(pid)+'&kind='+kind,
        {method:'PUT',headers:{'Content-Type':type},body:body});
      var j=await r.json().catch(function(){return {};});
      if(!r.ok)throw new Error(kind+' '+r.status+(j.error?' '+String(j.error).slice(0,80):''));
      if(kind==='view'||kind==='thumb'){
        if(j.moderation==='bad')moderationState='bad';
        else if(j.moderation==='error'&&moderationState!=='bad')moderationState='error';
        else if(j.moderation==='ok'&&moderationState==='not-required')moderationState='ok';
      }
      return j;
    }

    // iPhoneの48MP原本やHEICをそのまま最初に送ると、25MB超過・形式不一致で
    // サムネイルまで一件も保存されない。4096px/94%の高品質JPEGを保存版にし、
    // EXIFもサーバーへ持ち込まない。端末内の元写真には手を加えない。
    var archive=await resize(dataUrl,4096,.94);
    if(!archive)throw new Error('archive resize failed');
    var view=await resize(archive,2560,.90);
    if(!view)throw new Error('view resize failed');
    var th=await resize(view,512,.82);
    if(!th)throw new Error('thumb resize failed');
    var tb=dataUrlBlob(th);
    // まず地図表示に必要な小さい2種類を確実に作り、最後に高品質版を預ける。
    await put('thumb',tb,'image/jpeg');
    var vb=dataUrlBlob(view);
    await put('view',vb,'image/jpeg');
    var ab=dataUrlBlob(archive);
    await put('orig',ab,'image/jpeg');
    return {ok:true,moderation:moderationState};
  }catch(e){
    // 同期ループ側で再試行できるよう、認証情報や画像本体は返さず理由だけ保持する。
    return {ok:false,error:e&&e.message?String(e.message):'photo upload failed'};
  }
}
/* data: URLをfetchするとCSPのconnect-srcに遮断されるため、端末内だけでBlob化する。 */
function dataUrlBlob(dataUrl){
  var comma=String(dataUrl||'').indexOf(',');
  var head=comma>=0?dataUrl.slice(0,comma):'';
  if(comma<0||!/^data:image\/jpeg;base64$/i.test(head))throw new Error('jpeg data invalid');
  var raw=atob(dataUrl.slice(comma+1)),bytes=new Uint8Array(raw.length);
  for(var i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
  return new Blob([bytes],{type:'image/jpeg'});
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

/*
 * サーバー保存が確定した写真は、端末内に同じ高解像度JPEGを残し続けない。
 * 地図用サムネイルだけをIndexedDBへ残し、全画面表示は認証済みの
 * /api/photo/:id/view から取得する。未同期の原本は絶対に縮小・削除しない。
 */
async function compactSyncedPhoto(rec){
  if(!rec||rec.photo_synced!==1||!rec.server_photo_id||!rec.photo||rec.photo_is_thumb)return false;
  var thumb=rec.photo_thumb||await resize(rec.photo,512,.82);
  if(!thumb)return false;
  rec.photo=thumb;rec.photo_is_thumb=1;
  delete rec.photo_thumb;delete rec.thumb_building;
  return dbPut('spots',rec);
}
async function compactSyncedPhotos(limit){
  var candidates=spots.filter(function(rec){
    return rec&&rec.owner_scope===activeSpotScope&&rec.photo_synced===1&&
      rec.server_photo_id&&rec.photo&&!rec.photo_is_thumb;
  });
  if(limit>0)candidates=candidates.slice(0,limit);
  var done=0;
  for(var i=0;i<candidates.length;i++)if(await compactSyncedPhoto(candidates[i]))done++;
  return done;
}
window.compactSyncedPhotos=compactSyncedPhotos;

/* 1件をサーバーへ送る */
async function pushOne(rec){
  try{
    var auth=await captureAuth();
    if(!auth||rec.owner_scope!==auth.scope)return false;
    // 公開向けの安全確認は、アップロード後にWorkerがview/thumbの双方へ行う。
    // 端末から同じ写真を先に別送せず、迂回できない一つの経路に限定する。
    if(!rec.server_id){
      var r=await apiAs(auth,'/api/posts',{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          title:rec.n, category:rec.c, tag:rec.tag||'', place_name:rec.place||'',
          lat:rec.lat, lng:rec.lng,
          taken_at:rec.d?Date.parse(rec.d):null,
          visibility:rec.visibility||null,
          client_operation_id:rec.id
        })});
      if(!r.ok)return false;
      var j=await r.json();
      rec.server_id=j.id;
      rec.visibility=j.visibility;
      await dbPut('spots',rec);
    }
    if(rec.photo&&!rec.photo_synced){
      rec.server_photo_id=rec.server_photo_id||nid();
      await dbPut('spots',rec);
      var uploaded=await uploadPhoto(auth,rec.server_id,rec.server_photo_id,rec.photo);
      if(!uploaded||uploaded.ok===false){
        rec.synced=0;rec.photo_synced=0;
        rec.sync_error=String(uploaded&&uploaded.error||'photo upload failed').slice(0,120);
        await dbPut('spots',rec);
        if(authIsCurrent(auth))setTip('写真をサーバーへ預けられませんでした（'+rec.sync_error+'）');
        return false;
      }
      rec.photo_synced=1;
      delete rec.sync_error;
      if(rec.visibility!=='private'&&uploaded.moderation==='bad'){
        rec.visibility='private';
        delete rec.moderation_pending;
        if(authIsCurrent(auth))setTip('安全確認で公開できない写真だったため、自分だけの記録にしました');
      }else if(rec.visibility!=='private'&&uploaded.moderation==='error'){
        rec.moderation_pending=1;
        if(authIsCurrent(auth))setTip('写真は預けました。みんなへの表示は安全確認の完了後に始まります');
      }else{
        delete rec.moderation_pending;
      }
    }
    rec.synced=1;
    // 先に同期済み状態を確定し、その後に端末原本を安全に小さくする。
    if(!(await dbPut('spots',rec)))return false;
    await compactSyncedPhoto(rec);
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
  var pending=todo.filter(function(s){return s.moderation_pending;}).length;
  setTip(ok?(pending?(ok+'件を預けました。公開は安全確認後に始まります'):(ok+'件を預けました')):'預けられませんでした');
  render(true);
  if(fbUser&&activeSpotScope!==startedScope)setTimeout(syncUp,0);
}

/* サーバーから取り込む。他人のぶんも含む */
let fetching=false;
var restoreQueue=[], restoring=0,restoreGeneration=0,restoreControllers=[];
function blobDataUrl(blob){return new Promise(function(resolve,reject){
  var rd=new FileReader();rd.onload=function(){resolve(rd.result);};rd.onerror=reject;rd.readAsDataURL(blob);
});}
function invalidatePhotoRestoreQueue(){
  restoreGeneration++;
  restoreQueue.splice(0).forEach(function(job){delete job.rec.photo_restoring;});
  restoreControllers.splice(0).forEach(function(entry){
    delete entry.job.rec.photo_restoring;try{entry.controller.abort();}catch(e){}
  });
}
window.invalidatePhotoRestoreQueue=invalidatePhotoRestoreQueue;
function queuePhotoRestore(rec,photoId,auth){
  // 同時通信は2本のまま、待ち行列だけを一画面分まで許可する。
  // 以前の「最初の3枚」上限で、4枚目以降が地図から消える問題を防ぐ。
  if(!photoId||rec.photo||rec.photo_restoring||(rec.photo_retry_at||0)>Date.now()||restoreQueue.length>=40)return;
  if(!authIsCurrent(auth)||rec.owner_scope!==auth.scope)return;
  rec.photo_restoring=1;restoreQueue.push({rec:rec,id:photoId,auth:auth,scope:auth.scope,generation:restoreGeneration});runPhotoRestore();
}
function runPhotoRestore(){
  while(restoring<2&&restoreQueue.length){
    var job=restoreQueue.shift();
    if(job.generation!==restoreGeneration||job.scope!==activeSpotScope||!authIsCurrent(job.auth)){
      delete job.rec.photo_restoring;continue;
    }
    var controller=new AbortController(),entry={controller:controller,job:job};restoreControllers.push(entry);restoring++;
    (async function(j,abortController,restoreEntry){try{
      if(j.generation!==restoreGeneration||j.scope!==activeSpotScope||!authIsCurrent(j.auth))return;
      var r=await apiAs(j.auth,'/api/photo/'+encodeURIComponent(j.id)+'/thumb',{signal:abortController.signal});
      if(!r.ok)throw new Error('photo '+r.status);
      var data=await blobDataUrl(await r.blob());
      if(j.generation!==restoreGeneration||j.scope!==activeSpotScope||!authIsCurrent(j.auth)||j.rec.owner_scope!==j.scope)return;
      j.rec.photo=data;j.rec.photo_is_thumb=1;j.rec.server_photo_id=j.id;j.rec.photo_synced=1;
      delete j.rec.photo_restoring;
      await dbPut('spots',j.rec);render(true);
    }catch(e){
      delete j.rec.photo_restoring;
      if(j.generation===restoreGeneration&&j.scope===activeSpotScope&&authIsCurrent(j.auth)&&e&&e.name!=='AbortError'){
        j.rec.photo_retry_at=Date.now()+10*60*1000;dbPut('spots',j.rec);
      }
    }finally{
      var at=restoreControllers.indexOf(restoreEntry);if(at>=0)restoreControllers.splice(at,1);
      restoring--;runPhotoRestore();
    }})(job,controller,entry);
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
  var meta=await dbGet('meta',key),cursor=meta&&meta.v||initial,hasMore=false,failed=false,
    added=0,missingUploads=0;
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
        if(p.photo_id){
          if(existing.server_photo_id!==p.photo_id||existing.photo_synced!==1||existing.sync_error){
            existing.server_photo_id=p.photo_id;existing.photo_synced=1;delete existing.sync_error;
            await dbPut('spots',existing);
          }
        }else if(existing.photo){
          // 旧版で投稿だけ同期済みになった記録を、自動的に写真再送の対象へ戻す。
          existing.synced=0;existing.photo_synced=0;existing.sync_error='server photo missing';
          await dbPut('spots',existing);missingUploads++;
        }
        // 新端末のプロフィール用に直近3枚だけを永続サムネイルへ戻す。
        // 地図は必要な代表写真をBlobで遅延取得するため、全件復元しない。
        if(!existing.photo&&p.photo_id&&page===0&&i<3)queuePhotoRestore(existing,p.photo_id,auth);
        continue;
      }
      var rec={id:nid(),server_id:p.id,synced:1,n:p.title,c:p.category,
        tag:p.tag||'',place:p.place_name||'',lat:p.lat,lng:p.lng,
        d:p.taken_at?new Date(p.taken_at).toISOString().slice(0,10):'',
        photo:'',visibility:p.visibility,server_photo_id:p.photo_id||null,
        photo_synced:p.photo_id?1:0,owner_scope:auth.scope};
      if(await dbPut('spots',rec)){
        if(authIsCurrent(auth))spots.push(rec);
        if(p.photo_id&&page===0&&i<3)queuePhotoRestore(rec,p.photo_id,auth);
        added++;
      }
    }
    cursor=j.cursor||cursor;await dbPut('meta',{k:key,v:cursor});
    if(!hasMore)break;
  }
  if(added&&authIsCurrent(auth))render(true);
  if(missingUploads&&authIsCurrent(auth))setTimeout(syncUp,500);
  if(failed)return;
  if(!hasMore){await dbPut('meta',{k:key,v:initial});return;}
  if(authIsCurrent(auth))setTimeout(function(){syncOwnArchive(auth);},1500);
}
async function syncDown(){
  if(window.__spotaOnboardingActive||window.__spotaNeedsOnboarding)return;
  if(!fbUser||fetching)return;
  fetching=true;
  var auth=null,startedScope=activeSpotScope,startedUid=fbUser.uid;
  try{
    auth=await captureAuth();if(!auth)return;
    if(typeof window.setMapPhotoAuth==='function')window.setMapPhotoAuth(auth);
    startedScope=auth.scope;startedUid=auth.uid;
    await syncDeletions(auth);
    var b=map.getBounds();
    var r=await apiAs(auth,'/api/posts/query',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({s:b.getSouth(),w:b.getWest(),n:b.getNorth(),e:b.getEast(),limit:100})});
    if(!r.ok)return;
    var j=await r.json();
    if(!fbUser||fbUser.uid!==startedUid||activeSpotScope!==startedScope)return;
    var tombstones={};(await dbAll('deleted')).forEach(function(t){
      if(t.owner_scope===auth.scope)tombstones[t.server_id]=1;
    });
    var mineIds={}; spots.forEach(function(s){ if(s.server_id)mineIds[s.server_id]=s; });
    var added=0,missingUploads=0;
    (j.posts||[]).forEach(function(p){
      if(p.mine){
        if(tombstones[p.id])return;
        if(mineIds[p.id]){
          var local=mineIds[p.id];
          if(p.photo_id){
            if(local.server_photo_id!==p.photo_id||local.photo_synced!==1||local.sync_error){
              local.server_photo_id=p.photo_id;local.photo_synced=1;delete local.sync_error;dbPut('spots',local);
            }
          }else if(local.photo){
            local.synced=0;local.photo_synced=0;local.sync_error='server photo missing';
            dbPut('spots',local);missingUploads++;
          }
          return;
        }
        var rec={id:nid(),server_id:p.id,synced:1,n:p.title,c:p.category,
          tag:p.tag||'',place:p.place_name||'',lat:p.lat,lng:p.lng,
          d:p.taken_at?new Date(p.taken_at).toISOString().slice(0,10):'',
          photo:'',visibility:p.visibility,server_photo_id:p.photo_id||null,
          photo_synced:p.photo_id?1:0};
        rec.owner_scope=activeSpotScope;
        spots.push(rec); dbPut('spots',rec);added++;
      }else{
        // 他人の思い出。地図には出すが端末には残さない
        var k=p.id;
        var shared=others[k]||{};
        Object.assign(shared,{id:p.id,n:p.title,c:p.category,lat:p.lat,lng:p.lng,
          gname:(p.author&&p.author.name?p.author.name+' の思い出':''),
          place:p.place_name||'',tag:p.tag||'',d:p.taken_at?new Date(p.taken_at).toISOString().slice(0,10):'',
          author:p.author,precision:p.precision,visibility:p.visibility,
          server_photo_id:p.photo_id||null,friend:p.visibility==='friends'});
        others[k]=shared;
        if(!others[k].__counted){others[k].__counted=1;added++;}
      }
    });
    if(added)render(true);
    if(missingUploads)setTimeout(syncUp,500);
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
let authenticatedSessionSeq=0;

function emitSpotaAuthChanged(){
  window.dispatchEvent(new CustomEvent('spota:auth-changed',{detail:{user:fbUser,profile:meP}}));
}

function onboardingLogoutKey(){
  return 'spota_onboarding_logout_'+String(window.__spotaOnboardingVersion||'current').replace(/[^A-Za-z0-9_.-]/g,'_');
}

async function syncLegalAcceptance(auth){
  if(!auth)return false;
  var accepted;
  try{accepted=JSON.parse(localStorage.getItem('spota_legal_acceptance')||'null');}catch(e){return false;}
  var version=String(window.__spotaOnboardingVersion||'');
  if(!accepted||accepted.terms!==version||accepted.privacy!==version||!accepted.accepted_at)return false;
  var key='spota_legal_synced_'+auth.uid+'_'+version;
  try{if(localStorage.getItem(key)==='1')return true;}catch(e){}
  try{
    var response=await apiAs(auth,'/api/legal/acceptance',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({terms_version:accepted.terms,privacy_version:accepted.privacy,accepted_at:accepted.accepted_at})});
    if(!response.ok)return false;
    try{localStorage.setItem(key,'1');}catch(e){}
    return true;
  }catch(e){return false;}
}

/**
 * この版の初回案内を最初から確認できるよう、既存の認証だけを一度解除する。
 * 投稿、写真、IndexedDB、サーバー上のアカウントは削除しない。
 */
async function resetExistingLoginForOnboarding(user){
  if(!window.__spotaNeedsOnboarding||window.__spotaOnboardingLogoutDone)return false;
  var key=onboardingLogoutKey(),done=false;
  try{done=localStorage.getItem(key)==='1';}catch(e){}
  if(done){window.__spotaOnboardingLogoutDone=true;return false;}

  var pushToken=window.__spotaPushToken;
  if(!pushToken)try{pushToken=localStorage.getItem('spota_push_token');}catch(e){}
  if(pushToken&&user){
    try{
      var token=await user.getIdToken();
      await fetch(SERVER+'/api/push/token',{method:'DELETE',headers:{
        'Authorization':'Bearer '+token,'Content-Type':'application/json'
      },body:JSON.stringify({token:pushToken})});
    }catch(e){}
  }
  window.__spotaPushToken=null;
  try{localStorage.removeItem('spota_push_token');}catch(e){}
  var FA=plugin('FirebaseAuthentication');
  if(isApp&&FA&&FA.signOut){try{await FA.signOut();}catch(e){}}

  window.__spotaOnboardingLogoutDone=true;
  try{localStorage.setItem(key,'1');}catch(e){}
  if(!user)return false;
  try{
    await firebase.auth().signOut();
    return true;
  }catch(e){
    window.__spotaOnboardingLogoutDone=false;
    try{localStorage.removeItem(key);}catch(ignore){}
    return false;
  }
}

async function startAuthenticatedSession(user,auth,authSeq){
  if(window.__spotaOnboardingActive||!authIsCurrent(auth)||authSeq!==authChangeSeq)return false;
  if(authenticatedSessionSeq===authSeq)return true;
  authenticatedSessionSeq=authSeq;
  // 旧版が残した同期済み原本を先に整理し、新しい写真を書ける容量を戻す。
  await compactSyncedPhotos();
  if(typeof setMapAudience==='function')setMapAudience('public',true);
  await migrateOwnedLegacy(auth);
  await offerLegacySpots(user,auth);
  if(!authIsCurrent(auth)||authSeq!==authChangeSeq)return false;
  syncUp();syncDown().then(function(){syncOwnArchive(auth);});askHandle();setupPush(false);checkTags();
  return true;
}

window.getSpotaAuthState=function(){return {user:fbUser,profile:meP};};
window.resumeSpotaAfterOnboarding=async function(){
  if(!fbUser)return false;
  var seq=authChangeSeq,auth=await captureAuth(fbUser);
  if(!auth||seq!==authChangeSeq)return false;
  return startAuthenticatedSession(fbUser,auth,seq);
};

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
      if(typeof closeReleaseScreen==='function')closeReleaseScreen();
      fbUser=u;meP=null;var b=document.getElementById('btn-me');
      if(!b)return;
      if(await resetExistingLoginForOnboarding(u))return;
      await activateSpotScope(u);
      if(authSeq!==authChangeSeq)return;
      if(u){
        b.innerHTML='<div class="bc"><b>'+esc((u.displayName||'?').trim().charAt(0))+'</b></div>';
        var auth=await captureAuth(u);
        if(!auth||authSeq!==authChangeSeq)return;
        await retryPendingDeletes(auth);
        if(!authIsCurrent(auth)||authSeq!==authChangeSeq)return;
        await activateSpotScope(u);
        var profile=await loadMe(auth);
        if(!authIsCurrent(auth)||authSeq!==authChangeSeq)return;
        meP=profile;
        await syncLegalAcceptance(auth);
        if(!authIsCurrent(auth)||authSeq!==authChangeSeq)return;
        emitSpotaAuthChanged();
        if(window.__spotaOnboardingActive)return;
        await startAuthenticatedSession(u,auth,authSeq);
      }else{
        b.innerHTML='<div class="bc"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg></div>';
        meP=null;
        if(typeof setMapAudience==='function')setMapAudience('mine',true);
        emitSpotaAuthChanged();
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
window.startSpotaLogin=doLogin;

function appleWebCredential(result){
  var value=result&&result.credential||{};
  if(!value.idToken)throw new Error('Appleの認証情報を受け取れませんでした');
  var provider=new firebase.auth.OAuthProvider('apple.com');
  return provider.credential({idToken:value.idToken,rawNonce:value.nonce||undefined});
}

// Appleのエラー本文には認証情報やOSの内部文言が混ざることがあるため、
// 画面へ表示するのは既知のコードだけに限定する。トークン・メール・URLは表示しない。
function spotaAppleAuthErrorCode(error){
  var raw=String(error&&(error.code||error.message)||'unknown').trim();
  var auth=raw.match(/auth\/[a-z0-9-]+/i);
  if(auth)return auth[0].toLowerCase().slice(0,64);
  var os=raw.match(/(?:ASAuthorizationError|error)\s*(?:code)?\s*[:=]?\s*(\d{1,4})/i);
  if(os)return 'apple/'+os[1];
  if(/^\d{1,4}$/.test(raw))return 'apple/'+raw;
  return 'unknown';
}
function spotaAppleAuthErrorText(error){
  var code=spotaAppleAuthErrorCode(error);
  var labels={
    'auth/operation-not-allowed':'FirebaseでAppleログインが有効になっていません',
    'auth/invalid-credential':'Appleの認証情報を確認できませんでした',
    'auth/account-exists-with-different-credential':'別のログイン方法で登録済みです',
    'auth/popup-blocked':'Appleの確認画面がブロックされました',
    'auth/popup-closed-by-user':'Appleの確認画面が閉じられました',
    'auth/cancelled-popup-request':'Appleログインをキャンセルしました',
    'apple/1000':'Appleのアプリ設定（Bundle ID・Team）を確認してください',
    'apple/1001':'Appleログインをキャンセルしました'
  };
  return (labels[code]||'Appleログインに失敗しました')+'（コード: '+code+'）';
}
window.describeSpotaAppleAuthError=spotaAppleAuthErrorText;

async function doAppleLogin(){
  if(typeof firebase==='undefined'){setTip('ログインの部品がありません');return;}
  var provider=new firebase.auth.OAuthProvider('apple.com');
  provider.addScope('email');provider.addScope('name');
  var FA=plugin('FirebaseAuthentication');
  try{
    setTip('Appleでログインしています…');
    if(isApp&&FA&&FA.signInWithApple){
      // ネイティブ側でFirebaseへ二重サインインせず、raw nonce付きcredentialだけを
      // Web SDKへ渡す。skipNativeAuth=falseのままだとnonceが消費済みになり、
      // auth/missing-or-invalid-nonceになる。
      var result=await FA.signInWithApple({skipNativeAuth:true});
      await firebase.auth().signInWithCredential(appleWebCredential(result));
    }else{
      try{await firebase.auth().signInWithPopup(provider);}
      catch(error){
        if(error&&/popup|blocked/i.test(error.code||''))return firebase.auth().signInWithRedirect(provider);
        throw error;
      }
    }
    setTip('ログインしました');
  }catch(error){
    var code=String(error&&(error.code||error.message)||error);
    var text=spotaAppleAuthErrorText(error);
    if(/cancel|canceled|1001/i.test(code)){
      var cancelled=new Error(text);cancelled.code='auth/cancelled-popup-request';
      throw cancelled;
    }
    setTip(text);
    throw error;
  }
}
window.startSpotaAppleLogin=doAppleLogin;

window.saveSpotaOnboardingProfile=async function(handle,profileIcon){
  var auth=await captureAuth();
  if(!auth)throw new Error('ログインを確認できませんでした。');
  var body={profile_icon:PROFILE_ICONS.indexOf(profileIcon)>=0?profileIcon:'pin'};
  if(!(meP&&meP.handle))body.handle=String(handle||'').trim();
  var response=await apiAs(auth,'/api/me',{method:'PATCH',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body)});
  var result=await response.json().catch(function(){return {};});
  if(!response.ok){
    if(response.status===409&&result.code==='taken')throw new Error('その利用者IDは既に使われています。');
    throw new Error(result.error||'プロフィールを保存できませんでした。');
  }
  if(!authIsCurrent(auth))throw new Error('ログイン状態が変わりました。もう一度お試しください。');
  await syncLegalAcceptance(auth);
  meP=await loadMe(auth);
  emitSpotaAuthChanged();
  return meP;
};

/** ログアウト。アプリのときは両方から出る */
async function doLogout(){
  var pushToken=window.__spotaPushToken;
  if(!pushToken)try{pushToken=localStorage.getItem('spota_push_token');}catch(e){}
  if(pushToken&&fbUser){
    try{await api('/api/push/token',{method:'DELETE',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token:pushToken})});}catch(e){}
  }
  window.__spotaPushToken=null;
  try{localStorage.removeItem('spota_push_token');}catch(e){}
  var FA=plugin('FirebaseAuthentication');
  if(isApp&&FA){ try{ await FA.signOut(); }catch(e){} }
  fbUser=null;meP=null;activateSpotScope(null);
  if(typeof closeReleaseScreen==='function')closeReleaseScreen();
  try{ await firebase.auth().signOut(); }catch(e){}
  setTip('ログアウトしました');
}

function currentProviderId(){
  var providers=(fbUser&&fbUser.providerData)||[];
  for(var i=0;i<providers.length;i++)if(providers[i]&&providers[i].providerId)return providers[i].providerId;
  return '';
}

async function reauthenticateForDeletion(){
  if(!fbUser)throw new Error('ログインが必要です');
  var providerId=currentProviderId();
  var FA=plugin('FirebaseAuthentication');
  if(providerId==='apple.com'){
    if(isApp&&FA&&FA.signInWithApple){
      var apple=await FA.signInWithApple();
      await fbUser.reauthenticateWithCredential(appleWebCredential(apple));
      var code=apple&&apple.credential&&apple.credential.authorizationCode;
      if(!code||!FA.revokeAccessToken)throw new Error('Appleとの連携を解除できませんでした');
      await FA.revokeAccessToken({token:code});
      return {apple_revoked:true};
    }
    var appleProvider=new firebase.auth.OAuthProvider('apple.com');
    appleProvider.addScope('email');appleProvider.addScope('name');
    await fbUser.reauthenticateWithPopup(appleProvider);
    throw new Error('Apple連携の解除はiPhoneアプリから行ってください');
  }

  var googleProvider=new firebase.auth.GoogleAuthProvider();
  googleProvider.setCustomParameters({prompt:'select_account'});
  if(isApp&&FA&&FA.signInWithGoogle){
    var google=await FA.signInWithGoogle();
    var token=google&&google.credential&&google.credential.idToken;
    var access=google&&google.credential&&google.credential.accessToken;
    if(!token&&!access)throw new Error('Googleの認証情報を受け取れませんでした');
    await fbUser.reauthenticateWithCredential(
      firebase.auth.GoogleAuthProvider.credential(token||null,access||null));
  }else await fbUser.reauthenticateWithPopup(googleProvider);
  return {apple_revoked:false};
}

async function purgeLocalAccountScope(scope){
  await openDB();
  for(var i=0;i<['spots','deleted'].length;i++){
    var store=['spots','deleted'][i],rows=await dbAll(store);
    for(var j=0;j<rows.length;j++)if(rows[j]&&rows[j].owner_scope===scope)await dbDel(store,rows[j].id||rows[j].server_id);
  }
}

function openAccountDeletion(){
  var html='<div class="grab"></div><div class="pad account-delete" style="padding-top:20px">'+
    '<h2>アカウントを削除</h2><p>サーバーに保存した写真、投稿、フレンド、メッセージを削除します。この操作は元に戻せません。</p>'+
    '<form id="account-delete-form" novalidate><label for="account-delete-confirm">確認のため「削除」と入力</label>'+
    '<input class="fld" id="account-delete-confirm" autocomplete="off" autocapitalize="none" aria-describedby="account-delete-help account-delete-error">'+
    '<p id="account-delete-help">本人確認のため、続けてAppleまたはGoogleのログイン画面が開きます。</p>'+
    '<p class="form-error" id="account-delete-error" role="alert" hidden></p>'+
    '<p class="form-status" id="account-delete-status" role="status" aria-live="polite"></p>'+
    '<button class="btn d" type="submit">アカウントを削除</button><button class="btn g" id="account-delete-cancel" type="button">やめる</button></form></div>';
  var sheet=showSheet(html),form=sheet.querySelector('#account-delete-form');
  var input=sheet.querySelector('#account-delete-confirm'),error=sheet.querySelector('#account-delete-error');
  var status=sheet.querySelector('#account-delete-status'),submit=form.querySelector('[type="submit"]');
  sheet.querySelector('#account-delete-cancel').onclick=closeSheet;
  form.onsubmit=async function(event){
    event.preventDefault();error.hidden=true;
    if(input.value.trim()!=='削除'){
      input.setAttribute('aria-invalid','true');error.textContent='「削除」と入力してください。';error.hidden=false;input.focus();return;
    }
    input.removeAttribute('aria-invalid');submit.disabled=true;status.textContent='本人確認をしています…';
    var scope=activeSpotScope;
    try{
      var proof=await reauthenticateForDeletion();
      var auth=await captureAuth();if(!auth)throw new Error('本人確認を完了できませんでした');
      status.textContent='写真とアカウントを削除しています…';
      var response=await apiAs(auth,'/api/account/delete',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({confirmation:'削除',apple_revoked:!!proof.apple_revoked})});
      var result=await response.json().catch(function(){return {};});
      if(!response.ok)throw new Error(result.error||'削除できませんでした');
      await purgeLocalAccountScope(scope);
      window.__spotaPushToken=null;try{localStorage.removeItem('spota_push_token');}catch(ignore){}
      var nativeAuth=plugin('FirebaseAuthentication');
      if(isApp&&nativeAuth){try{await nativeAuth.signOut();}catch(ignore){}}
      try{await firebase.auth().signOut();}catch(ignore){}
      fbUser=null;meP=null;await activateSpotScope(null);closeSheet();
      setTip(result.completed?'アカウントを削除しました':'削除を受け付けました。残りは自動で完了します');
    }catch(e){
      submit.disabled=false;status.textContent='';error.textContent=e&&e.message||'削除できませんでした';error.hidden=false;error.focus();
    }
  };
}
window.openSpotaAccountDeletion=openAccountDeletion;

function monitorRows(state){
  var steps=state&&state.steps||{};
  var rows=[
    ['投稿',!!steps.post],['DM',!!steps.message],['いいね',!!steps.like],
    ['フラッシュ',!!steps.flash],['通知データ',!!steps.notification],
    ['FCM受付',!!(state&&state.push_accepted)],['端末受信',!!(state&&state.received)],
    ['通知を開いた',!!(state&&state.opened)],['目視確認',!!(state&&state.confirmed)]
  ];
  return rows.map(function(row){return '<li class="'+(row[1]?'done':'pending')+'"><span>'+esc(row[0])+'</span><b>'+(
    row[1]?'確認済み':'待機中')+'</b></li>';}).join('');
}

function openCommunicationMonitor(){
  var html='<div class="grab"></div><div class="pad communication-monitor" style="padding-top:20px">'+
    '<h2>通信モニター</h2><p>テスト投稿、DM、いいね、フラッシュを作り、iPhoneへの通知まで順に確認します。テストデータは自動で消えます。</p>'+
    '<p class="form-status" id="monitor-status" role="status" aria-live="polite">通知の準備をしています…</p>'+
    '<ul class="monitor-checks" id="monitor-checks">'+monitorRows({})+'</ul>'+
    '<button class="btn" id="monitor-confirm" type="button" disabled>通知が画面に見えた</button>'+
    '<button class="btn g" id="monitor-close" type="button">閉じる</button></div>';
  var sheet=showSheet(html),status=sheet.querySelector('#monitor-status');
  var list=sheet.querySelector('#monitor-checks'),confirm=sheet.querySelector('#monitor-confirm');
  var stopped=false,timer=0,runId='';
  sheet.__onClose=function(){stopped=true;if(timer)clearTimeout(timer);};
  sheet.querySelector('#monitor-close').onclick=closeSheet;
  function paint(state){
    list.innerHTML=monitorRows(state);confirm.disabled=!(state&&state.push_accepted)||!!state.confirmed;
    if(state&&state.status==='failed')status.textContent='通信確認に失敗しました。'+(state.error?' '+state.error:' 15分後にもう一度お試しください。');
    else if(state&&state.status==='expired')status.textContent='通信確認の期限が切れました。もう一度開始してください。';
    else if(state&&state.confirmed)status.textContent='通知の目視確認まで完了しました。';
    else if(state&&state.received)status.textContent='端末で受信しました。通知が見えたら下のボタンを押してください。';
    else if(state&&state.push_accepted)status.textContent='FCMが受理しました。iPhoneの通知を確認してください。';
  }
  async function poll(){
    if(stopped||!runId)return;
    try{
      var response=await api('/api/monitor/'+encodeURIComponent(runId));
      var state=await response.json();if(response.ok){paint(state);if(state.confirmed||state.status==='failed'||state.status==='expired')return;}
    }catch(e){}
    timer=setTimeout(poll,1800);
  }
  confirm.onclick=async function(){
    if(!runId)return;confirm.disabled=true;status.textContent='目視確認を記録しています…';
    try{
      var response=await api('/api/monitor/receipt',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({run_id:runId,event:'confirmed'})});
      if(!response.ok)throw new Error('confirm failed');await poll();
    }catch(e){confirm.disabled=false;status.textContent='確認を保存できませんでした。もう一度お試しください。';}
  };
  (async function(){
    try{
      var push=window.setupSpotaPush&&await window.setupSpotaPush(true);
      if(!push||!push.ok){
        var pushMessage=push&&push.message||'通知の端末登録を完了できませんでした。';
        if(push&&push.code)pushMessage+='（コード: '+String(push.code).replace(/[^a-z_]/g,'')+'）';
        throw new Error(pushMessage);
      }
      status.textContent='投稿・DM・通知を送っています…';
      var response=await api('/api/monitor/run',{method:'POST'});
      var result=await response.json().catch(function(){return {};});
      if(response.status===409&&result.run_id){runId=result.run_id;status.textContent='進行中の通信確認を再開します。';poll();return;}
      if(!response.ok)throw new Error(result.error||'通信モニターを開始できませんでした。');
      runId=result.run_id;paint({steps:result.steps,push_accepted:!!result.push_accepted});
      if(typeof refreshSocialBadge==='function')refreshSocialBadge();poll();
    }catch(e){status.textContent=e&&e.message||'通信モニターを開始できませんでした。';}
  })();
}
window.openSpotaCommunicationMonitor=openCommunicationMonitor;

function openMe(){
  var html='<div class="grab"></div><div class="pad" style="padding-top:18px">';
  if(!fbUser){
    html+='<div style="font-size:19px;font-weight:700;margin-bottom:8px">ログイン</div>'+
      '<div style="font-size:13.5px;color:var(--dim);line-height:1.8;margin-bottom:18px">'+
      '思い出がこの端末から離れて残るようになります。機種を変えても戻ってきます。<br>'+
      'フレンドと見せあうこともできます。</div>'+
      '<button class="btn g" id="timeline-guest" style="margin-bottom:8px">タイムラインを見る</button>'+
      '<button class="btn" id="a" style="margin-bottom:8px">Appleでログイン</button>'+
      '<button class="btn g" id="g">Googleでログイン</button>'+
      '<div class="me-section">規約とプライバシー</div>'+
      '<button class="me-row" id="guest-terms">利用規約<small>›</small></button>'+
      '<button class="me-row" id="guest-privacy">プライバシーポリシー<small>›</small></button>'+
      '<button class="btn g" id="x" style="margin-top:8px">あとで</button></div>';
    var s0=showSheet(html);
    s0.querySelector('#x').onclick=closeSheet;
    s0.querySelector('#a').onclick=function(){ closeSheet(); doAppleLogin(); };
    s0.querySelector('#g').onclick=function(){ closeSheet(); doLogin(); };
    s0.querySelector('#timeline-guest').onclick=function(){closeSheet();if(typeof openSocialHub==='function')openSocialHub('timeline');};
    s0.querySelector('#guest-terms').onclick=function(){closeSheet();if(window.openSpotaLegal)window.openSpotaLegal('/terms.html');};
    s0.querySelector('#guest-privacy').onclick=function(){closeSheet();if(window.openSpotaLegal)window.openSpotaLegal('/privacy.html');};
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
    '<div class="me-head"><button class="me-profile-icon" id="me-profile-icon" aria-label="プロフィールアイコンを変更">'+profileIconSvg(meP&&meP.profile_icon)+'</button><div><div class="me-title">'+esc(fbUser.displayName||'プロフィール')+'</div>'+
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


    '<div class="me-section">規約とプライバシー</div>'+
    '<button class="me-row" id="me-terms">利用規約<small>›</small></button>'+
    '<button class="me-row" id="me-privacy">プライバシーポリシー<small>›</small></button>'+


    '<div class="me-section">アカウント</div>'+
    '<button class="me-row" id="communication-monitor">通信モニター<small>投稿・DM・通知を確認　›</small></button>'+
    '<button class="me-row" id="push-test">通知を試す<small>›</small></button>'+
    '<div id="trend-operator-entry" hidden></div>'+
    '<button class="me-row" id="account-delete" style="color:var(--warn)">アカウントを削除<small>›</small></button>'+
    '<button class="me-row" id="out" style="color:var(--warn)">ログアウト</button></div></div>';

  var s=showSheet(html);
  s.querySelector('#x').onclick=closeSheet;
  s.querySelector('#fr').onclick=function(){openFriends();};
  s.querySelector('#me-terms').onclick=function(){closeSheet();if(window.openSpotaLegal)window.openSpotaLegal('/terms.html');};
  s.querySelector('#me-privacy').onclick=function(){closeSheet();if(window.openSpotaLegal)window.openSpotaLegal('/privacy.html');};
  var profileIcon=s.querySelector('#me-profile-icon');if(profileIcon)profileIcon.onclick=function(){closeSheet();if(meP&&meP.handle&&typeof openProfileIconPicker==='function')openProfileIconPicker(meP.handle,meP.profile_icon||'pin');};
  s.querySelector('#out').onclick=function(){ doLogout(); closeSheet(); };
  s.querySelector('#account-delete').onclick=function(){closeSheet();openAccountDeletion();};
  s.querySelector('#communication-monitor').onclick=function(){closeSheet();openCommunicationMonitor();};
  if(typeof window.mountTrendOperatorEntry==='function')window.mountTrendOperatorEntry(s);
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
    var rows=(j.posts||[]).filter(function(p){return !p.mine&&p.visibility==='public'&&p.map_available;});
    if(!rows.length){setTip('表示できる思い出はまだありません');return;}
    others={};
    rows.forEach(function(p){
      others[p.id]={id:p.id,n:p.title,c:p.category,lat:p.lat,lng:p.lng,
        gname:(p.author&&p.author.name?p.author.name+' の思い出':''),
        place:p.place_name||'',tag:p.tag||'',d:p.taken_at?new Date(p.taken_at).toISOString().slice(0,10):'',
        author:p.author,precision:p.precision,visibility:p.visibility,
        server_photo_id:p.photo_id||null,friend:p.visibility==='friends'};
      if(typeof queueSharedPhoto==='function'&&p.visibility==='public'&&p.photo_id)queueSharedPhoto(others[p.id],auth);
    });
    closeSheet();setMapAudience('public',true);render(true);
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
