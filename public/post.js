/* ============================================================
   記録する
   ============================================================ */

/* ============================================================
   一度取り込んだ写真を覚えておく

   写真そのものに固有の番号は無いので、指紋を自分で作る。
   撮影日時＋座標で判別し、日時が無いものはファイルの中身から作る。
   ============================================================ */
function fingerprint(lat,lng,at,file){
  if(at&&isFinite(lat)){
    return 'g'+Math.round(at/1000)+'_'+lat.toFixed(5)+'_'+lng.toFixed(5);
  }
  // 日時が取れない場合は、大きさと更新時刻で代用
  if(file&&file.__spotaId)return 'a'+String(file.__spotaId).slice(-160);
  return 'f'+(file?file.size:0)+'_'+(file?(file.lastModified||0):0);
}
function scopedSeenId(fp,scope){return (scope||activeSpotScope)+'|'+fp;}
async function seenAdd(fp,scope){ return dbPut('seen',{id:scopedSeenId(fp,scope),at:Date.now()}); }
async function seenHas(fp){
  return new Promise(function(r){
    if(!db)return r(false);
    try{
      var q=db.transaction('seen','readonly').objectStore('seen').get(scopedSeenId(fp));
      q.onsuccess=function(){ r(!!q.result); };
      q.onerror=function(){ r(false); };
    }catch(e){ r(false); }
  });
}

function defaultPostVisibility(){
  var v=meP&&meP.settings&&meP.settings.default_visibility;
  return ['private','friends','public'].indexOf(v)>=0?v:'private';
}
function visibilityLabel(v){
  return {private:'自分だけ',friends:'フレンド',public:'みんな'}[v]||'自分だけ';
}
function precisionLabel(v){
  return {exact:'正確な位置',approx:'約500m',area:'約2kmのエリア',hidden:'位置なし'}[v]||'位置なし';
}
function visibilityDescription(v){
  if(v==='private')return '自分だけに表示されます';
  var settings=meP&&meP.settings||{};
  var precision=v==='friends'?settings.friend_precision:settings.public_precision;
  return visibilityLabel(v)+'に表示・位置は'+precisionLabel(precision)+'。公開用画像は安全確認のためGoogle Cloud Visionへ送信されます';
}

/* ============================================================
   カメラロールからまとめて取り込む

   写真には撮った場所と日時が埋まっている。
   それを読めば、選ぶだけで地図が埋まる。
   1枚ずつ記録させると続かないので、ここが要になる。
   ============================================================ */
function readAsData(file){
  return new Promise(function(res){
    var r=new FileReader();
    r.onload=function(){res(r.result);};
    r.onerror=function(){res(null);};
    r.readAsDataURL(file);
  });
}

