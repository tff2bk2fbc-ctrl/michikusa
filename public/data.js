/* ============================================================
   データの取り込み
   ============================================================ */
const TAGS=[['amenity','public_bath','湯'],['shop','bakery','喫茶'],['shop','books','本'],
  ['leisure','park','園'],['amenity','place_of_worship','社'],
  ['tourism','attraction','景'],['tourism','viewpoint','景'],['tourism','museum','景']];
const OVER=['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter'];
let busy=false;
const cells={};
let loadLog={run:0,hp:0,wiki:0,rk:0,ours:0,err:'',skip:''};

/* この辺りのデータを取りに行く。
   同じところを何度も叩かないよう、約1km四方の区画で覚えておく。
   force が true なら、記録を無視して必ず取りに行く */
async function autoLoad(force){
  try{
    // なぜ走らなかったかを残す。原因の切り分けのため
    if(busy){ loadLog.skip='ほかの取得が動いている'; return; }
    if(placing && !force){ loadLog.skip='場所を置いている途中'; return; }
    var z=map.getZoom();
    if(z<13){ loadLog.skip='引きすぎ ('+z.toFixed(1)+')'; return; }

    var c=map.getCenter(), cell=c.lat.toFixed(2)+','+c.lng.toFixed(2);
    if(!force&&cells[cell]){ loadLog.skip='この辺りは取得済み'; return; }

    cells[cell]=1; busy=true; loadLog.run++; loadLog.skip='';

    // まず自分たちが貯めたものから。外へは足りない分だけ取りに行く
    var mine=0,n=0,w=0,rk=0;
    try{ mine=await loadOurs(); }catch(e){ loadLog.err='自前: '+e; }
    try{ n=await loadHP(); }catch(e){ loadLog.err='食: '+e; }
    try{ w=await loadWiki(); }catch(e){ loadLog.err='名所: '+e; }
    try{ rk=await loadRakuten(); }catch(e){ loadLog.err='宿: '+e; }

    loadLog.hp+=n; loadLog.wiki+=w; loadLog.rk+=rk; loadLog.ours+=mine;

    var t=mine+n+w+rk;
    if(t){ render(true); setTip('この辺りを '+t+' 件 読み込みました'); }
    else if(force){ setTip('この辺りには見つかりませんでした'); }
  }catch(e){ loadLog.err=String(e&&e.message||e); }
  finally{ busy=false; }
}

function dedupe(){var s={};pois.forEach(function(p){s[p.n+p.lat.toFixed(4)]=1;});return s;}


/* 自分たちで貯めた場所。外に頼らず、ここから返せる分 */
async function loadOurs(){
  try{
    var b=map.getBounds();
    var r=await fetch(SERVER+'/api/places?s='+b.getSouth()+'&w='+b.getWest()+
      '&n='+b.getNorth()+'&e='+b.getEast()+'&limit=400');
    if(!r.ok)return 0;
    var j=await r.json();
    var seen=dedupe(), n=0;
    (j.places||[]).forEach(function(p){
      if(!isFinite(p.lat)||!isFinite(p.lng))return;
      var k=p.n+p.lat.toFixed(4); if(seen[k])return; seen[k]=1;
      pois.push({n:p.n,c:p.c||'景',lat:p.lat,lng:p.lng,
        gname:p.gname||'',budget:p.budget||'',addr:p.addr||'',src:'db'});
      n++;
    });
    return n;
  }catch(e){ return 0; }
}

