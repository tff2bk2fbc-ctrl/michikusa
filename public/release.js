/* ============================================================
   リリース前大型更新

   ・みんなの地図 / 自分の地図
   ・思い出アルバム
   ・公開タイムラインとタグ検索
   ・公開プロフィール / 通知 / チャット / ソーシャル操作

   既存の投稿・公開範囲・位置精度を唯一のデータ源にする。
   ============================================================ */

var releaseScreen=null;
var sharedPhotoQueue=[],sharedPhotoBusy=0,sharedPhotoCache={},sharedPhotoOrder=[],sharedPhotoRecords={};

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

function closeReleaseScreen(){
  if(!releaseScreen)return;
  var screen=releaseScreen;releaseScreen=null;
  var dispose=screen.__onClose;screen.__onClose=null;if(dispose)dispose();
  (screen.__urls||[]).forEach(function(u){URL.revokeObjectURL(u);});
  (screen.__inert||[]).forEach(function(node){node.inert=false;});
  if(screen.classList.contains('profile-screen')){
    var closingPanel=screen.querySelector('.profile-panel');if(closingPanel)closingPanel.style.transition='transform .32s cubic-bezier(.2,.72,.2,1)';
    screen.style.setProperty('--dismiss-y','100vh');screen.style.setProperty('--profile-scrim','0');
    screen.classList.add('dismissing');
  }else screen.classList.remove('on');
  var focus=screen.__previousFocus;
  setTimeout(function(){screen.remove();if(focus&&focus.isConnected)focus.focus();},320);
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
  screen.__urls=[];screen.__previousFocus=document.activeElement;screen.__inert=[];
  Array.prototype.forEach.call(document.body.children,function(node){
    if(node!==screen&&node.id!=='err'&&!node.inert){node.inert=true;screen.__inert.push(node);}
  });
  document.body.appendChild(screen);releaseScreen=screen;
  screen.querySelector('.release-back').onclick=closeReleaseScreen;
  screen.onkeydown=function(e){
    if(e.key==='Escape'){e.preventDefault();closeReleaseScreen();}
  };
  void screen.offsetWidth;screen.classList.add('on');screen.querySelector('.release-back').focus();
  if(profile)bindProfileDismiss(screen);
  return screen;
}

async function putRemotePhoto(img,photoId,screen,kind){
  if(!img||!photoId||!screen||!screen.isConnected)return;
  try{
    var r=await api('/api/photo/'+encodeURIComponent(photoId)+'/'+(kind||'thumb'));
    if(!r.ok)throw new Error('photo '+r.status);
    var u=URL.createObjectURL(await r.blob());
    if(!screen.isConnected){URL.revokeObjectURL(u);return;}
    screen.__urls.push(u);img.src=u;img.classList.add('loaded');
  }catch(e){img.closest('[data-photo]')&&img.closest('[data-photo]').classList.add('photo-failed');}
}

