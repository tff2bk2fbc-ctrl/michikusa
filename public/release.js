/* ============================================================
   リリース前大型更新

   ・みんなの地図 / 自分の地図
   ・思い出アルバム
   ・公開タイムラインとタグ検索
   ・公開プロフィール

   既存の投稿・公開範囲・位置精度を唯一のデータ源にする。
   まだ保存先のない「いいね」「コメント」「チャット」は表示しない。
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
  (screen.__urls||[]).forEach(function(u){URL.revokeObjectURL(u);});
  (screen.__inert||[]).forEach(function(node){node.inert=false;});
  screen.classList.remove('on');
  var focus=screen.__previousFocus;
  setTimeout(function(){screen.remove();if(focus&&focus.isConnected)focus.focus();},280);
}
function makeReleaseScreen(label){
  closeReleaseScreen();
  var screen=el('<section class="release-screen" role="dialog" aria-modal="true" aria-label="'+esc(label)+'">'+
    '<header class="release-bar"><button class="release-back" type="button" aria-label="地図へ戻る">'+
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M15 5l-7 7 7 7"/></svg></button>'+
      '<div class="release-bar-title">'+esc(label)+'</div><span class="release-bar-space"></span></header>'+
    '<main class="release-body"></main></section>');
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

/* ---------- タイムライン ---------- */
async function renderTimeline(screen,host,query){
  host.innerHTML='<form class="timeline-search" id="timeline-search">'+
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>'+
      '<input id="timeline-q" value="'+esc(query||'')+'" placeholder="場所・ことば・#タグ" enterkeyhint="search" autocomplete="off">'+
      '<button type="submit">探す</button></form>'+
    '<div class="timeline-status" aria-live="polite">写真を読み込んでいます…</div>';
  host.querySelector('#timeline-search').onsubmit=function(e){e.preventDefault();renderTimeline(screen,host,host.querySelector('#timeline-q').value.trim());};
  if(!fbUser){
    host.querySelector('.timeline-status').innerHTML='<b>ログインするとタイムラインを見られます</b><span>公開された写真と、フレンドの写真が表示されます。</span>'+
      '<button class="release-main" id="timeline-login" type="button">ログインする</button>';
    host.querySelector('#timeline-login').onclick=function(){closeReleaseScreen();document.getElementById('btn-me').click();};
    return;
  }
  try{
    var r=await api('/api/feed?limit=24'+(query?'&q='+encodeURIComponent(query):''));
    var j=await r.json();if(!r.ok)throw new Error(j.error||'読み込めませんでした');
    var posts=j.posts||[],status=host.querySelector('.timeline-status');
    if(!posts.length){status.innerHTML='<b>写真が見つかりませんでした</b><span>ことばを変えて、もう一度探してみてください。</span>';return;}
    var tags=[];posts.forEach(function(p){releaseTags(p.tag).forEach(function(t){if(tags.indexOf(t)<0)tags.push(t);});});
    var day=Math.floor(Date.now()/86400000),daily=posts[day%posts.length];
    status.outerHTML='<section class="daily-view" data-daily="'+esc(daily.id)+'">'+
      '<button class="daily-photo" type="button" aria-label="きょうの景色を開く"><img alt=""></button><div><p class="release-kicker">今日</p><b>きょうの景色</b><span>'+esc(daily.place_name||daily.title||'誰かの思い出')+'</span></div>'+
      (daily.map_available?'<button type="button">地図で見る</button>':'')+'</section>'+
      (tags.length?'<div class="trend-row" aria-label="よく使われているタグ">'+tags.slice(0,6).map(function(t){return '<button type="button" data-tag="'+esc(t)+'">'+esc(t)+'</button>';}).join('')+'</div>':'')+
      '<div class="timeline-list">'+posts.map(function(p,i){
        var who=p.author&&(p.author.name||p.author.handle)||'Spotaユーザー';
        return '<article class="timeline-card" data-post="'+esc(p.id)+'">'+
          '<header><button class="timeline-person" type="button" data-profile="'+esc(p.author&&p.author.handle||'')+'"><i>'+esc(who.charAt(0))+'</i><span><b>'+esc(who)+'</b><small>@'+esc(p.author&&p.author.handle||'')+'</small></span></button>'+
          '<time>'+esc(releaseDate(p.taken_at||p.created_at))+'</time></header>'+
          '<button class="timeline-photo" type="button" data-photo="'+esc(p.photo_id||'')+'" data-index="'+i+'" aria-label="写真を開く"><img alt="" loading="lazy"></button>'+
          '<div class="timeline-copy"><div class="timeline-place"><b>'+esc(p.title||p.place_name||'思い出')+'</b>'+
            (p.map_available?'<button type="button" data-map="'+i+'">地図で見る</button>':'')+'</div>'+
            (p.tag?'<p>'+esc(p.tag)+'</p>':'')+'</div></article>';
      }).join('')+'</div>';
    var dailyBox=host.querySelector('[data-daily]'),dailyImg=dailyBox.querySelector('.daily-photo img');
    putRemotePhoto(dailyImg,daily.photo_id,screen,'thumb');
    dailyBox.querySelector('.daily-photo').onclick=function(){if(dailyImg.src)openViewer([dailyImg.src],0,daily.author&&(daily.author.name||daily.author.handle),daily.place_name||daily.title,daily.tag||'',releaseDate(daily.taken_at),releaseTags(daily.tag),[daily.photo_id]);};
    var dailyButtons=dailyBox.querySelectorAll('button');
    if(daily.map_available&&dailyButtons[1])dailyButtons[1].onclick=function(){openTimelineMap(daily);};
    Array.prototype.forEach.call(host.querySelectorAll('[data-tag]'),function(b){b.onclick=function(){renderTimeline(screen,host,b.dataset.tag);};});
    Array.prototype.forEach.call(host.querySelectorAll('[data-profile]'),function(b){b.onclick=function(){if(b.dataset.profile)openPublicProfile(b.dataset.profile);};});
    Array.prototype.forEach.call(host.querySelectorAll('[data-map]'),function(b){b.onclick=function(){openTimelineMap(posts[Number(b.dataset.map)]);};});
    Array.prototype.forEach.call(host.querySelectorAll('.timeline-photo'),function(b){
      var p=posts[Number(b.dataset.index)],img=b.querySelector('img');putRemotePhoto(img,p.photo_id,screen,'thumb');
      b.onclick=function(){if(img.src)openViewer([img.src],0,p.author&&(p.author.name||p.author.handle),p.place_name||p.title,p.tag||'',releaseDate(p.taken_at),releaseTags(p.tag),[p.photo_id]);};
    });
  }catch(e){host.querySelector('.timeline-status').innerHTML='<b>読み込めませんでした</b><span>'+esc(e.message||'通信を確認してください')+'</span>';}
}
function openTimelineMap(p){
  if(!p||!p.map_available)return;
  closeReleaseScreen();setMapAudience('public',true);
  map.easeTo({center:[p.lng,p.lat],zoom:16.4,duration:820});
  setTip((p.author&&p.author.name?p.author.name+'の ':'')+(p.precision==='exact'?'':'公開位置で ')+'思い出を表示しました');
}

