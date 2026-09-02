/* ============================================================
   写真を開く

   一枚に集中して見られるように、画面いっぱいで出す。
   下へ払うと閉じる。
   ============================================================ */
let viewerEl=null;
let viewerOpenSerial=0;
let viewerPending=null;
const PHOTO_VIEW_TIMEOUT_MS=20000;

function finishPendingViewer(pending){
  if(!pending||pending.done)return;
  pending.done=true;
  clearTimeout(pending.timer);
  if(pending.waitId&&window.SpotaMotion)window.SpotaMotion.endWait(pending.waitId);
  pending.waitId=0;
  if(viewerPending===pending)viewerPending=null;
}
function cancelPendingViewer(){
  var pending=viewerPending;
  if(!pending)return;
  viewerPending=null;pending.cancelled=true;
  if(pending.controller&&!pending.controller.signal.aborted)pending.controller.abort();
  finishPendingViewer(pending);
}
function pendingViewerIsCurrent(pending,auth){
  return !!(pending&&!pending.cancelled&&viewerPending===pending&&
    pending.serial===viewerOpenSerial&&typeof authIsCurrent==='function'&&authIsCurrent(auth));
}

function openViewer(list, idx, who, place, cap, when, tags, photoIds){
  closeViewer();
  idx=idx||0;
  var previousFocus=document.activeElement;
  var serial=++viewerOpenSerial;
  var photoId=photoIds&&photoIds[idx];

  // サーバー写真は高解像度版が実際に取れてから詳細を開く。
  // 400ms以上かかった時だけ、承認済みの待機カメラが地図の中央に現れる。
  if(photoId&&fbUser){
    var waitId=window.SpotaMotion?window.SpotaMotion.beginWait('写真を読み込んでいます'):0;
    var controller=new AbortController();
    var pending={serial:serial,controller:controller,waitId:waitId,timer:0,auth:null,done:false,cancelled:false};
    viewerPending=pending;
    pending.timer=setTimeout(function(){
      if(viewerPending!==pending)return;
      pending.cancelled=true;viewerPending=null;
      if(!controller.signal.aborted)controller.abort();
      finishPendingViewer(pending);
    },PHOTO_VIEW_TIMEOUT_MS);
    captureAuth().then(function(auth){
      pending.auth=auth;
      if(!pendingViewerIsCurrent(pending,auth))throw Object.assign(new Error('stale viewer'),{name:'AbortError'});
      return apiAs(auth,'/api/photo/'+encodeURIComponent(photoId)+'/view',{signal:controller.signal}).then(function(r){
        if(!r.ok)throw new Error('view '+r.status);
        return r.blob().then(function(blob){
          if(!pendingViewerIsCurrent(pending,auth))throw Object.assign(new Error('stale viewer'),{name:'AbortError'});
          return {auth:auth,url:URL.createObjectURL(blob)};
        });
      });
    }).then(function(preloaded){
      if(!pendingViewerIsCurrent(pending,preloaded.auth)){
        URL.revokeObjectURL(preloaded.url);finishPendingViewer(pending);return;
      }
      finishPendingViewer(pending);
      openViewerReady(list,idx,who,place,cap,when,tags,photoIds,previousFocus,preloaded.auth,preloaded.url);
    }).catch(function(e){
      var mayFallback=e&&e.name!=='AbortError'&&pendingViewerIsCurrent(pending,pending.auth);
      finishPendingViewer(pending);
      if(mayFallback)openViewerReady(list,idx,who,place,cap,when,tags,photoIds,previousFocus,null,null);
    });
    return;
  }
  openViewerReady(list,idx,who,place,cap,when,tags,photoIds,previousFocus,null,null);
}