/* 地図用の共有写真。最大24枚だけを保持し、古いURLは解放する。 */
function queueSharedPhoto(rec,auth){
  if(!rec||!rec.server_photo_id||rec.photo)return;
  var id=rec.server_photo_id;
  if(sharedPhotoCache[id]){
    rec.photo=sharedPhotoCache[id];
    (sharedPhotoRecords[id]||(sharedPhotoRecords[id]=[])).push(rec);
    return;
  }
  if(rec.photo_loading)return;
  rec.photo_loading=1;sharedPhotoQueue.push({rec:rec,auth:auth,id:id});runSharedPhotoQueue();
}
function runSharedPhotoQueue(){
  while(sharedPhotoBusy<2&&sharedPhotoQueue.length){
    var job=sharedPhotoQueue.shift();sharedPhotoBusy++;
    (async function(item){
      try{
        var r=await apiAs(item.auth,'/api/photo/'+encodeURIComponent(item.id)+'/thumb');
        if(!r.ok)throw new Error('photo '+r.status);
        var u=URL.createObjectURL(await r.blob());
        if(!authIsCurrent(item.auth)){URL.revokeObjectURL(u);return;}
        sharedPhotoCache[item.id]=u;sharedPhotoOrder.push(item.id);item.rec.photo=u;
        (sharedPhotoRecords[item.id]||(sharedPhotoRecords[item.id]=[])).push(item.rec);
        while(sharedPhotoOrder.length>24){
          var old=sharedPhotoOrder.shift(),oldUrl=sharedPhotoCache[old];
          (sharedPhotoRecords[old]||[]).forEach(function(rec){if(rec.photo===oldUrl)delete rec.photo;});
          delete sharedPhotoRecords[old];delete sharedPhotoCache[old];if(oldUrl)URL.revokeObjectURL(oldUrl);
        }
        if(typeof render==='function')render(true);
      }catch(e){}finally{delete item.rec.photo_loading;sharedPhotoBusy--;runSharedPhotoQueue();}
    })(job);
  }
}
window.queueSharedPhoto=queueSharedPhoto;

/* ---------- アルバム ---------- */
function albumMonthLabel(key){
  var m=/^(\d{4})-(\d{2})/.exec(key||'');
  return m?Number(m[1])+'年'+Number(m[2])+'月':'日付のない思い出';
}
function renderAlbumHome(screen,host){
  var withPhoto=spots.filter(function(p){return p.photo_thumb||p.photo;})
    .slice().sort(function(a,b){return String(b.d||'').localeCompare(String(a.d||''));});
  var groups={};withPhoto.forEach(function(p){var key=String(p.d||'').slice(0,7)||'none';(groups[key]||(groups[key]=[])).push(p);});
  var keys=Object.keys(groups).sort().reverse();
  host.innerHTML='<section class="memory-intro"><p class="release-kicker">自分の地図</p>'+
    '<h1>思い出を、場所と時間で。</h1><p>写真は自分の地図に必ず残り、公開を選んだものだけがみんなの地図にも現れます。</p>'+
    '<button class="release-main" id="album-import" type="button">写真からアルバムを作る</button></section>'+
    (keys.length?keys.map(function(key){
      return '<section class="album-section"><div class="album-heading"><h2>'+albumMonthLabel(key)+'</h2><span>'+groups[key].length+'枚</span></div>'+
        '<div class="album-grid">'+groups[key].map(function(p,i){
          return '<button type="button" data-album="'+esc(key)+'" data-index="'+i+'" aria-label="'+esc(p.n||'思い出')+'を開く">'+
            '<img src="'+esc(p.photo_thumb||p.photo)+'" alt="" loading="lazy"><span>'+esc(p.n||'')+'</span></button>';
        }).join('')+'</div></section>';
    }).join(''):'<div class="release-empty"><b>まだ写真がありません</b><span>写真を選ぶと、撮影場所と日付から最初のアルバムを作れます。</span></div>');
  host.querySelector('#album-import').onclick=function(){closeReleaseScreen();chooseAlbumPhotos();};
  Array.prototype.forEach.call(host.querySelectorAll('[data-album]'),function(button){
    button.onclick=function(){
      var list=groups[button.dataset.album]||[],idx=Number(button.dataset.index)||0,p=list[idx]||{};
      openViewer(list.map(function(x){return x.photo||x.photo_thumb;}),idx,'じぶん',p.place||p.n,p.tag||'',p.d||'',[],list.map(function(x){return x.server_photo_id||null;}));
    };
  });
}