function secureShuffle(list){
  list=list.slice();
  for(var i=list.length-1;i>0;i--){
    var box=new Uint32Array(1);crypto.getRandomValues(box);var j=box[0]%(i+1),tmp=list[i];list[i]=list[j];list[j]=tmp;
  }
  return list;
}
async function chosenCandidateFile(candidate,index){
  if(candidate instanceof Blob)return candidate;
  if(candidate.file)return candidate.file;
  var r=await fetch(candidate.asset);if(!r.ok)throw new Error('写真取得 '+r.status);
  var b=await r.blob(),f=new File([b],'memory-'+index+'.jpg',{type:b.type||'image/jpeg'});
  if(candidate.exif)Object.defineProperty(f,'__spotaExif',{value:candidate.exif});return f;
}
function candidateExif(candidate){return candidate&&candidate.exif||(candidate&&candidate.file&&candidate.file.__spotaExif)||candidate&&candidate.__spotaExif||null;}
function openMemoryDeck(candidates){
  candidates=secureShuffle(candidates).slice(0,200);if(!candidates.length){setTip('選ばれませんでした');return;}
  var screen=makeReleaseScreen('写真を選ぶ'),body=screen.querySelector('.release-body');screen.classList.add('memory-deck-screen');
  body.innerHTML='<section class="memory-deck"><header><p><b id="deck-step">1</b> / '+candidates.length+'</p><span>右へ使う・左へ使わない</span></header><div class="memory-stage"><div class="memory-card" id="memory-card"><img id="memory-card-img" alt="選択する写真"><span class="memory-choice no">使わない</span><span class="memory-choice yes">使う</span></div></div><div class="memory-deck-actions"><button type="button" id="memory-no">使わない</button><button type="button" id="memory-yes">使う</button></div><div class="sr-only" id="memory-live" aria-live="polite"></div></section>';
  var card=body.querySelector('#memory-card'),img=body.querySelector('#memory-card-img'),step=body.querySelector('#deck-step'),live=body.querySelector('#memory-live'),at=0,kept=[],busy=false,currentUrl='',alive=true;
  screen.__onClose=function(){alive=false;if(currentUrl){URL.revokeObjectURL(currentUrl);currentUrl='';}};
  function preview(){
    if(!alive||releaseScreen!==screen||!screen.isConnected)return;
    if(currentUrl){URL.revokeObjectURL(currentUrl);currentUrl='';}
    if(at>=candidates.length){finish();return;}
    var c=candidates[at];step.textContent=String(at+1);card.style.transition='none';card.style.transform='';card.classList.remove('choose-yes','choose-no');
    if(c.file){currentUrl=URL.createObjectURL(c.file);img.src=currentUrl;}else img.src=c.asset;
  }
  function decide(use,direction){
    if(!alive||busy||at>=candidates.length)return;busy=true;card.classList.add(use?'choose-yes':'choose-no');card.style.transition='transform .24s cubic-bezier(.2,.72,.2,1),opacity .2s';card.style.transform='translate3d('+(direction*(innerWidth+120))+'px,0,0) rotate('+(direction*7)+'deg)';live.textContent=use?'この写真を使います':'この写真は使いません';
    var candidate=candidates[at++];
    // デッキ中は原寸Blobを保持せず参照だけを残す。採用後の解析時に1枚ずつ読む。
    if(use)kept.push(candidate);
    setTimeout(function(){if(!alive||releaseScreen!==screen)return;busy=false;preview();},220);
  }
  function finish(){
    if(!alive||releaseScreen!==screen||!screen.isConnected)return;
    if(currentUrl){URL.revokeObjectURL(currentUrl);currentUrl='';}alive=false;screen.__onClose=null;closeReleaseScreen();
    if(!kept.length){setTip('使う写真は選ばれませんでした');return;}
    setTip(kept.length+'枚を確認します');handleBulk(kept);
  }
  var dragging=false,locked=false,pointer=0,sx=0,lastX=0,lastT=0,vx=0;
  card.onpointerdown=function(e){if(busy||!e.isPrimary||e.button!==0)return;dragging=true;locked=false;pointer=e.pointerId;sx=lastX=e.clientX;lastT=e.timeStamp;vx=0;card.style.transition='none';};
  card.onpointermove=function(e){if(!dragging||e.pointerId!==pointer)return;var dx=e.clientX-sx;if(!locked&&Math.abs(dx)>8){locked=true;try{card.setPointerCapture(pointer);}catch(err){}}if(!locked)return;e.preventDefault();var dt=Math.max(1,e.timeStamp-lastT),instant=(e.clientX-lastX)/dt*1000;vx=vx*.65+instant*.35;lastX=e.clientX;lastT=e.timeStamp;card.style.transform='translate3d('+dx+'px,0,0) rotate('+(dx/innerWidth*6)+'deg)';card.classList.toggle('choose-yes',dx>18);card.classList.toggle('choose-no',dx<-18);};
  function release(e){if(!dragging||e.pointerId!==pointer)return;dragging=false;var dx=e.clientX-sx,idle=e.timeStamp-lastT;if(idle>80)vx=0;var byDistance=Math.abs(dx)>card.offsetWidth*.25,bySpeed=Math.abs(vx)>700,go=byDistance||bySpeed,direction=byDistance?(dx>0?1:-1):(vx>0?1:-1);if(go)decide(direction>0,direction);else{card.style.transition='transform .3s cubic-bezier(.18,.78,.24,1)';card.style.transform='';card.classList.remove('choose-yes','choose-no');}}
  card.onpointerup=release;card.onpointercancel=function(){if(dragging){dragging=false;card.style.transition='transform .25s';card.style.transform='';card.classList.remove('choose-yes','choose-no');}};
  body.querySelector('#memory-no').onclick=function(){decide(false,-1);};body.querySelector('#memory-yes').onclick=function(){decide(true,1);};preview();
}
async function chooseMemoryDeckPhotos(){
  var got=await pickPhotos();
  if(got===null)return;              // ブラウザなら入力欄が開く
  if(!got.length){ setTip('選ばれませんでした'); return; }
  var candidates=got.map(function(photo){return {asset:typeof nativePhotoUrl==='function'?nativePhotoUrl(photo):(photo.webPath||photo.path||''),exif:photo.exif};}).filter(function(c){return !!c.asset;});
  if(!candidates.length){setTip('写真を読めませんでした');return;}openMemoryDeck(candidates);
}
function chooseAlbumPhotos(){return chooseMemoryDeckPhotos();}

