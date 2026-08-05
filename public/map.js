/* ============================================================
   地図の配色

   これまでは元の色を計算でずらしていたが、
   夜に道路が背景へ沈んでしまう問題があった。
   Apple Maps は夜でも道路が背景より明るい。そこが読みやすさの要。

   そこで計算をやめ、地図の部品ごとに色を割り当てる方式にする。
   ============================================================ */
const PALETTE={
  night:{
    land:      '#1C1C1E',   // 陸。落ち着いた黒に近いグレー
    water:     '#16305C',   // 水。青は残す
    green:     '#1F2A22',   // 公園・林。ほんのり緑
    road:      '#6B6B70',   // 大きな道。背景よりはっきり明るく
    roadMinor: '#48484D',   // 細い道
    roadCase:  '#141416',   // 道のふち
    rail:      '#3A3A3E',
    building:  '#2A2A2E',
    text:      '#F0F0F2',
    textSub:   '#A8A8AE',
    halo:      '#121214',
    border:    '#4A4A50'
  },
  day:{
    land:      '#F2F0EA',
    water:     '#A9CBE8',
    green:     '#D6E4CE',
    road:      '#FFFFFF',
    roadMinor: '#FFFFFF',
    roadCase:  '#E0DDD5',
    rail:      '#D8D4CB',
    building:  '#E6E2D9',
    text:      '#3A3A38',
    textSub:   '#7A7A76',
    halo:      '#FFFFFF',
    border:    '#D2CEC4'
  }
};

/* 地図の部品の名前から、どの役割かを見分ける */
function roleOf(L){
  var id=(L.id||'').toLowerCase();
  var sl=(L['source-layer']||'').toLowerCase();

  if(L.type==='background')                       return 'land';
  if(/water|ocean|sea|lake|river/.test(id+sl))    return 'water';
  if(/park|wood|forest|grass|green|golf|cemetery|pitch/.test(id+sl)) return 'green';
  if(/building/.test(id+sl))                      return 'building';
  if(/rail|transit|aeroway/.test(id+sl))          return 'rail';
  if(/boundary|admin/.test(id+sl))                return 'border';
  if(/tunnel|bridge|road|highway|street|path|transportation/.test(id+sl)){
    if(/case|outline|casing/.test(id))            return 'roadCase';
    if(/motorway|trunk|primary|secondary/.test(id)) return 'road';
    return 'roadMinor';
  }
  if(/landuse|landcover|earth|land/.test(id+sl))  return 'land';
  return null;
}

function retint(st){
  try{
    var C=PALETTE[night?'night':'day'];
    var s=JSON.parse(JSON.stringify(st));

    (s.layers||[]).forEach(function(L){
      try{
        if(!L.paint)L.paint={};

        if(L.type==='symbol'){
          var big=/place|city|town|country|state/.test((L.id||'')+(L['source-layer']||''));
          L.paint['text-color']=big?C.text:C.textSub;
          L.paint['text-halo-color']=C.halo;
          L.paint['text-halo-width']=1.6;
          return;
        }

        var role=roleOf(L);
        if(!role)return;
        var col=C[role];
        if(!col)return;

        if(L.type==='background') L.paint['background-color']=col;
        if(L.type==='fill'){
          L.paint['fill-color']=col;
          if('fill-outline-color' in L.paint) L.paint['fill-outline-color']=C.roadCase;
        }
        if(L.type==='line'){
          L.paint['line-color']=col;
          // 夜は道路をわずかに太く。細いと背景に沈む
          if(night&&(role==='road'||role==='roadMinor')){
            var w=L.paint['line-width'];
            if(typeof w==='number') L.paint['line-width']=w*1.25;
          }
          if(night&&role==='road') L.paint['line-opacity']=1;
        }
        if(L.type==='fill-extrusion') L.paint['fill-extrusion-color']=C.building;
      }catch(e){ /* この部品だけ飛ばす */ }
    });
    return s;
  }catch(e){
    showErr('[retint] '+dump(e));
    return st;                 // 失敗したら元の色のまま出す
  }
}