async function loadHP(){
  var c=map.getCenter(),b=map.getBounds();
  var half=Math.abs(b.getNorth()-c.lat)*111000;
  var range=half<=300?1:half<=500?2:half<=1000?3:half<=2000?4:5;
  var r=await fetch(SERVER+'/api/hotpepper?lat='+c.lat+'&lng='+c.lng+'&range='+range+'&pages=3');
  var j=await r.json();
  if(j.error){ loadLog.err='食: '+j.error; setTip(j.error); return 0; }
  var seen=dedupe(),n=0;
  (j.shops||[]).forEach(function(s){
    if(!isFinite(s.lat)||!isFinite(s.lng))return;
    var k=s.n+s.lat.toFixed(4); if(seen[k])return; seen[k]=1;
    pois.push({n:s.n,c:HP_CAT[s.genre]||'食',lat:s.lat,lng:s.lng,gname:s.gname,
      budget:s.budget,photo:s.photo||'',src:'hp'});n++;});
  return n;
}
/* ============================================================
   Wikipedia

   座標のついた記事を拾うだけでなく、
   ・カテゴリを見て「観光地かどうか」を判断する
   ・直近の閲覧数を見て「いま話題かどうか」を判断する
   この2つを足すと、ただの一覧が「行きたい場所の地図」になる。
   ============================================================ */

/* 出したくないもの */
const WSKIP=/学校|高校|中学|小学|大学|病院|株式会社|放送局|変電|工場|廃止|事件|事故/;

/* カテゴリから、そこがどういう場所かを見分ける。
   Wikipediaの記事には「Category:日本の城」のような分類が付いている */
const WCAT=[
  [/温泉|銭湯|浴場/,                          '湯', 3],
  [/神社|寺院|寺|大社|神宮|仏閣|霊場/,         '社', 3],
  [/公園|庭園|植物園|渓谷|滝|湖沼|山|海岸|岬/, '園', 3],
  [/城|城郭|史跡|重要文化財|国宝|遺跡|古墳/,   '景', 4],
  [/美術館|博物館|資料館|記念館|水族館|動物園/,'景', 4],
  [/観光地|名所|景勝地|日本百|世界遺産/,       '景', 5],
  [/駅|空港|港/,                              '景', 1],
  [/図書館|書店/,                             '本', 2]
];

/* 記事のカテゴリと説明から、種類と「観光地らしさ」を出す */
function wikiJudge(title, desc, cats){
  var s=String(title||'')+' '+String(desc||'')+' '+(cats||[]).join(' ');
  var cat='景', score=0;
  for(var i=0;i<WCAT.length;i++){
    if(WCAT[i][0].test(s)){
      if(WCAT[i][2]>score){ cat=WCAT[i][1]; score=WCAT[i][2]; }
    }
  }
  return {cat:cat, score:score};
}

/* 直近7日の閲覧数。いま人が見ている場所ほど、話題になっている。
   サーバー側で1日ぶん残しているので、同じ場所を何度開いても呼び出しは増えない */
async function wikiViews(titles){
  if(!titles.length)return {};
  try{
    var r=await fetch(SERVER+'/api/wiki?mode=views&titles='+
      encodeURIComponent(titles.slice(0,12).join('|')));
    if(!r.ok)return {};
    var j=await r.json();
    return j.views||{};
  }catch(e){ return {}; }
}