document.getElementById('btn-bulk').onclick=function(){
  var s=showSheet('<div class="grab"></div><div class="pad" style="padding-top:18px">'+
    '<div style="font-size:19px;font-weight:700">思い出アルバム</div>'+
    '<div style="font-size:13px;color:var(--dim);line-height:1.7;margin-top:6px">'+
    '旅の写真を選ぶと、撮影した場所と時間からアルバムを作ります。</div>'+
    '<button class="btn" id="album-new" style="margin-top:18px">新しいアルバムを作る</button>'+
    '<button class="btn g" id="album-close" style="margin-top:8px">とじる</button></div>');
  s.querySelector('#album-close').onclick=closeSheet;
  s.querySelector('#album-new').onclick=function(){closeSheet();chooseAlbumPhotos();};
};

document.getElementById('in-bulk').onchange=function(e){
  var files=Array.prototype.slice.call(e.target.files||[]);
  e.target.value='';
  openMemoryDeck(files.map(function(file){return {file:file};}));
};

var manualPhotoImports=[],manualPhotoImportActive=false;
function startManualPhotoImports(files){
  manualPhotoImports=manualPhotoImports.concat(files||[]);manualPhotoImportNext();
}
async function manualPhotoImportNext(){
  if(manualPhotoImportActive)return;
  if(!manualPhotoImports.length){setTip('選んだ写真の確認が終わりました');return;}
  manualPhotoImportActive=true;var source=manualPhotoImports.shift(),file=null;
  try{file=await chosenCandidateFile(source,manualPhotoImports.length);}catch(e){}
  var url=file?await readAsData(file):null;
  if(!url){manualPhotoImportActive=false;manualPhotoImportNext();return;}
  setTip('位置情報のない写真です。場所を選んでください（残り '+(manualPhotoImports.length+1)+'枚）');
  afterPhoto(url,file,file.__spotaExif);
}
function finishManualPhotoImport(){
  if(!manualPhotoImportActive)return;manualPhotoImportActive=false;setTimeout(manualPhotoImportNext,180);
}
window.finishManualPhotoImport=finishManualPhotoImport;