/* ---------- タイムライン / 通知 / チャット ---------- */
async function socialJson(path,options){
  var r=await api(path,options),j=await r.json().catch(function(){return {};});
  if(!r.ok)throw new Error(j.error||'読み込めませんでした');return j;
}
function beginSocialRender(screen){screen.__socialGeneration=(screen.__socialGeneration||0)+1;return screen.__socialGeneration;}
function socialRenderAlive(screen,host,generation){return releaseScreen===screen&&screen.isConnected&&host.isConnected&&screen.__socialGeneration===generation;}
function feedCard(p,i){
  var who=p.author&&(p.author.name||p.author.handle)||'Spotaユーザー';
  return '<article class="timeline-card" data-post="'+esc(p.id)+'">'+
    '<header><button class="timeline-person" type="button" data-profile="'+esc(p.author&&p.author.handle||'')+'"><i>'+esc(who.charAt(0))+'</i><span><b>'+esc(who)+'</b><small>@'+esc(p.author&&p.author.handle||'')+'</small></span></button>'+
      (!p.mine?'<button class="timeline-follow'+(p.following?' on':'')+'" type="button" data-follow="'+i+'" aria-pressed="'+String(!!p.following)+'">'+(p.following?'フォロー中':'フォロー')+'</button>':'')+
      '<time>'+esc(releaseDate(p.taken_at||p.created_at))+'</time></header>'+
    '<button class="timeline-photo" type="button" data-photo="'+esc(p.photo_id||'')+'" data-index="'+i+'" aria-label="写真を開く"><img alt="" loading="lazy"></button>'+
    '<div class="timeline-copy"><div class="timeline-place"><b>'+esc(p.title||p.place_name||'思い出')+'</b>'+
      (p.map_available?'<button type="button" data-map="'+i+'">地図で見る</button>':'')+'</div>'+
      (p.tag?'<p>'+esc(p.tag)+'</p>':'')+
      '<div class="timeline-actions"><button type="button" data-like="'+i+'" aria-pressed="'+String(!!p.liked)+'" class="'+(p.liked?'on':'')+'"><span aria-hidden="true">♡</span><b>'+Number(p.like_count||0)+'</b><em class="sr-only">いいね</em></button>'+
      '<button type="button" data-comments="'+i+'"><span aria-hidden="true">○</span><b>'+Number(p.comment_count||0)+'</b><em class="sr-only">コメント</em></button>'+
      '<button type="button" data-share="'+i+'"><span aria-hidden="true">↗</span><em class="sr-only">共有</em></button></div></div></article>';
}
function bindFeedCards(screen,host,posts){
  Array.prototype.forEach.call(host.querySelectorAll('[data-profile]'),function(b){if(b.__releaseBound)return;b.__releaseBound=1;b.onclick=function(){if(b.dataset.profile)openPublicProfile(b.dataset.profile);};});
  Array.prototype.forEach.call(host.querySelectorAll('[data-map]'),function(b){if(b.__releaseBound)return;b.__releaseBound=1;b.onclick=function(){openTimelineMap(posts[Number(b.dataset.map)]);};});
  Array.prototype.forEach.call(host.querySelectorAll('.timeline-photo'),function(b){
    if(b.__releaseBound)return;b.__releaseBound=1;
    var p=posts[Number(b.dataset.index)],img=b.querySelector('img');putRemotePhoto(img,p.photo_id,screen,'thumb');
    b.onclick=function(){if(img.src)openViewer([img.src],0,p.author&&(p.author.name||p.author.handle),p.place_name||p.title,p.tag||'',releaseDate(p.taken_at),releaseTags(p.tag),[p.photo_id]);};
  });
  Array.prototype.forEach.call(host.querySelectorAll('[data-like]'),function(b){if(b.__releaseBound)return;b.__releaseBound=1;b.onclick=async function(){
    var p=posts[Number(b.dataset.like)],next=!p.liked;b.disabled=true;
    try{var j=await socialJson('/api/posts/'+encodeURIComponent(p.id)+'/like',{method:next?'PUT':'DELETE'});p.liked=j.liked;p.like_count=j.count;
      b.classList.toggle('on',p.liked);b.setAttribute('aria-pressed',String(p.liked));b.querySelector('b').textContent=p.like_count;
    }catch(e){setTip(e.message);}b.disabled=false;
  };});
  Array.prototype.forEach.call(host.querySelectorAll('[data-comments]'),function(b){if(b.__releaseBound)return;b.__releaseBound=1;b.onclick=function(){openComments(posts[Number(b.dataset.comments)]);};});
  Array.prototype.forEach.call(host.querySelectorAll('[data-follow]'),function(b){if(b.__releaseBound)return;b.__releaseBound=1;b.onclick=async function(){
    var p=posts[Number(b.dataset.follow)],next=!p.following,handle=p.author&&p.author.handle;if(!handle)return;b.disabled=true;
    try{await socialJson('/api/follows/'+encodeURIComponent(handle),{method:next?'PUT':'DELETE'});p.following=next;b.classList.toggle('on',next);b.textContent=next?'フォロー中':'フォロー';b.setAttribute('aria-pressed',String(next));}
    catch(e){setTip(e.message);}b.disabled=false;
  };});
  Array.prototype.forEach.call(host.querySelectorAll('[data-share]'),function(b){if(b.__releaseBound)return;b.__releaseBound=1;b.onclick=function(){sharePost(posts[Number(b.dataset.share)]);};});
}
async function sharePost(post){
  try{
    var j=await socialJson('/api/shares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({target_type:'post',target_id:post.id,expires_in_days:7})});
    var url=location.origin+j.path,title=post.title||post.place_name||'Spotaの思い出';
    if(navigator.share)await navigator.share({title:title,url:url});
    else if(navigator.clipboard){await navigator.clipboard.writeText(url);setTip('共有リンクをコピーしました');}
  }catch(e){setTip(e.message||'共有できませんでした');}
}
async function renderTimeline(screen,host,query,mode){
  var generation=beginSocialRender(screen);
  mode=mode||'recommended';
  host.innerHTML='<div class="feed-modes" role="tablist" aria-label="タイムラインの種類">'+
      '<button type="button" data-feed-mode="recommended" class="'+(mode==='recommended'?'on':'')+'" role="tab" aria-selected="'+String(mode==='recommended')+'">おすすめ</button>'+
      '<button type="button" data-feed-mode="following" class="'+(mode==='following'?'on':'')+'" role="tab" aria-selected="'+String(mode==='following')+'">フォロー中</button></div>'+
    '<form class="timeline-search" id="timeline-search"><span aria-hidden="true">⌕</span>'+
      '<input id="timeline-q" value="'+esc(query||'')+'" placeholder="場所・ことば・#タグ" enterkeyhint="search" autocomplete="off">'+
      '<button type="submit">探す</button></form><div class="timeline-status" aria-live="polite">写真を読み込んでいます…</div>';
  Array.prototype.forEach.call(host.querySelectorAll('[data-feed-mode]'),function(b){b.onclick=function(){renderTimeline(screen,host,query,b.dataset.feedMode);};});
  host.querySelector('#timeline-search').onsubmit=function(e){e.preventDefault();renderTimeline(screen,host,host.querySelector('#timeline-q').value.trim(),mode);};
  if(!fbUser){host.querySelector('.timeline-status').innerHTML='<b>ログインするとタイムラインを見られます</b><span>公開された写真と、フレンドの写真が表示されます。</span><button class="release-main" id="timeline-login" type="button">ログインする</button>';host.querySelector('#timeline-login').onclick=function(){closeReleaseScreen();document.getElementById('btn-me').click();};return;}
  try{
    var paths=['/api/feed?limit=24'+(mode==='following'?'&mode=following':'')+(query?'&q='+encodeURIComponent(query):''),'/api/hashtags/trending'];
    var result=await Promise.all([socialJson(paths[0]),socialJson(paths[1]).catch(function(){return {tags:[]};})]);if(!socialRenderAlive(screen,host,generation))return;var j=result[0],tags=result[1].tags||[],posts=j.posts||[],status=host.querySelector('.timeline-status');
    if(!posts.length){status.innerHTML='<b>'+(mode==='following'?'フォロー中の投稿はまだありません':'写真が見つかりませんでした')+'</b><span>'+(query?'ことばを変えて、もう一度探してみてください。':'気になる人をフォローすると、ここに写真が並びます。')+'</span>';return;}
    status.outerHTML=(tags.length?'<div class="trend-row" aria-label="よく使われているタグ">'+tags.map(function(t){return '<button type="button" data-tag="'+esc(t.label)+'">'+esc(t.label)+'</button>';}).join('')+'</div>':'')+
      '<div class="timeline-list">'+posts.map(feedCard).join('')+'</div>'+(j.has_more?'<button type="button" class="feed-more" id="feed-more">さらに見る</button>':'');
    Array.prototype.forEach.call(host.querySelectorAll('[data-tag]'),function(b){b.onclick=function(){renderTimeline(screen,host,b.dataset.tag,mode);};});
    bindFeedCards(screen,host,posts);
    var more=host.querySelector('#feed-more');if(more)more.onclick=async function(){
      more.disabled=true;try{var next=await socialJson('/api/feed?limit=24&cursor='+encodeURIComponent(j.cursor)+(mode==='following'?'&mode=following':'')+(query?'&q='+encodeURIComponent(query):''));if(!socialRenderAlive(screen,host,generation))return;var offset=posts.length;
        posts=posts.concat(next.posts||[]);var list=host.querySelector('.timeline-list');list.insertAdjacentHTML('beforeend',(next.posts||[]).map(function(p,i){return feedCard(p,offset+i);}).join(''));bindFeedCards(screen,list,posts);j=next;if(!next.has_more)more.remove();else more.disabled=false;
      }catch(e){more.disabled=false;setTip(e.message);}
    };
  }catch(e){if(!socialRenderAlive(screen,host,generation))return;var st=host.querySelector('.timeline-status');if(st)st.innerHTML='<b>読み込めませんでした</b><span>'+esc(e.message||'通信を確認してください')+'</span>';}
}

async function openComments(post){
  var screen=makeReleaseScreen('コメント'),body=screen.querySelector('.release-body');
  body.innerHTML='<div class="comment-list" aria-live="polite">読み込んでいます…</div><form class="comment-form"><input maxlength="1000" placeholder="コメントを書く" aria-label="コメント"><button type="submit">送る</button></form>';
  var list=body.querySelector('.comment-list'),form=body.querySelector('.comment-form'),input=form.querySelector('input');
  function row(c){var who=c.author&&(c.author.name||c.author.handle)||'ユーザー';return '<div class="comment-row" data-comment="'+esc(c.id)+'"><i>'+esc(who.charAt(0))+'</i><div><b>'+esc(who)+'</b><p>'+esc(c.body)+'</p><time>'+esc(releaseDate(c.created_at))+'</time></div>'+(c.mine?'<button type="button" aria-label="コメントを削除">×</button>':'')+'</div>';}
  function bindDelete(){Array.prototype.forEach.call(list.querySelectorAll('.comment-row>button'),function(b){b.onclick=async function(){var r=b.closest('[data-comment]');try{await socialJson('/api/posts/'+encodeURIComponent(post.id)+'/comments/'+encodeURIComponent(r.dataset.comment),{method:'DELETE'});r.remove();}catch(e){setTip(e.message);}};});}
  try{var j=await socialJson('/api/posts/'+encodeURIComponent(post.id)+'/comments');list.innerHTML=(j.comments||[]).length?(j.comments||[]).map(row).join(''):'<div class="release-empty"><b>最初のコメントをどうぞ</b></div>';bindDelete();}
  catch(e){list.innerHTML='<div class="release-empty"><b>コメントを読めませんでした</b><span>'+esc(e.message)+'</span></div>';}
  form.onsubmit=async function(e){e.preventDefault();var value=input.value.trim();if(!value)return;form.querySelector('button').disabled=true;try{var c=await socialJson('/api/posts/'+encodeURIComponent(post.id)+'/comments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({body:value,client_operation_id:nid()})});if(list.querySelector('.release-empty'))list.innerHTML='';list.insertAdjacentHTML('beforeend',row(c));input.value='';bindDelete();}catch(err){setTip(err.message);}form.querySelector('button').disabled=false;};
}

function notificationCopy(n){return {like:'あなたの思い出にいいねしました',comment:'コメントしました',follow:'あなたをフォローしました',post:'新しい思い出を公開しました',message:'メッセージが届きました'}[n.kind]||'お知らせがあります';}
async function renderNotifications(screen,host){
  var generation=beginSocialRender(screen);
  host.innerHTML='<div class="social-section-head"><b>通知</b><button id="notifications-read">すべて既読</button></div><div class="notification-list" aria-live="polite">読み込んでいます…</div>';
  try{var j=await socialJson('/api/notifications');if(!socialRenderAlive(screen,host,generation))return;var list=host.querySelector('.notification-list'),items=j.notifications||[];list.innerHTML=items.length?items.map(function(n){var who=n.actor&&(n.actor.name||n.actor.handle)||'Spota';return '<button type="button" class="notification-row'+(n.read?'':' unread')+'" data-notification="'+esc(n.id)+'" data-kind="'+esc(n.kind)+'" data-entity="'+esc(n.entityId||n.entity_id||'')+'" data-handle="'+esc(n.actor&&n.actor.handle||'')+'"><i>'+esc(who.charAt(0))+'</i><span><b>'+esc(who)+'</b><small>'+esc(notificationCopy(n))+'</small></span><time>'+esc(releaseDate(n.created_at))+'</time></button>';}).join(''):'<div class="release-empty"><b>通知はまだありません</b><span>反応やメッセージがここに届きます。</span></div>';
    Array.prototype.forEach.call(list.querySelectorAll('.notification-row'),function(b){b.onclick=async function(){try{await socialJson('/api/notifications/read',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[b.dataset.notification]})});}catch(e){}if(b.dataset.kind==='message'&&b.dataset.entity)openConversation(b.dataset.entity,b.querySelector('b').textContent);else if(b.dataset.handle)openPublicProfile(b.dataset.handle);refreshSocialBadge();};});
  }catch(e){if(!socialRenderAlive(screen,host,generation))return;var failed=host.querySelector('.notification-list');if(failed)failed.innerHTML='<div class="release-empty"><b>通知を読めませんでした</b><span>'+esc(e.message)+'</span></div>';}
  host.querySelector('#notifications-read').onclick=async function(){try{await socialJson('/api/notifications/read',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({all:true})});Array.prototype.forEach.call(host.querySelectorAll('.notification-row'),function(r){r.classList.remove('unread');});refreshSocialBadge();}catch(e){setTip(e.message);}};
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
  form.onsubmit=async function(e){e.preventDefault();var value=input.value.trim();if(!value)return;form.querySelector('button').disabled=true;try{var m=await socialJson('/api/conversations/'+encodeURIComponent(id)+'/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({body:value,client_operation_id:nid()})});if(list.querySelector('.release-empty'))list.innerHTML='';list.insertAdjacentHTML('beforeend',messageRow(m));input.value='';list.scrollTop=list.scrollHeight;}catch(err){setTip(err.message);}form.querySelector('button').disabled=false;};
}
async function startConversation(handle){
  try{var j=await socialJson('/api/conversations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({handle:handle})});openConversation(j.id,j.person&&(j.person.name||j.person.handle));}
  catch(e){setTip(e.message||'フレンドになるとメッセージを送れます');}
}
async function refreshSocialBadge(){
  var badge=document.getElementById('social-badge');if(!badge)return;if(!fbUser){badge.hidden=true;return;}
  try{var j=await socialJson('/api/unread'),n=Number(j.notifications||0)+Number(j.messages||0);badge.hidden=!n;badge.textContent=n>99?'99+':String(n);badge.setAttribute('aria-label','未読 '+n+'件');}catch(e){badge.hidden=true;}
}
function openTimelineMap(p){
  if(!p||!p.map_available)return;
  closeReleaseScreen();setMapAudience('public',true);
  map.easeTo({center:[p.lng,p.lat],zoom:16.4,duration:820});
  setTip((p.author&&p.author.name?p.author.name+'の ':'')+(p.precision==='exact'?'':'公開位置で ')+'思い出を表示しました');
}

function openMemoryHub(){var screen=makeReleaseScreen('アルバム');renderAlbumHome(screen,screen.querySelector('.release-body'));}
function openSocialHub(tab){
  var screen=makeReleaseScreen('新着'),body=screen.querySelector('.release-body');
  body.innerHTML='<div class="release-tabs release-tabs-three" role="tablist" aria-label="新着の表示"><button type="button" data-social-tab="timeline" role="tab">タイムライン</button><button type="button" data-social-tab="notifications" role="tab">通知</button><button type="button" data-social-tab="messages" role="tab">メッセージ</button></div><div id="release-content"></div>';
  var content=body.querySelector('#release-content');function show(name){Array.prototype.forEach.call(body.querySelectorAll('[data-social-tab]'),function(b){var on=b.dataset.socialTab===name;b.classList.toggle('on',on);b.setAttribute('aria-selected',String(on));});if(name==='notifications')renderNotifications(screen,content);else if(name==='messages')renderConversations(screen,content);else renderTimeline(screen,content,'','recommended');}
  Array.prototype.forEach.call(body.querySelectorAll('[data-social-tab]'),function(b){b.onclick=function(){show(b.dataset.socialTab);};});show(tab||'timeline');refreshSocialBadge();
}

/* ---------- プロフィール ---------- */
async function openPublicProfile(handle){
  if(!fbUser){setTip('プロフィールを見るにはログインしてください');return;}
  var screen=makeReleaseScreen('プロフィール',{kind:'profile'}),body=screen.querySelector('.release-body');
  body.innerHTML='<div class="profile-loading" aria-live="polite">プロフィールを読み込んでいます…</div>';
  try{
    var result=await Promise.all([socialJson('/api/posts?user='+encodeURIComponent(handle)+'&limit=100'),socialJson('/api/follows?user='+encodeURIComponent(handle)).catch(function(){return {};})]),j=result[0],follow=result[1]||{};
    var profile=j.profile||{},posts=j.posts||[],photoPosts=posts.filter(function(p){return !!p.photo_id;}),name=profile.name||profile.handle||handle,own=(meP&&meP.handle)===(profile.handle||handle);
    body.innerHTML='<section class="public-profile"><button class="profile-portrait" id="profile-avatar" type="button" aria-label="'+(own?'プロフィールを編集':'プロフィール画像')+'">'+esc(name.charAt(0))+'</button>'+
      '<div class="profile-name"><h1>'+esc(name)+'</h1><p>@'+esc(profile.handle||handle)+'</p></div>'+
      (profile.bio?'<p class="profile-bio">'+esc(profile.bio)+'</p>':'')+
      '<div class="profile-stats"><span><b>'+posts.length+'</b><small>思い出</small></span><span><b>'+Number(follow.followers||0)+'</b><small>フォロワー</small></span><span><b>'+Number(follow.following||0)+'</b><small>フォロー中</small></span></div>'+
      '<div class="profile-actions">'+
        (own?'<button class="release-main" id="profile-map" type="button">自分の地図</button><button type="button" id="profile-settings">編集</button>':'<button class="release-main'+(follow.followed?' on':'')+'" id="profile-follow" type="button" aria-pressed="'+String(!!follow.followed)+'">'+(follow.followed?'フォロー中':'フォロー')+'</button><button type="button" id="profile-message">メッセージ</button>')+
      '</div>'+(own?'':'<div class="profile-links"><button type="button" id="profile-map">地図を見る</button><button type="button" id="profile-friend">フレンド申請</button></div>')+'</section>'+
      (photoPosts.length?'<div class="profile-grid">'+photoPosts.map(function(p,i){return '<button type="button" data-profile-photo="'+i+'" aria-label="'+esc(p.title||'思い出')+'を開く"><img alt="" loading="lazy"><span>'+esc(p.place_name||p.title||'')+'</span></button>';}).join('')+'</div>':'<div class="release-empty"><b>見られる写真はまだありません</b><span>公開範囲と位置設定により、表示されない写真もあります。</span></div>');
    body.querySelector('#profile-map').onclick=function(){
      closeReleaseScreen();
      if(own){
        setMapAudience('mine',true);setTip('自分の地図を表示しました');
      }else openFriendMap(profile.handle||handle);
    };
    var settings=body.querySelector('#profile-settings');if(settings)settings.onclick=function(){closeReleaseScreen();openMe();};
    var avatar=body.querySelector('#profile-avatar');if(avatar&&own)avatar.onclick=function(){closeReleaseScreen();openMe();};
    var followButton=body.querySelector('#profile-follow');if(followButton)followButton.onclick=async function(){var next=!follow.followed;followButton.disabled=true;try{await socialJson('/api/follows/'+encodeURIComponent(profile.handle||handle),{method:next?'PUT':'DELETE'});follow.followed=next;followButton.classList.toggle('on',next);followButton.textContent=next?'フォロー中':'フォロー';followButton.setAttribute('aria-pressed',String(next));}catch(e){setTip(e.message);}followButton.disabled=false;};
    var message=body.querySelector('#profile-message');if(message)message.onclick=function(){startConversation(profile.handle||handle);};
    var friend=body.querySelector('#profile-friend');if(friend)friend.onclick=async function(){friend.disabled=true;await addByHandle(profile.handle||handle);friend.textContent='申請しました';};
    Array.prototype.forEach.call(body.querySelectorAll('[data-profile-photo]'),function(b){
      var p=photoPosts[Number(b.dataset.profilePhoto)],img=b.querySelector('img');putRemotePhoto(img,p.photo_id,screen,'thumb');
      b.onclick=function(){if(img.src)openViewer([img.src],0,name,p.place_name||p.title,p.tag||'',releaseDate(p.taken_at),releaseTags(p.tag),[p.photo_id]);};
    });
  }catch(e){body.innerHTML='<div class="release-empty"><b>プロフィールを読み込めませんでした</b><span>'+esc(e.message||'通信を確認してください')+'</span></div>';}
}

/* ---------- 既存の5操作へ接続 ---------- */
(function(){
  var scope=document.getElementById('map-scope');
  if(scope){
    Array.prototype.forEach.call(scope.querySelectorAll('button'),function(b){
      b.onclick=function(){
        if(b.dataset.scope==='public'&&!fbUser){setTip('みんなの地図を見るにはログインしてください');document.getElementById('btn-me').click();return;}
        setMapAudience(b.dataset.scope);
      };
    });
    scope.onkeydown=function(e){
      if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;
      e.preventDefault();var next=mapAudience==='mine'?'public':'mine';scope.querySelector('[data-scope="'+next+'"]').focus();scope.querySelector('[data-scope="'+next+'"]').click();
    };
    refreshMapAudienceUI();
  }
  var social=document.getElementById('btn-social');if(social)social.onclick=function(){openSocialHub('timeline');};
  var bulk=document.getElementById('btn-bulk');if(bulk)bulk.onclick=function(){openMemoryHub();};
  var library=document.getElementById('btn-lib');if(library)library.onclick=function(){
    if(typeof chooseMemoryDeckPhotos==='function')chooseMemoryDeckPhotos();else chooseAlbumPhotos();
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