/* ---------- 地図 ---------- */
const map=new maplibregl.Map({
  container:'map',
  /* 以前は「元の色で読む → 色を変えて差し替える」の2段階だった。
     タイルを2回取りに行くので出るまで待たされる。
     いったん空で立ち上げ、色を変えたものを一度だけ渡す */
  style:{version:8,sources:{},layers:[
    {id:'bg',type:'background',paint:{'background-color':night?'#1C1C1E':'#F2F0EA'}}
  ]},
  center:[139.7745,35.7150],zoom:15.4,pitch:48,bearing:-12,maxPitch:70,
  antialias:true,
  fadeDuration:0,
  attributionControl:{
    compact:true,
    /* たたんだ状態で出す。ⓘ を押したときだけ開く */
    customAttribution:[
      '<a href="https://webservice.recruit.co.jp/" target="_blank">Powered by ホットペッパー グルメ</a>',
      '<a href="https://webservice.rakuten.co.jp/" target="_blank">Supported by 楽天ウェブサービス</a>',
      '<a href="https://ja.wikipedia.org/" target="_blank">Wikipedia</a>'
    ]
  }
});
/* 見た目の元を取ってきて、色を変えてから渡す */
(async function loadStyle(){
  try{
    var t0=performance.now();
    var r=await fetch(STYLE);
    baseStyle=await r.json();
    window.__tStyle=Math.round(performance.now()-t0);
    mark('見た目を取得');
    map.setStyle(retint(baseStyle),{diff:false});
    map.once('styledata',function(){ afterStyle(); });
  }catch(e){ showErr('[style] '+dump(e)); hideSplash(); }
})();
/* 地図が描けた時点で、待たせている画面を引く */
map.on('data',function(e){ if(e.tile) hideSplash(); });
setTimeout(function(){ hideSplash(); },3000);
function applyTint(){
  try{
    if(!baseStyle)return;
    map.setStyle(retint(baseStyle),{diff:false});
    map.once('styledata',function(){ afterStyle(); });
  }catch(e){ showErr('[applyTint] '+dump(e)); }
}
/* 3Dの建物。起動時に描くと重いので、あとから足す */
function addBuildings(){
  try{
    if(!is3D||map.getLayer('bld3d'))return;
    var st=map.getStyle(); if(!st||!st.layers)return;
    var src=null;
    for(var k in st.sources){ if(st.sources[k].type==='vector'){src=k;break;} }
    if(!src)return;
    var firstSym=null;
    for(var i=0;i<st.layers.length;i++){
      if(st.layers[i].type==='symbol'){firstSym=st.layers[i].id;break;} }
    map.addLayer({id:'bld3d',type:'fill-extrusion',source:src,'source-layer':'building',
      minzoom:14,paint:{
        'fill-extrusion-color':night?'#2A2A2E':'#E6E2D9',
        'fill-extrusion-height':['coalesce',['get','render_height'],['get','height'],6],
        'fill-extrusion-base':['coalesce',['get','render_min_height'],0],
        'fill-extrusion-opacity':night?0.72:0.88}},firstSym);
  }catch(e){}
}

function afterStyle(){
 try{
  // 地図に元からある店の文字を静かにする（写真ピンを主役にするため）
  var st=map.getStyle();
  (st.layers||[]).forEach(function(L){
    if(L.type!=='symbol'||L['source-layer']!=='poi')return;
    try{
      map.setLayoutProperty(L.id,'text-size',10.5);
      map.setPaintProperty(L.id,'text-opacity',0.75);
      map.setPaintProperty(L.id,'icon-opacity',0.45);
    }catch(e){}
  });
  if(is3D) setTimeout(addBuildings,700);   // 重いので後から
  SPRITE=null;
  Object.keys(ICON_CACHE).forEach(function(k){delete ICON_CACHE[k];});
  Object.keys(madeIcons).forEach(function(k){delete madeIcons[k];});
  addPlaceLayers();
  render(true);
  hideSplash();
  if(!locDone && !window.__homed){ window.__homed=1; goHome(false); }
 }catch(e){ showErr('[afterStyle] '+dump(e)); }
}

/* ============================================================
   写真ピン
   引きでは点、拡大すると写真になる
   ============================================================ */

/* ============================================================
   地図の上の表示

   ピンをHTMLで作ると、拡大縮小のあいだ地図と別々に動いてしまう。
   （HTMLは地図のアニメーションから遅れて追いつくため）
   なので地図そのものの中に描く。元からある店の記号と同じ仕組み。
   ============================================================ */
function photoOf(p){
  if(p.photo)return p.photo;
  var m=spots.filter(function(s){return s.n===p.n&&s.photo;});
  return m.length?m[m.length-1].photo:'';
}

