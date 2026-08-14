/* ============================================================
   アプリとして動いているときは、iOSの仕組みを使う

   HTMLの入力欄はアプリの中だと制限がある。
   Capacitorの部品があればそちらを使い、
   無ければ（ブラウザなら）今まで通りの方法にする。
   ============================================================ */
const isApp = !!(window.Capacitor && window.Capacitor.isNativePlatform &&
                 window.Capacitor.isNativePlatform());

function plugin(name){
  return (window.Capacitor && window.Capacitor.Plugins &&
          window.Capacitor.Plugins[name]) || null;
}

/** 写真を1枚。撮るか、選ぶか */
function blobToPhotoDataUrl(blob){
  return new Promise(function(resolve,reject){
    var reader=new FileReader();
    reader.onload=function(){resolve(typeof reader.result==='string'?reader.result:'');};
    reader.onerror=function(){reject(reader.error||new Error('photo read failed'));};
    reader.readAsDataURL(blob);
  });
}

async function mediaPhotoDataUrl(photo){
  if(!photo)return '';
  if(photo.dataUrl)return photo.dataUrl;
  if(photo.base64String)return 'data:image/jpeg;base64,'+photo.base64String;
  var source=photo.webPath||nativePhotoUrl({path:photo.uri||photo.path});
  if(!source)return '';
  var sourceUrl=new URL(source,location.href);
  // 写真プラグインが作ったアプリ内URLだけを読む。外部URLへ写真取得を広げない。
  if(sourceUrl.origin!==location.origin)throw new Error('photo source origin');
  var response=await fetch(sourceUrl.href);
  if(!response.ok)throw new Error('photo file '+response.status);
  return blobToPhotoDataUrl(await response.blob());
}

function mediaPhotoExif(photo){
  var meta=photo&&photo.metadata||{};
  var exif=meta.exif!=null?meta.exif:(photo&&photo.exif);
  try{if(typeof exif==='string')exif=JSON.parse(exif);}catch(e){exif={};}
  if(!exif||typeof exif!=='object')exif={};
  if(meta.creationDate&&!exif.CreateDate)exif.CreateDate=meta.creationDate;
  return exif;
}

async function pickPhoto(fromCamera){
  var Camera=plugin('Camera');
  if(!isApp||!Camera){
    document.getElementById(fromCamera?'in-cam':'in-lib').click();
    return null;
  }
  try{
    // Capacitor 8.1以降の現行APIを優先する。旧getPhotoは残っているが非推奨で、
    // 選択元ごとに返却形式が変わるため、アップデート後に新規追加だけ止まり得る。
    if(Camera.takePhoto&&Camera.chooseFromGallery){
      try{
        var media=fromCamera
          ? await Camera.takePhoto({quality:96,targetWidth:4096,targetHeight:4096,
              correctOrientation:true,encodingType:0,editable:'no',saveToGallery:false,
              includeMetadata:true})
          : ((await Camera.chooseFromGallery({mediaType:0,allowMultipleSelection:false,
              limit:1,quality:96,targetWidth:4096,targetHeight:4096,
              correctOrientation:true,editable:'no',includeMetadata:true})).results||[])[0];
        var mediaUrl=await mediaPhotoDataUrl(media);
        if(mediaUrl)return {dataUrl:mediaUrl,file:null,exif:mediaPhotoExif(media)};
        throw new Error('empty photo result');
      }catch(modernError){
        // 選択キャンセルでは別の選択画面を重ねない。それ以外は、移行途中の端末でも
        // 追加を止めないよう、プラグインに残る互換APIへ一度だけ退避する。
        if(/cancel/i.test(String(modernError&&modernError.message||modernError))||!Camera.getPhoto)
          throw modernError;
      }
    }
    var r=await Camera.getPhoto({
      quality:96,
      // 48MP写真をdata URLのままWebViewへ展開するとメモリを圧迫する。
      // 長辺4096pxならRetina表示と拡大閲覧の品質を保ちながら安定して保存できる。
      width:4096,
      height:4096,
      allowEditing:false,
      // 画像本体は、iOS WebViewで最も安定して受け取れるdata URLを使う。
      // GPSは画像の再解析だけに頼らず、Camera pluginのexifから直接読む。
      resultType:'dataUrl',
      source:fromCamera?'CAMERA':'PHOTOS',
      saveToGallery:false
    });
    if(r&&r.dataUrl)return {dataUrl:r.dataUrl,file:null,exif:r.exif||{}};
    setTip('写真を読み込めませんでした');
    return null;
  }catch(e){
    var message=String(e&&e.message||e||'');
    if(/permission|denied/i.test(message))
      setTip('設定でカメラ・写真の使用を許可してください');
    else if(!/cancel/i.test(message))setTip('写真を開けませんでした。もう一度お試しください');
    return null;
  }
}

