/* ============================================================
   リリース前大型更新

   ・みんなの地図 / 自分の地図
   ・思い出アルバム
   ・公開タイムラインとタグ検索
   ・公開プロフィール / 通知 / チャット / ソーシャル操作

   既存の投稿・公開範囲・位置精度を唯一のデータ源にする。
   ============================================================ */

var releaseScreen=null;
// 認証コンテキストを含む待機列もwindowの名前付きプロパティへ出さない。
let sharedPhotoQueue=[],sharedPhotoBusy=0,sharedPhotoCache={},sharedPhotoOrder=[],sharedPhotoRecords={},sharedPhotoPending={},sharedPhotoGeneration=0;
// classic script の `var` で認証情報を window の名前付きプロパティへ出さない。
let mapPhotoAuth=null;

function rememberSharedPhotoRecord(id,rec){
  var records=sharedPhotoRecords[id]||(sharedPhotoRecords[id]=[]);
  if(records.indexOf(rec)<0)records.push(rec);
}

function releaseDate(value){
  if(!value)return '';
  var d=typeof value==='number'?new Date(value):new Date(String(value));
  if(isNaN(d.getTime()))return String(value).slice(0,10);
  return d.toLocaleDateString('ja-JP',{year:'numeric',month:'short',day:'numeric'});
}
function releaseTags(value){
  var raw=String(value||''),found=raw.match(/#[^\s#]{1,30}/g)||[];
  return found.filter(function(v,i,a){return a.indexOf(v)===i;}).slice(0,8);
}

function closeReleaseScreen(after){
  if(!releaseScreen)return;
  var screen=releaseScreen;releaseScreen=null;
  var dispose=screen.__onClose;screen.__onClose=null;if(dispose)dispose();
  resetReleasePhotos(screen);
  (screen.__inert||[]).forEach(function(node){node.inert=false;});
  if(screen.classList.contains('profile-screen')){
    var closingPanel=screen.querySelector('.profile-panel');if(closingPanel)closingPanel.style.transition='transform .32s cubic-bezier(.2,.72,.2,1)';
    screen.style.setProperty('--dismiss-y','100vh');screen.style.setProperty('--profile-scrim','0');
    screen.classList.add('dismissing');
  }else screen.classList.remove('on');
  var focus=screen.__previousFocus;
  setTimeout(function(){screen.remove();if(focus&&focus.isConnected)focus.focus();if(typeof after==='function')after();},320);
}
function bindProfileDismiss(screen){
  var panel=screen.querySelector('.profile-panel'),scroller=screen.querySelector('.release-body');
  if(!panel)return;
  var active=false,locked=false,pointer=null,sx=0,sy=0,lastY=0,lastT=0,vy=0,raf=0,pending=0;
  function cancelFrame(){if(raf){cancelAnimationFrame(raf);raf=0;}}
  function reset(){
    cancelFrame();active=false;locked=false;pointer=null;vy=0;panel.style.transition='';screen.style.setProperty('--dismiss-y','0px');
    screen.style.setProperty('--profile-scrim','1');panel.classList.add('settling');
    setTimeout(function(){panel.classList.remove('settling');},320);
  }
  function down(e){
    if(!e.isPrimary||e.button!==0||!releaseScreen||releaseScreen!==screen)return;
    if(scroller&&scroller.scrollTop>0)return;
    if(!e.target.closest('.profile-drag-zone,.release-bar,.profile-hero'))return;
    if(e.target.closest('button,input,textarea,select,a,.profile-grid'))return;
    active=true;locked=false;pointer=e.pointerId;sx=e.clientX;sy=e.clientY;lastY=sy;lastT=e.timeStamp;vy=0;
    panel.classList.remove('settling');
  }
  function move(e){
    if(!active||e.pointerId!==pointer)return;
    var dx=e.clientX-sx,dy=Math.max(0,e.clientY-sy);
    if(!locked){
      if(Math.max(Math.abs(dx),Math.abs(dy))<8)return;
      if(dy<=Math.abs(dx)*1.2){active=false;return;}
      locked=true;panel.style.transition='none';try{panel.setPointerCapture(pointer);}catch(err){}
    }
    e.preventDefault();
    var dt=Math.max(1,e.timeStamp-lastT),instant=(e.clientY-lastY)/dt*1000;
    vy=vy*.68+instant*.32;lastY=e.clientY;lastT=e.timeStamp;pending=dy;
    if(!raf)raf=requestAnimationFrame(function(){
      raf=0;var h=Math.max(1,panel.offsetHeight);screen.style.setProperty('--dismiss-y',pending+'px');
      screen.style.setProperty('--profile-scrim',String(Math.max(0,1-pending/h)));
    });
  }
  function end(e){
    if(!active||e.pointerId!==pointer)return;
    cancelFrame();var idle=e.timeStamp-lastT;if(idle>80)vy=0;
    else if(idle>0)vy=vy*.68+((e.clientY-lastY)/idle*1000)*.32;
    var dy=Math.max(0,e.clientY-sy),close=locked&&(dy>panel.offsetHeight*.30||vy>900);
    active=false;
    try{panel.releasePointerCapture(pointer);}catch(err){}
    if(close)closeReleaseScreen();else reset();
  }
  panel.addEventListener('pointerdown',down);
  panel.addEventListener('pointermove',move,{passive:false});
  panel.addEventListener('pointerup',end);panel.addEventListener('pointercancel',reset);
  panel.addEventListener('lostpointercapture',function(){if(active)reset();});
  var priorDispose=screen.__onClose;screen.__onClose=function(){cancelFrame();active=false;if(priorDispose)priorDispose();};
}
function makeReleaseScreen(label,options){
  closeReleaseScreen();
  options=options||{};var profile=options.kind==='profile';
  var bar='<header class="release-bar">'+(profile?'<span class="release-bar-space"></span>':'<button class="release-back" type="button" aria-label="地図へ戻る"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M15 5l-7 7 7 7"/></svg></button>')+
      '<div class="release-bar-title">'+esc(label)+'</div>'+(profile?'<button class="release-back profile-close" type="button" aria-label="プロフィールを閉じる">×</button>':'<span class="release-bar-space"></span>')+'</header>';
  var screen=el('<section class="release-screen'+(profile?' profile-screen':'')+'" role="dialog" aria-modal="true" aria-label="'+esc(label)+'">'+
    (profile?'<div class="profile-panel"><div class="profile-drag-zone" aria-hidden="true"><i></i></div>'+bar+'<main class="release-body"></main></div>':bar+'<main class="release-body"></main>')+'</section>');
  screen.__urls=[];screen.__photoControllers=[];screen.__photoGeneration=0;
  screen.__previousFocus=document.activeElement;screen.__inert=[];
  Array.prototype.forEach.call(document.body.children,function(node){
    if(node!==screen&&node.id!=='err'&&!node.inert){node.inert=true;screen.__inert.push(node);}
  });
  document.body.appendChild(screen);releaseScreen=screen;
  screen.querySelector('.release-back').onclick=function(){closeReleaseScreen(options.onBack);};
  screen.onkeydown=function(e){
    if(e.key==='Escape'){e.preventDefault();closeReleaseScreen();}
  };
  void screen.offsetWidth;screen.classList.add('on');screen.querySelector('.release-back').focus();
  if(profile)bindProfileDismiss(screen);
  return screen;
}

function resetReleasePhotos(screen){
  if(!screen)return 0;
  screen.__photoGeneration=(screen.__photoGeneration||0)+1;
  (screen.__photoControllers||[]).forEach(function(controller){try{controller.abort();}catch(e){}});
  screen.__photoControllers=[];
  (screen.__urls||[]).forEach(function(u){URL.revokeObjectURL(u);});
  screen.__urls=[];
  return screen.__photoGeneration;
}

async function putRemotePhoto(img,photoId,screen,kind){
  if(!img||!photoId||!screen||!screen.isConnected)return;
  var generation=screen.__photoGeneration||0;
  var controller=typeof AbortController!=='undefined'?new AbortController():null;
  var u='';
  if(controller)(screen.__photoControllers||(screen.__photoControllers=[])).push(controller);
  try{
    var r=await api('/api/photo/'+encodeURIComponent(photoId)+'/'+(kind||'thumb'),controller?{signal:controller.signal}:undefined);
    if(!r.ok)throw new Error('photo '+r.status);
    u=URL.createObjectURL(await r.blob());
    if(!screen.isConnected||!img.isConnected||generation!==screen.__photoGeneration){URL.revokeObjectURL(u);return;}
    img.src=u;
    if(typeof img.decode==='function')await img.decode();
    else if(!img.complete||!img.naturalWidth)await new Promise(function(resolve,reject){
      img.addEventListener('load',resolve,{once:true});img.addEventListener('error',reject,{once:true});
    });
    if(!screen.isConnected||!img.isConnected||generation!==screen.__photoGeneration){URL.revokeObjectURL(u);return;}
    screen.__urls.push(u);u='';img.classList.add('loaded');
    // 認証済みレスポンスを受け取り、画像の復号まで完了した時だけ知らせる。
    if(window.SpotaMotion)window.SpotaMotion.sharedPhotoReveal(img);
  }catch(e){if(u)URL.revokeObjectURL(u);if(e&&e.name!=='AbortError'&&img.isConnected){
    if(img.closest('[data-photo]'))img.closest('[data-photo]').classList.add('photo-failed');
    if(window.SpotaMotion)window.SpotaMotion.photoError(img);
  }}
  finally{
    if(controller){var at=(screen.__photoControllers||[]).indexOf(controller);if(at>=0)screen.__photoControllers.splice(at,1);}
  }
}

/* 地図用サムネイル。自分・共有の区別なく、画面が必要とした写真だけ取得する。 */
function queueSharedPhoto(rec,auth){
  if(!rec||!rec.server_photo_id||rec.photo)return;
  var id=rec.server_photo_id;
  if(sharedPhotoCache[id]){
    rec.photo=sharedPhotoCache[id];
    rememberSharedPhotoRecord(id,rec);
    return;
  }
  if(rec.photo_loading)return;
  var pending=sharedPhotoPending[id];
  if(pending&&pending.generation===sharedPhotoGeneration){
    rec.photo_loading=1;if(pending.records.indexOf(rec)<0)pending.records.push(rec);return;
  }
  if(sharedPhotoQueue.length>=32)return;
  rec.photo_loading=1;
  var job={rec:rec,records:[rec],auth:auth,id:id,generation:sharedPhotoGeneration};
  sharedPhotoPending[id]=job;sharedPhotoQueue.push(job);runSharedPhotoQueue();
}
function setMapPhotoAuth(auth){
  if(!auth||!authIsCurrent(auth))return;
  var changed=!mapPhotoAuth||mapPhotoAuth.uid!==auth.uid||mapPhotoAuth.scope!==auth.scope||mapPhotoAuth.seq!==auth.seq;
  mapPhotoAuth=auth;
  // 認証前の初回描画で取得を見送ったサーバ写真を、認証確定直後に再評価する。
  if(changed&&typeof render==='function')render(true);
}
function queueMapPhotoThumb(rec){
  if(!mapPhotoAuth||!authIsCurrent(mapPhotoAuth))return;
  queueSharedPhoto(rec,mapPhotoAuth);
}
window.setMapPhotoAuth=setMapPhotoAuth;
window.queueMapPhotoThumb=queueMapPhotoThumb;
function runSharedPhotoQueue(){
  while(sharedPhotoBusy<2&&sharedPhotoQueue.length){
    var job=sharedPhotoQueue.shift();sharedPhotoBusy++;
    (async function(item){
      try{
        var r=await apiAs(item.auth,'/api/photo/'+encodeURIComponent(item.id)+'/thumb');
        if(!r.ok)throw new Error('photo '+r.status);
        var u=URL.createObjectURL(await r.blob());
        if(item.generation!==sharedPhotoGeneration||!authIsCurrent(item.auth)){URL.revokeObjectURL(u);return;}
        sharedPhotoCache[item.id]=u;sharedPhotoOrder.push(item.id);
        item.records.forEach(function(rec){rec.photo=u;rememberSharedPhotoRecord(item.id,rec);});
        while(sharedPhotoOrder.length>36){
          var old=sharedPhotoOrder.shift(),oldUrl=sharedPhotoCache[old];
          (sharedPhotoRecords[old]||[]).forEach(function(rec){if(rec.photo===oldUrl)delete rec.photo;});
          delete sharedPhotoRecords[old];delete sharedPhotoCache[old];if(oldUrl)URL.revokeObjectURL(oldUrl);
        }
        if(typeof render==='function')render(true);
      }catch(e){}finally{
        item.records.forEach(function(rec){delete rec.photo_loading;});
        if(sharedPhotoPending[item.id]===item)delete sharedPhotoPending[item.id];
        sharedPhotoBusy--;runSharedPhotoQueue();
      }
    })(job);
  }
}
function clearSharedPhotoCache(){
  sharedPhotoGeneration++;
  mapPhotoAuth=null;
  sharedPhotoQueue.forEach(function(item){item.records.forEach(function(rec){delete rec.photo_loading;});});
  sharedPhotoQueue=[];sharedPhotoPending={};
  Object.keys(sharedPhotoCache).forEach(function(id){
    var url=sharedPhotoCache[id];
    (sharedPhotoRecords[id]||[]).forEach(function(rec){if(rec.photo===url)delete rec.photo;delete rec.photo_loading;});
    if(url)URL.revokeObjectURL(url);
  });
  sharedPhotoCache={};sharedPhotoOrder=[];sharedPhotoRecords={};
}
window.queueSharedPhoto=queueSharedPhoto;
window.clearSharedPhotoCache=clearSharedPhotoCache;

/* ---------- アルバム ---------- */
function albumMonthLabel(key){
  var m=/^(\d{4})-(\d{2})/.exec(key||'');
  return m?Number(m[1])+'年'+Number(m[2])+'月':'日付のない思い出';
}
var ALBUM_REORDER_LIMIT=120;
function albumSpotId(p){return String(p&&((p.id||p.server_id||p.server_photo_id||p.photo_id)||''));}
function albumCanReorder(list){
  if(!Array.isArray(list)||!list.length||list.length>ALBUM_REORDER_LIMIT)return false;
  var seen=Object.create(null);
  return list.every(function(p){var id=albumSpotId(p);if(!id||id.length>256||seen[id])return false;seen[id]=1;return true;});
}
function albumOrderRows(list,key,scope){return list.map(function(p,index){
  return {id:albumSpotId(p),owner_scope:scope,month_key:key,order:index};
});}
function albumOrderValue(p){
  var value=Number(p&&p.album_order);
  return isFinite(value)&&value>=0?value:null;
}
function albumCompare(a,b){
  var ao=albumOrderValue(a),bo=albumOrderValue(b);
  if(ao!==null||bo!==null){
    if(ao===null)return 1;if(bo===null)return -1;
    if(ao!==bo)return ao-bo;
  }
  var date=String(b&&b.d||'').localeCompare(String(a&&a.d||''));
  return date||albumSpotId(a).localeCompare(albumSpotId(b));
}
function renderAlbumHome(screen,host){
  var withPhoto=spots.filter(function(p){return p.photo_thumb||p.photo;})
    .slice();
  var groups={};withPhoto.forEach(function(p){var key=String(p.d||'').slice(0,7)||'none';(groups[key]||(groups[key]=[])).push(p);});
  Object.keys(groups).forEach(function(key){groups[key].sort(albumCompare);});
  var keys=Object.keys(groups).sort().reverse();
  host.innerHTML='<section class="memory-intro"><p class="release-kicker">自分の地図</p>'+
    '<h1>思い出を、場所と時間で。</h1><p>写真は自分の地図に必ず残り、公開を選んだものだけがみんなの地図にも現れます。</p>'+
    '<button class="release-main" id="album-import" type="button">写真からアルバムを作る</button></section>'+
    '<section class="daily-view"><div><p class="release-kicker">1日1枚</p><b>今日の思い出</b><span>'+(dailyEnabled()?'毎日ランダムな時間に、端末内で候補を選びます':'許可した写真から1枚だけ候補にします')+'</span></div>'+
      '<button type="button" id="daily-toggle">'+(dailyEnabled()?'停止':'はじめる')+'</button></section>'+
    (keys.length?keys.map(function(key){
      var canReorder=albumCanReorder(groups[key]);
      return '<section class="album-section" data-album-section="'+esc(key)+'"><div class="album-heading"><h2>'+albumMonthLabel(key)+'</h2><div class="album-heading-actions"><span>'+groups[key].length+'枚</span><button type="button" class="album-edit" data-album-edit="'+esc(key)+'"'+(canReorder?'':' disabled')+' aria-label="'+(canReorder?'並べ替え':'並べ替え（120枚まで）')+'">'+(canReorder?'並べ替え':'120枚まで')+'</button></div></div>'+
        '<div class="album-sort-toolbar" data-album-toolbar="'+esc(key)+'" hidden><p>写真をドラッグ、または「前へ」「後へ」で順番を変更</p><div><button type="button" data-album-cancel="'+esc(key)+'">キャンセル</button><button type="button" class="album-save" data-album-save="'+esc(key)+'">保存</button></div></div>'+
        '<p class="album-sort-status sr-only" data-album-status="'+esc(key)+'" role="status" aria-atomic="true"></p>'+
        '<div class="album-grid" data-album-grid="'+esc(key)+'">'+groups[key].map(function(p,i){return albumCardMarkup(p,key,i,false);}).join('')+'</div></section>';
    }).join(''):'<div class="release-empty"><b>まだ写真がありません</b><span>写真を選ぶと、撮影場所と日付から最初のアルバムを作れます。</span></div>');
  var albumImport=host.querySelector('#album-import');if(albumImport)albumImport.onclick=function(){closeReleaseScreen();chooseAlbumPhotos();};
  var dailyToggle=host.querySelector('#daily-toggle');if(dailyToggle)dailyToggle.onclick=async function(){var button=this;button.disabled=true;var changed=await setDailyPhotoEnabled(!dailyEnabled());if(changed)renderAlbumHome(screen,host);else button.disabled=false;};
  function findAlbumNode(root,attribute,value){var nodes=root.querySelectorAll('['+attribute+']'),wanted=String(value);for(var i=0;i<nodes.length;i++)if(nodes[i].getAttribute(attribute)===wanted)return nodes[i];return null;}
  function announce(key,message){var status=findAlbumNode(host,'data-album-status',key);if(status)status.textContent=message;}
  function renderGrid(key,list,editing,state){
    var grid=findAlbumNode(host,'data-album-grid',key);if(!grid)return;
    grid.innerHTML=list.map(function(p,i){return albumCardMarkup(p,key,i,editing);}).join('');
    bindGrid(key,list,editing,state);
  }
  function bindGrid(key,list,editing,state){
    var grid=findAlbumNode(host,'data-album-grid',key);if(!grid)return;
    Array.prototype.forEach.call(grid.querySelectorAll('[data-album-photo]'),function(button){button.onclick=function(){
      if(state)return;
      var current=list.filter(function(p){return albumSpotId(p)===button.dataset.spotId;})[0]||{};
      var index=list.indexOf(current);
      openViewer(list.map(function(x){return x.photo||x.photo_thumb;}),Math.max(0,index),'じぶん',current.place||current.n,current.tag||'',current.d||'',[],list.map(function(x){return x.server_photo_id||null;}));
    };});
    if(!editing||!state)return;
    Array.prototype.forEach.call(grid.querySelectorAll('.album-card'),function(card){
      function endDrag(event,cancel){
        var drag=state.drag;if(!drag||drag.card!==card)return;
        if(event&&event.pointerId!==undefined&&drag.pointerId!==event.pointerId)return;
        state.drag=null;card.classList.remove('is-dragging');
        try{if(card.hasPointerCapture&&card.hasPointerCapture(drag.pointerId))card.releasePointerCapture(drag.pointerId);}catch(e){}
        if(cancel){applyOrder(state,drag.origin);announce(key,'移動を取り消しました');}
        else if(drag.moved)announce(key,'写真の仮の順番を変更しました。保存で確定します');
      }
      card.addEventListener('keydown',function(event){
        var index=state.order.findIndex(function(p){return albumSpotId(p)===card.dataset.spotId;});
        if(index<0)return;
        var target=-1;
        if(event.key==='ArrowLeft')target=index-1;
        else if(event.key==='ArrowRight')target=index+1;
        else if(event.key==='Home')target=0;
        else if(event.key==='End')target=state.order.length-1;
        else return;
        event.preventDefault();if(target<0||target>=state.order.length||target===index)return;
        var next=state.order.slice(),item=next.splice(index,1)[0];next.splice(target,0,item);applyOrder(state,next);
        announce(key,(item.n||'写真')+'を'+(target+1)+'番目に移動しました');
        var focus=findAlbumNode(grid,'data-spot-id',albumSpotId(item));if(focus)focus.focus();
      });
      card.addEventListener('pointerdown',function(event){
        if(event.target.closest&&event.target.closest('.album-reorder-controls'))return;
        if(state.drag||event.isPrimary===false||(event.button!==undefined&&event.button!==0))return;
        state.drag={card:card,pointerId:event.pointerId,origin:state.order.slice(),moved:false,startX:event.clientX,startY:event.clientY};
        card.classList.add('is-dragging');
        try{card.setPointerCapture(event.pointerId);}catch(e){}
      });
      card.addEventListener('pointermove',function(event){
        var drag=state.drag;if(!drag||drag.pointerId!==event.pointerId)return;
        if(!drag.moved&&Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)<6)return;
        drag.moved=true;
        var target=document.elementFromPoint(event.clientX,event.clientY),other=target&&target.closest&&target.closest('.album-card');
        if(!other||other===card||other.parentNode!==grid)return;
        var order=state.order.slice(),from=order.findIndex(function(p){return albumSpotId(p)===card.dataset.spotId;}),to=order.findIndex(function(p){return albumSpotId(p)===other.dataset.spotId;});
        if(from<0||to<0||from===to)return;
        var item=order.splice(from,1)[0],rect=other.getBoundingClientRect(),insert=event.clientY>rect.top+rect.height/2?to+1:to;
        if(from<insert)insert--;if(insert<0)insert=0;if(insert>order.length)insert=order.length;
        order.splice(insert,0,item);if(order.map(albumSpotId).join('|')!==state.order.map(albumSpotId).join('|'))applyOrder(state,order);
      });
      card.addEventListener('pointerup',function(event){
        endDrag(event,false);
      });
      card.addEventListener('pointercancel',function(event){
        endDrag(event,true);
      });
      card.addEventListener('lostpointercapture',function(event){endDrag(event,true);});
      Array.prototype.forEach.call(card.querySelectorAll('[data-album-move]'),function(button){button.onclick=function(event){
        event.stopPropagation();var index=state.order.findIndex(function(p){return albumSpotId(p)===card.dataset.spotId;}),nextIndex=index+(button.dataset.albumMove==='next'?1:-1);
        if(index<0||nextIndex<0||nextIndex>=state.order.length)return;
        var next=state.order.slice(),item=next.splice(index,1)[0];next.splice(nextIndex,0,item);applyOrder(state,next);announce(key,(item.n||'写真')+'を'+(nextIndex+1)+'番目に移動しました');
        var focus=findAlbumNode(grid,'data-spot-id',albumSpotId(item));if(focus)focus.focus();
      };});
    });
  }
  function applyOrder(state,next){
    var grid=state.grid,first=new Map();Array.prototype.forEach.call(grid.children,function(card){first.set(card.dataset.spotId,card.getBoundingClientRect());});
    next.forEach(function(p){var card=Array.prototype.find.call(grid.children,function(node){return node.dataset.spotId===albumSpotId(p);});if(card)grid.appendChild(card);});
    state.order=next.slice();
    var reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if(reduce)return;
    requestAnimationFrame(function(){Array.prototype.forEach.call(grid.children,function(card){var from=first.get(card.dataset.spotId);if(!from)return;var to=card.getBoundingClientRect(),dx=from.left-to.left,dy=from.top-to.top;if(Math.abs(dx)+Math.abs(dy)<1)return;card.animate([{transform:'translate3d('+dx+'px,'+dy+'px,0)'},{transform:'none'}],{duration:360,easing:'cubic-bezier(.22,.61,.36,1)'});});});
  }
  function startReorder(key){
    var list=groups[key]||[];if(!albumCanReorder(list))return;
    var section=findAlbumNode(host,'data-album-section',key),grid=findAlbumNode(host,'data-album-grid',key);if(!section||!grid)return;
    var state={key:key,grid:grid,order:list.slice(),before:list.slice(),drag:null,scope:activeSpotScope,scopeSwitch:spotScopeSwitch};
    section.__albumReorder=state;section.classList.add('is-editing');
    section.querySelector('[data-album-edit]').hidden=true;section.querySelector('[data-album-toolbar]').hidden=false;
    renderGrid(key,state.order,true,state);state.grid=grid;announce(key,'並べ替えモード。ドラッグ、前へ・後へ、左右キーで順番を変更できます');
    var first=grid.querySelector('.album-card');if(first)first.focus();
  }
  function finishReorder(key,cancel){
    var section=findAlbumNode(host,'data-album-section',key),state=section&&section.__albumReorder;if(!section||!state)return;
    if(cancel){applyOrder(state,state.before);groups[key]=state.before.slice();}
    section.classList.remove('is-editing');section.__albumReorder=null;renderGrid(key,groups[key],false);
    var edit=section.querySelector('[data-album-edit]');if(edit){edit.hidden=false;edit.focus();}
    section.querySelector('[data-album-toolbar]').hidden=true;
    announce(key,cancel?'並べ替えをキャンセルしました':'並べ替えを保存しました');
  }
  async function saveReorder(key){
    var section=findAlbumNode(host,'data-album-section',key),state=section&&section.__albumReorder;if(!state)return;
    if(state.scope!==activeSpotScope||state.scopeSwitch!==spotScopeSwitch){finishReorder(key,true);setTip('アカウントが変わったため保存を中止しました','error');return;}
    var save=section.querySelector('[data-album-save]');if(save)save.disabled=true;
    var scope=state.scope,before=state.before.slice(),rows=albumOrderRows(state.order,key,scope);
    if(typeof dbPutAlbumOrdersAtomic!=='function'||!(await dbPutAlbumOrdersAtomic(rows,scope))){if(save)save.disabled=false;setTip(dbFailureReason?dbFailureReason():'順番を保存できませんでした','error');announce(key,'保存に失敗しました。順番は保持されています');return;}
    if(scope!==activeSpotScope||state.scopeSwitch!==spotScopeSwitch)return;
    state.order.forEach(function(p,index){p.album_order=index;});groups[key]=state.order.slice();
    finishReorder(key,false);setTip('アルバムの順番を保存しました','success');
    if(window.SpotaMotion&&typeof window.SpotaMotion.showUndo==='function')window.SpotaMotion.showUndo('アルバムの順番を保存しました',async function(){
      if(scope!==activeSpotScope||state.scopeSwitch!==spotScopeSwitch)throw new Error('アカウントが変わったため元に戻せません');
      if(!(await dbPutAlbumOrdersAtomic(albumOrderRows(before,key,scope),scope)))throw new Error(dbFailureReason?dbFailureReason():'元の順番へ戻せませんでした');
      if(scope!==activeSpotScope||state.scopeSwitch!==spotScopeSwitch)throw new Error('アカウントが変わったため元に戻せません');
      before.forEach(function(p,index){p.album_order=index;});groups[key]=before.slice();
      if(screen.isConnected)renderAlbumHome(screen,host);setTip('元の順番へ戻しました','success');
    });
  }
  Array.prototype.forEach.call(host.querySelectorAll('[data-album-edit]'),function(button){button.onclick=function(){startReorder(button.dataset.albumEdit);};});
  Array.prototype.forEach.call(host.querySelectorAll('[data-album-cancel]'),function(button){button.onclick=function(){finishReorder(button.dataset.albumCancel,true);};});
  Array.prototype.forEach.call(host.querySelectorAll('[data-album-save]'),function(button){button.onclick=function(){saveReorder(button.dataset.albumSave);};});
  keys.forEach(function(key){bindGrid(key,groups[key],false);});
}
function albumCardMarkup(p,key,index,editing){
  var id=albumSpotId(p),label=p.n||p.place||'思い出';
  return '<div class="album-card" data-spot-id="'+esc(id)+'"'+(editing?' tabindex="0" role="group" aria-label="'+esc(label)+'。左右キーで移動"':'')+'><button type="button" class="album-photo" data-album-photo="'+esc(key)+'" data-spot-id="'+esc(id)+'" aria-label="'+esc(label)+'を開く"'+(editing?' disabled aria-hidden="true"':'')+'><img src="'+esc(p.photo_thumb||p.photo)+'" alt="" loading="lazy"><span>'+esc(p.n||'')+'</span></button>'+(editing?'<div class="album-reorder-controls"><button type="button" data-album-move="prev" aria-label="'+esc(label)+'を前へ">前へ</button><button type="button" data-album-move="next" aria-label="'+esc(label)+'を後へ">後へ</button></div>':'')+'</div>';
}

