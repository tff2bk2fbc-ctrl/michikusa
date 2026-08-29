/* ============================================================
   地図の配色

   これまでは元の色を計算でずらしていたが、
   夜に道路が背景へ沈んでしまう問題があった。
   Apple Maps は夜でも道路が背景より明るい。そこが読みやすさの要。

   そこで計算をやめ、地図の部品ごとに色を割り当てる方式にする。
   ============================================================ */
/* 見た目は2種類。切り替えられる。
     apple … いまの標準。道が明るく、夜でも読める
     paper … 紙の地図。やわらかい黄緑の陸に、白い道 */
const THEMES={

apple:{
  name:'標準',
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
},

/* 紙に刷った地図。
   陸を白ではなく黄緑にすると、印刷物の空気になる。
   道は白のまま残し、ふちを濃くして輪郭を立てる。 */
paper:{
  name:'紙',
  day:{
    land:      '#E7EBDC',   // 陸。わずかに緑がかった生成り
    water:     '#A9CBE8',
    green:     '#D6E2C2',   // 公園。陸より少し濃く
    road:      '#FFFFFF',
    roadMinor: '#F4F5EE',
    roadCase:  '#DCDCD1',   // 道のふち。ここを効かせると紙らしくなる
    rail:      '#CFCCBF',
    building:  '#D6D4C9',
    text:      '#4A483F',
    textSub:   '#7C7A70',
    halo:      '#E7EBDC',
    border:    '#C9C6BB'
  },
  night:{
    land:      '#23241E',   // 夜も、黒ではなく墨がかった緑
    water:     '#1B3350',
    green:     '#2A3126',
    road:      '#8C8A7E',
    roadMinor: '#5A594F',
    roadCase:  '#191A15',
    rail:      '#4A493F',
    building:  '#33342C',
    text:      '#EDEBE0',
    textSub:   '#A6A395',
    halo:      '#191A15',
    border:    '#55544A'
  }
}

};