function openMemoryHub(tab){
  var screen=makeReleaseScreen('思い出');
  var body=screen.querySelector('.release-body');
  body.innerHTML='<div class="release-tabs" role="tablist" aria-label="思い出の表示">'+
    '<button type="button" data-tab="album" role="tab">アルバム</button>'+
    '<button type="button" data-tab="timeline" role="tab">タイムライン</button></div><div id="release-content"></div>';
  var content=body.querySelector('#release-content');
  function show(name){
    Array.prototype.forEach.call(body.querySelectorAll('[data-tab]'),function(b){var on=b.dataset.tab===name;b.classList.toggle('on',on);b.setAttribute('aria-selected',String(on));});
    if(name==='timeline')renderTimeline(screen,content,'');else renderAlbumHome(screen,content);
  }
  Array.prototype.forEach.call(body.querySelectorAll('[data-tab]'),function(b){b.onclick=function(){show(b.dataset.tab);};});
  show(tab||'album');
}

/* ---------- プロフィール ---------- */
async function openPublicProfile(handle){
  if(!fbUser){setTip('プロフィールを見るにはログインしてください');return;}
  var screen=makeReleaseScreen('プロフィール'),body=screen.querySelector('.release-body');
  body.innerHTML='<div class="profile-loading" aria-live="polite">プロフィールを読み込んでいます…</div>';
  try{
    var r=await api('/api/posts?user='+encodeURIComponent(handle)+'&limit=100'),j=await r.json();
    if(!r.ok)throw new Error(j.error||'読み込めませんでした');
    var profile=j.profile||{},posts=j.posts||[],photoPosts=posts.filter(function(p){return !!p.photo_id;}),name=profile.name||profile.handle||handle;
    body.innerHTML='<section class="public-profile"><div class="profile-portrait" aria-hidden="true">'+esc(name.charAt(0))+'</div>'+
      '<div class="profile-name"><h1>'+esc(name)+'</h1><p>@'+esc(profile.handle||handle)+'</p></div>'+
      (profile.bio?'<p class="profile-bio">'+esc(profile.bio)+'</p>':'')+
      '<div class="profile-count"><b>'+posts.length+'</b><span>見られる思い出</span></div>'+
      '<div class="profile-actions">'+
        '<button class="release-main" id="profile-map" type="button">地図を開く</button>'+
        ((meP&&meP.handle)===(profile.handle||handle)?'<button type="button" id="profile-settings">設定</button>':'<button type="button" id="profile-friend">フレンド申請</button>')+
      '</div></section>'+
      (photoPosts.length?'<div class="profile-grid">'+photoPosts.map(function(p,i){return '<button type="button" data-profile-photo="'+i+'" aria-label="'+esc(p.title||'思い出')+'を開く"><img alt="" loading="lazy"><span>'+esc(p.place_name||p.title||'')+'</span></button>';}).join('')+'</div>':'<div class="release-empty"><b>見られる写真はまだありません</b><span>公開範囲と位置設定により、表示されない写真もあります。</span></div>');
    body.querySelector('#profile-map').onclick=function(){
      closeReleaseScreen();
      if((meP&&meP.handle)===(profile.handle||handle)){
        setMapAudience('mine',true);setTip('自分の地図を表示しました');
      }else openFriendMap(profile.handle||handle);
    };
    var settings=body.querySelector('#profile-settings');if(settings)settings.onclick=function(){closeReleaseScreen();openMe();};
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
  var bulk=document.getElementById('btn-bulk');if(bulk)bulk.onclick=function(){openMemoryHub('album');};
  var me=document.getElementById('btn-me');if(me){
    var prior=me.onclick;
    me.onclick=async function(){
      if(!fbUser){if(prior)return prior.call(me);openMe();return;}
      if(meP&&meP.handle)openPublicProfile(meP.handle);else openMe();
    };
  }
})();