/* ---------- タイムライン / 通知 / チャット ---------- */
async function socialJson(path,options,showWait){
  var r=await api(path,options),j=await r.json().catch(function(){return {};});
  if(!r.ok)throw new Error(j.error||'読み込めませんでした');return j;
}
function beginSocialRender(screen){screen.__socialGeneration=(screen.__socialGeneration||0)+1;return screen.__socialGeneration;}
function socialRenderAlive(screen,host,generation){return releaseScreen===screen&&screen.isConnected&&host.isConnected&&screen.__socialGeneration===generation;}
function feedCard(p,i){
  var who=p.author&&(p.author.name||p.author.handle)||'Spotaユーザー';
  return '<article class="timeline-card" data-post="'+esc(p.id)+'">'+
    '<header><button class="timeline-person" type="button" data-profile="'+esc(p.author&&p.author.handle||'')+'"><i>'+profileIconSvg(p.author&&p.author.profile_icon)+'</i><span><b>'+esc(who)+'</b><small>@'+esc(p.author&&p.author.handle||'')+'</small></span></button>'+
      (!p.mine?'<button class="timeline-follow'+(p.following?' on':'')+'" type="button" data-follow="'+i+'" aria-pressed="'+String(!!p.following)+'"><span class="follow-label">フォロー</span><span class="following-label"><i class="follow-check" aria-hidden="true"></i>フォロー中</span></button>':'')+
      '<time>'+esc(releaseDate(p.taken_at||p.created_at))+'</time></header>'+
    '<button class="timeline-photo" type="button" data-photo="'+esc(p.photo_id||'')+'" data-index="'+i+'" aria-label="写真を開く"><img alt="" loading="lazy"><span class="timeline-like-heart" aria-hidden="true">♥</span><span class="timeline-like-particles" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span></button>'+
    '<div class="timeline-copy"><div class="timeline-place"><b>'+esc(p.title||p.place_name||'思い出')+'</b>'+
      (p.map_available?'<button type="button" data-map="'+i+'">地図で見る</button>':'')+'</div>'+
      (p.tag?'<p>'+esc(p.tag)+'</p>':'')+
      '<div class="timeline-actions"><button type="button" data-like="'+i+'" aria-label="いいね '+Number(p.like_count||0)+'件" aria-pressed="'+String(!!p.liked)+'" class="'+(p.liked?'on':'')+'"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 5.8c-2.1-2.3-5.6-1.8-7.2.6L12 8.7l-1.6-2.3c-1.6-2.4-5.1-2.9-7.2-.6-2 2.2-1.7 5.7.5 7.7L12 21l8.3-7.5c2.2-2 2.5-5.5.5-7.7Z"/></svg><b><span>'+Number(p.like_count||0)+'</span></b></button>'+
      '<button type="button" data-comments="'+i+'" aria-label="コメント '+Number(p.comment_count||0)+'件"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v11H9l-5 3Z"/><path d="M8 10h8M8 13h5"/></svg><b>'+Number(p.comment_count||0)+'</b></button>'+
      (p.visibility==='public'?'<button type="button" data-flash="'+i+'" aria-label="フラッシュ '+Number(p.flash_count||0)+'件" aria-pressed="'+String(!!p.flashed)+'" class="'+(p.flashed?'on':'')+'" '+(p.flashed?'disabled':'')+'><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 2 5.8 13h5.5l-.8 9L18.2 11h-5.5Z"/></svg><b>'+Number(p.flash_count||0)+'</b></button>':'')+
      (p.mine&&p.visibility==='public'?'<button type="button" data-share="'+i+'" aria-label="共有"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8"/><path d="M18 13v6H5V6h6"/></svg></button>':'')+
      (!p.mine?'<button type="button" data-report="'+i+'" aria-label="この投稿を通報"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V4m0 1h11l-2 4 2 4H6"/></svg></button>':'')+'</div></div></article>';
}