/** どの画面から開いても、写真選択後は同じ追加フローへ進める。 */
async function chooseSinglePhoto(fromCamera){
  setTip(fromCamera?'カメラを開いています…':'写真を開いています…');
  var picked=await pickPhoto(fromCamera);
  if(!picked)return false;
  setTip('写真の位置情報を確認しています…');
  await afterPhoto(picked.dataUrl,picked.file,picked.exif);
  return true;
}
window.chooseSinglePhoto=chooseSinglePhoto;

/** まとめて選ぶ */
async function pickPhotos(){
  var Camera=plugin('Camera');
  if(!isApp||!Camera){
    document.getElementById('in-bulk').click();
    return null;
  }
  try{
    // 単独追加と同じCapacitor 8.1以降の現行APIを使う。旧pickImagesの一時URLは
    // 選別画面を操作している間に読めなくなり、保存時に0枚となる端末がある。
    if(Camera.chooseFromGallery){
      try{
        var modern=await Camera.chooseFromGallery({mediaType:0,allowMultipleSelection:true,
          limit:200,quality:96,targetWidth:4096,targetHeight:4096,
          correctOrientation:true,editable:'no',includeMetadata:true});
        return (modern&&modern.results)||[];
      }catch(modernError){
        if(/cancel/i.test(String(modernError&&modernError.message||modernError)))return [];
        if(!Camera.pickImages)throw modernError;
      }
    }
    // Capacitorを更新できていない端末だけ、互換APIへ一度だけ退避する。
    if(Camera.pickImages){
      var legacy=await Camera.pickImages({quality:96,width:4096,height:4096,limit:200});
      return (legacy&&legacy.photos)||[];
    }
    document.getElementById('in-bulk').click();
    return null;
  }catch(e){
    if(!/cancel/i.test(String(e&&e.message||e)))setTip('写真を開けませんでした。もう一度お試しください');
    return [];
  }
}

function nativePhotoUrl(photo){
  if(!photo)return '';
  if(photo.webPath)return photo.webPath;
  var path=photo.uri||photo.path||'';
  if(path&&window.Capacitor&&typeof window.Capacitor.convertFileSrc==='function')
    return window.Capacitor.convertFileSrc(path);
  return path;
}

/** 現在地。アプリなら許可を先に尋ねる */
async function whereAmI(){
  var Geo=plugin('Geolocation');
  if(isApp&&Geo){
    try{
      var st=await Geo.checkPermissions();
      if(st.location!=='granted'){
        st=await Geo.requestPermissions();
      }
      if(st.location!=='granted') return null;
      var p=await Geo.getCurrentPosition({enableHighAccuracy:true,timeout:15000});
      return {lat:p.coords.latitude,lng:p.coords.longitude,acc:p.coords.accuracy};
    }catch(e){ return null; }
  }
  return new Promise(function(res){
    if(!navigator.geolocation)return res(null);
    navigator.geolocation.getCurrentPosition(function(p){
      res({lat:p.coords.latitude,lng:p.coords.longitude,acc:p.coords.accuracy});
    },function(){ res(null); },
      {enableHighAccuracy:true,timeout:15000,maximumAge:60000});
  });
}