async function handleBulk(files){
  if(!files.length)return;
  setTip('準備しています…');
  await Promise.race([
    need('exifr'),
    new Promise(function(resolve){setTimeout(function(){resolve(false);},4000);})
  ]);
  var hasNativeExif=files.some(function(f){return !!candidateExif(f);});
  if(typeof exifr==='undefined'&&!hasNativeExif){
    setTip('写真の位置情報を読めません。通信を確認してください');return;
  }

  var s=showSheet('<div class="grab"></div><div class="pad" style="padding-top:18px">'+
    '<div style="font-size:18px;font-weight:700;margin-bottom:6px">写真を読んでいます</div>'+
    '<div id="bmsg" style="font-size:13px;color:var(--dim);line-height:1.9">'+
      files.length+' 枚を調べています…</div>'+
    '<div id="blist" style="margin-top:14px"></div>'+
    '<div id="bfoot"></div></div>');
  var msg=s.querySelector('#bmsg'), foot=s.querySelector('#bfoot');

  var found=[], manual=[], noGeo=0, already=0;
  for(var i=0;i<files.length;i++){
    msg.textContent=(i+1)+' / '+files.length+' 枚を調べています…';
    var source=files[i],f=source instanceof Blob?source:(source&&source.file)||null,nativeExif=candidateExif(source);
    try{
      var nativeGps=typeof gpsFromNativeExif==='function'?
        gpsFromNativeExif(nativeExif):null;
      var g=nativeGps?{latitude:nativeGps.lat,longitude:nativeGps.lng}:null;
      if(!g&&typeof exifr!=='undefined'){
        if(!f)f=await chosenCandidateFile(source,i);
        g=await exifr.gps(f).catch(function(){return null;});
      }
      if(!g||g.latitude==null){ noGeo++;manual.push(source);continue; }
      var nativeDate=typeof dateFromNativeExif==='function'?
        dateFromNativeExif(nativeExif):null;
      var pp=null;
      if(!nativeDate&&typeof exifr!=='undefined'){
        if(!f)f=await chosenCandidateFile(source,i);
        pp=await exifr.parse(f,{pick:['DateTimeOriginal','CreateDate']}).catch(function(){return null;});
      }
      var dt=nativeDate||(pp&&(pp.DateTimeOriginal||pp.CreateDate));
      var parsed=dt?new Date(dt).getTime():NaN;
      var at=isFinite(parsed)?parsed:((f&&f.lastModified)||Date.now());
      var fp=fingerprint(g.latitude,g.longitude,isFinite(parsed)?at:null,f||{__spotaId:source.asset});
      if(await seenHas(fp)){ already++; continue; }   // もう入れたもの
      found.push({source:source,lat:g.latitude,lng:g.longitude,fp:fp,
        d:isFinite(parsed)?new Date(parsed).toISOString().slice(0,10):'', at:at});
    }catch(err){ noGeo++;manual.push(source); }
  }

  if(!found.length){
    if(manual.length){
      msg.innerHTML='<b>'+manual.length+' 枚</b>には位置情報がありません。<br><span style="font-size:12px">使う場所を、地図で1枚ずつ選びます。</span>';
      foot.innerHTML='<button class="btn" id="manual" style="margin-top:16px">地図で場所を選ぶ</button><button class="btn g" id="x" style="margin-top:8px">やめる</button>';
      foot.querySelector('#x').onclick=closeSheet;foot.querySelector('#manual').onclick=function(){closeSheet();startManualPhotoImports(manual);};return;
    }
    if(already&&!noGeo){
      msg.innerHTML='<b>'+already+' 枚</b>は、すでに地図に入っています。<br>'+
        '<span style="font-size:12px">新しく入れるものはありませんでした。</span>';
      foot.innerHTML='<button class="btn g" id="x" style="margin-top:16px">とじる</button>';
      foot.querySelector('#x').onclick=closeSheet;
      return;
    }
    msg.innerHTML='位置情報のある写真が見つかりませんでした。<br>'+
      '<span style="font-size:12px">iPhoneなら「設定 → プライバシーとセキュリティ → '+
      '位置情報サービス → カメラ」をオンにしてください。</span>';
    foot.innerHTML='<button class="btn g" id="x" style="margin-top:16px">とじる</button>';
    foot.querySelector('#x').onclick=closeSheet;
    return;
  }

  // 近くて時間も近いものを、ひとつの場所にまとめる
  found.sort(function(a,b){return a.at-b.at;});
  var groups=[];
  found.forEach(function(p){
    var g=groups[groups.length-1];
    if(g){
      var d=Math.hypot((p.lat-g.lat)*111000,(p.lng-g.lng)*91000);
      var dt=Math.abs(p.at-g.at)/3600000;
      if(d<120&&dt<3){ g.items.push(p); return; }
    }
    groups.push({lat:p.lat,lng:p.lng,at:p.at,d:p.d,items:[p]});
  });

  msg.innerHTML='<b>'+found.length+' 枚</b>から <b>'+groups.length+' か所</b>が見つかりました。'+
    (noGeo?('<br><span style="font-size:12px">位置情報のない '+noGeo+' 枚は、後で場所を選びます。</span>'):'')+
    (already?('<br><span style="font-size:12px">すでに入っている '+already+' 枚は飛ばしました。</span>'):'');

  var list=s.querySelector('#blist');
  list.innerHTML='<div style="font-size:12px;color:var(--dim)">場所を調べています…</div>';
  for(var k=0;k<groups.length;k++){
    var r=await revGeo(groups[k].lat,groups[k].lng);
    groups[k].place=r.name;
    groups[k].name=(r.near&&r.near.n)||r.name;
    groups[k].cat=(r.near&&r.near.c)||'景';
  }

  list.innerHTML=groups.map(function(g,i){
    return '<div class="post" style="align-items:center">'+
      '<div class="av2" id="bth'+i+'"></div>'+
      '<div class="b"><b>'+esc(g.name)+'</b>'+
      '<span>'+esc(g.d||'')+' ・ '+g.items.length+'枚</span></div>'+
      '<button class="chip on" data-skip="'+i+'" style="flex:0 0 auto">入れる</button></div>';
  }).join('');

  groups.forEach(async function(g,i){
    try{var previewFile=await chosenCandidateFile(g.items[0].source,i),r2=new FileReader();
      r2.onload=function(){
      var e2=document.getElementById('bth'+i);
      if(e2)e2.style.backgroundImage='url('+JSON.stringify(r2.result)+')';
      };
      r2.readAsDataURL(previewFile);
    }catch(e){}
  });

  var skip={};
  Array.prototype.forEach.call(list.querySelectorAll('[data-skip]'),function(b){
    b.onclick=function(){
      var i=b.dataset.skip;
      skip[i]=!skip[i];
      b.classList.toggle('on',!skip[i]);
      b.textContent=skip[i]?'入れない':'入れる';
    };
  });

  foot.innerHTML='<button class="btn" id="go" style="margin-top:16px">'+
      'この '+groups.length+' か所を地図に置く'+(manual.length?'＋場所を選ぶ':'')+'</button>'+
    '<button class="btn g" id="x" style="margin-top:8px">やめる</button>';
  foot.querySelector('#x').onclick=closeSheet;

  foot.querySelector('#go').onclick=async function(){
    var btn=this; btn.disabled=true;
    var workScope=activeSpotScope;
    var use=groups.filter(function(g,i){return !skip[i];});
    var done=0, donePlaces=0;
    for(var i=0;i<use.length;i++){
      var g=use[i];
      btn.textContent=(i+1)+' / '+use.length+' を置いています…';
      var savedHere=0;
      for(var q=0;q<g.items.length;q++){
        var item=g.items[q];
        var itemFile=null;try{itemFile=await chosenCandidateFile(item.source,q);}catch(e){}
        var url=itemFile?await readAsData(itemFile):null;
        if(!url||activeSpotScope!==workScope)continue;
        var rec={id:nid(),n:g.name,c:g.cat,lat:item.lat,lng:item.lng,place:g.place||'',
          tag:'',d:item.d||new Date(item.at).toISOString().slice(0,10),photo:url,
          visibility:defaultPostVisibility(),owner_scope:workScope};
        if(!(await dbPut('spots',rec))){
          continue;
        }
        if(item.fp)await seenAdd(item.fp,workScope);
        if(activeSpotScope!==workScope)continue;
        spots.push(rec);
        if(typeof ensureLocalThumb==='function')ensureLocalThumb(rec);
        done++; savedHere++;
      }
      if(savedHere)donePlaces++;
    }
    if(activeSpotScope!==workScope)return;
    closeSheet(); render(true);
    setTip(done+'枚を '+donePlaces+'か所に置きました');
    if(fbUser)syncUp();
    if(manual.length)startManualPhotoImports(manual);
    else if(use.length) map.easeTo({center:[use[0].lng,use[0].lat],zoom:16.6,duration:900});
  };
}