function openViewerReady(list, idx, who, place, cap, when, tags, photoIds, previousFocus, initialAuth, initialUrl){
  list=(list||[]).slice();
  if(initialUrl)list[idx]=initialUrl;
  var v=el('<div class="viewer" role="dialog" aria-modal="true" aria-label="写真を見る">'+
    '<div class="vw-bar">'+
      '<div class="av"'+(list[0]?' style="background-image:url('+
        JSON.stringify(list[0]).replace(/"/g,'&quot;')+')"':'')+'></div>'+
      '<div class="who"><b>'+esc(who||'じぶん')+'</b><span>'+esc(place||'')+'</span></div>'+
      '<button class="x" aria-label="写真を閉じる">✕</button></div>'+
    '<div class="vw-track" id="vwt">'+
      list.map(function(u,i){return '<img src="'+u+'" alt="写真 '+(i+1)+'">';}).join('')+'</div>'+
    (list.length>1?'<div class="vw-dots" id="vwd">'+
      list.map(function(_,i){return '<i class="'+(i===idx?'on':'')+'"></i>';}).join('')+
      '</div>':'')+
    (cap?'<div class="vw-cap"><em>'+esc(who||'じぶん')+'</em>'+esc(cap)+'</div>':'')+
    (tags&&tags.length?'<div class="vw-tags">'+tags.map(function(t){
      return '<span>'+esc(t)+'</span>';}).join('')+'</div>':'')+
    '<div class="vw-meta">'+esc(when||'')+(place?('　'+esc(place)):'')+'</div>'+
  '</div>');
  document.body.appendChild(v);
  v.__previousFocus=previousFocus;v.__blobUrls=initialUrl?[initialUrl]:[];v.__viewControllers=[];
  v.__inert=[];Array.prototype.forEach.call(document.body.children,function(node){
    if(node!==v&&node.id!=='spota-wait'&&node.id!=='spota-wait-status'&&!node.inert){node.inert=true;v.__inert.push(node);}
  });
  viewerEl=v;
  var track=v.querySelector('#vwt');
  if(idx)track.scrollLeft=track.clientWidth*idx;
  void v.offsetWidth; v.classList.add('on');
  if(window.SpotaMotion)window.SpotaMotion.viewerTransition(v,previousFocus,track.children[idx]);
  if(idx) setTimeout(function(){ track.scrollLeft=track.clientWidth*idx; },30);
  var dots=v.querySelector('#vwd');
  if(dots) track.onscroll=function(){
    var i=Math.round(track.scrollLeft/track.clientWidth);
    Array.prototype.forEach.call(dots.children,function(d,j){
      d.classList.toggle('on',j===i);});
    loadAround(i);
  };
  v.querySelector('.x').onclick=closeViewer;
  v.querySelector('.x').focus();
  v.onkeydown=function(e){
    if(e.key==='Escape'){e.preventDefault();closeViewer();}
    if(e.key==='Tab'){e.preventDefault();v.querySelector('.x').focus();}
  };

  var viewAuth=initialAuth||null,viewLoaded={};
  if(initialUrl)viewLoaded[idx]=1;
  function loadAround(center){
    if(!viewAuth)return;
    [center-1,center,center+1].forEach(function(i){
      var id=photoIds&&photoIds[i];if(!id||viewLoaded[i])return;viewLoaded[i]=1;
      var waitId=i===center&&window.SpotaMotion?window.SpotaMotion.beginWait('写真を読み込んでいます'):0;
      var controller=new AbortController();v.__viewControllers.push(controller);
      apiAs(viewAuth,'/api/photo/'+encodeURIComponent(id)+'/view',{signal:controller.signal}).then(function(r){
        if(!r.ok)throw new Error('view '+r.status);return r.blob();
      }).then(function(blob){
        if(viewerEl!==v||!authIsCurrent(viewAuth))return;
        var u=URL.createObjectURL(blob),im=track.children[i];
        if(!im){URL.revokeObjectURL(u);return;}
        v.__blobUrls.push(u);im.src=u;
      }).catch(function(e){if(!e||e.name!=='AbortError')delete viewLoaded[i];}).finally(function(){
        v.__viewControllers=v.__viewControllers.filter(function(item){return item!==controller;});
        if(waitId)window.SpotaMotion.endWait(waitId);
      });
    });
  }
  if(viewAuth)loadAround(idx);
  else if(photoIds&&photoIds.length&&fbUser){
    captureAuth().then(function(auth){
      if(viewerEl!==v||!authIsCurrent(auth))return;viewAuth=auth;loadAround(idx);
    }).catch(function(){});
  }

  /* 下へ払うと閉じる */
  var y0=0,dragging=false;
  v.addEventListener('touchstart',function(e){
    if(v.scrollTop>4)return;
    y0=e.touches[0].clientY; dragging=true;
  },{passive:true});
  v.addEventListener('touchmove',function(e){
    if(!dragging)return;
    var dy=e.touches[0].clientY-y0;
    if(dy>0){ v.style.transform='translateY('+dy+'px)';
      v.style.transition='none'; }
  },{passive:true});
  v.addEventListener('touchend',function(e){
    if(!dragging)return; dragging=false;
    var dy=e.changedTouches[0].clientY-y0;
    v.style.transition='';
    if(dy>110) closeViewer();
    else v.style.transform='';
  },{passive:true});
}
function closeViewer(){
  viewerOpenSerial++;
  cancelPendingViewer();
  if(!viewerEl)return;
  var v=viewerEl; viewerEl=null;
  (v.__viewControllers||[]).forEach(function(controller){if(!controller.signal.aborted)controller.abort();});
  v.__viewControllers=[];
  (v.__blobUrls||[]).forEach(function(u){URL.revokeObjectURL(u);});
  (v.__inert||[]).forEach(function(node){node.inert=false;});
  if(v.__previousFocus&&v.__previousFocus.isConnected)v.__previousFocus.focus();
  v.style.transform='translateY(100%)';
  setTimeout(function(){ v.remove(); },340);
}

/* ============================================================
   場所のシート
   ============================================================ */
const scrim=document.getElementById('scrim');
let sheetEl=null;
function closeSheet(){
  if(sheetEl){var s=sheetEl;sheetEl=null;s.style.transition='transform .32s cubic-bezier(.2,.72,.2,1)';s.style.transform='translate3d(0,100%,0)';s.classList.remove('on');
    var onClose=s.__onClose;s.__onClose=null;if(onClose)onClose();
    setTimeout(function(){s.remove();},420);}
  scrim.classList.remove('on');
}
scrim.onclick=closeSheet;
function showSheet(html,onClose){
  closeSheet();
  var s=el('<div class="sheet">'+html+'</div>');
  document.body.appendChild(s);
  sheetEl=s;s.__onClose=typeof onClose==='function'?onClose:null;
  void s.offsetWidth;s.classList.add('on');

  /* grabberを下へ払うと、指に追従し速度または距離で閉じる。 */
  var y0=0,x0=0,drag=false,lock=false,pid=0,lastY=0,lastT=0,vy=0;
  s.addEventListener('pointerdown',function(e){
    if(!e.isPrimary||e.button!==0||s.scrollTop>4||!e.target.closest('.grab'))return;
    y0=lastY=e.clientY;x0=e.clientX;lastT=e.timeStamp;pid=e.pointerId;drag=true;lock=false;vy=0;
  });
  s.addEventListener('pointermove',function(e){
    if(!drag||e.pointerId!==pid)return;var dx=e.clientX-x0,dy=Math.max(0,e.clientY-y0);
    if(!lock){if(Math.max(Math.abs(dx),dy)<8)return;if(dy<=Math.abs(dx)*1.2){drag=false;return;}lock=true;try{s.setPointerCapture(pid);}catch(err){}}
    e.preventDefault();var dt=Math.max(1,e.timeStamp-lastT),instant=(e.clientY-lastY)/dt*1000;vy=vy*.68+instant*.32;lastY=e.clientY;lastT=e.timeStamp;s.style.transition='none';s.style.transform='translate3d(0,'+dy+'px,0)';
  },{passive:false});
  function release(e){if(!drag||e.pointerId!==pid)return;drag=false;var dy=Math.max(0,e.clientY-y0);s.style.transition='transform .32s cubic-bezier(.18,.88,.24,1)';if(lock&&(dy>s.offsetHeight*.3||vy>900))closeSheet();else s.style.transform='';}
  s.addEventListener('pointerup',release);s.addEventListener('pointercancel',function(){if(drag){drag=false;s.style.transition='';s.style.transform='';}});
  scrim.classList.add('on');
  return s;
}

function openPlace(p,mine){
  function samePlace(s){
    if(!s||s.n!==p.n)return false;
    if(!valid(s)||!valid(p))return true;
    return Math.hypot((s.lat-p.lat)*111000,(s.lng-p.lng)*91000)<180;
  }
  var mySpots=visibleOwnSpots().filter(samePlace);
  var sharedSpots=visibleOtherSpots().filter(samePlace);
  var allSpots=mySpots.concat(sharedSpots);
  var photoPlaceholder='data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="8" height="8"%3E%3Crect width="8" height="8" fill="%23e9e7e2"/%3E%3C/svg%3E';
  var photoSpots=allSpots.filter(function(s){return s.photo||s.server_photo_id;});
  var photos=photoSpots.map(function(s){return s.photo||photoPlaceholder;});
  var photoIds=photoSpots.map(function(s){return s.server_photo_id||null;});
  if(p.photo&&photos.indexOf(p.photo)<0){photos.unshift(p.photo);photoIds.unshift(null);}
  var av=photos[0]||'';
  var meta=[p.gname,p.budget,p.place].filter(Boolean).join(' ・ ')||p.c||'';

  var html='<div class="grab"></div>'+
    '<div class="head"><div class="av"'+(av?' style="background-image:url('+
      JSON.stringify(av).replace(/"/g,'&quot;')+')"':'')+'>'+(av?'':esc((p.n||'?').charAt(0)))+'</div>'+
    '<div class="t"><h2>'+esc(p.n)+'</h2><p>'+esc(meta)+
      (allSpots.length?' ・ '+allSpots.length+'件の思い出':'')+'</p></div></div>'+
    '<div class="acts"><button class="main" id="a-add">ここに追加</button>'+
    '<button id="a-route">経路</button></div>';

  if(photos.length){
    // 大小を混ぜて並べる。均一だと単調になる
    html+='<div class="grid2">'+photos.slice(0,9).map(function(u,i){
      var tall=(i%5===0);
      return '<button type="button" aria-label="写真 '+(i+1)+' を開く" class="'+(tall?'tall':'')+'" data-ph="'+i+'" style="background-image:url('+
        JSON.stringify(u).replace(/"/g,'&quot;')+')"></button>';
    }).join('')+'</div>';
  }
  var frnd=sharedSpots.filter(function(o){return o.tag;});
  if(frnd.length){
    html+='<div class="posts">'+frnd.map(function(o){
      return '<div class="post"><div class="av2"></div><div class="b"><b>'+
        esc(o.author&&o.author.name||'フレンド')+'</b>'+
        '<p>'+esc(o.tag)+'</p></div></div>';
    }).join('')+'</div>';
  }
  if(mySpots.length){
    html+='<div class="posts">'+mySpots.map(function(s){
      var preview=s.photo_thumb||s.photo;
      var visText=typeof visibilityLabel==='function'?visibilityLabel(s.visibility||'private'):'自分だけ';
      return '<div class="post"><div class="av2"'+(preview?' style="background-image:url('+
        JSON.stringify(preview).replace(/"/g,'&quot;')+')"':'')+'></div>'+
        '<div class="b"><b>じぶん</b><span>'+esc([s.d||'',visText].filter(Boolean).join(' ・ '))+'</span>'+
        (s.tag?'<p>'+esc(s.tag)+'</p>':'')+'</div>'+
        '<button class="post-del" data-del="'+esc(s.id)+'">削除</button></div>';
    }).join('')+'</div>';
  }else{
    html+='<div class="empty">まだ思い出がありません。<br>写真を1枚、置いてみてください。</div>';
  }

  var s=showSheet(html);
  Array.prototype.forEach.call(s.querySelectorAll('[data-ph]'),function(e2){
    e2.onclick=function(){
      var i=Number(e2.dataset.ph);
      var m=photoSpots[i]||allSpots[0]||{};
      var who=m.author&&(m.author.name||m.author.handle)||'じぶん';
      openViewer(photos, i, who, p.place||p.n, m.tag||'', m.d||'', [],photoIds);
    };
  });
  s.querySelector('#a-add').onclick=function(){
    // 場所はもう分かっているので、確認は挟まない
    closeSheet();
    openAdd({lat:p.lat,lng:p.lng,known:p.n,cat:p.c,
      place:p.place||p.addr||'',gname:p.gname,budget:p.budget});
  };
  s.querySelector('#a-route').onclick=function(){
    var ios=/iPad|iPhone|iPod/.test(navigator.userAgent);
    location.href=(ios?'maps://?daddr=':'https://www.google.com/maps/dir/?api=1&destination=')
      +p.lat+','+p.lng;
  };
  var placeScope=activeSpotScope;
  Array.prototype.forEach.call(s.querySelectorAll('[data-del]'),function(button){
    button.onclick=function(){
      var target=mySpots.filter(function(x){return x.id===button.dataset.del;})[0];
      if(!target)return;
      var confirm=showSheet('<div class="grab"></div><div class="pad" style="padding-top:20px">'+
        '<div style="font-size:19px;font-weight:700;margin-bottom:8px">この思い出を削除しますか？</div>'+
        '<div style="font-size:13px;color:var(--dim);line-height:1.8;margin-bottom:18px">'+
        esc(target.d||target.n)+'<br>Spotaの端末データとクラウドから削除します。写真ライブラリの元写真は残ります。</div>'+
        '<button class="btn d" id="delete-confirm">削除する</button>'+
        '<button class="btn g" id="delete-cancel" style="margin-top:8px">キャンセル</button></div>');
      confirm.querySelector('#delete-cancel').onclick=closeSheet;
      confirm.querySelector('#delete-confirm').onclick=async function(){
        var del=this;if(activeSpotScope!==placeScope){closeSheet();return;}
        if(target.server_id&&!fbUser){setTip('クラウドから削除するにはログインしてください');return;}
        del.disabled=true;del.textContent='削除しています…';
        var tombId=null;
        try{
          var auth=target.server_id?await captureAuth():null;
          if(target.server_id&&(!auth||auth.scope!==placeScope))throw new Error('auth changed');
          tombId=target.server_id?placeScope+'|'+target.server_id:null;
          if(tombId&&!(await dbPut('deleted',{id:tombId,server_id:target.server_id,owner_scope:placeScope,state:'pending',at:Date.now()})))throw new Error('tombstone');
          if(target.server_id){
            var r=await apiAs(auth,'/api/posts/'+encodeURIComponent(target.server_id),{method:'DELETE'});
            if(!r.ok&&r.status!==404)throw new Error('delete '+r.status);
          }
          if(!(await dbDel('spots',target.id)))throw new Error('local delete');
          if(activeSpotScope===placeScope)spots=spots.filter(function(x){return x.id!==target.id;});
          closeSheet();render(true);setTip('削除しました。ほかの端末にも同期されます');
        }catch(e){
          del.disabled=false;del.textContent='削除する';setTip('削除できませんでした。通信を確認してください');
        }
      };
    };
  });
}

/* ============================================================
   場所を置く
   ============================================================ */
const cf=document.getElementById('confirm');
const cfName=document.getElementById('cf-name'), cfAsk=document.getElementById('cf-ask');

function startPlacing(lat,lng,opt){
 try{
  opt=opt||{};
  if(!isFinite(lat)||!isFinite(lng))return;
  if(dropM){dropM.remove();dropM=null;}
  placing=Object.assign({lat:lat,lng:lng,place:null},opt);
  // 選択座標は確認シートだけで伝える。Marker はドラッグ操作の透明な
  // 当たり領域としてだけ残し、CSSの継承や古いピン装飾でも円を描かない。
  var d=document.createElement('div');d.className='drop';
  d.setAttribute('aria-hidden','true');
  dropM=new maplibregl.Marker({element:d,draggable:true,anchor:'bottom'})
    .setLngLat([lng,lat]).addTo(map);
  dropM.on('dragend',function(){var q=dropM.getLngLat();movePlacing(q.lat,q.lng,true);});
  closeSheet();                       // 開いている詳細を閉じる（重なり防止）
  document.body.classList.add('placing');
  cf.classList.add('on');
  // EXIFが無い写真は、最初に地図を選ぶまで確定ボタンを出さない。
  // 初期位置（画面中央）は仮置きであり、現在地として扱わない。
  cf.classList.toggle('pick',!!placing.manualPhotoLocation);
  map.easeTo({center:[lng,lat],zoom:Math.max(map.getZoom(),16.4),duration:480});
  askPlace(lat,lng);
 }catch(e){showErr('[startPlacing] '+dump(e));}
}
function movePlacing(lat,lng,drag){
  if(!placing)return;
  placing.lat=lat;placing.lng=lng;
  if(placing.manualPhotoLocation)placing.manualLocationChosen=true;
  if(!drag&&dropM)dropM.setLngLat([lng,lat]);
  cf.classList.remove('pick');askPlace(lat,lng);
}
async function askPlace(lat,lng){
 try{
  var my=++askSeq;
  if(placing&&placing.manualPhotoLocation&&!placing.manualLocationChosen){
    cfName.textContent='写真の場所を選んでください';
    cfAsk.textContent='地図をタップ、またはピンを動かしてください';
    return;
  }
  cfName.textContent='場所を調べています…';cfAsk.textContent='この場所でいいですか？';
  var r=await revGeo(lat,lng);
  if(my!==askSeq||!placing)return;
  placing.place=r.name;
  if(r.near&&!placing.known)placing.known=r.near.n;
  cfName.textContent=r.name;
  var ex=[placing.gname,placing.budget].filter(Boolean).join(' ・ ');
  cfAsk.textContent=ex||(r.near?('近く：'+r.near.n):'この場所でいいですか？');
 }catch(e){showErr('[askPlace] '+dump(e));}
}
function endPlacing(){
  if(dropM){dropM.remove();dropM=null;}
  placing=null;cf.classList.remove('on','pick');
  document.body.classList.remove('placing');
}
document.getElementById('cf-yes').onclick=function(){
  if(!placing)return;var p=placing;endPlacing();openAdd(p);};
document.getElementById('cf-no').onclick=function(){
  if(!placing)return;cf.classList.add('pick');
  cfName.textContent='地図をタップして選び直してください';
  cfAsk.textContent='ピンを長押しして動かすこともできます';};
document.getElementById('cf-cancel').onclick=function(){endPlacing();if(typeof finishManualPhotoImport==='function')finishManualPhotoImport();};

function baseCat(p){
  var c=((p.class||'')+'/'+(p.subclass||'')).toLowerCase();
  if(/cafe|coffee|tea/.test(c))return '喫茶';
  if(/bar|pub|alcohol|nightclub/.test(c))return '酒';
  if(/restaurant|fast_food|food|noodle/.test(c))return '食';
  if(/park|garden|playground/.test(c))return '園';
  if(/worship|shinto|temple|shrine/.test(c))return '社';
  if(/book|library/.test(c))return '本';
  if(/onsen|spa|bath|sauna/.test(c))return '湯';
  return '景';
}
map.on('click',function(e){
  // 地図を水平・垂直に動かした直後の合成clickは、場所選択へ渡さない。
  // 通常の短いタップだけを残し、意図しない位置確定を防ぐ。
  if(window.SpotaGestures&&typeof window.SpotaGestures.mapTapAllowed==='function'&&
     !window.SpotaGestures.mapTapAllowed())return;
  if(placing){ movePlacing(e.lngLat.lat,e.lngLat.lng); return; }

  var pad=20,box=[[e.point.x-pad,e.point.y-pad],[e.point.x+pad,e.point.y+pad]],fs=[];
  try{ fs=map.queryRenderedFeatures(box); }catch(_){}

  /* 優先順位をはっきり決める。
     ① 自分の思い出　② フレンド　③ 読み込んだ場所　④ 地図に元からある店
     上のものが見つかったら、そこで打ち止め。
     こうしないと、記録を押したのに「この場所でいいですか」も一緒に出てしまう */
  function nearest(list){
    var best=null,bd=1e9;
    fs.forEach(function(f){
      if(!f.layer||list.indexOf(f.layer.id)<0)return;
      if(!f.geometry||f.geometry.type!=='Point')return;
      var q=map.project(f.geometry.coordinates);
      var d=Math.hypot(q.x-e.point.x,q.y-e.point.y);
      if(d<bd){bd=d;best=f;}
    });
    return best;
  }

  function recordForFeature(list,feature){
    var props=feature&&feature.properties||{},rid=String(props.rid||'');
    if(rid){
      var byId=list.filter(function(x){return String(x.id||x.server_id||x.spot||'')===rid;})[0];
      if(byId)return byId;
    }
    var lat=Number(props.lat),lng=Number(props.lng);
    if(isFinite(lat)&&isFinite(lng)){
      var byPoint=list.filter(function(x){return Math.abs(Number(x.lat)-lat)<1e-7&&Math.abs(Number(x.lng)-lng)<1e-7;})[0];
      if(byPoint)return byPoint;
    }
    return null;
  }

  var cluster=nearest(['photo-cluster-a','photo-cluster-a-pending','photo-cluster','photo-cluster-count']);
  if(cluster){
    var source=map.getSource('spota-photo');
    var clusterId=Number(cluster.properties&&cluster.properties.cluster_id);
    var center=cluster.geometry&&cluster.geometry.coordinates;
    if(source&&isFinite(clusterId)&&center){
      source.getClusterExpansionZoom(clusterId).then(function(zoom){
        map.easeTo({center:center,zoom:Math.min(24,Math.max(map.getZoom()+1,zoom)),duration:420});
      }).catch(function(){});
    }
    return;
  }

  var f=nearest(['photo-ic','photo-group-ic','photo-same-cluster','photo-same-cluster-count','photo-pending','mine-ring','mine-ic']);
  if(f){
    var s=recordForFeature(visibleOwnSpots(),f);
    if(s){ openPlace(s,true); return; }
    var publicPhoto=recordForFeature(visibleOtherSpots(),f);
    if(publicPhoto){openPlace(publicPhoto,false);return;}
  }

  f=nearest(['frnd-ring','frnd-ic']);
  if(f){
    var shared=recordForFeature(visibleOtherSpots(),f);
    if(shared){openPlace(shared,false);return;}
  }

  f=nearest(['spot-dot','spot-ic']);
  if(f){
    var p3=recordForFeature(pois,f);
    if(p3){ openPlace(p3,false); return; }
  }

  var best=null,bd=1e9;
  fs.forEach(function(x){
    if(!x.geometry||x.geometry.type!=='Point')return;
    if(x.sourceLayer!=='poi'||!x.properties||!x.properties.name)return;
    var q=map.project(x.geometry.coordinates);
    var d=Math.hypot(q.x-e.point.x,q.y-e.point.y);
    if(d<bd){bd=d;best=x;}
  });
  if(best){
    var pr=best.properties,c=best.geometry.coordinates;
    var nm=pr['name:ja']||pr.name;
    var known=pois.filter(function(x){return x.n===nm;})[0];
    openPlace(known||{n:nm,c:baseCat(pr),lat:c[1],lng:c[0],
      gname:pr.subclass||pr.class||''},false);
    return;
  }

  startPlacing(e.lngLat.lat,e.lngLat.lng,{});
});

/* ---------- 地名を調べる ---------- */
const gcache=new Map();
async function revGeo(lat,lng){
  var key=lat.toFixed(4)+','+lng.toFixed(4);
  if(gcache.has(key))return gcache.get(key);
  var near=null,nd=1e9;
  pois.concat(spots).forEach(function(p){if(!valid(p))return;
    var d=Math.hypot((p.lat-lat)*111000,(p.lng-lng)*91000);
    if(d<nd){nd=d;near=p;}});
  if(nd>90)near=null;
  var name=null;
  try{
    // 写真EXIF由来の座標も含め、位置情報を第三者へ直接送らない。
    // Worker 側でキャッシュ・レート制限して地名へ変換する。
    var r=await fetch(SERVER+'/api/reverse',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({lat:lat,lng:lng})});
    if(r.ok){var j=await r.json(),a=j.address||{};
      var seq=[a.province||a.state,a.city||a.town||a.village||a.county,
        a.city_district||a.suburb,a.neighbourhood||a.quarter,a.road],o=[];
      seq.forEach(function(v){if(v&&o.indexOf(v)<0)o.push(v);});
      if(o.length)name=o.join('');
      if(j.name&&name&&name.indexOf(j.name)<0)name=j.name+'（'+name+'）';
      else if(j.name&&!name)name=j.name;
      // Worker の簡潔な応答 {name:"…"} も受け付ける。
      if(!name&&j.name)name=j.name;}
  }catch(e){}
  if(!name&&near)name=near.n+' のあたり';
  // 公開範囲を狭めても、地名欄に真の座標が入れば位置が漏れる。
  // 逆引き失敗時は座標文字列を保存せず、中立なラベルにする。
  if(!name)name='撮影場所';
  var out={name:name,near:near};gcache.set(key,out);return out;
}