/* いま選ばれている見た目 */
let theme = (function(){
  try{ return localStorage.getItem('mk_theme')||'apple'; }catch(e){ return 'apple'; }
})();
function PAL(){ return (THEMES[theme]||THEMES.apple)[night?'night':'day']; }
try{ document.body.classList.toggle('paper', theme==='paper'); }catch(e){}

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
    var C=PAL();
    var paper=(theme==='paper');
    var s=JSON.parse(JSON.stringify(st));

    (s.layers||[]).forEach(function(L){
      try{
        if(!L.paint)L.paint={};

        if(L.type==='symbol'){
          var big=/place|city|town|country|state/.test((L.id||'')+(L['source-layer']||''));

          // 紙の地図は、地名を「英字 / 日本語」の2段で出す
          if(paper&&big&&L.layout){
            L.layout['text-field']=[
              'case',
              ['all',['has','name:latin'],['has','name:ja']],
              ['concat',['get','name:latin'],'\n',['get','name:ja']],
              ['coalesce',['get','name:ja'],['get','name'],['get','name:latin']]
            ];
            L.layout['text-line-height']=1.35;
            L.layout['text-size']=['interpolate',['linear'],['zoom'],6,11,12,14,16,17];
          }

          L.paint['text-color']=big?C.text:C.textSub;
          L.paint['text-halo-color']=C.halo;
          L.paint['text-halo-width']=paper?2.2:1.6;
          if(paper){
            // 紙の地図は、文字の間を広くとって落ち着かせる
            if(!L.layout)L.layout={};
            L.layout['text-letter-spacing']=big?0.09:0.05;
            L.paint['text-halo-blur']=0.4;
          }
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
          var w=L.paint['line-width'];
          // 夜は道路をわずかに太く。細いと背景に沈む
          if(night&&(role==='road'||role==='roadMinor')&&typeof w==='number'){
            L.paint['line-width']=w*1.25;
          }
          if(night&&role==='road') L.paint['line-opacity']=1;
          // 紙は、道のふちを太くして輪郭を立てる
          if(paper&&role==='roadCase'&&typeof L.paint['line-width']==='number'){
            L.paint['line-width']=L.paint['line-width']*1.35;
          }
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
// 正確な現在地は端末へ永続化しない。旧版が残した値も起動時に破棄し、
// 現在の権限確認が終わる前は日本全体の中立表示だけを使う。
try{localStorage.removeItem('spota_last_location');}catch(e){}
var initialMapView={center:[138.2529,36.2048],zoom:4.6};
var deferInitialMap=!!(window.__spotaOnboardingActive||window.__spotaNeedsOnboarding);
var initialMapWaitId=0,initialMapWaitTimer=0,mapStyleStartPromise=null;
function startInitialMapWait(){
  if(initialMapWaitId||!window.SpotaMotion)return;
  initialMapWaitId=window.SpotaMotion.beginWait('地図を読み込んでいます');
  initialMapWaitTimer=setTimeout(finishInitialMapLoad,20000);
}
function finishInitialMapLoad(){
  if(initialMapWaitTimer)clearTimeout(initialMapWaitTimer);
  initialMapWaitTimer=0;
  if(initialMapWaitId&&window.SpotaMotion)window.SpotaMotion.endWait(initialMapWaitId);
  initialMapWaitId=0;
}
if(!deferInitialMap)startInitialMapWait();
const map=new maplibregl.Map({
  container:'map',
  /* 以前は「元の色で読む → 色を変えて差し替える」の2段階だった。
     タイルを2回取りに行くので出るまで待たされる。
     いったん空で立ち上げ、色を変えたものを一度だけ渡す */
  style:{version:8,sources:{},layers:[
    {id:'bg',type:'background',paint:{'background-color':night?'#1C1C1E':'#F2F0EA'}}
  ]},
  // 現在地取得前に特定の街（以前は上野）を現在地のように見せない。
  // 許可後はnative.jsが実際の現在地へ移動する。
  center:initialMapView.center,zoom:initialMapView.zoom,pitch:0,bearing:0,maxPitch:70,
  antialias:true,
  fadeDuration:0,
  attributionControl:{
    compact:true,
    /* たたんだ状態で出す。ⓘ を押したときだけ開く */
    customAttribution:[
      '<a href="https://nlftp.mlit.go.jp/ksj/" target="_blank" rel="noopener noreferrer">国土交通省 国土数値情報・位置参照情報（加工）</a>',
      '<a href="https://www.digital.go.jp/policies/base_registry_address" target="_blank" rel="noopener noreferrer">デジタル庁 アドレス・ベース・レジストリ（加工／CC BY 4.0）</a>',
      '<a href="https://www.geonames.org/" target="_blank" rel="noopener noreferrer">地名データ © GeoNames, CC BY 4.0</a>',
      '<a href="https://webservice.recruit.co.jp/" target="_blank" rel="noopener noreferrer">Powered by ホットペッパー グルメ</a>',
      '<a href="https://webservice.rakuten.co.jp/" target="_blank" rel="noopener noreferrer">Supported by 楽天ウェブサービス</a>',
      '<a href="https://ja.wikipedia.org/" target="_blank" rel="noopener noreferrer">Wikipedia contributors（CC BY-SA 4.0）</a>'
    ]
  }
});
// 後から読む分割ファイルへ、地図インスタンスを明示的に渡す。
// top-level constの暗黙共有に依存すると、読み込み方によって初期化判定が失敗する。
window.__michikusaMap=map;
/* 見た目の元を取ってきて、色を変えてから渡す。
   初回案内中は外部の地図配信先へ接続せず、規約確認とプロフィール設定が
   完了した瞬間に初めて開始する。 */
function startSpotaMapAfterOnboarding(){
  if(mapStyleStartPromise)return false;
  deferInitialMap=false;
  startInitialMapWait();
  mapStyleStartPromise=(async function loadStyle(){
    try{
      var t0=performance.now();
      var r=await fetch(STYLE);
      if(!r.ok)throw new Error('map style '+r.status);
      baseStyle=await r.json();
      window.__tStyle=Math.round(performance.now()-t0);
      mark('見た目を取得');
      map.once('style.load',function(){ setTimeout(afterStyle,0); });
      map.setStyle(retint(baseStyle),{diff:false});
      return true;
    }catch(e){
      showErr('[style] '+dump(e));hideSplash();finishInitialMapLoad();return false;
    }
  })();
  return true;
}
window.startSpotaMapAfterOnboarding=startSpotaMapAfterOnboarding;
if(!deferInitialMap)startSpotaMapAfterOnboarding();
/* 最初のタイルだけではまだ地図は未完成。afterStyle後に起動画面を引く。 */
function applyTint(){
  try{
    if(!baseStyle)return;
    map.setStyle(retint(baseStyle),{diff:false});
    map.once('style.load',function(){ setTimeout(afterStyle,0); });
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
  Object.keys(madeIcons).forEach(function(k){
    if(map.hasImage&&map.hasImage(k)){ try{ map.removeImage(k); }catch(e){} }
    delete madeIcons[k];
  });
  addPlaceLayers();
  render(true);
  hideSplash();
  // 背景タイルと写真レイヤーまで描画し終えた時点を、地図ロードの完了とする。
  // 400ms未満なら SpotaMotion 側が待機カメラを一度も表示しない。
  if(initialMapWaitId){
    if(map.loaded())finishInitialMapLoad();
    else map.once('idle',finishInitialMapLoad);
  }

  /* map.jsの通信が速いと、後ろにあるnative.jsより先にここへ来る。
     別ファイルの変数を直接読むと未定義になるため、双方が準備できた時点で
     window上の関数を呼ぶ。native.jsが後なら、そちらがこのフラグを読む。 */
  window.__michikusaMapReady=true;
  if(typeof window.requestInitialHome==='function')window.requestInitialHome();

  /* 絵は少し遅れて揃うことがある。
     揃ってからもう一度見て、記号を割り当て直す */
  setTimeout(function(){
    SPRITE=null;
    Object.keys(ICON_CACHE).forEach(function(k){delete ICON_CACHE[k];});
    scanSprite();
    if(Object.keys(SPRITE||{}).length) render(true);
  },1200);

  /* 現在地が取れなくても、いま見えている辺りは必ず読む。
     ここを現在地まかせにすると、位置を断った人が空の地図を見ることになる */
  setTimeout(function(){
    if(!window.__spotaOnboardingActive&&!window.__spotaNeedsOnboarding&&typeof window.autoLoad==='function')window.autoLoad(true);
  },1400);
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
  var m=visibleOwnSpots().concat(visibleOtherSpots())
    .filter(function(s){return s.n===p.n&&s.photo;});
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
    /* 公式に用意されている方法を先に使う。
       内部の作りに頼ると、地図の版が変わったときに取れなくなる */
    var names=[];
    if(typeof map.listImages==='function'){
      try{ names=map.listImages()||[]; }catch(e){}
    }
    if(!names.length){
      var im=map.style&&map.style.imageManager;
      if(im&&im.images) names=Object.keys(im.images);
      else if(im&&im._images) names=Object.keys(im._images);
    }
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
  return {type:'FeatureCollection',features:list.filter(valid)
    // 写真アイコンの生成中も通常ピンを残す。先に消すと、ズーム境界や
    // 画像の再読込時に思い出そのものが地図から消えたように見える。
    .map(function(p){
      return {type:'Feature',geometry:{type:'Point',coordinates:[p.lng,p.lat]},
        properties:{rid:String(p.id||p.server_id||p.spot||''),lat:p.lat,lng:p.lng,
        n:p.n,c:p.c||'景',icon:pickIcon(p.c||'景'),mine:mine?1:0,
        hot:p.hot?1:0,spot:p.spot||0,has_photo:(p.photo||p.server_photo_id)?1:0}};
    })};
}

let lastSig='';
function render(force){
 try{
  if(!map.getSource('mine'))return;
  var own=visibleOwnSpots(),shared=visibleOtherSpots();
  map.getSource('mine').setData(fcOf(own,true));
  map.getSource('spot').setData(fcOf(pois,false));
  if(map.getSource('frnd'))
    map.getSource('frnd').setData(fcOf(shared,false));
  refreshPhotoSource();
 }catch(e){ showErr('[render] '+dump(e)); }
}
map.on('moveend',function(){
  render();
  if(window.__spotaOnboardingActive||window.__spotaNeedsOnboarding)return;
  autoLoad();syncDown();
});

/* 地図の中にレイヤーを積む */
function addPlaceLayers(){
  if(map.getSource('spot'))return;
  map.addSource('spot',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addSource('frnd',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addSource('mine',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addSource('spota-photo',{
    type:'geojson',
    data:{type:'FeatureCollection',features:[]},
    // 画面上で近い写真は、場所名や座標の丸め値ではなく実際の描画距離でまとめる。
    cluster:true,clusterRadius:48,clusterMaxZoom:23,maxzoom:24,
    // 同一座標にまとめた写真数も、画面距離クラスターの件数へ加算する。
    clusterProperties:{photo_count:['+',['get','photo_count']]}
  });
  // MapLibreが画面距離でまとめた集合へ、代表写真を後から重ねる軽量ソース。
  // 元データとは分け、低ズームでは常に空にして画像デコードを発生させない。
  map.addSource('spota-photo-overlay',{
    type:'geojson',data:{type:'FeatureCollection',features:[]}
  });
  // GeoJSON のクラスタ計算は Web Worker で完了する。固定時間だけ待つと、
  // 実機が忙しい時に querySourceFeatures が空のまま終わり、A案が出ない。
  // source の完了通知を受けてからもう一度代表写真を組み立てる。
  if(!window.__spotaPhotoSourceWatch){
    window.__spotaPhotoSourceWatch=1;
    map.on('sourcedata',function(e){
      if(e&&e.sourceId==='spota-photo'&&e.isSourceLoaded)schedulePhotoClusterOverlay();
    });
  }

  // まだ思い出のない場所。
  // 地図が元から描いている店（薄い丸に絵）と、大きさも濃さも揃える
  // 地図が元から描いている店とまったく同じ大きさ・濃さにする
  map.addLayer({id:'spot-dot',type:'circle',source:'spot',minzoom:14,paint:{
    /* いま話題の場所は、少し大きくして縁を光らせる */
    // zoom式はMapLibreの制約に合わせて最上位をinterpolateにする。
    'circle-radius':['interpolate',['linear'],['zoom'],
      14,['case',['==',['get','hot'],1],9.45,7],
      16,['case',['==',['get','hot'],1],11.475,8.5],
      18,['case',['==',['get','hot'],1],13.5,10]],
    'circle-color':['case',['==',['get','hot'],1],
      (night?'#4A4A52':'#FFFFFF'), PAL().building],
    'circle-stroke-color':night?'#FFC24B':'#E08A00',
    'circle-stroke-width':['case',['==',['get','hot'],1],1.8,0],
    'circle-opacity':.95}});
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
  map.addLayer({id:'frnd-ring',type:'circle',source:'frnd',filter:['!=',['get','has_photo'],1],paint:{
    'circle-radius':['interpolate',['linear'],['zoom'],12,4,15,6.5,18,9],
    'circle-color':'#1E88E5',
    'circle-stroke-color':night?'#000000':'#FFFFFF','circle-stroke-width':2.2}});
  map.addLayer({id:'frnd-ic',type:'symbol',source:'frnd',minzoom:14,filter:['!=',['get','has_photo'],1],layout:{
    'icon-image':['get','icon'],
    'icon-size':['interpolate',['linear'],['zoom'],14,.8,17,1.05],
    'icon-allow-overlap':true,'icon-optional':true,'icon-offset':[0,-24],
    'text-field':['get','n'],'text-size':11,'text-offset':[0,1.4],'text-anchor':'top',
    'text-optional':true,'text-max-width':9
  },paint:{
    'text-color':night?'#BBD9F5':'#1A5FA8',
    'text-halo-color':night?'#000000':'#FFFFFF','text-halo-width':1.7}});

  // 自分の思い出がある場所
  map.addLayer({id:'mine-ring',type:'circle',source:'mine',filter:['!=',['get','has_photo'],1],paint:{
    'circle-radius':['interpolate',['linear'],['zoom'],12,5,15,8,18,11],
    'circle-color':night?'#FAFAFA':'#111111',
    'circle-stroke-color':PAL().halo,'circle-stroke-width':2.4}});
  map.addLayer({id:'mine-ic',type:'symbol',source:'mine',minzoom:13.5,filter:['!=',['get','has_photo'],1],layout:{
    'icon-image':['get','icon'],
    'icon-size':['interpolate',['linear'],['zoom'],13.5,.85,17,1.15],
    'icon-allow-overlap':true,'icon-optional':true,'icon-offset':[0,-26],
    'text-field':['get','n'],'text-size':11.5,'text-offset':[0,1.5],'text-anchor':'top',
    'text-optional':true,'text-max-width':9
  },paint:{
    'text-color':night?'#FFFFFF':'#000000',
    'text-halo-color':PAL().halo,'text-halo-width':1.8}});

  // A案は別ソースの pending → 写真だけを描画する。
  // 元クラスタはタップ判定にだけ残し、背後から小丸をはみ出させない。
  map.addLayer({id:'photo-cluster',type:'circle',source:'spota-photo',minzoom:4,
    filter:['has','point_count'],paint:{
      'circle-radius':5,
      'circle-color':'#19191B',
      'circle-stroke-color':'#F7F7F4',
      'circle-stroke-width':2,
      'circle-opacity':0,
      'circle-stroke-opacity':0
    }});
  // 既存のクリック判定とレイヤー互換性は残すが、大数字は描画しない。
  map.addLayer({id:'photo-cluster-count',type:'symbol',source:'spota-photo',minzoom:4,
    filter:['has','point_count'],layout:{
      'visibility':'none',
      'text-field':['to-string',['get','photo_count']],
      'text-font':['Noto Sans Bold'],'text-size':14,
      'text-allow-overlap':true
    },paint:{'text-color':'#FFFFFF'}});

  // 同一座標もA案の画像準備中だけ小さな点を残す。
  map.addLayer({id:'photo-same-cluster',type:'circle',source:'spota-photo',minzoom:4,
    filter:['all',['!',['has','point_count']],['==',['get','ready'],0],['>', ['get','photo_count'],1]],paint:{
      'circle-radius':5,'circle-color':'#19191B','circle-stroke-color':'#F7F7F4',
      'circle-stroke-width':2,'circle-opacity':1
    }});
  map.addLayer({id:'photo-same-cluster-count',type:'symbol',source:'spota-photo',minzoom:4,
    filter:['all',['!',['has','point_count']],['>', ['get','photo_count'],1]],layout:{
      'visibility':'none',
      'text-field':['to-string',['get','photo_count']],'text-font':['Noto Sans Bold'],
      'text-size':14,'text-allow-overlap':true
    },paint:{'text-color':'#FFFFFF'}});

  // A案: 同じ座標の複数写真は、低ズームから代表写真＋右上件数で出す。
  map.addLayer({id:'photo-group-ic',type:'symbol',source:'spota-photo',minzoom:4,
    filter:['all',['!',['has','point_count']],['==',['get','ready'],1],['>', ['get','photo_count'],1]],layout:{
      'icon-image':['get','icon'],'icon-size':1,'icon-allow-overlap':true,
      'icon-anchor':'bottom','icon-offset':[0,4]
    }});

  // 写真本体の読込中でも、地図から記録そのものを消さない。
  map.addLayer({id:'photo-pending',type:'circle',source:'spota-photo',minzoom:4,
    filter:['all',['!',['has','point_count']],['==',['get','ready'],0]],paint:{
      'circle-radius':5,
      'circle-color':night?'#F4F4F5':'#111111',
      'circle-stroke-color':night?'#171719':'#FFFFFF','circle-stroke-width':2
    }});

  // 写真の丸。地図の中に描くので、ズームしてもずれない。
  // クラスタに入っておらず、画像の準備が終わった写真だけを描く。
  map.addLayer({id:'photo-ic',type:'symbol',source:'spota-photo',minzoom:PHOTO_ZOOM,
    filter:['all',['!',['has','point_count']],['==',['get','ready'],1],['==',['get','photo_count'],1]],layout:{
    'icon-image':['get','icon'],
    // プレビューと同じ54×62px。画像側を2倍で登録して高密度画面でもぼかさない。
    'icon-size':1,
    'icon-allow-overlap':true,'icon-anchor':'bottom','icon-offset':[0,4],
    'text-field':['get','n'],'text-font':['Noto Sans Regular'],'text-size':11,'text-offset':[0,0.6],'text-anchor':'top',
    'text-optional':true,'text-max-width':8
  },paint:{
    'text-color':PAL().text,
    'text-halo-color':PAL().halo,'text-halo-width':1.7}});

  // A案: 画面距離でまとまった写真はズーム4から代表写真＋右上件数にする。
  // 画面内24集合だけを作るため、全国表示でも無制限に画像化しない。
  map.addLayer({id:'photo-cluster-a-pending',type:'circle',source:'spota-photo-overlay',minzoom:4,
    filter:['==',['get','ready'],0],paint:{'circle-radius':5,
      'circle-color':night?'#F4F4F5':'#111111',
      'circle-stroke-color':night?'#171719':'#FFFFFF','circle-stroke-width':2}});
  map.addLayer({id:'photo-cluster-a',type:'symbol',source:'spota-photo-overlay',minzoom:4,
    filter:['==',['get','ready'],1],
    layout:{'icon-image':['get','icon'],'icon-size':1,'icon-allow-overlap':true,
      'icon-anchor':'bottom','icon-offset':[0,4]}});

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
const PHOTO_ZOOM=6;                  // ズーム6以降はクラスタが分かれても単写真を消さない
const PHOTO_FEATURE_LIMIT=1600;      // 低ズームで地図へ渡すのは座標と件数だけ
const PHOTO_ICON_VISIBLE_LIMIT=36;   // 一度に画像化する画面内サムネイル
const PHOTO_CLUSTER_VISIBLE_LIMIT=24;// A案へ置き換える画面内クラスター
const PHOTO_ICON_CACHE_LIMIT=72;     // Canvas画像は約5MB以内を目安に保持
const PHOTO_ICON_CONCURRENCY=3;      // 元写真の同時デコード数
const madeIcons={};                  // 作った画像の名前と最終使用時刻
const makingIcons={};                // 待機中または作っている途中のもの
const photoIconMeta={};              // クラスターの代表写真を引くための小さな索引
let desiredPhotoIcons={};
let activeClusterIconKeys={};
let livePhotoMetaKeys={};
let photoIconQueue=[];
let photoIconBusy=0;
let photoRefreshTimer=0;
let photoPruneTimer=0;
let clusterOverlayTimer=0;
let clusterOverlayGeneration=0;
let clusterOverlaySig='';

let photoDiag={try:0,ok:0,ngLoad:0,ngAdd:0,last:''};

/** 角の丸い四角を描く。Canvas には用意されていないので自分で書く */
function roundRect(x,px,py,w,hh,r){
  x.beginPath();
  x.moveTo(px+r,py);
  x.lineTo(px+w-r,py);   x.quadraticCurveTo(px+w,py,px+w,py+r);
  x.lineTo(px+w,py+hh-r);x.quadraticCurveTo(px+w,py+hh,px+w-r,py+hh);
  x.lineTo(px+r,py+hh);  x.quadraticCurveTo(px,py+hh,px,py+hh-r);
  x.lineTo(px,py+r);     x.quadraticCurveTo(px,py,px+r,py);
  x.closePath();
}

function wantedPhotoIcon(key){
  return !!(desiredPhotoIcons[key]||activeClusterIconKeys[key]);
}
function keepPhotoIcons(){
  var keep={};
  Object.keys(desiredPhotoIcons).forEach(function(k){keep[k]=1;});
  Object.keys(activeClusterIconKeys).forEach(function(k){keep[k]=1;});
  return keep;
}
function removePhotoIcon(key){
  if(map.hasImage&&map.hasImage(key)){try{map.removeImage(key);}catch(e){}}
  delete madeIcons[key];
  if(/^phc_/.test(key)||!livePhotoMetaKeys[key])delete photoIconMeta[key];
}
function prunePhotoIcons(keep,aggressive){
  keep=keep||{};
  var keys=Object.keys(madeIcons);
  keys.sort(function(a,b){return (madeIcons[a].used||0)-(madeIcons[b].used||0);});
  keys.forEach(function(key){
    if(!keep[key]&&(aggressive||Object.keys(madeIcons).length>PHOTO_ICON_CACHE_LIMIT))removePhotoIcon(key);
  });
  // まだ開始していない不要なデコードも捨てる。
  photoIconQueue=photoIconQueue.filter(function(job){
    if(keep[job.key])return true;
    delete makingIcons[job.key];return false;
  });
  Object.keys(photoIconMeta).forEach(function(key){
    if(/^phc_/.test(key)&&!keep[key]&&!madeIcons[key]&&!makingIcons[key])delete photoIconMeta[key];
  });
}
function schedulePhotoIconPrune(aggressive){
  clearTimeout(photoPruneTimer);
  // setDataを地図workerへ渡したあとで旧画像を外す。先にremoveImageすると
  // 直前フレームが古いicon名を参照し、MapLibreがmissing image警告を出す。
  photoPruneTimer=setTimeout(function(){prunePhotoIcons(keepPhotoIcons(),aggressive);},120);
}
function schedulePhotoRefresh(){
  clearTimeout(photoRefreshTimer);
  photoRefreshTimer=setTimeout(function(){refreshPhotoSource();},32);
}
function schedulePhotoClusterOverlay(){
  clearTimeout(clusterOverlayTimer);
  clusterOverlayTimer=setTimeout(refreshPhotoClusterOverlay,70);
}

/** 写真を切り抜いて、地図に登録する。
    A案の実寸は写真56×60px、右上の数字11px。2倍密度で描く。 */
function makeRoundIcon(url,mine,key,count,kind,record){
  var prior=photoIconMeta[key]||{};
  photoIconMeta[key]={url:url,mine:mine,count:count,kind:kind||'photo',record:record||prior.record||null};
  if(madeIcons[key]){madeIcons[key].used=Date.now();return;}
  if(makingIcons[key])return;
  makingIcons[key]=1;
  photoIconQueue.push({url:url,mine:mine,key:key,count:count,kind:kind||'photo'});
  runPhotoIconQueue();
}
function runPhotoIconQueue(){
 while(photoIconBusy<PHOTO_ICON_CONCURRENCY&&photoIconQueue.length){
  var job=photoIconQueue.shift();
  if(!wantedPhotoIcon(job.key)){delete makingIcons[job.key];continue;}
  photoIconBusy++;photoDiag.try++;
  decodePhotoIcon(job);
 }
}
function finishPhotoIcon(job){
  delete makingIcons[job.key];
  photoIconBusy=Math.max(0,photoIconBusy-1);
  runPhotoIconQueue();
}
function decodePhotoIcon(job){
  var url=job.url,mine=job.mine,key=job.key,count=job.count;
  var im=new Image();
  im.decoding='async';
  var src=String(url||'');
  // 地図ピンには端末内または自分の配信元の画像だけを使う。
  // 第三者画像の自動取得は、閲覧履歴・IP・位置の推測材料になるため行わない。
  if(/^https?:/i.test(src)){
    try{
      var parsed=new URL(src,location.href);
      if(parsed.origin!==location.origin && parsed.origin!==new URL(SERVER,location.href).origin){
        photoDiag.ngLoad++;finishPhotoIcon(job);return;
      }
    }catch(e){photoDiag.ngLoad++;finishPhotoIcon(job);return;}
  }

  im.onload=function(){
    try{
      if(!wantedPhotoIcon(key)){finishPhotoIcon(job);return;}
      /* A案の62×70px領域を2倍で描く。
         写真外形56×60px、白枠3px、右上バッジ23px、文字11px。 */
      var S=128,H=140,pw=112,ph=120,ring=6,r=26,ox=4,oy=8;
      var cv=document.createElement('canvas');
      cv.width=S; cv.height=H;
      var x=cv.getContext('2d',{willReadFrequently:true});
      x.imageSmoothingEnabled=true;x.imageSmoothingQuality='high';
      var iw=pw-ring*2,ih=ph-ring*2;
      var scale=Math.max(iw/im.width,ih/im.height);
      var sw=iw/scale,sh=ih/scale;

      // 写真の後ろにある白い尾。
      x.save();x.translate(ox+pw/2,oy+ph+4);x.rotate(Math.PI/4);
      x.fillStyle='#F7F7F4';roundRect(x,-10,-10,20,20,4);x.fill();x.restore();

      // 参照HTMLの 0 2px 9px rgba(5,5,7,.30) を2倍密度でそのまま描く。
      x.save();x.shadowColor='rgba(5,5,7,.30)';x.shadowBlur=18;x.shadowOffsetX=0;x.shadowOffsetY=4;
      x.fillStyle='#F7F7F4';
      roundRect(x,ox,oy,pw,ph,r);
      x.fill();
      x.restore();

      // 中に写真
      x.save();
      roundRect(x,ox+ring,oy+ring,iw,ih,r-ring);
      x.clip();
      x.drawImage(im,(im.width-sw)/2,(im.height-sh)/2,sw,sh,ox+ring,oy+ring,iw,ih);
      x.restore();

      // 複数写真の件数は、A案どおり右上の小さな黒い円へ置く。
      if(count>1){
        var label=count>999?'999+':String(count);
        x.save();x.font='760 22px -apple-system, BlinkMacSystemFont, sans-serif';
        x.textAlign='center';x.textBaseline='middle';
        var bw=Math.max(46,Math.ceil(x.measureText(label).width)+24),bh=46,bx=S-bw,by=0;
        x.shadowColor='rgba(5,5,7,.30)';x.shadowBlur=8;x.shadowOffsetY=2;
        x.fillStyle='#F7F7F4';roundRect(x,bx,by,bw,bh,bh/2);x.fill();
        x.shadowColor='transparent';
        x.fillStyle='#19191B';roundRect(x,bx+4,by+4,bw-8,bh-8,(bh-8)/2);x.fill();
        x.fillStyle='#F7F7F4';x.fillText(label,bx+bw/2,by+bh/2);x.restore();
      }

      var dat=x.getImageData(0,0,S,H);
      if(map.hasImage(key))map.removeImage(key);
      // ImageData をそのまま渡すのが一番確実
      map.addImage(key,dat,{pixelRatio:2});

      madeIcons[key]={used:Date.now(),kind:job.kind};
      photoDiag.ok++;
      im.onload=null;im.onerror=null;im.src='';
      finishPhotoIcon(job);
      schedulePhotoIconPrune(false);
      schedulePhotoRefresh();
      schedulePhotoClusterOverlay();
    }catch(e){
      photoDiag.ngAdd++;
      photoDiag.last=String(e&&e.message||e);
      im.onload=null;im.onerror=null;im.src='';
      finishPhotoIcon(job);
    }
  };
  im.onerror=function(){
    photoDiag.ngLoad++;
    photoDiag.last='画像を読めない: '+String(url).slice(0,60);
    im.onload=null;im.onerror=null;im.src='';
    finishPhotoIcon(job);
  };
  im.src=src;
}

function photoKey(p,mine){
  // 同じ場所・同じ名前でも別の写真なら別アイコンにする。
  var id=String(p.id||p.server_id||p.server_photo_id||p.spot||'')
    .replace(/[^A-Za-z0-9_-]/g,'').slice(0,64);
  if(!id)id=p.lat.toFixed(6)+'_'+p.lng.toFixed(6)+'_'+String(p.d||'');
  return 'ph_'+(mine?'m':'o')+'_'+id.replace(/[^A-Za-z0-9_-]/g,'_');
}

function photoFeatures(){
  var out=[];
  var b=map.getBounds(),c=map.getCenter(),zoom=map.getZoom(),list=[],groups={},liveMeta={};

  // 自分の地図では本人の記録を、みんなの地図では公開された記録だけを出す。
  // 店の宣材写真ではなく、利用者本人の写真だけを地図上のアルバムとして扱う。
  visibleOwnSpots().filter(valid).forEach(function(s){
    if(s.photo||s.photo_thumb||s.server_photo_id)
      list.push({p:s,mine:true,img:s.photo_thumb||s.photo||''});
  });
  visibleOtherSpots().forEach(function(o){
    if(valid(o)&&(o.photo||o.photo_thumb||o.server_photo_id))
      list.push({p:o,mine:false,img:o.photo_thumb||o.photo||''});
  });

  // 約1m以内の同一地点は先に一つに束ねる。MapLibreの最大ズームでも
  // サムネイル同士を重ねず、右上の数字を残すため。
  list.forEach(function(item){
    var groupKey=Math.round(item.p.lat*1e5)+'_'+Math.round(item.p.lng*1e5);
    (groups[groupKey]||(groups[groupKey]=[])).push(item);
  });
  list=Object.keys(groups).map(function(k){
    var items=groups[k],preview=items.find(function(item){return !!item.img;})||items[0];
    return {items:items,p:preview.p,mine:preview.mine,img:preview.img};
  });
  // 表示範囲によって配列そのものを作り直さない。座標データを保持したまま
  // MapLibreへ渡すことで、ズーム6付近をまたいでも写真が消えない。
  list.sort(function(a,x){
    if(a.mine!==x.mine)return a.mine?-1:1;
    var ad=String(a.p.d||''),xd=String(x.p.d||'');
    if(ad!==xd)return xd.localeCompare(ad);
    return photoKey(a.p,a.mine).localeCompare(photoKey(x.p,x.mine));
  });
  list=list.slice(0,PHOTO_FEATURE_LIMIT);

  // 低ズームは複数写真のA案だけを最大24集合、ズーム6以上は単写真を含め36枚まで。
  // server_photo_idだけの記録は、この選抜後に初めてサムネイル取得を要求する。
  var candidates=list.filter(function(o){
    return (o.items.length>1||zoom>=PHOTO_ZOOM)&&(o.img||o.p.server_photo_id)&&b.contains([o.p.lng,o.p.lat]);
  }).sort(function(a,x){
    return Math.hypot(a.p.lat-c.lat,a.p.lng-c.lng)-Math.hypot(x.p.lat-c.lat,x.p.lng-c.lng);
  }).slice(0,zoom>=PHOTO_ZOOM?PHOTO_ICON_VISIBLE_LIMIT:PHOTO_CLUSTER_VISIBLE_LIMIT);
  var nextDesired={};
  candidates.forEach(function(o){
    var count=o.items.length,key=photoKey(o.p,o.mine)+'_c'+count;
    nextDesired[key]=1;
    if(!o.img&&o.p.server_photo_id&&typeof window.queueMapPhotoThumb==='function')window.queueMapPhotoThumb(o.p);
  });
  desiredPhotoIcons=nextDesired;

  list.forEach(function(o){
    var count=o.items.length,key=photoKey(o.p,o.mine)+'_c'+count;
    var ready=desiredPhotoIcons[key]&&madeIcons[key]?1:0;
    liveMeta[key]=1;
    photoIconMeta[key]={url:o.img||'',mine:o.mine,count:count,kind:'photo',record:o.p};
    if(o.img&&!ready&&desiredPhotoIcons[key])makeRoundIcon(o.img,o.mine,key,count,'photo',o.p);
    if(ready)madeIcons[key].used=Date.now();
    out.push({type:'Feature',geometry:{type:'Point',coordinates:[o.p.lng,o.p.lat]},
      properties:{rid:String(o.p.id||o.p.server_id||o.p.spot||''),lat:o.p.lat,lng:o.p.lng,
        n:o.p.n,mine:o.mine?1:0,icon:key,ready:ready,photo_count:count}});
  });
  // 削除済み・上限外の記録が持っていたData URL参照を残さない。
  Object.keys(photoIconMeta).forEach(function(key){
    if(!/^phc_/.test(key)&&!liveMeta[key]&&!madeIcons[key]&&!makingIcons[key])delete photoIconMeta[key];
  });
  livePhotoMetaKeys=liveMeta;
  return out;
}
function refreshPhotoSource(){
  if(map.getSource('spota-photo')){
    map.getSource('spota-photo').setData({type:'FeatureCollection',features:photoFeatures()});
    // 低ズームでもA案を最大24集合だけ残す。不要画像はLRU上限で解放する。
    schedulePhotoIconPrune(false);
    schedulePhotoClusterOverlay();
  }
}

function clearPhotoClusterOverlay(){
  activeClusterIconKeys={};clusterOverlayGeneration++;
  var source=map.getSource('spota-photo-overlay');
  if(source&&clusterOverlaySig!=='[]')source.setData({type:'FeatureCollection',features:[]});
  clusterOverlaySig='[]';
  schedulePhotoIconPrune(false);
}

/** MapLibreの画面距離クラスターを、ズーム4からA案の代表写真へ置き換える。 */
async function refreshPhotoClusterOverlay(){
  var overlay=map.getSource('spota-photo-overlay'),source=map.getSource('spota-photo');
  if(!overlay||!source)return;
  var generation=++clusterOverlayGeneration,b=map.getBounds(),c=map.getCenter(),seen={},clusters=[];
  try{
    (map.querySourceFeatures('spota-photo',{filter:['has','point_count']})||[]).forEach(function(f){
      var id=Number(f.properties&&f.properties.cluster_id),coords=f.geometry&&f.geometry.coordinates;
      if(!isFinite(id)||!coords||seen[id]||!b.contains(coords))return;
      seen[id]=1;clusters.push(f);
    });
  }catch(e){return;}
  clusters.sort(function(a,x){
    var ac=a.geometry.coordinates,xc=x.geometry.coordinates;
    return Math.hypot(ac[1]-c.lat,ac[0]-c.lng)-Math.hypot(xc[1]-c.lat,xc[0]-c.lng);
  });
  clusters=clusters.slice(0,PHOTO_CLUSTER_VISIBLE_LIMIT);
  var rows=await Promise.all(clusters.map(async function(f){
    try{
      var id=Number(f.properties.cluster_id),leaves=await source.getClusterLeaves(id,1,0);
      var leaf=leaves&&leaves[0],base=leaf&&leaf.properties&&leaf.properties.icon;
      var meta=base&&photoIconMeta[base];if(!meta)return null;
      if(!meta.url&&meta.record&&meta.record.server_photo_id&&typeof window.queueMapPhotoThumb==='function')window.queueMapPhotoThumb(meta.record);
      var count=Number(f.properties.photo_count||f.properties.point_count||2);
      var key='phc_'+id+'_'+count+'_'+String(base).replace(/[^A-Za-z0-9_-]/g,'_').slice(-40);
      return {feature:f,key:key,count:count,meta:meta};
    }catch(e){return null;}
  }));
  if(generation!==clusterOverlayGeneration)return;
  var next={},features=[];
  rows.filter(Boolean).forEach(function(row){next[row.key]=1;});
  activeClusterIconKeys=next;
  rows.filter(Boolean).forEach(function(row){
    if(row.meta.url)makeRoundIcon(row.meta.url,row.meta.mine,row.key,row.count,'cluster',row.meta.record);
    var ready=madeIcons[row.key]?1:0;
    if(ready)madeIcons[row.key].used=Date.now();
    features.push({type:'Feature',geometry:row.feature.geometry,properties:{
      icon:row.key,ready:ready,cluster_id:Number(row.feature.properties.cluster_id),photo_count:row.count
    }});
  });
  var sig=JSON.stringify(features.map(function(f){return [f.properties.icon,f.properties.ready,f.geometry.coordinates];}));
  if(sig!==clusterOverlaySig){clusterOverlaySig=sig;overlay.setData({type:'FeatureCollection',features:features});}
  schedulePhotoIconPrune(false);
}
