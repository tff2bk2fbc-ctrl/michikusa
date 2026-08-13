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
async function pickPhoto(fromCamera){
  var Camera=plugin('Camera');
  if(!isApp||!Camera){
    document.getElementById(fromCamera?'in-cam':'in-lib').click();
    return null;
  }
  try{
    var r=await Camera.getPhoto({
      quality:100,
      allowEditing:false,
      resultType:'dataUrl',
      source:fromCamera?'CAMERA':'PHOTOS',
      saveToGallery:false
    });
    return r&&r.dataUrl?r.dataUrl:null;
  }catch(e){ return null; }   // 途中でやめた場合もここに来る
}

/** まとめて選ぶ */
async function pickPhotos(){
  var Camera=plugin('Camera');
  if(!isApp||!Camera||!Camera.pickImages){
    document.getElementById('in-bulk').click();
    return null;
  }
  try{
    var r=await Camera.pickImages({quality:100,limit:0});
    return (r&&r.photos)||[];
  }catch(e){ return null; }
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

    await P.register();

    P.addListener('registration',function(t){
      // この端末の宛先をサーバーへ預ける
      api('/api/push/token',{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({token:t.value,platform:'ios'})}).catch(function(){});
    });
    P.addListener('pushNotificationActionPerformed',function(ev){
      // 通知から開いたとき、その場所へ飛ぶ
      var d=(ev&&ev.notification&&ev.notification.data)||{};
      if(d.lat&&d.lng){
        map.easeTo({center:[Number(d.lng),Number(d.lat)],zoom:16.5,duration:800});
      }
    });
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

/* ============================================================
   写真 / 現在地 / 昼夜
   ============================================================ */
document.getElementById('btn-cam').onclick=async function(){
  var url=await pickPhoto(true);
  if(url) afterPhoto(url,null);
};
document.getElementById('btn-lib').onclick=async function(){
  var url=await pickPhoto(false);
  if(url) afterPhoto(url,null);
};

/* 写真を受け取ったあとの流れ。位置は写真から読む */
async function afterPhoto(dataUrl,file){
  var gps=null,date=null;
  await need('exifr');
  try{
    if(typeof exifr!=='undefined'){
      var target=file||dataUrl;
      var g=await exifr.gps(target).catch(function(){return null;});
      if(g&&g.latitude!=null)gps={lat:g.latitude,lng:g.longitude};
      var pp=await exifr.parse(target,{pick:['DateTimeOriginal','CreateDate']})
        .catch(function(){return null;});
      var d=pp&&(pp.DateTimeOriginal||pp.CreateDate);
      if(d)date=new Date(d).toISOString().slice(0,10);
    }
  }catch(e){}
  if(!gps){
    var here=await whereAmI();
    if(here)gps={lat:here.lat,lng:here.lng};
  }
  var c=map.getCenter();
  startPlacing(gps?gps.lat:c.lat, gps?gps.lng:c.lng, {photo:dataUrl,date:date});
  if(!gps)setTimeout(function(){
    cfAsk.textContent='写真に位置情報がありません。場所を選んでください';},900);
}
['in-cam','in-lib'].forEach(function(id){
  document.getElementById(id).onchange=async function(e){
    var f=e.target.files[0]; if(!f)return; e.target.value='';
    setTip('写真を読み込んでいます…');
    shrink(f,function(url){ if(url) afterPhoto(url,f); });
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

document.getElementById('btn-loc').onclick=async function(){
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