/* ============================================================
   通知

   フレンドが新しい場所を記録したときに知らせる。
   アプリのときだけ。断られても普通に使える。
   ============================================================ */
async function setupPush(){
  try{
    if(!isApp)return;
    var P=plugin('PushNotifications');
    if(!P)return;

    var st=await P.checkPermissions();
    if(st.receive==='prompt'||st.receive==='prompt-with-rationale'){
      st=await P.requestPermissions();
    }
    if(st.receive!=='granted')return;

    if(window.__spotaPushRegistration&&window.__spotaPushRegistration.remove){
      try{await window.__spotaPushRegistration.remove();}catch(e){}
    }
    // registerより先にlistenerを置く。即時に返るtokenを取りこぼさない。
    window.__spotaPushRegistration=await P.addListener('registration',function(t){
      window.__spotaPushToken=t.value;
      try{localStorage.setItem('spota_push_token',t.value);}catch(e){}
      // この端末の宛先をサーバーへ預ける
      api('/api/push/token',{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({token:t.value,platform:'ios'})}).catch(function(){});
    });
    if(!window.__spotaPushAction)window.__spotaPushAction=await P.addListener('pushNotificationActionPerformed',function(ev){
      // Pushに正確な座標は入れない。通知種別から認証済み画面だけを開く。
      var d=(ev&&ev.notification&&ev.notification.data)||{};
      if(d.conversation&&typeof openConversation==='function')openConversation(String(d.conversation),'メッセージ');
      else if(d.profile&&typeof openPublicProfile==='function')openPublicProfile(String(d.profile));
      else if(d.post&&typeof openSocialHub==='function')openSocialHub('timeline');
    });
    await P.register();
  }catch(e){}
}

/* ============================================================
   起動したら、まず自分のいる場所を映す
   ・許可されていなければ、ここで初めて尋ねる
   ・断られても地図は普通に使える
   ============================================================ */
let locDone=false;
function showMe(lat,lng,acc){
  if(meM)meM.remove();
  var d=document.createElement('div');
  d.style.cssText='width:15px;height:15px;border-radius:50%;background:#1E88E5;'+
    'border:2.5px solid #fff;box-shadow:0 0 0 6px rgba(30,136,229,.22),0 2px 8px rgba(0,0,0,.35)';
  meM=new maplibregl.Marker({element:d}).setLngLat([lng,lat]).addTo(map);
}
async function goHome(quiet){
  var p=await whereAmI();
  if(!p){
    if(!quiet) setTip('現在地を使えません。設定から許可してください');
    autoLoad(true);                 // 位置が取れなくても、いま見えている辺りは読む
    return;
  }
  locDone=true;
  map.easeTo({center:[p.lng,p.lat],zoom:p.acc>2000?14:16.4,duration:900});
  showMe(p.lat,p.lng,p.acc);
  setTimeout(function(){ autoLoad(true); },900);
}

/* 地図のstyleとnative.jsは通信状況によって完了順が入れ替わる。
   どちらが先でも、両方が揃った時点で初回の現在地取得を一度だけ始める。 */
function requestInitialHome(){
  if(locDone||window.__homed)return;
  window.__homed=1;
  goHome(false);
}
window.requestInitialHome=requestInitialHome;
if(window.__michikusaMapReady)requestInitialHome();

// 設定アプリから位置許可を変更して戻ったときは、初回失敗を引きずらない。
try{
  var App=plugin('App');
  if(App&&App.addListener)App.addListener('appStateChange',async function(state){
    if(!state||!state.isActive)return;
    var Geo=plugin('Geolocation'),granted=false;
    try{var permission=Geo&&await Geo.checkPermissions();granted=!!permission&&permission.location==='granted';}catch(e){}
    if(locDone&&!granted){
      locDone=false;window.__homed=0;
      if(meM){meM.remove();meM=null;}
      map.jumpTo({center:[138.2529,36.2048],zoom:4.6,pitch:0,bearing:0});
      if(typeof autoLoad==='function')autoLoad(true);
      return;
    }
    if(!locDone){window.__homed=0;requestInitialHome();}
  });
}catch(e){}