function openPostReport(post){
  var choices=[['spam','迷惑投稿・宣伝'],['harassment','嫌がらせ'],['nudity','不適切な画像'],
    ['violence','暴力的な内容'],['privacy','プライバシー'],['other','その他']];
  var html='<div class="grab"></div><div class="pad report-sheet" style="padding-top:20px">'+
    '<h2>投稿を通報</h2><p>運営確認に必要な内容だけを送ります。通報した人の名前は投稿者へ表示されません。</p>'+
    '<form id="report-form" novalidate><fieldset><legend>理由</legend>'+choices.map(function(row,i){
      return '<label><input type="radio" name="reason" value="'+row[0]+'" '+(i===0?'checked':'')+'><span>'+row[1]+'</span></label>';
    }).join('')+'</fieldset><label for="report-details">補足（任意）</label>'+
    '<textarea class="fld" id="report-details" maxlength="500" rows="3" aria-describedby="report-help report-error"></textarea>'+
    '<p id="report-help">個人情報や正確な位置情報は入力しないでください。</p>'+
    '<p class="form-error" id="report-error" role="alert" hidden></p>'+
    '<p class="form-status" id="report-status" role="status" aria-live="polite"></p>'+
    '<button class="btn" type="submit">通報を送る</button><button class="btn g" id="report-cancel" type="button">やめる</button></form></div>';
  var sheet=showSheet(html),form=sheet.querySelector('#report-form'),error=sheet.querySelector('#report-error');
  var status=sheet.querySelector('#report-status'),submit=form.querySelector('[type="submit"]');
  sheet.querySelector('#report-cancel').onclick=closeSheet;
  form.onsubmit=async function(event){
    event.preventDefault();submit.disabled=true;error.hidden=true;status.textContent='送信しています…';
    try{
      var reason=form.querySelector('input[name="reason"]:checked');
      var result=await socialJson('/api/reports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        target_type:'post',target_id:post.id,reason:reason&&reason.value||'',
        details:sheet.querySelector('#report-details').value.trim(),client_operation_id:nid()
      })});
      if(!result.ok)throw new Error('通報を送れませんでした');closeSheet();setTip('通報を受け付けました');
    }catch(e){submit.disabled=false;status.textContent='';error.textContent=e&&e.message||'通報を送れませんでした';error.hidden=false;error.focus();}
  };
}
function bindFeedCards(screen,host,posts,timelineState){
  Array.prototype.forEach.call(host.querySelectorAll('[data-profile]'),function(b){if(b.__releaseBound)return;b.__releaseBound=1;b.onclick=function(){if(b.dataset.profile)openPublicProfile(b.dataset.profile,b);};});
  Array.prototype.forEach.call(host.querySelectorAll('[data-map]'),function(b){if(b.__releaseBound)return;b.__releaseBound=1;b.onclick=function(){openTimelineMap(posts[Number(b.dataset.map)]);};});
  Array.prototype.forEach.call(host.querySelectorAll('.timeline-photo'),function(b){
    if(b.__releaseBound)return;b.__releaseBound=1;
    var p=posts[Number(b.dataset.index)],img=b.querySelector('img');putRemotePhoto(img,p.photo_id,screen,'thumb');
    var lastTap=0,openTimer=0;
    function openPhoto(){if(b.isConnected&&img.src)openViewer([img.src],0,p.author&&(p.author.name||p.author.handle),p.place_name||p.title,p.tag||'',releaseDate(p.taken_at),releaseTags(p.tag),[p.photo_id]);}
    b.onclick=function(){
      var now=Date.now();
      if(now-lastTap<330){
        clearTimeout(openTimer);lastTap=0;
        var like=b.closest('.timeline-card').querySelector('[data-like]');
        if(like&&like.getAttribute('aria-pressed')!=='true')like.click();
      }else{lastTap=now;openTimer=setTimeout(openPhoto,340);}
    };
  });
  Array.prototype.forEach.call(host.querySelectorAll('[data-like]'),function(b){if(b.__releaseBound)return;b.__releaseBound=1;b.onclick=async function(){
    var p=posts[Number(b.dataset.like)],next=!p.liked,wasLiked=!!p.liked,wasCount=Number(p.like_count)||0;
    var photo=b.closest('.timeline-card').querySelector('.timeline-photo');
    function paint(liked,count){p.liked=!!liked;p.like_count=Math.max(0,Number(count)||0);
      b.classList.toggle('on',p.liked);b.setAttribute('aria-pressed',String(p.liked));
      if(window.SpotaMotion)window.SpotaMotion.rollNumber(b.querySelector('b'),p.like_count);
      else b.querySelector('b').innerHTML='<span>'+p.like_count+'</span>';
      b.setAttribute('aria-label','いいね '+p.like_count+'件');}
    b.disabled=true;
    try{var j=await socialJson('/api/posts/'+encodeURIComponent(p.id)+'/like',{method:next?'PUT':'DELETE'});paint(j.liked,j.count);
      if(window.SpotaMotion){
        if(j.liked&&!wasLiked){window.SpotaMotion.restartClass(b,'flash',820);window.SpotaMotion.restartClass(photo,'like-burst',1000);}
        else if(!j.liked&&wasLiked)window.SpotaMotion.restartClass(b,'unlike-settle',300);
      }
    }
    catch(e){paint(wasLiked,wasCount);setTip(e.message,'error');}b.disabled=false;
  };});
  Array.prototype.forEach.call(host.querySelectorAll('[data-comments]'),function(b){if(b.__releaseBound)return;b.__releaseBound=1;b.onclick=function(){
    var state=timelineState||{};state={query:state.query||'',mode:state.mode||'recommended',scrollY:screen.scrollTop||0};
    openComments(posts[Number(b.dataset.comments)],function(){openSocialHub('timeline',state);});
  };});
  Array.prototype.forEach.call(host.querySelectorAll('[data-flash]'),function(b){if(b.__releaseBound)return;b.__releaseBound=1;b.onclick=async function(){
    var p=posts[Number(b.dataset.flash)];if(!p||p.flashed)return;
    b.disabled=true;
    try{
      var j=await socialJson('/api/posts/'+encodeURIComponent(p.id)+'/flash',{method:'POST'});
      p.flashed=!!j.flashed;p.flash_count=Number(j.flash_count)||0;
      b.classList.add('on','flash-burst');b.setAttribute('aria-pressed','true');
      b.setAttribute('aria-label','フラッシュ '+p.flash_count+'件');b.querySelector('b').textContent=p.flash_count;
      setTimeout(function(){b.classList.remove('flash-burst');},520);
      setTip(Number(j.recipient_count)?Number(j.recipient_count)+'人へフラッシュしました':'フラッシュしました');
    }catch(e){b.disabled=false;setTip(e.message||'フラッシュできませんでした','error');}
  };});
  Array.prototype.forEach.call(host.querySelectorAll('[data-follow]'),function(b){if(b.__releaseBound)return;b.__releaseBound=1;b.onclick=async function(){
    var p=posts[Number(b.dataset.follow)],previous=!!p.following,next=!previous,handle=p.author&&p.author.handle;if(!handle)return;
    function paint(value){p.following=!!value;b.classList.toggle('on',p.following);b.setAttribute('aria-pressed',String(p.following));b.setAttribute('aria-label',p.following?'フォロー中':'フォロー');}
    b.disabled=true;
    try{await socialJson('/api/follows/'+encodeURIComponent(handle),{method:next?'PUT':'DELETE'});paint(next);if(next&&window.SpotaMotion)window.SpotaMotion.restartClass(b,'follow-confirm',620);}
    catch(e){paint(previous);setTip(e.message,'error');}b.disabled=false;
  };});
  Array.prototype.forEach.call(host.querySelectorAll('[data-share]'),function(b){if(b.__releaseBound)return;b.__releaseBound=1;b.onclick=async function(){
    if(b.disabled)return;b.disabled=true;
    try{await sharePost(posts[Number(b.dataset.share)],b);}finally{if(b.isConnected)b.disabled=false;}
  };});
  Array.prototype.forEach.call(host.querySelectorAll('[data-report]'),function(b){if(b.__releaseBound)return;b.__releaseBound=1;b.onclick=function(){openPostReport(posts[Number(b.dataset.report)]);};});
}
async function sharePost(post,source){
  try{
    var j=await socialJson('/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({target_type:'post',target_id:post.id,expires_in_days:7})});
    var url=location.origin+j.path,title=post.title||post.place_name||'Spotaの思い出';
    if(navigator.share){
      // これは「共有完了」ではなく、OS共有シートを開いた手応え。成功表示は出さない。
      if(window.SpotaMotion)window.SpotaMotion.shareLaunch(source);
      try{await navigator.share({title:title,url:url});}
      catch(shareError){if(shareError&&shareError.name==='AbortError')return;throw shareError;}
    }
    else if(navigator.clipboard){await navigator.clipboard.writeText(url);if(window.SpotaMotion)window.SpotaMotion.shareLaunch(source);setTip('共有リンクをコピーしました','success');}
  }catch(e){setTip(e.message||'共有できませんでした','error');}
}
function bindTimelineRefresh(screen,host,query,mode){
  var hint=host.querySelector('.timeline-refresh-hint');
  if(!hint)return;
  screen.__timelineRefreshState={host:host,query:query||'',mode:mode||'recommended'};
  if(screen.__timelineRefreshBound)return;
  screen.__timelineRefreshBound=true;
  var tracking=false,startY=0,pull=0,pointer=null;
  function paint(value,ready){
    pull=Math.max(0,Math.min(90,value));
    hint=screen.__timelineRefreshState.host.querySelector('.timeline-refresh-hint')||hint;
    screen.__timelineRefreshState.host.style.setProperty('--pull',pull+'px');
    hint.style.setProperty('--pull',pull+'px');
    hint.classList.toggle('pulling',pull>4);
    hint.classList.toggle('ready',!!ready);
    var copy=hint.querySelector('.timeline-refresh-copy');if(copy)copy.textContent=ready?'離して更新':'下に引いて更新';
    hint.setAttribute('aria-hidden',String(pull<=4));
  }
  function reset(){tracking=false;pointer=null;paint(0,false);}
  function down(e){
    if(!e.isPrimary||screen.__timelineRefreshBusy||screen.scrollTop>1||e.clientX<24)return;
    if(e.pointerType==='mouse'&&e.button!==0)return;
    tracking=true;pointer=e.pointerId;startY=e.clientY;pull=0;
    try{screen.setPointerCapture(pointer);}catch(err){}
  }
  function move(e){
    if(!tracking||e.pointerId!==pointer)return;
    var dy=e.clientY-startY;
    if(dy<=0||screen.scrollTop>1){reset();return;}
    var distance=Math.min(90,dy*.45);
    paint(distance,distance>=56);
    if(distance>8)e.preventDefault();
  }
  function up(e){
    if(!tracking||e.pointerId!==pointer)return;
    var ready=pull>=56,state=screen.__timelineRefreshState;
    if(ready&&!screen.__timelineRefreshBusy&&state){
      tracking=false;pointer=null;paint(56,true);
      hint.classList.add('refreshing');hint.setAttribute('aria-hidden','false');
      screen.__timelineRefreshBusy=true;
      renderTimeline(screen,state.host,state.query,state.mode,0,true).finally(function(){
        screen.__timelineRefreshBusy=false;
        var currentHint=state.host.querySelector('.timeline-refresh-hint');
        state.host.style.setProperty('--pull','0px');
        if(currentHint){currentHint.classList.remove('refreshing','pulling','ready');currentHint.style.setProperty('--pull','0px');currentHint.setAttribute('aria-hidden','true');}
      });
    }else reset();
  }
  screen.addEventListener('pointerdown',down);
  screen.addEventListener('pointermove',move,{passive:false});
  screen.addEventListener('pointerup',up);
  screen.addEventListener('pointercancel',reset);
  screen.addEventListener('lostpointercapture',function(){if(tracking)reset();});
}
function drawTimelineShell(screen,host,query,mode){
  resetReleasePhotos(screen);
  host.innerHTML='<div class="timeline-refresh-hint" aria-hidden="true"><span aria-hidden="true"><i class="timeline-refresh-copy">下に引いて更新</i><i class="timeline-refresh-spinner"></i></span></div>'+
    '<form class="timeline-search" id="timeline-search"><span aria-hidden="true">⌕</span>'+
      '<input id="timeline-q" value="'+esc(query||'')+'" placeholder="場所・ことば・#タグ" enterkeyhint="search" autocomplete="off">'+
      '<button type="submit">探す</button></form>'+
    '<div class="feed-modes" role="tablist" aria-label="タイムラインの種類">'+
      '<button type="button" data-feed-mode="recommended" class="'+(mode==='recommended'?'on':'')+'" role="tab" aria-selected="'+String(mode==='recommended')+'">おすすめ</button>'+
      '<button type="button" data-feed-mode="following" class="'+(mode==='following'?'on':'')+'" role="tab" aria-selected="'+String(mode==='following')+'">フォロー中</button></div>'+
    '<div class="timeline-status timeline-loading"><span class="sr-only">写真を読み込んでいます</span></div>';
  bindTimelineRefresh(screen,host,query,mode);
  Array.prototype.forEach.call(host.querySelectorAll('[data-feed-mode]'),function(b){b.onclick=function(){renderTimeline(screen,host,query,b.dataset.feedMode);};});
  host.querySelector('#timeline-search').onsubmit=function(e){e.preventDefault();renderTimeline(screen,host,host.querySelector('#timeline-q').value.trim(),mode);};
}
async function renderTimeline(screen,host,query,mode,restoreY,refreshing){
  var generation=refreshing?(screen.__socialGeneration||0):beginSocialRender(screen);
  mode=mode||'recommended';
  if(!refreshing)drawTimelineShell(screen,host,query,mode);
  if(!fbUser){
    if(refreshing)drawTimelineShell(screen,host,query,mode);
    host.querySelector('.timeline-status').classList.remove('timeline-loading');
    host.querySelector('.timeline-status').innerHTML='<b>ログインするとタイムラインを見られます</b><span>公開された写真と、フレンドの写真が表示されます。</span><button class="release-main" id="timeline-login" type="button">ログインする</button>';
    host.querySelector('#timeline-login').onclick=function(){closeReleaseScreen();document.getElementById('btn-me').click();};return;
  }
  try{
    var feedBody={limit:24,mode:mode,query:query||''};
    var result=await Promise.all([socialJson('/api/feed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(feedBody)},!refreshing),socialJson('/api/hashtags/trending',undefined,!refreshing).catch(function(){return {tags:[]};})]);
    if(!socialRenderAlive(screen,host,generation))return;
    if(refreshing)drawTimelineShell(screen,host,query,mode);
    var j=result[0],tags=result[1].tags||[],posts=j.posts||[],status=host.querySelector('.timeline-status');
    status.classList.remove('timeline-loading');
    if(!posts.length){status.innerHTML='<b>'+(mode==='following'?'フォロー中の投稿はまだありません':'写真が見つかりませんでした')+'</b><span>'+(query?'ことばを変えて、もう一度探してみてください。':'気になる人をフォローすると、ここに写真が並びます。')+'</span>';return;}
    status.outerHTML=(tags.length?'<div class="trend-row" aria-label="よく使われているタグ">'+tags.map(function(t){return '<button type="button" data-tag="'+esc(t.label)+'">'+esc(t.label)+'</button>';}).join('')+'</div>':'')+
      '<div class="timeline-list">'+posts.map(feedCard).join('')+'</div>'+(j.has_more?'<button type="button" class="feed-more" id="feed-more">さらに見る</button>':'');
    if(refreshing){var fresh=host.querySelector('.timeline-card');if(fresh){fresh.classList.add('timeline-fresh');setTimeout(function(){if(fresh.isConnected)fresh.classList.remove('timeline-fresh');},700);}}
    Array.prototype.forEach.call(host.querySelectorAll('[data-tag]'),function(b){b.onclick=function(){renderTimeline(screen,host,b.dataset.tag,mode);};});
    bindFeedCards(screen,host,posts,{query:query,mode:mode});
    if(restoreY)requestAnimationFrame(function(){if(screen.isConnected)screen.scrollTop=restoreY;});
    var more=host.querySelector('#feed-more');if(more)more.onclick=async function(){
      more.disabled=true;try{var next=await socialJson('/api/feed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:24,cursor:j.cursor,mode:mode,query:query||''})});if(!socialRenderAlive(screen,host,generation))return;var offset=posts.length;
        posts=posts.concat(next.posts||[]);var list=host.querySelector('.timeline-list');list.insertAdjacentHTML('beforeend',(next.posts||[]).map(function(p,i){return feedCard(p,offset+i);}).join(''));bindFeedCards(screen,list,posts,{query:query,mode:mode});j=next;if(!next.has_more)more.remove();else more.disabled=false;
      }catch(e){more.disabled=false;setTip(e.message,'error');}
    };
  }catch(e){
    if(!socialRenderAlive(screen,host,generation))return;
    if(refreshing){setTip(e.message||'更新できませんでした');return;}
    var st=host.querySelector('.timeline-status');if(st){st.classList.remove('timeline-loading');st.innerHTML='<b>読み込めませんでした</b><span>'+esc(e.message||'通信を確認してください')+'</span>';}
  }
}

async function openComments(post,onBack){
  // #16: タイムライン上の写真を残したまま、コメントだけを下から重ねる。
  var previousFocus=document.activeElement,commentInert=[];
  var sheet=showSheet('<div class="grab" aria-hidden="true"></div><section class="comment-sheet-body" role="dialog" aria-modal="true" aria-labelledby="comment-sheet-title"><header><h2 id="comment-sheet-title">コメント</h2><button type="button" data-comment-close>閉じる</button></header><div class="comment-list" aria-live="polite">読み込んでいます…</div><form class="comment-form"><input maxlength="1000" placeholder="コメントを書く" aria-label="コメント"><button type="submit">送る</button></form></section>',function(){commentInert.forEach(function(node){node.inert=false;});commentInert=[];if(previousFocus&&previousFocus.isConnected)previousFocus.focus();});
  sheet.classList.add('comment-sheet-shell');
  Array.prototype.forEach.call(document.body.children,function(node){
    if(node!==sheet&&node!==scrim&&node.id!=='err'&&node.id!=='spota-wait'&&node.id!=='spota-wait-status'&&!node.inert){node.inert=true;commentInert.push(node);}
  });
  sheet.querySelector('[data-comment-close]').onclick=closeSheet;
  sheet.onkeydown=function(event){
    if(event.key==='Escape'){event.preventDefault();closeSheet();return;}
    if(event.key!=='Tab')return;
    var focusable=Array.prototype.filter.call(sheet.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])'),function(node){return !node.hidden&&node.offsetParent!==null;});
    if(!focusable.length){event.preventDefault();return;}
    var first=focusable[0],last=focusable[focusable.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  };
  requestAnimationFrame(function(){var close=sheet.querySelector('[data-comment-close]');if(close&&sheet.isConnected)close.focus();});
  var body=sheet.querySelector('.comment-sheet-body'),list=body.querySelector('.comment-list'),form=body.querySelector('.comment-form'),input=form.querySelector('input');
  function row(c){var who=c.author&&(c.author.name||c.author.handle)||'ユーザー';return '<div class="comment-row" data-comment="'+esc(c.id)+'"><i>'+esc(who.charAt(0))+'</i><div><b>'+esc(who)+'</b><p>'+esc(c.body)+'</p><time>'+esc(releaseDate(c.created_at))+'</time></div>'+(c.mine?'<button type="button" aria-label="コメントを削除">×</button>':'')+'</div>';}
  function bindDelete(){Array.prototype.forEach.call(list.querySelectorAll('.comment-row>button'),function(b){b.onclick=async function(){var r=b.closest('[data-comment]');try{await socialJson('/api/posts/'+encodeURIComponent(post.id)+'/comments/'+encodeURIComponent(r.dataset.comment),{method:'DELETE'});r.remove();}catch(e){setTip(e.message,'error');}};});}
  try{var j=await socialJson('/api/posts/'+encodeURIComponent(post.id)+'/comments');list.innerHTML=(j.comments||[]).length?(j.comments||[]).map(row).join(''):'<div class="release-empty"><b>最初のコメントをどうぞ</b></div>';bindDelete();}
  catch(e){list.innerHTML='<div class="release-empty"><b>コメントを読めませんでした</b><span>'+esc(e.message)+'</span></div>';}
  form.onsubmit=async function(e){e.preventDefault();var value=input.value.trim();if(!value)return;form.querySelector('button').disabled=true;try{var c=await socialJson('/api/posts/'+encodeURIComponent(post.id)+'/comments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({body:value,client_operation_id:nid()})});if(list.querySelector('.release-empty'))list.innerHTML='';list.insertAdjacentHTML('beforeend',row(c));var inserted=list.lastElementChild;if(inserted)inserted.classList.add('motion-comment-in');input.value='';bindDelete();}catch(err){setTip(err.message,'error');}form.querySelector('button').disabled=false;};
}

function notificationCopy(n){return {like:'あなたの思い出にいいねしました',comment:'コメントしました',flash:'公開された思い出をフラッシュで届けました',follow:'あなたをフォローしました',post:'新しい思い出を公開しました',message:'メッセージが届きました'}[n.kind]||'お知らせがあります';}
async function renderNotifications(screen,host){
  var generation=beginSocialRender(screen);
  host.innerHTML='<div class="social-section-head"><b>通知</b><button id="notifications-read">すべて既読</button></div><div class="notification-list" aria-live="polite">読み込んでいます…</div>';
  try{var j=await socialJson('/api/notifications');if(!socialRenderAlive(screen,host,generation))return;var list=host.querySelector('.notification-list'),items=j.notifications||[];list.innerHTML=items.length?items.map(function(n){var who=n.actor&&(n.actor.name||n.actor.handle)||'Spota';return '<button type="button" class="notification-row'+(n.read?'':' unread')+'" data-notification="'+esc(n.id)+'" data-kind="'+esc(n.kind)+'" data-entity="'+esc(n.entityId||n.entity_id||'')+'" data-handle="'+esc(n.actor&&n.actor.handle||'')+'"><i>'+esc(who.charAt(0))+'</i><span><b>'+esc(who)+'</b><small>'+esc(notificationCopy(n))+'</small></span><time>'+esc(releaseDate(n.created_at))+'</time></button>';}).join(''):'<div class="release-empty"><b>通知はまだありません</b><span>反応やメッセージがここに届きます。</span></div>';
    var newestUnread=list.querySelector('.notification-row.unread');if(newestUnread)newestUnread.classList.add('motion-notification-in');
    Array.prototype.forEach.call(list.querySelectorAll('.notification-row'),function(b){b.onclick=async function(){try{await socialJson('/api/notifications/read',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[b.dataset.notification]})});}catch(e){}if(b.dataset.kind==='message'&&b.dataset.entity)openConversation(b.dataset.entity,b.querySelector('b').textContent);else if((b.dataset.kind==='like'||b.dataset.kind==='comment'||b.dataset.kind==='flash')&&b.dataset.entity)openSocialHub('timeline');else if(b.dataset.handle)openPublicProfile(b.dataset.handle);refreshSocialBadge();};});
  }catch(e){if(!socialRenderAlive(screen,host,generation))return;var failed=host.querySelector('.notification-list');if(failed)failed.innerHTML='<div class="release-empty"><b>通知を読めませんでした</b><span>'+esc(e.message)+'</span></div>';}
  host.querySelector('#notifications-read').onclick=async function(){try{await socialJson('/api/notifications/read',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({all:true})});Array.prototype.forEach.call(host.querySelectorAll('.notification-row'),function(r){r.classList.remove('unread');});refreshSocialBadge();}catch(e){setTip(e.message,'error');}};
}
async function renderConversations(screen,host){
  var generation=beginSocialRender(screen);
  host.innerHTML='<div class="social-section-head"><b>メッセージ</b></div><div class="conversation-list" aria-live="polite">読み込んでいます…</div>';
  try{var j=await socialJson('/api/conversations');if(!socialRenderAlive(screen,host,generation))return;var list=host.querySelector('.conversation-list'),items=j.conversations||[];list.innerHTML=items.length?items.map(function(c){var who=c.person&&(c.person.name||c.person.handle)||'フレンド';return '<button type="button" class="conversation-row" data-conversation="'+esc(c.id)+'"><i>'+esc(who.charAt(0))+'</i><span><b>'+esc(who)+'</b><small>'+esc(c.last_body||'会話を始める')+'</small></span>'+(c.unread?'<em>'+Number(c.unread)+'</em>':'')+'</button>';}).join(''):'<div class="release-empty"><b>会話はまだありません</b><span>フレンドのプロフィールからメッセージを始められます。</span></div>';Array.prototype.forEach.call(list.querySelectorAll('[data-conversation]'),function(b){b.onclick=function(){openConversation(b.dataset.conversation,b.querySelector('b').textContent);};});}
  catch(e){if(!socialRenderAlive(screen,host,generation))return;var failed=host.querySelector('.conversation-list');if(failed)failed.innerHTML='<div class="release-empty"><b>メッセージを読めませんでした</b><span>'+esc(e.message)+'</span></div>';}
}
async function openConversation(id,label){
  var screen=makeReleaseScreen(label||'メッセージ'),body=screen.querySelector('.release-body');body.classList.add('chat-body');
  body.innerHTML='<div class="message-list" aria-live="polite">読み込んでいます…</div><form class="message-form"><textarea maxlength="2000" rows="1" placeholder="メッセージ" aria-label="メッセージ"></textarea><button type="submit">送る</button></form>';
  var list=body.querySelector('.message-list'),form=body.querySelector('.message-form'),input=form.querySelector('textarea');
  function messageRow(m){return '<div class="message-row '+(m.mine?'mine':'theirs')+'"><p>'+esc(m.body)+'</p><time>'+esc(releaseDate(m.created_at))+'</time></div>';}
  try{var j=await socialJson('/api/conversations/'+encodeURIComponent(id)+'/messages');list.innerHTML=(j.messages||[]).map(messageRow).join('');await socialJson('/api/conversations/'+encodeURIComponent(id)+'/read',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({last_message_id:j.latest_message_id||null})});refreshSocialBadge();list.scrollTop=list.scrollHeight;}
  catch(e){list.innerHTML='<div class="release-empty"><b>会話を読めませんでした</b><span>'+esc(e.message)+'</span></div>';}
  form.onsubmit=async function(e){e.preventDefault();var value=input.value.trim();if(!value)return;form.querySelector('button').disabled=true;try{var m=await socialJson('/api/conversations/'+encodeURIComponent(id)+'/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({body:value,client_operation_id:nid()})});if(list.querySelector('.release-empty'))list.innerHTML='';list.insertAdjacentHTML('beforeend',messageRow(m));var inserted=list.lastElementChild;if(inserted)inserted.classList.add('motion-message-in');input.value='';list.scrollTop=list.scrollHeight;}catch(err){setTip(err.message);}form.querySelector('button').disabled=false;};
}
async function startConversation(handle){
  try{var j=await socialJson('/api/conversations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({handle:handle})});openConversation(j.id,j.person&&(j.person.name||j.person.handle));}
  catch(e){setTip(e.message||'フレンドになるとメッセージを送れます','error');}
}
async function refreshSocialBadge(){
  var notificationBadge=document.getElementById('notification-badge');
  var messageBadge=document.getElementById('message-badge');
  if(!notificationBadge||!messageBadge)return;
  function update(badge,n,label){n=Number(n)||0;badge.hidden=!n;badge.textContent=n>99?'99+':String(n);badge.setAttribute('aria-label',label+' '+n+'件');}
  if(!fbUser){update(notificationBadge,0,'未読通知');update(messageBadge,0,'未読メッセージ');return;}
  try{var j=await socialJson('/api/unread',undefined,false);update(notificationBadge,j.notifications,'未読通知');update(messageBadge,j.messages,'未読メッセージ');}
  catch(e){update(notificationBadge,0,'未読通知');update(messageBadge,0,'未読メッセージ');}
}
function openTimelineMap(p){
  if(!p||!p.map_available)return;
  closeReleaseScreen();setMapAudience('public',true);
  map.easeTo({center:[p.lng,p.lat],zoom:16.4,duration:820});
  setTip((p.author&&p.author.name?p.author.name+'の ':'')+(p.precision==='exact'?'':'公開位置で ')+'思い出を表示しました');
}

function openMemoryHub(){var screen=makeReleaseScreen('アルバム');renderAlbumHome(screen,screen.querySelector('.release-body'));}
function openSocialHub(tab,state){
  tab=tab||'timeline';
  var label=tab==='notifications'?'通知':tab==='messages'?'メッセージ':'タイムライン';
  var screen=makeReleaseScreen(label),body=screen.querySelector('.release-body');
  if(tab==='notifications')renderNotifications(screen,body);
  else if(tab==='messages')renderConversations(screen,body);
  else renderTimeline(screen,body,state&&state.query||'',state&&state.mode||'recommended',state&&state.scrollY||0);
  refreshSocialBadge();
}

async function openProfileIconPicker(handle,current){
  var screen=makeReleaseScreen('アイコン'),body=screen.querySelector('.release-body');
  body.innerHTML='<section class="profile-icon-picker"><p>プロフィールに表示する印を選んでください。</p><div role="radiogroup" aria-label="プロフィールアイコン">'+
    PROFILE_ICONS.map(function(key){var on=key===current;return '<button type="button" data-profile-icon="'+key+'" class="'+(on?'on':'')+'" role="radio" aria-checked="'+String(on)+'" aria-label="'+esc(PROFILE_ICON_LABELS[key])+'">'+profileIconSvg(key)+'<span>'+esc(PROFILE_ICON_LABELS[key])+'</span></button>';}).join('')+'</div></section>';
  Array.prototype.forEach.call(body.querySelectorAll('[data-profile-icon]'),function(button){button.onclick=async function(){
    var key=button.dataset.profileIcon;if(key===current){setTip('このアイコンを使っています');return;}
    var previous=current,operationUid=fbUser&&fbUser.uid;button.disabled=true;
    try{await socialJson('/api/me',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile_icon:key})});
      current=key;if(meP)meP.profile_icon=key;openPublicProfile(handle);
      if(window.SpotaMotion&&typeof window.SpotaMotion.showUndo==='function')window.SpotaMotion.showUndo('アイコンを変更しました',async function(){
        try{
          if(!operationUid||!fbUser||fbUser.uid!==operationUid)throw new Error('アカウントが変わったため元に戻せません');
          await socialJson('/api/me',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile_icon:previous})});
          if(!fbUser||fbUser.uid!==operationUid)throw new Error('アカウントが変わったため表示を更新できません');
          current=previous;if(meP)meP.profile_icon=previous;setTip('元のアイコンへ戻しました','success');openPublicProfile(handle);
        }catch(error){setTip(error.message||'元に戻せませんでした','error');throw error;}
      });
      else setTip('アイコンを変更しました','success');
    }catch(e){button.disabled=false;setTip(e.message||'変更できませんでした','error');}
  };});
}

/* ---------- プロフィール ---------- */
async function openPublicProfile(handle,origin){
  if(!fbUser){setTip('プロフィールを見るにはログインしてください');return;}
  var screen=makeReleaseScreen('プロフィール',{kind:'profile'}),body=screen.querySelector('.release-body');
  body.innerHTML='<div class="profile-loading" aria-live="polite">プロフィールを読み込んでいます…</div>';
  try{
    var result=await Promise.all([socialJson('/api/posts?user='+encodeURIComponent(handle)+'&limit=100'),socialJson('/api/follows?user='+encodeURIComponent(handle)).catch(function(){return {};})]),j=result[0],follow=result[1]||{};
    var profile=j.profile||{},posts=j.posts||[],photoPosts=posts.filter(function(p){return !!p.photo_id;}),name=profile.name||profile.handle||handle,own=(meP&&meP.handle)===(profile.handle||handle);
    body.innerHTML='<section class="public-profile"><button class="profile-portrait" id="profile-avatar" type="button" aria-label="'+(own?'プロフィールアイコンを変更':'プロフィールアイコン')+'">'+profileIconSvg(profile.profile_icon)+'</button>'+
      '<div class="profile-name"><h1>'+esc(name)+'</h1><p>@'+esc(profile.handle||handle)+'</p></div>'+
      (profile.bio?'<p class="profile-bio">'+esc(profile.bio)+'</p>':'')+
      '<div class="profile-stats"><span><b>'+posts.length+'</b><small>思い出</small></span><span><b>'+Number(follow.followers||0)+'</b><small>フォロワー</small></span><span><b>'+Number(follow.following||0)+'</b><small>フォロー中</small></span></div>'+
      '<div class="profile-actions">'+
        (own?'<button class="release-main" id="profile-map" type="button">自分の地図</button><button type="button" id="profile-settings">編集</button>':'<button class="release-main'+(follow.followed?' on':'')+'" id="profile-follow" type="button" aria-pressed="'+String(!!follow.followed)+'">'+(follow.followed?'フォロー中':'フォロー')+'</button><button type="button" id="profile-message">メッセージ</button>')+
      '</div>'+(own?'<div class="profile-links"><button type="button" id="profile-timeline">タイムラインを見る</button></div>':'<div class="profile-links"><button type="button" id="profile-map">地図を見る</button><button type="button" id="profile-friend">フレンド申請</button></div>')+'</section>'+
      (photoPosts.length?'<div class="profile-grid">'+photoPosts.map(function(p,i){return '<button type="button" data-profile-photo="'+i+'" aria-label="'+esc(p.title||'思い出')+'を開く"><img alt="" loading="lazy"><span>'+esc(p.place_name||p.title||'')+'</span></button>';}).join('')+'</div>':'<div class="release-empty"><b>見られる写真はまだありません</b><span>公開範囲と位置設定により、表示されない写真もあります。</span></div>');
    body.querySelector('#profile-map').onclick=function(){
      closeReleaseScreen();
      if(own){
        setMapAudience('mine',true);setTip('自分の地図を表示しました');
      }else openFriendMap(profile.handle||handle);
    };
    var settings=body.querySelector('#profile-settings');if(settings)settings.onclick=function(){closeReleaseScreen();openMe();};
    var timeline=body.querySelector('#profile-timeline');if(timeline)timeline.onclick=function(){openSocialHub('timeline');};
    var avatar=body.querySelector('#profile-avatar');
    if(window.SpotaMotion&&origin)window.SpotaMotion.avatarTransition(origin,avatar);
    if(avatar&&own)avatar.onclick=function(){openProfileIconPicker(profile.handle||handle,profile.profile_icon||'pin');};
    var followButton=body.querySelector('#profile-follow');if(followButton)followButton.onclick=async function(){
      var previous=!!follow.followed,next=!previous;followButton.disabled=true;
      function paint(value){follow.followed=!!value;followButton.classList.toggle('on',follow.followed);followButton.textContent=follow.followed?'フォロー中':'フォロー';followButton.setAttribute('aria-pressed',String(follow.followed));}
      try{await socialJson('/api/follows/'+encodeURIComponent(profile.handle||handle),{method:next?'PUT':'DELETE'});paint(next);if(next&&window.SpotaMotion)window.SpotaMotion.restartClass(followButton,'profile-follow-confirm',620);}
      catch(e){paint(previous);setTip(e.message,'error');}followButton.disabled=false;
    };
    var message=body.querySelector('#profile-message');if(message)message.onclick=function(){startConversation(profile.handle||handle);};
    var friend=body.querySelector('#profile-friend');if(friend)friend.onclick=async function(){friend.disabled=true;await addByHandle(profile.handle||handle);friend.textContent='申請しました';};
    Array.prototype.forEach.call(body.querySelectorAll('[data-profile-photo]'),function(b){
      var p=photoPosts[Number(b.dataset.profilePhoto)],img=b.querySelector('img');putRemotePhoto(img,p.photo_id,screen,'thumb');
      b.onclick=function(){if(img.src)openViewer([img.src],0,name,p.place_name||p.title,p.tag||'',releaseDate(p.taken_at),releaseTags(p.tag),[p.photo_id]);};
    });
  }catch(e){setTip(e.message||'プロフィールを読み込めませんでした','error');body.innerHTML='<div class="release-empty"><b>プロフィールを読み込めませんでした</b><span>'+esc(e.message||'通信を確認してください')+'</span></div>';}
}

/* ---------- 既存の5操作へ接続 ---------- */
(function(){
  var scope=document.getElementById('btn-map-scope');
  if(scope)scope.onclick=function(){
    var next=mapAudience==='mine'?'public':'mine';
    if(next==='public'&&!fbUser){setTip('みんなの地図を見るにはログインしてください');document.getElementById('btn-me').click();return;}
    setMapAudience(next);
  };
  refreshMapAudienceUI();
  var notifications=document.getElementById('btn-notifications');if(notifications)notifications.onclick=function(){openSocialHub('notifications');};
  var messages=document.getElementById('btn-messages');if(messages)messages.onclick=function(){openSocialHub('messages');};
  var timelineButton=document.getElementById('btn-timeline');if(timelineButton)timelineButton.onclick=function(){openSocialHub('timeline');};
  var bulk=document.getElementById('btn-bulk');if(bulk)bulk.onclick=function(){openMemoryHub();};
  var library=document.getElementById('btn-lib');if(library)library.onclick=function(){
    chooseSinglePhoto(false);
  };
  var me=document.getElementById('btn-me');if(me){
    var prior=me.onclick;
    me.onclick=async function(){
      if(!fbUser){if(prior)return prior.call(me);openMe();return;}
      if(meP&&meP.handle)openPublicProfile(meP.handle);else openMe();
    };
  }
  setTimeout(refreshSocialBadge,1800);
})();