/* 地図が元から持っている記号の名前に合わせる。
   これで自分で足した場所も、地図に元からある店と同じ絵になる */
/* 中の絵。地図が持っている名前の候補を、細かい順に並べる。
   実際にどれがあるかは走査して決める */
const ICON_ALT={
  '喫茶':['cafe','coffee','bakery','fast_food','restaurant','bar'],
  '食'  :['restaurant','fast_food','japanese','noodle','cafe'],
  '酒'  :['bar','alcohol_shop','pub','nightclub','beer','restaurant'],
  '湯'  :['hot_spring','onsen','spa','public_bath','swimming','beach','water'],
  '宿'  :['lodging','hotel','hostel','guest_house','shelter','building'],
  '社'  :['place_of_worship','shinto','buddhist','temple','shrine','religious',
          'monument','castle','historic','attraction'],
  '園'  :['park','garden','tree','forest','playground','picnic_site',
          'nature_reserve','grass','pitch','attraction'],
  '景'  :['attraction','viewpoint','monument','castle','museum','art_gallery',
          'tower','information'],
  '本'  :['library','books','stationery','shop'],
  '店'  :['shop','convenience','supermarket','grocery'],
  '駅'  :['rail','railway','train','subway','bus']
};

let SPRITE=null;
function scanSprite(){
  SPRITE={};
  try{
    // MapLibre が読み込み済みの絵の名前を全部もらう
    var names=(map.style&&map.style.imageManager&&map.style.imageManager.images)
      ? Object.keys(map.style.imageManager.images) : [];
    if(!names.length&&map.listImages) names=map.listImages();
    names.forEach(function(n){ SPRITE[n]=1; });
  }catch(e){}
  return SPRITE;
}
function findIcon(words){
  if(!SPRITE)scanSprite();
  var keys=Object.keys(SPRITE);
  for(var i=0;i<words.length;i++){
    var w=words[i];
    if(SPRITE[w])return w;
    // 名前の付け方は地図ごとに違うので、幅を持たせて探す
    for(var k=0;k<keys.length;k++){
      if(keys[k].indexOf(w)===0)return keys[k];
    }
    for(var k2=0;k2<keys.length;k2++){
      if(keys[k2].indexOf(w)>=0)return keys[k2];
    }
  }
  return '';
}
const ICON_CACHE={};
function pickIcon(cat){
  if(ICON_CACHE[cat]!==undefined)return ICON_CACHE[cat];
  var v=findIcon(ICON_ALT[cat]||ICON_ALT['景']);
  ICON_CACHE[cat]=v;
  return v;
}

function fcOf(list,mine){
  var big=map.getZoom()>=PHOTO_ZOOM;
  return {type:'FeatureCollection',features:list.filter(valid)
    // 自分の記録だけは写真で出すので、そのときは記号を出さない
    .filter(function(p){ return !(big&&mine&&p.photo); })
    .map(function(p){
      return {type:'Feature',geometry:{type:'Point',coordinates:[p.lng,p.lat]},
        properties:{n:p.n,c:p.c||'景',icon:pickIcon(p.c||'景'),mine:mine?1:0}};
    })};
}

let lastSig='';
function render(force){
 try{
  if(!map.getSource('mine'))return;
  map.getSource('mine').setData(fcOf(spots,true));
  map.getSource('spot').setData(fcOf(pois,false));
  if(map.getSource('frnd'))
    map.getSource('frnd').setData(fcOf(Object.keys(others).map(function(k){return others[k];}),false));
  refreshPhotoSource();
 }catch(e){ showErr('[render] '+dump(e)); }
}
map.on('moveend',function(){render();autoLoad();syncDown();});