function openAdd(p){
  var cat=p.cat||CATS[0];
  var tagged=[];        // 一緒にいた人
  var chosenVisibility=defaultPostVisibility();
  var sheetScope=activeSpotScope;

  /* 聞くことを絞る。場所も日付も写真から分かるので、聞かない */
  var html='<div class="grab"></div>'+
    (p.photo?'<div class="pv-wrap">'+
      '<img src="'+p.photo+'">'+
      '<button class="pv-btn" id="tag-btn">'+
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">'+
        '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>'+
      '</button>'+
      '<span class="pv-cnt" id="tag-cnt" style="display:none"></span>'+
    '</div>':'')+
    '<div class="pad">'+
      '<div style="font-size:18px;font-weight:700;line-height:1.4;margin-bottom:3px">'+
        esc(p.known||p.place||'この場所')+'</div>'+
      '<div style="font-size:12.5px;color:var(--dim);margin-bottom:16px">'+
        esc([p.place&&p.place!==p.known?p.place:'', p.date||'いま']
          .filter(Boolean).join('　'))+'</div>'+
      (!p.known?'<input class="fld" id="f-n" placeholder="場所の名前">':'')+
      '<input class="fld" id="f-t" placeholder="キャプションを追加…">'+
      '<div class="chips" id="sug" style="margin:-2px 0 12px;display:none"></div>'+
      (!p.photo?'<div class="photorow">'+
        '<label class="pick" id="p1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 7.5h4L8.5 5.5h7L17 7.5h4v12H3z"/><circle cx="12" cy="13" r="3.6"/></svg><span>撮る</span></label>'+
        '<label class="pick" id="p2"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 5.5h18v13H3z"/><path d="M3 15l5-4 4 3 3-3 6 5"/></svg><span>カメラロール</span></label>'+
      '</div>':'')+
      '<div class="post-vis-label">公開範囲</div>'+
      '<div class="chips post-vis" id="post-vis" role="radiogroup" aria-label="この思い出の公開範囲">'+
        [['private','自分だけ'],['friends','フレンド'],['public','みんな']].map(function(o){
          return '<button type="button" class="chip '+(chosenVisibility===o[0]?'on':'')+'" data-v="'+o[0]+'" role="radio" aria-checked="'+(chosenVisibility===o[0])+'">'+o[1]+'</button>';
        }).join('')+'</div>'+
      '<div class="post-vis-note" id="post-vis-note" aria-live="polite">'+visibilityDescription(chosenVisibility)+'</div>'+
      '<button class="btn" id="ok">ここに残す</button>'+
      '<button class="btn g" id="ng" style="margin-top:8px">やめる</button>'+
    '</div>';

  var s=showSheet(html);
  var ft=s.querySelector('#f-t');
  var nm=s.querySelector('#f-n');
  var ok=s.querySelector('#ok');
  var vis=s.querySelector('#post-vis'), visNote=s.querySelector('#post-vis-note');
  function setPostVisibility(value){
    chosenVisibility=value;
    if(!vis)return;
    Array.prototype.forEach.call(vis.querySelectorAll('.chip'),function(x){
      var on=x.dataset.v===value;x.classList.toggle('on',on);x.setAttribute('aria-checked',String(on));x.tabIndex=on?0:-1;
    });
    visNote.textContent=visibilityDescription(chosenVisibility);
  }
  if(vis)Array.prototype.forEach.call(vis.querySelectorAll('.chip'),function(b){
    b.onclick=function(){
      if(b.dataset.v==='private'&&tagged.length){
        setTip('タグ付けを外すと自分だけにできます');return;
      }
      setPostVisibility(b.dataset.v);
    };
  });
  if(vis)vis.onkeydown=function(e){
    if(['ArrowLeft','ArrowRight','Home','End'].indexOf(e.key)<0)return;
    var buttons=Array.prototype.slice.call(vis.querySelectorAll('.chip'));
    var i=buttons.indexOf(document.activeElement),next=e.key==='Home'?0:e.key==='End'?buttons.length-1:
      (i+(e.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
    e.preventDefault();buttons[next].focus();buttons[next].click();
  };
  setPostVisibility(chosenVisibility);

  function sync(){ ok.disabled = nm ? !nm.value.trim() : false; }
  if(nm) nm.oninput=sync;
  sync();

  s.querySelector('#ng').onclick=function(){closeSheet();finishManualPhotoImport();};
  var p1=s.querySelector('#p1'), p2=s.querySelector('#p2');
  if(p1) p1.onclick=function(){
    closeSheet();
    if(typeof chooseSinglePhoto==='function')chooseSinglePhoto(true);
    else document.getElementById('in-cam').click();
  };
  if(p2) p2.onclick=function(){
    closeSheet();
    if(typeof chooseSinglePhoto==='function')chooseSinglePhoto(false);
    else document.getElementById('in-lib').click();
  };

  /* 一緒にいた人を選ぶ */
  var tb=s.querySelector('#tag-btn'), tc=s.querySelector('#tag-cnt');
  function showCount(){
    if(!tc)return;
    if(tagged.length){ tc.style.display='block'; tc.textContent=tagged.length+'人';
      tb.classList.add('has'); }
    else { tc.style.display='none'; tb.classList.remove('has'); }
  }
  if(tb) tb.onclick=function(){
    openTagPicker(tagged,function(sel){
      tagged=sel;showCount();
      if(tagged.length&&chosenVisibility==='private'){
        setPostVisibility('friends');
        setTip('タグ付けしたためフレンド公開にしました');
      }
    });
  };

  ok.onclick=async function(){
    if(activeSpotScope!==sheetScope){closeSheet();setTip('アカウントが変わったため保存を中止しました');return;}
    ok.disabled=true;ok.textContent='保存しています…';
    var rec={id:nid(),n:(nm?nm.value.trim():p.known)||p.place||'この場所',
      c:cat,lat:p.lat,lng:p.lng,place:p.place||'',
      tag:ft.value.trim(),d:p.date||new Date().toISOString().slice(0,10),
      photo:p.photo||'', tagged:tagged.map(function(u){return u.id;}),
      visibility:chosenVisibility,owner_scope:sheetScope};
    if(!(await dbPut('spots',rec))){
      ok.disabled=false;ok.textContent='ここに残す';setTip('端末へ保存できませんでした');return;
    }
    if(p.fp)await seenAdd(p.fp,sheetScope);
    if(activeSpotScope!==sheetScope){closeSheet();return;}
    spots.push(rec);
    if(typeof ensureLocalThumb==='function')ensureLocalThumb(rec);
    closeSheet(); render(true); setTip('残しました');finishManualPhotoImport();
    if(fbUser) pushOne(rec).then(function(o){
      if(o&&rec.server_id&&tagged.length){
        api('/api/tags',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({post_id:rec.server_id,
            user_ids:tagged.map(function(u){return u.id;})})}).catch(function(){});
      }
      if(o)render(true);
    });
  };
  if(!p.known&&!p.photo&&nm) setTimeout(function(){nm.focus();},340);
}

/* ============================================================
   友達をタグ付け
   ============================================================ */
async function openTagPicker(current, done){
  if(!fbUser){ setTip('ログインが必要です'); return; }
  var sel=(current||[]).slice();

  var s=showSheet('<div class="grab"></div>'+
    '<div class="tg-head"><span style="width:56px"></span>'+
    '<b>友達をタグ付け</b>'+
    '<button id="tg-ok">完了</button></div>'+
    '<div class="pad"><input class="fld" id="tg-q" placeholder="友達を探す"></div>'+
    '<div id="tg-list" style="padding-bottom:22px">'+
      '<div style="padding:18px 16px;font-size:13px;color:var(--dim)">読み込んでいます…</div>'+
    '</div>');

  var list=s.querySelector('#tg-list');
  var r=await api('/api/friends');
  var friends=[];
  if(r.ok){ var j=await r.json(); friends=j.friends||[]; }

  function draw(q){
    var f=friends.filter(function(u){
      if(!q)return true;
      return (u.display_name||'').indexOf(q)>=0 || (u.handle||'').indexOf(q)>=0;
    });
    if(!f.length){
      list.innerHTML='<div style="padding:22px 16px;text-align:center;'+
        'font-size:13px;color:var(--dim);line-height:1.9">'+
        (friends.length?'見つかりません':'まだフレンドがいません。<br>'+
        'アカウントからIDを交換してください。')+'</div>';
      return;
    }
    list.innerHTML=f.map(function(u){
      var on=sel.some(function(x){return x.id===u.id;});
      var nm=u.display_name||u.handle||'';
      return '<div class="tg-row" data-id="'+esc(u.id)+'">'+
        '<div class="av">'+esc(nm.charAt(0))+'</div>'+
        '<div class="nm"><b>'+esc(nm)+'</b><span>@'+esc(u.handle||'')+'</span></div>'+
        '<button class="pick'+(on?' on':'')+'">'+(on?'解除':'タグ付け')+'</button></div>';
    }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('.tg-row'),function(row){
      row.querySelector('.pick').onclick=function(){
        var id=row.dataset.id;
        var i=sel.findIndex(function(x){return x.id===id;});
        if(i>=0) sel.splice(i,1);
        else {
          var u=friends.filter(function(x){return x.id===id;})[0];
          if(u) sel.push(u);
        }
        draw(s.querySelector('#tg-q').value.trim());
      };
    });
  }
  draw('');
  s.querySelector('#tg-q').oninput=function(){ draw(this.value.trim()); };
  s.querySelector('#tg-ok').onclick=function(){ closeSheet(); done(sel); };
}