async function loadWiki(){
  try{
    var c=map.getCenter(),b=map.getBounds();
    var rad=Math.min(10000,Math.max(500,Math.round(Math.abs(b.getNorth()-c.lat)*111000)));

    /* サーバーを通す。
       こちらの名乗りを付けないと、Wikipediaから遮断される決まりになった */
    var r=await fetch(SERVER+'/api/wiki?mode=near&lat='+c.lat.toFixed(6)+
      '&lng='+c.lng.toFixed(6)+'&radius='+rad);
    if(!r.ok){ loadLog.err='wiki HTTP '+r.status; return 0; }
    var j=await r.json();
    if(j.error) loadLog.err='wiki: '+j.error;
    var seen=dedupe();

    var list=[];
    (j.pages||[]).forEach(function(p){
      if(!p.title||!isFinite(p.lat)||!isFinite(p.lng))return;
      var ds=p.desc||'';
      if(WSKIP.test(p.title+ds))return;
      var key=p.title+Number(p.lat).toFixed(4); if(seen[key])return; seen[key]=1;

      var jd=wikiJudge(p.title, ds, p.cats||[]);
      list.push({
        n:p.title, c:jd.cat, lat:Number(p.lat), lng:Number(p.lng),
        gname:ds, photo:p.photo||'', src:'wiki', spot:jd.score
      });
    });

    /* 観光地らしいものを前に。写真があるものも上げる */
    list.sort(function(a,x){
      return (x.spot+(x.photo?1:0)) - (a.spot+(a.photo?1:0));
    });

    /* 上位の閲覧数を見て、話題のものに印をつける */
    try{
      var pv=await wikiViews(list.slice(0,12).map(function(o){return o.n;}));
      var vals=Object.keys(pv).map(function(k){return pv[k];})
        .filter(function(v){return v>0;}).sort(function(a,b){return a-b;});
      var mid=vals.length? vals[Math.floor(vals.length/2)] : 0;
      list.forEach(function(o){
        o.views=pv[o.n]||0;
        // 周りの2倍以上見られていれば「話題」とみなす
        o.hot = (mid>0 && o.views > mid*2 && o.views > 300);
      });
    }catch(e){}

    var n=0;
    list.forEach(function(o){ pois.push(o); n++; });
    return n;
  }catch(e){ loadLog.err='wiki: '+String(e&&e.message||e); return 0; }
}


/* 楽天トラベルの宿 */
async function loadRakuten(){
  try{
    var c=map.getCenter(),b=map.getBounds();
    var km=Math.min(3,Math.max(0.3,Math.abs(b.getNorth()-c.lat)*111));
    var r=await fetch(SERVER+'/api/rakuten?lat='+c.lat+'&lng='+c.lng+'&km='+km.toFixed(1));
    var j=await r.json(); if(j.error)return 0;
    var seen=dedupe(),n=0;
    (j.hotels||[]).forEach(function(x){
      if(!isFinite(x.lat)||!isFinite(x.lng))return;
      var k=x.n+x.lat.toFixed(4); if(seen[k])return; seen[k]=1;
      pois.push({n:x.n,c:'宿',lat:x.lat,lng:x.lng,
        gname:x.min?('1泊 '+Number(x.min).toLocaleString()+'円〜'):'宿',
        photo:x.photo||'',addr:x.addr||'',src:'rk'});n++;});
    return n;
  }catch(e){return 0;}
}

/* ============================================================
   検索
   ============================================================ */
const qEl=document.getElementById('q'),resEl=document.getElementById('results'),
      qx=document.getElementById('qx');
let qT=null;
qEl.oninput=function(){
  qx.style.display=qEl.value?'block':'none';
  clearTimeout(qT); var v=qEl.value.trim();
  if(v.length<2){resEl.classList.remove('on');return;}
  qT=setTimeout(function(){search(v);},350);
};
qx.onclick=function(){qEl.value='';qx.style.display='none';resEl.classList.remove('on');};
qEl.onkeydown=function(e){if(e.key==='Enter'){e.preventDefault();qEl.blur();search(qEl.value.trim());}};
document.getElementById('map').addEventListener('touchstart',function(){
  resEl.classList.remove('on');},{passive:true});


/* Googleの分類を、こちらの分類に置き換える */
function gCat(types){
  var t=(types||[]).join(' ').toLowerCase();
  if(/cafe|coffee|bakery|tea/.test(t))                    return '喫茶';
  if(/bar|night_club|liquor/.test(t))                     return '酒';
  if(/restaurant|food|meal|ramen|sushi/.test(t))          return '食';
  if(/lodging|hotel|resort/.test(t))                      return '宿';
  if(/spa|onsen|bath|sauna/.test(t))                      return '湯';
  if(/place_of_worship|shrine|temple|church/.test(t))     return '社';
  if(/park|garden|campground/.test(t))                    return '園';
  if(/book|library/.test(t))                              return '本';
  return '景';
}