/* ============================================================
   写真 / 現在地 / 昼夜
   ============================================================ */
document.getElementById('btn-cam').onclick=async function(){
  await chooseSinglePhoto(true);
};
document.getElementById('btn-lib').onclick=async function(){
  await chooseSinglePhoto(false);
};

function validPhotoGps(g){
  if(!g||g.latitude==null||g.longitude==null)return false;
  var lat=Number(g&&g.latitude),lng=Number(g&&g.longitude);
  return isFinite(lat)&&isFinite(lng)&&lat>=-90&&lat<=90&&lng>=-180&&lng<=180;
}

function exifCoordinate(value){
  if(Array.isArray(value)){
    var parts=value.map(exifCoordinate);
    if(parts.length>=3&&parts.slice(0,3).every(function(x){return isFinite(x);}))
      return parts[0]+parts[1]/60+parts[2]/3600;
    return parts.length?parts[0]:NaN;
  }
  if(value&&typeof value==='object'){
    var n=Number(value.numerator),d=Number(value.denominator);
    return isFinite(n)&&isFinite(d)&&d?n/d:Number(value.value);
  }
  if(typeof value==='string'&&/[ ,]/.test(value)){
    var xs=value.trim().split(/[ ,]+/).map(Number);
    if(xs.length>=3&&xs.slice(0,3).every(function(x){return isFinite(x);}))
      return xs[0]+xs[1]/60+xs[2]/3600;
  }
  return Number(value);
}

function gpsFromNativeExif(exif){
  if(!exif)return null;
  try{
    if(typeof exif==='string')exif=JSON.parse(exif);
    var g=exif.GPS||exif.gps||exif['{GPS}']||exif;
    var lat=exifCoordinate(g.GPSLatitude!=null?g.GPSLatitude:g.Latitude);
    var lng=exifCoordinate(g.GPSLongitude!=null?g.GPSLongitude:g.Longitude);
    if(String(g.GPSLatitudeRef||g.LatitudeRef||'').toUpperCase()==='S')lat=-Math.abs(lat);
    if(String(g.GPSLongitudeRef||g.LongitudeRef||'').toUpperCase()==='W')lng=-Math.abs(lng);
    return validPhotoGps({latitude:lat,longitude:lng})?{lat:lat,lng:lng}:null;
  }catch(e){return null;}
}

function dateFromNativeExif(exif){
  if(!exif)return null;
  try{
    if(typeof exif==='string')exif=JSON.parse(exif);
    var raw=exif.DateTimeOriginal||exif.DateTimeDigitized||exif.CreateDate||'';
    var m=String(raw).match(/^(\d{4})[:-]?(\d{2})[:-]?(\d{2})/);
    return m?m[1]+'-'+m[2]+'-'+m[3]:null;
  }catch(e){return null;}
}

function startManualPhotoPlacement(dataUrl,date){
  var c=map.getCenter();
  startPlacing(c.lat,c.lng,{photo:dataUrl,date:date,manualPhotoLocation:true});
  setTip('写真の場所を地図で選んでください');
}

