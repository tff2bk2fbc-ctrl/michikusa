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
/*
 * 「みんなの地図」で既定値のまま保存すると、投稿が直後に消えて保存失敗に
 * 見える。一方、閲覧中という理由だけで public にすると意図しない公開になる。
 * 共有地図では未選択から始め、本人が公開範囲をタップするまで保存させない。
 */
function initialPostVisibility(){
  return typeof mapAudience!=='undefined'&&mapAudience==='public'
    ?null:defaultPostVisibility();
}
function visibilityLabel(v){
  return {private:'自分だけ',friends:'フレンド',public:'みんな'}[v]||'自分だけ';
}
function precisionLabel(v){
  return {exact:'正確な位置',approx:'約500m',area:'約2kmのエリア',hidden:'位置なし'}[v]||'位置なし';
}
function visibilityDescription(v){
  if(!v)return '公開範囲を選んでください';
  if(v==='private')return '自分だけに表示されます';
  var settings=meP&&meP.settings||{};
  // 設定取得が一時失敗しても、サーバー既定値と違う「位置なし」を表示しない。
  // 公開前の説明と実際の配信精度を一致させる。
  var precision=v==='friends'?(settings.friend_precision||'exact'):
    (settings.public_precision||'approx');
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

async function photoForLocalStorage(dataUrl){
  if(!dataUrl)return '';
  // ブラウザの写真選択は48MP原本を返すことがある。原本data URLをそのまま
  // IndexedDBへ書くと容量超過で全件失敗するため、表示品質を保つ4096px JPEGに揃える。
  if(typeof resize==='function'){
    var bounded=await resize(dataUrl,4096,.94);
    if(bounded)return bounded;
  }
  return dataUrl;
}

async function putSpotWithStorageRecovery(rec){
  if(await dbPut('spots',rec))return true;
  // 同期済みの高解像度コピーだけを整理してから、同じレコードを一度だけ再試行する。
  // 未同期の写真は対象外なので、通信失敗時の原本を失わない。
  if(typeof compactSyncedPhotos==='function')await compactSyncedPhotos();
  return dbPut('spots',rec);
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
  if(candidate.dataUrl){
    var match=/^data:(image\/[A-Za-z0-9.+-]+);base64,(.*)$/i.exec(candidate.dataUrl);
    if(!match)throw new Error('写真データが不正です');
    var raw=atob(match[2]),bytes=new Uint8Array(raw.length);for(var n=0;n<raw.length;n++)bytes[n]=raw.charCodeAt(n);
    var direct=new File([bytes],'memory-'+index+'.jpg',{type:match[1]});
    if(candidate.exif)Object.defineProperty(direct,'__spotaExif',{value:candidate.exif});candidate.file=direct;return direct;
  }
  if(!candidate.asset)throw new Error('写真参照なし');
  var assetUrl=new URL(candidate.asset,location.href);
  // ネイティブプラグインがアプリ内へ渡した写真だけを読む。外部URLは許可しない。
  var nativeBridge=!!candidate.nativeAsset&&
    /^(capacitor:|ionic:|https?:)$/.test(assetUrl.protocol)&&
    assetUrl.hostname==='localhost'&&assetUrl.pathname.indexOf('/_capacitor_file_')===0;
  if(assetUrl.origin!==location.origin&&!nativeBridge)throw new Error('写真参照元が不正です');
  var r=await fetch(assetUrl.href);if(!r.ok)throw new Error('写真取得 '+r.status);
  var b=await r.blob(),f=new File([b],'memory-'+index+'.jpg',{type:b.type||'image/jpeg'});
  if(candidate.exif)Object.defineProperty(f,'__spotaExif',{value:candidate.exif});
  // EXIF解析・プレビュー・保存で同じ一時URLを何度も読まない。
  candidate.file=f;
  return f;
}
function candidateExif(candidate){return candidate&&candidate.exif||(candidate&&candidate.file&&candidate.file.__spotaExif)||candidate&&candidate.__spotaExif||null;}
function openMemoryDeck(candidates,options){
  options=options||{};
  candidates=(options.daily?candidates.slice(0,1):secureShuffle(candidates).slice(0,200));if(!candidates.length){setTip('選ばれませんでした');return;}
  var screen=makeReleaseScreen(options.daily?'今日の1枚':'写真を選ぶ'),body=screen.querySelector('.release-body');screen.classList.add('memory-deck-screen');
  // Motion 50 B / Corner Split。左右の判定語を分け、進行方向を一目で読めるようにする。
  body.innerHTML='<section class="memory-deck" data-motion-50="B"><header><p id="deck-progress"><b id="deck-step">1</b> / '+candidates.length+'</p><span id="deck-instructions">右へ KEEP THIS・左へ NOT THIS</span></header><div class="memory-stage" id="memory-stage"><div class="memory-verdict yes" aria-hidden="true"><span>keep</span><span>this.</span></div><div class="memory-verdict no" aria-hidden="true"><span>not</span><span>this.</span></div><div class="memory-card" id="memory-card" role="group" tabindex="0" aria-describedby="deck-progress deck-instructions" aria-label="今日の写真候補。右矢印または右スワイプで使う、左矢印または左スワイプで使わない"><img id="memory-card-img" alt="選択する写真"></div></div><div class="memory-deck-actions"><button type="button" id="memory-no" aria-label="NOT THIS。写真を使わない">NOT THIS</button><button type="button" id="memory-yes" aria-label="KEEP THIS。写真を使う">KEEP THIS</button></div><div class="sr-only" id="memory-live" role="status" aria-live="polite" aria-atomic="true"></div></section>';
  var card=body.querySelector('#memory-card'),stage=body.querySelector('#memory-stage'),img=body.querySelector('#memory-card-img'),step=body.querySelector('#deck-step'),live=body.querySelector('#memory-live'),at=0,kept=[],busy=false,currentUrl='',alive=true,finishing=false,reduceDeck=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  screen.__onClose=function(){alive=false;if(currentUrl){URL.revokeObjectURL(currentUrl);currentUrl='';}if(options.onClose)options.onClose(finishing);};
  function preview(){
    if(!alive||releaseScreen!==screen||!screen.isConnected)return;
    if(currentUrl){URL.revokeObjectURL(currentUrl);currentUrl='';}
    if(at>=candidates.length){finish();return;}
    var c=candidates[at];step.textContent=String(at+1);card.style.transition='none';card.style.transform='';card.style.opacity='';stage.style.removeProperty('--decision-progress');stage.classList.remove('choose-yes','choose-no');
    if(c.file){currentUrl=URL.createObjectURL(c.file);img.src=currentUrl;}else img.src=c.asset;
  }
  function decide(use,direction){
    if(!alive||busy||at>=candidates.length)return;busy=true;stage.classList.add(use?'choose-yes':'choose-no');stage.style.setProperty('--decision-progress','1');card.style.transition=reduceDeck?'opacity .01ms':'transform .26s cubic-bezier(.2,.72,.2,1),opacity .2s';card.style.opacity='.12';card.style.transform=reduceDeck?'none':'translate3d('+(direction*(innerWidth+120))+'px,'+(use?'-18vh':'4vh')+',0) rotate('+(direction*7)+'deg)';live.textContent=use?'この写真を使います':'この写真は使いません';
    // スワイプ判定線で既に触覚を返した場合は、指を離した瞬間に二重発火させない。
    if(window.SpotaMotion&&!thresholdHit)window.SpotaMotion.haptic('rigid',.92);
    var candidate=candidates[at++];
    // デッキ中は原寸Blobを保持せず参照だけを残す。採用後の解析時に1枚ずつ読む。
    if(use)kept.push(candidate);
    if(options.onDecision)options.onDecision(use,candidate);
    setTimeout(function(){if(!alive||releaseScreen!==screen)return;busy=false;preview();},reduceDeck?0:220);
  }
  function finish(){
    if(!alive||releaseScreen!==screen||!screen.isConnected)return;
    if(currentUrl){URL.revokeObjectURL(currentUrl);currentUrl='';}finishing=true;alive=false;closeReleaseScreen();
    if(!kept.length){setTip(options.daily?'今日の候補は使いません':'使う写真は選ばれませんでした');return;}
    if(options.onKeep){options.onKeep(kept[0]);return;}
    setTip(kept.length+'枚を確認します');handleBulk(kept);
  }
  var dragging=false,locked=false,pointer=0,sx=0,sy=0,lastX=0,lastT=0,vx=0,thresholdHit=false;
  card.onpointerdown=function(e){if(busy||!e.isPrimary||(e.pointerType==='mouse'&&e.button!==0))return;dragging=true;locked=false;thresholdHit=false;pointer=e.pointerId;sx=lastX=e.clientX;sy=e.clientY;lastT=e.timeStamp;vx=0;card.style.transition='none';};
  card.onpointermove=function(e){if(!dragging||e.pointerId!==pointer)return;var dx=e.clientX-sx,dy=e.clientY-sy;if(!locked&&Math.max(Math.abs(dx),Math.abs(dy))>8){if(Math.abs(dy)>Math.abs(dx)*1.2){dragging=false;return;}locked=true;try{card.setPointerCapture(pointer);}catch(err){}}if(!locked)return;e.preventDefault();var dt=Math.max(1,e.timeStamp-lastT),instant=(e.clientX-lastX)/dt*1000;vx=vx*.65+instant*.35;lastX=e.clientX;lastT=e.timeStamp;var y=Math.max(-140,Math.min(70,dy*.42)),progress=Math.min(1,Math.abs(dx)/(card.offsetWidth*.30));card.style.transform='translate3d('+dx+'px,'+y+'px,0) rotate('+(dx/innerWidth*7)+'deg)';stage.style.setProperty('--decision-progress',String(progress));stage.classList.toggle('choose-yes',dx>12);stage.classList.toggle('choose-no',dx<-12);var nowHit=progress>=1;if(nowHit&&!thresholdHit&&window.SpotaMotion)window.SpotaMotion.haptic('rigid',.86);thresholdHit=nowHit;};
  function resetCard(){card.style.transition='transform .3s cubic-bezier(.18,.78,.24,1),opacity .18s';card.style.transform='';card.style.opacity='';stage.style.removeProperty('--decision-progress');stage.classList.remove('choose-yes','choose-no');thresholdHit=false;}
  function release(e){if(!dragging||e.pointerId!==pointer)return;dragging=false;var dx=e.clientX-sx,idle=e.timeStamp-lastT;if(idle>80)vx=0;var byDistance=Math.abs(dx)>card.offsetWidth*.28,bySpeed=Math.abs(vx)>760,go=byDistance||bySpeed,direction=byDistance?(dx>0?1:-1):(vx>0?1:-1);if(go)decide(direction>0,direction);else resetCard();}
  card.onpointerup=release;card.onpointercancel=function(){if(dragging){dragging=false;resetCard();}};card.onlostpointercapture=function(){if(dragging){dragging=false;resetCard();}};
  card.onkeydown=function(e){if(e.key==='ArrowRight'){e.preventDefault();decide(true,1);}else if(e.key==='ArrowLeft'){e.preventDefault();decide(false,-1);}};
  body.querySelector('#memory-no').onclick=function(){decide(false,-1);};body.querySelector('#memory-yes').onclick=function(){decide(true,1);};preview();
}

/* ============================================================
   1日1枚の思い出候補

   写真は、利用者がアルバム画面から明示的に有効化した後だけ読む。
   候補のプレビュと選択結果は端末内だけで扱い、「使う」後にのみ既存の追加フローへ進む。
   ============================================================ */
var DAILY_ENABLED='spota_daily_photo_enabled',DAILY_PLAN='spota_daily_photo_plan',
  DAILY_SEEN_LEGACY='spota_daily_photo_seen',dailyOpening=false,dailyTimer=0;
function localDay(now){
  var d=now||new Date(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');
  return d.getFullYear()+'-'+m+'-'+day;
}
function dailyEnabled(){try{return localStorage.getItem(DAILY_ENABLED)==='1';}catch(e){return false;}}
function dailyPlan(){try{return JSON.parse(localStorage.getItem(DAILY_PLAN)||'null');}catch(e){return null;}}
function randomMinute(){var a=new Uint32Array(1);crypto.getRandomValues(a);return 9*60+(a[0]%(12*60));}
function ensureDailyPlan(){
  var today=localDay(),plan=dailyPlan();if(plan&&plan.day===today)return plan;
  var parts=today.split('-').map(Number),minute=randomMinute(),due=new Date(parts[0],parts[1]-1,parts[2],Math.floor(minute/60),minute%60,0,0).getTime();
  plan={day:today,due:due,done:false};try{localStorage.setItem(DAILY_PLAN,JSON.stringify(plan));}catch(e){}return plan;
}
function saveDailyPlan(plan){try{localStorage.setItem(DAILY_PLAN,JSON.stringify(plan));}catch(e){}}
function retryDaily(plan){
  plan=plan||ensureDailyPlan();plan.done=false;plan.due=Date.now()+2*60*60*1000;saveDailyPlan(plan);
  dailyOpening=false;scheduleDailyCheck();
}
function finishDaily(){var plan=ensureDailyPlan();plan.done=true;saveDailyPlan(plan);dailyOpening=false;clearTimeout(dailyTimer);}
function discardDaily(Daily,item){
  finishDaily();
  if(Daily&&item&&item.dailyId&&typeof Daily.discard==='function')
    Promise.resolve(Daily.discard({id:item.dailyId})).catch(function(){});
}
function scheduleDailyCheck(){
  clearTimeout(dailyTimer);if(!dailyEnabled())return;var plan=ensureDailyPlan(),wait=Math.max(0,Number(plan.due)-Date.now());
  if(plan.done)return;dailyTimer=setTimeout(function(){maybeShowDailyPhoto();},Math.min(wait,15*60*1000));
}
async function maybeShowDailyPhoto(force){
  if(!dailyEnabled()||dailyOpening||!isApp||document.hidden)return scheduleDailyCheck();
  var plan=ensureDailyPlan();if(plan.done)return;if(!force&&Date.now()<Number(plan.due))return scheduleDailyCheck();
  if(typeof releaseScreen!=='undefined'&&releaseScreen||placing){dailyTimer=setTimeout(function(){maybeShowDailyPhoto();},10*60*1000);return;}
  var Daily=plugin('DailyPhoto');if(!Daily)return;
  dailyOpening=true;
  try{
    var permission=await Daily.authorizationStatus();
    if(!permission||['granted','limited'].indexOf(permission.status)<0){dailyOpening=false;if(permission&&permission.status==='denied'){try{localStorage.removeItem(DAILY_ENABLED);}catch(e){}}return;}
    var result=await Daily.randomCandidate(),candidate=result&&result.candidate;
    if(!candidate||!candidate.dataUrl){plan.done=true;saveDailyPlan(plan);dailyOpening=false;return;}
    openMemoryDeck([{asset:candidate.dataUrl,exif:candidate.exif||{},dailyId:candidate.id}],{
      daily:true,
      onClose:function(finished){if(!finished)discardDaily(Daily,candidate);},
      onDecision:function(use,item){if(!use)discardDaily(Daily,item);},
      onKeep:async function(item){
        try{
          // フル写真の読み込み中にログイン先が変わった場合、別アカウントの追加フローへ渡さない。
          var keepScope=activeSpotScope,keepAuth=null;
          if(typeof captureAuth==='function')keepAuth=await captureAuth().catch(function(){return null;});
          if(activeSpotScope!==keepScope||(keepAuth&&typeof authIsCurrent==='function'&&!authIsCurrent(keepAuth))){discardDaily(Daily,item);setTip('アカウントが変わったため追加を中止しました');return;}
          setTip('写真を準備しています…');var full=await Daily.photo({id:item.dailyId}),photo=full&&full.photo;
          if(activeSpotScope!==keepScope||(keepAuth&&typeof authIsCurrent==='function'&&!authIsCurrent(keepAuth))){discardDaily(Daily,item);setTip('アカウントが変わったため追加を中止しました');return;}
          if(!photo||!photo.dataUrl)throw new Error('empty photo');finishDaily();await afterPhoto(photo.dataUrl,null,photo.exif||item.exif||{});
        }catch(e){retryDaily(plan);setTip('写真を読めませんでした。2時間後にもう一度試します');}
      }
    });
  }catch(e){retryDaily(plan);}
}
async function setDailyPhotoEnabled(enable){
  var Daily=plugin('DailyPhoto');if(!isApp||!Daily){setTip('1日1枚の候補はiPhoneアプリで使えます');return false;}
  if(!enable){try{localStorage.removeItem(DAILY_ENABLED);localStorage.removeItem(DAILY_PLAN);localStorage.removeItem(DAILY_SEEN_LEGACY);}catch(e){}clearTimeout(dailyTimer);return true;}
  var status=await Daily.authorizationStatus();
  if(status.status==='prompt')status=await Daily.requestAuthorization();
  if(['granted','limited'].indexOf(status.status)<0){setTip('設定で写真の使用を許可してください');return false;}
  try{localStorage.setItem(DAILY_ENABLED,'1');localStorage.removeItem(DAILY_PLAN);localStorage.removeItem(DAILY_SEEN_LEGACY);}catch(e){}ensureDailyPlan();scheduleDailyCheck();setTip('1日1枚の思い出候補をはじめました');return true;
}
window.dailyEnabled=dailyEnabled;window.setDailyPhotoEnabled=setDailyPhotoEnabled;window.maybeShowDailyPhoto=maybeShowDailyPhoto;
document.addEventListener('visibilitychange',function(){if(!document.hidden)maybeShowDailyPhoto();});
window.addEventListener('focus',function(){maybeShowDailyPhoto();});
setTimeout(scheduleDailyCheck,1800);

async function chooseAlbumPhotos(){
  var got=await pickPhotos();
  if(got===null)return;              // ブラウザなら入力欄が開く
  if(!got.length){ setTip('選ばれませんでした'); return; }
  var candidates=got.map(function(photo){return {
    asset:typeof nativePhotoUrl==='function'?nativePhotoUrl(photo):(photo.webPath||photo.uri||photo.path||''),
    dataUrl:photo.dataUrl||'',
    exif:typeof mediaPhotoExif==='function'?mediaPhotoExif(photo):(photo.exif||{}),nativeAsset:true
  };}).filter(function(c){return !!(c.asset||c.dataUrl);});
  if(!candidates.length){setTip('写真を読めませんでした');return;}handleBulk(candidates);
}

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
  handleBulk(files.map(function(file){return {file:file};}));
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

  // 一括追加でも公開範囲を暗黙の既定値だけで決めない。ここで明示してから
  // 全写真へ同じ値を付けるため、「みんな」を選んだ投稿だけが共有地図へ出る。
  var bulkVisibility=initialPostVisibility();
  foot.innerHTML='<div class="post-vis-label bulk-vis-label">この写真すべての公開範囲</div>'+
    '<div class="chips post-vis" id="bulk-vis" role="radiogroup" aria-label="一括追加する写真の公開範囲">'+
      [['private','自分だけ'],['friends','フレンド'],['public','みんな']].map(function(o){
        return '<button type="button" class="chip '+(bulkVisibility===o[0]?'on':'')+'" data-v="'+o[0]+'" role="radio" aria-checked="'+(bulkVisibility===o[0])+'">'+o[1]+'</button>';
      }).join('')+'</div>'+
    '<div class="post-vis-note" id="bulk-vis-note" aria-live="polite">'+visibilityDescription(bulkVisibility)+'</div>'+
    '<button class="btn" id="go" style="margin-top:16px">公開範囲を選んでください</button>'+
    '<button class="btn g" id="x" style="margin-top:8px">やめる</button>';
  foot.querySelector('#x').onclick=closeSheet;
  var bulkVis=foot.querySelector('#bulk-vis'),bulkVisNote=foot.querySelector('#bulk-vis-note'),
    go=foot.querySelector('#go');
  function setBulkVisibility(value){
    bulkVisibility=value;
    Array.prototype.forEach.call(bulkVis.querySelectorAll('.chip'),function(x){
      var on=x.dataset.v===value;x.classList.toggle('on',on);x.setAttribute('aria-checked',String(on));x.tabIndex=on?0:-1;
    });
    bulkVisNote.textContent=visibilityDescription(value);
    go.disabled=!value;
    go.textContent=!value?'公開範囲を選んでください':
      (value==='public'?'この '+groups.length+' か所をみんなの地図へ公開':
       value==='friends'?'この '+groups.length+' か所をフレンドに共有':
       'この '+groups.length+' か所を自分だけに残す')+(manual.length?'＋場所を選ぶ':'');
  }
  Array.prototype.forEach.call(bulkVis.querySelectorAll('.chip'),function(b){
    b.onclick=function(){setBulkVisibility(b.dataset.v);};
  });
  bulkVis.onkeydown=function(e){
    if(['ArrowLeft','ArrowRight','Home','End'].indexOf(e.key)<0)return;
    var buttons=Array.prototype.slice.call(bulkVis.querySelectorAll('.chip'));
    var i=buttons.indexOf(document.activeElement),next=e.key==='Home'?0:e.key==='End'?buttons.length-1:
      (i+(e.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
    e.preventDefault();buttons[next].focus();buttons[next].click();
  };
  setBulkVisibility(bulkVisibility);

  go.onclick=async function(){
    var btn=this; btn.disabled=true;
    var workScope=activeSpotScope;
    var use=groups.filter(function(g,i){return !skip[i];});
    if(!use.length){
      btn.disabled=false;btn.textContent='地図に置く場所を選んでください';
      setTip('「入れる」を1か所以上選んでください');return;
    }
    var done=0, donePlaces=0, readFailed=0, saveFailed=0,readError='',landingRec=null;
    for(var i=0;i<use.length;i++){
      var g=use[i];
      btn.textContent=(i+1)+' / '+use.length+' を置いています…';
      var savedHere=0;
      for(var q=0;q<g.items.length;q++){
        var item=g.items[q];
        var itemFile=null;try{itemFile=await chosenCandidateFile(item.source,q);}catch(e){readFailed++;readError=String(e&&e.message||e||'写真の再読込に失敗').slice(0,80);}
        var url=itemFile?await readAsData(itemFile):null;
        if(!url){if(itemFile)readFailed++;continue;}
        if(activeSpotScope!==workScope)return;
        url=await photoForLocalStorage(url);
        var rec={id:nid(),n:g.name,c:g.cat,lat:item.lat,lng:item.lng,place:g.place||'',
          tag:'',d:item.d||new Date(item.at).toISOString().slice(0,10),photo:url,
          visibility:bulkVisibility,owner_scope:workScope};
        if(!(await putSpotWithStorageRecovery(rec))){
          saveFailed++;
          continue;
        }
        if(item.fp)await seenAdd(item.fp,workScope);
        if(activeSpotScope!==workScope)continue;
        spots.push(rec);
        if(!landingRec)landingRec=rec;
        if(typeof ensureLocalThumb==='function')ensureLocalThumb(rec);
        done++; savedHere++;
      }
      if(savedHere)donePlaces++;
    }
    if(activeSpotScope!==workScope)return;
    if(!done){
      btn.disabled=false;btn.textContent='もう一度試す';
      if(readFailed){
        msg.innerHTML='写真データを保存用に読み直せませんでした。<br><span style="font-size:12px">'+esc(readError||'写真を選び直して、もう一度お試しください。')+'</span>';
        setTip('写真データを読み直せませんでした: '+(readError||'不明なエラー'),'error');
      }else{
        var storageError=typeof dbFailureReason==='function'?dbFailureReason():'端末へ保存できませんでした';
        msg.innerHTML=esc(storageError)+'。<br><span style="font-size:12px">同期済み写真を整理して再試行しましたが、保存を確定できませんでした。</span>';
        setTip(storageError,'error');
      }
      return;
    }
    if(window.SpotaMotion)window.SpotaMotion.saveSuccess(document.getElementById('btn-cam'));
    closeSheet(); render(true);
    var failed=readFailed+saveFailed;
    setTip(done+'枚を '+donePlaces+'か所に置きました'+(failed?'（'+failed+'枚は追加できませんでした）':''),failed?'error':'success');
    if(fbUser)syncUp();
    if(manual.length)startManualPhotoImports(manual);
    else if(use.length) map.easeTo({center:[use[0].lng,use[0].lat],zoom:16.6,duration:900});
    if(landingRec&&window.SpotaMotion)window.SpotaMotion.photoLanding(landingRec.photo,landingRec.lng,landingRec.lat);
  };
}

function openAdd(p){
  var cat=p.cat||CATS[0];
  var tagged=[];        // 一緒にいた人
  var chosenVisibility=initialPostVisibility();
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
    ok.textContent=!value?'公開範囲を選んでください':
      value==='public'?'みんなの地図へ公開':
      value==='friends'?'フレンドに共有して残す':'自分だけに残す';
    sync();
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

  function sync(){ ok.disabled = !chosenVisibility || (nm ? !nm.value.trim() : false); }
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
    var localPhoto=await photoForLocalStorage(p.photo||'');
    var rec={id:nid(),n:(nm?nm.value.trim():p.known)||p.place||'この場所',
      c:cat,lat:p.lat,lng:p.lng,place:p.place||'',
      tag:ft.value.trim(),d:p.date||new Date().toISOString().slice(0,10),
      photo:localPhoto, tagged:tagged.map(function(u){return u.id;}),
      visibility:chosenVisibility,owner_scope:sheetScope};
    if(!(await putSpotWithStorageRecovery(rec))){
      ok.disabled=false;ok.textContent='ここに残す';
      setTip(typeof dbFailureReason==='function'?dbFailureReason():'端末へ保存できませんでした','error');return;
    }
    if(p.fp)await seenAdd(p.fp,sheetScope);
    if(activeSpotScope!==sheetScope){closeSheet();return;}
    spots.push(rec);
    if(typeof ensureLocalThumb==='function')ensureLocalThumb(rec);
    if(window.SpotaMotion)window.SpotaMotion.saveSuccess(document.getElementById('btn-cam'));
    closeSheet(); render(true); setTip('残しました','success');finishManualPhotoImport();
    if(rec.photo&&window.SpotaMotion)window.SpotaMotion.photoLanding(rec.photo,rec.lng,rec.lat);
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