async function search(v){
  if(!v)return;
  var out=[];
  spots.filter(function(s){return s.n.indexOf(v)>=0;}).slice(0,3).forEach(function(s){
    out.push({k:'記録',img:s.photo,n:s.n,sub:s.place||'',lat:s.lat,lng:s.lng,p:s,mine:true});});
  pois.filter(function(p){return p.n.indexOf(v)>=0;}).slice(0,4).forEach(function(p){
    out.push({k:'地図',img:p.photo,n:p.n,sub:p.gname||'',lat:p.lat,lng:p.lng,p:p});});
  var c=map.getCenter();
  // ① 店（ホットペッパー）
  try{
    var r=await fetch(SERVER+'/api/hotpepper?keyword='+encodeURIComponent(v)+
      '&lat='+c.lat+'&lng='+c.lng+'&range=5&pages=1');
    var j=await r.json();
    (j.shops||[]).slice(0,5).forEach(function(s){
      out.push({k:'店',img:s.photo,n:s.n,sub:[s.gname,s.addr].filter(Boolean).join(' ・ '),
        lat:s.lat,lng:s.lng,p:{n:s.n,c:HP_CAT[s.genre]||'食',lat:s.lat,lng:s.lng,
        gname:s.gname,budget:s.budget,photo:s.photo||'',src:'hp'}});});
  }catch(e){}
  draw(out,'探しています…');

  // ② Google。曖昧な言葉や、ここに無い場所を拾う
  try{
    var rg=await fetch(SERVER+'/api/gsearch?q='+encodeURIComponent(v)+
      '&lat='+c.lat+'&lng='+c.lng);
    var jg=await rg.json();
    var have={}; out.forEach(function(o){ have[o.n]=1; });
    (jg.places||[]).forEach(function(g){
      if(have[g.n])return;              // 同じ店が二重に出ないように
      have[g.n]=1;
      out.push({k:'場所',n:g.n,sub:[g.gname,g.addr].filter(Boolean).join(' ・ '),
        lat:g.lat,lng:g.lng,
        p:{n:g.n,c:gCat(g.types),lat:g.lat,lng:g.lng,gname:g.gname,src:'g'}});
    });
  }catch(e){}

  // ③ 地名
  try{
    var r2=await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=4'+
      '&accept-language=ja&countrycodes=jp&q='+encodeURIComponent(v));
    var j2=await r2.json();
    (j2||[]).forEach(function(p){
      out.push({k:'地名',n:p.name||String(p.display_name).split(',')[0],
        sub:p.display_name,lat:Number(p.lat),lng:Number(p.lon)});});
  }catch(e){}

  draw(out,null);
}
function draw(list,note){
  if(!list.length&&!note){resEl.innerHTML='<div class="reshead">見つかりませんでした</div>';
    resEl.classList.add('on');return;}
  var h=note?'<div class="reshead">'+note+'</div>':'';
  list.forEach(function(r,i){
    h+='<div class="res" data-i="'+i+'"><span class="ic"'+
      (r.img?' style="background-image:url('+JSON.stringify(r.img).replace(/"/g,'&quot;')+')"':'')+
      '>'+(r.img?'':esc((r.n||'?').charAt(0)))+'</span>'+
      '<span class="tx"><b>'+esc(r.n)+'</b><span>'+esc(r.sub||'')+'</span></span></div>';
  });
  resEl.innerHTML=h; resEl.classList.add('on');
  Array.prototype.forEach.call(resEl.querySelectorAll('.res'),function(e2){
    e2.onclick=function(){
      var r=list[Number(e2.dataset.i)];
      resEl.classList.remove('on'); qEl.blur();
      map.easeTo({center:[r.lng,r.lat],zoom:17,duration:750});
      if(r.p&&!r.mine&&r.p.src&&!pois.some(function(p){
        return p.n===r.p.n&&Math.abs(p.lat-r.p.lat)<1e-5;})){pois.push(r.p);}
      setTimeout(function(){ if(r.p)openPlace(r.p,!!r.mine);
        else startPlacing(r.lat,r.lng,{}); render(); },800);
    };
  });
}