function askPhotoLocation(dataUrl,date,gps){
  if(!gps){
    startManualPhotoPlacement(dataUrl,date);
    return;
  }
  var decided=false;
  var s=showSheet('<div class="grab"></div><div class="pad photo-location-choice">'+
    '<div class="photo-location-kicker">写真の位置情報</div>'+
    '<h2>撮影した場所を使いますか？</h2>'+
    '<p>この写真には位置情報が入っています。写真の位置へピンを立てます。</p>'+
    '<button class="btn" id="photo-gps-yes">はい、写真の位置を使う</button>'+
    '<button class="btn g" id="photo-gps-no">いいえ、地図から選ぶ</button>'+
    '<button class="photo-location-cancel" id="photo-gps-cancel">キャンセル</button>'+
    '</div>',function(){if(!decided){setTip('写真の追加をキャンセルしました');if(typeof finishManualPhotoImport==='function')finishManualPhotoImport();}});
  s.querySelector('#photo-gps-yes').onclick=function(){
    decided=true;
    closeSheet();
    startPlacing(gps.lat,gps.lng,{photo:dataUrl,date:date,photoGps:true});
  };
  s.querySelector('#photo-gps-no').onclick=function(){
    decided=true;
    closeSheet();
    startManualPhotoPlacement(dataUrl,date);
  };
  s.querySelector('#photo-gps-cancel').onclick=function(){decided=true;closeSheet();setTip('写真の追加をキャンセルしました');if(typeof finishManualPhotoImport==='function')finishManualPhotoImport();};
}

/* 写真を受け取ったあとの流れ。EXIF GPSを確認してから位置を決める */
async function afterPhoto(dataUrl,file,nativeExif){
  var gps=gpsFromNativeExif(nativeExif),date=dateFromNativeExif(nativeExif);
  // ネイティブではCamera pluginが元画像のEXIFを返す。
  // 外部exifrの読込を待たず、カメラ・ライブラリ選択直後に次へ進む。
  if(isApp&&nativeExif!=null){
    askPhotoLocation(dataUrl,date,gps);
    return;
  }
  await Promise.race([
    need('exifr'),
    new Promise(function(resolve){setTimeout(function(){resolve(false);},4000);})
  ]);
  try{
    if(typeof exifr!=='undefined'){
      var target=file||dataUrl;
      var g=await exifr.gps(target).catch(function(){return null;});
      if(validPhotoGps(g))gps={lat:Number(g.latitude),lng:Number(g.longitude)};
      var pp=await exifr.parse(target,{pick:['DateTimeOriginal','CreateDate']})
        .catch(function(){return null;});
      var d=pp&&(pp.DateTimeOriginal||pp.CreateDate);
      var time=d?new Date(d):null;
      if(time&&!isNaN(time.getTime()))date=time.toISOString().slice(0,10);
    }
  }catch(e){}
  askPhotoLocation(dataUrl,date,gps);
}
['in-cam','in-lib'].forEach(function(id){
  document.getElementById(id).onchange=async function(e){
    var f=e.target.files[0]; if(!f)return; e.target.value='';
    setTip('写真を読み込んでいます…');
    shrink(f,function(url){
      if(url)afterPhoto(url,f);
      else setTip('写真を読み込めませんでした。形式や容量を確認してください');
    });
  };
});

function shrink(file,cb){
  // 圧縮しない。原本をそのまま持つ。
  // 一度落とした画質は戻らないので、ここでケチらない。
  var r=new FileReader();
  r.onload=function(){ cb(r.result); };
  r.onerror=function(){ cb(null); };
  r.readAsDataURL(file);
}

document.getElementById('map-locate').onclick=async function(){
  var btn=this;
  setTip('現在地を取得しています…');
  var p=await whereAmI();
  if(!p){ setTip('現在地を使えません。設定から許可してください'); return; }
  locDone=true;
  map.easeTo({center:[p.lng,p.lat],zoom:p.acc>2000?14:16.6,duration:850});
  showMe(p.lat,p.lng,p.acc);
  setTip('現在地　誤差 約'+Math.round(p.acc)+'m');
};

window.setColorMode=function(mode){
  night=mode==='dark'; document.body.classList.toggle('dark',night);
  try{localStorage.setItem('mk_color_mode',mode);}catch(e){}
  applyTint(); setTip(night?'ダーク':'ライト');
};