/* 地図の中にレイヤーを積む */
function addPlaceLayers(){
  if(map.getSource('spot'))return;
  map.addSource('spot',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addSource('frnd',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addSource('mine',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addSource('photo',{type:'geojson',data:{type:'FeatureCollection',features:[]}});

  // まだ思い出のない場所。
  // 地図が元から描いている店（薄い丸に絵）と、大きさも濃さも揃える
  // 地図が元から描いている店とまったく同じ大きさ・濃さにする
  map.addLayer({id:'spot-dot',type:'circle',source:'spot',minzoom:14,paint:{
    'circle-radius':['interpolate',['linear'],['zoom'],14,7,16,8.5,18,10],
    'circle-color':night?'#3A3A3E':'#E9E6E0',
    'circle-stroke-width':0,'circle-opacity':.95}});
  map.addLayer({id:'spot-ic',type:'symbol',source:'spot',minzoom:14,layout:{
    'icon-image':['get','icon'],
    'icon-size':['interpolate',['linear'],['zoom'],14,.55,17,.72],
    'icon-allow-overlap':true,'icon-optional':true,
    // 名前を出さないと、丸だけが浮いて見える
    'text-field':['get','n'],
    'text-size':['interpolate',['linear'],['zoom'],14,10,17,11.5],
    'text-offset':[0,1.05],'text-anchor':'top','text-optional':true,'text-max-width':8,
    'text-padding':2,'text-allow-overlap':false
  },paint:{
    'text-color':night?'#D2D2D2':'#3E3E3E',
    'text-halo-color':night?'#000000':'#FFFFFF','text-halo-width':1.6,
    'icon-opacity':.8}});

  // フレンドの思い出
  map.addLayer({id:'frnd-ring',type:'circle',source:'frnd',paint:{
    'circle-radius':['interpolate',['linear'],['zoom'],12,4,15,6.5,18,9],
    'circle-color':'#1E88E5',
    'circle-stroke-color':night?'#000000':'#FFFFFF','circle-stroke-width':2.2}});
  map.addLayer({id:'frnd-ic',type:'symbol',source:'frnd',minzoom:14,layout:{
    'icon-image':['get','icon'],
    'icon-size':['interpolate',['linear'],['zoom'],14,.8,17,1.05],
    'icon-allow-overlap':true,'icon-optional':true,'icon-offset':[0,-24],
    'text-field':['get','n'],'text-size':11,'text-offset':[0,1.4],'text-anchor':'top',
    'text-optional':true,'text-max-width':9
  },paint:{
    'text-color':night?'#BBD9F5':'#1A5FA8',
    'text-halo-color':night?'#000000':'#FFFFFF','text-halo-width':1.7}});

  // 自分の思い出がある場所
  map.addLayer({id:'mine-ring',type:'circle',source:'mine',paint:{
    'circle-radius':['interpolate',['linear'],['zoom'],12,5,15,8,18,11],
    'circle-color':night?'#FAFAFA':'#111111',
    'circle-stroke-color':night?'#121214':'#FFFFFF','circle-stroke-width':2.4}});
  map.addLayer({id:'mine-ic',type:'symbol',source:'mine',minzoom:13.5,layout:{
    'icon-image':['get','icon'],
    'icon-size':['interpolate',['linear'],['zoom'],13.5,.85,17,1.15],
    'icon-allow-overlap':true,'icon-optional':true,'icon-offset':[0,-26],
    'text-field':['get','n'],'text-size':11.5,'text-offset':[0,1.5],'text-anchor':'top',
    'text-optional':true,'text-max-width':9
  },paint:{
    'text-color':night?'#FFFFFF':'#000000',
    'text-halo-color':night?'#121214':'#FFFFFF','text-halo-width':1.8}});

  // 写真の丸。地図の中に描くので、ズームしてもずれない
  map.addLayer({id:'photo-ic',type:'symbol',source:'photo',minzoom:PHOTO_ZOOM,layout:{
    'icon-image':['get','icon'],
    'icon-size':['interpolate',['linear'],['zoom'],
       PHOTO_ZOOM,['case',['==',['get','mine'],1],0.44,0.40],
       19,        ['case',['==',['get','mine'],1],0.60,0.54]],
    'icon-allow-overlap':true,'icon-anchor':'bottom','icon-offset':[0,6],
    'text-field':['get','n'],'text-size':11,'text-offset':[0,0.7],'text-anchor':'top',
    'text-optional':true,'text-max-width':8
  },paint:{
    'text-color':night?'#FFFFFF':'#111111',
    'text-halo-color':night?'#000000':'#FFFFFF','text-halo-width':1.7}});

  /* 押したときの判定は、地図のクリック処理側で一括して行う。
     レイヤーごとに受けると、順番の都合で二重に開いてしまう */
}


/* ============================================================
   写真を地図そのものに描く

   HTMLの要素を重ねると、拡大縮小のあいだ地図と別々に動いてしまう。
   （地図はcanvasの中で描かれ、HTMLはその外側で追いかけるため）

   そこで写真を丸く切り抜いた画像を作り、地図に登録して使う。
   地図の記号と同じ扱いになるので、ずれようがない。
   ============================================================ */
const PHOTO_ZOOM=16.2;         // これ以上寄ったら写真にする
const madeIcons={};            // 作った画像の名前
const makingIcons={};          // 作っている途中のもの

let photoDiag={try:0,ok:0,ngLoad:0,ngAdd:0,last:''};

/** 写真を丸く切り抜いて、地図に登録する */
function makeRoundIcon(url,mine,key){
  if(madeIcons[key]||makingIcons[key])return;
  makingIcons[key]=1;
  photoDiag.try++;

  var im=new Image();
  var src=url;
  if(!/^data:/.test(url)){
    // よその画像は自分のサーバーを通す。そうしないとCanvasで加工できない
    src=SERVER+'/api/img?u='+encodeURIComponent(url);
    im.crossOrigin='anonymous';
  }

  im.onload=function(){
    try{
      var S=128,R=S/2,ring=7;
      var cv=document.createElement('canvas');
      cv.width=S; cv.height=S;
      var x=cv.getContext('2d',{willReadFrequently:true});

      x.beginPath(); x.arc(R,R,R-1,0,Math.PI*2);
      x.fillStyle = mine ? (night?'#FAFAFA':'#111111') : (night?'#101010':'#FFFFFF');
      x.fill();

      x.save();
      x.beginPath(); x.arc(R,R,R-ring,0,Math.PI*2); x.clip();
      var s=Math.min(im.width,im.height);
      x.drawImage(im,(im.width-s)/2,(im.height-s)/2,s,s,ring,ring,S-ring*2,S-ring*2);
      x.restore();

      var dat=x.getImageData(0,0,S,S);
      if(map.hasImage(key))map.removeImage(key);
      // ImageData をそのまま渡すのが一番確実
      map.addImage(key,dat,{pixelRatio:2});

      madeIcons[key]=1;
      delete makingIcons[key];
      photoDiag.ok++;
      refreshPhotoSource();
    }catch(e){
      delete makingIcons[key];
      photoDiag.ngAdd++;
      photoDiag.last=String(e&&e.message||e);
    }
  };
  im.onerror=function(){
    delete makingIcons[key];
    photoDiag.ngLoad++;
    photoDiag.last='画像を読めない: '+String(url).slice(0,60);
  };
  im.src=src;
}

function photoKey(p,mine){
  // 名前と座標から、重ならない名前をつくる
  return 'ph_'+(mine?'m':'o')+'_'+
    String(p.n||'').replace(/[^A-Za-z0-9]/g,'').slice(0,12)+'_'+
    p.lat.toFixed(5)+'_'+p.lng.toFixed(5);
}

function photoFeatures(){
  var out=[];
  if(map.getZoom()<PHOTO_ZOOM)return out;
  var b=map.getBounds(), c=map.getCenter(), list=[];

  // 地図に写真で出るのは、自分が撮ったものだけ。
  // 店の宣材写真を並べると「グルメアプリ」になってしまう。
  // ここはアルバムなので、写っているのは自分の記録だけでいい。
  spots.filter(valid).forEach(function(s){
    if(b.contains([s.lng,s.lat])&&s.photo)list.push({p:s,mine:true,img:s.photo});
  });
  Object.keys(others).forEach(function(k){
    var o=others[k];
    if(valid(o)&&b.contains([o.lng,o.lat])&&o.photo)list.push({p:o,mine:false,img:o.photo});
  });

  list.sort(function(a,x){
    if(a.mine!==x.mine)return a.mine?-1:1;
    return Math.hypot(a.p.lat-c.lat,a.p.lng-c.lng)-Math.hypot(x.p.lat-c.lat,x.p.lng-c.lng);
  });
  list=list.slice(0,30);

  list.forEach(function(o){
    var key=photoKey(o.p,o.mine);
    if(!madeIcons[key]){ makeRoundIcon(o.img,o.mine,key); return; }
    out.push({type:'Feature',geometry:{type:'Point',coordinates:[o.p.lng,o.p.lat]},
      properties:{n:o.p.n,mine:o.mine?1:0,icon:key}});
  });
  return out;
}
function refreshPhotoSource(){
  if(map.getSource('photo'))
    map.getSource('photo').setData({type:'FeatureCollection',features:photoFeatures()});
}
