/* ============================================================
   データの取り込み
   ============================================================ */
const TAGS=[['amenity','public_bath','湯'],['shop','bakery','喫茶'],['shop','books','本'],
  ['leisure','park','園'],['amenity','place_of_worship','社'],
  ['tourism','attraction','景'],['tourism','viewpoint','景'],['tourism','museum','景']];
const OVER=['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter'];
let busy=false;
const cells={};
let loadLog={run:0,hp:0,wiki:0,rk:0,err:''};

/* この辺りのデータを取りに行く。
   同じところを何度も叩かないよう、約1km四方の区画で覚えておく */
async function autoLoad(force){
  try{
    if(busy||placing)return;
    if(map.getZoom()<14.5)return;
    var c=map.getCenter(), cell=c.lat.toFixed(2)+','+c.lng.toFixed(2);
    if(!force&&cells[cell])return;
    cells[cell]=1; busy=true; loadLog.run++;

    // まず自分たちが貯めたものから。外へは足りない分だけ取りに行く
    var mine=await loadOurs();
    var n=await loadHP();
    var w=await loadWiki();
    var rk=await loadRakuten();
    loadLog.hp+=n; loadLog.wiki+=w; loadLog.rk+=rk; loadLog.ours=(loadLog.ours||0)+mine;

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
  var j=await r.json(); if(j.error){setTip(j.error);return 0;}
  var seen=dedupe(),n=0;
  (j.shops||[]).forEach(function(s){
    if(!isFinite(s.lat)||!isFinite(s.lng))return;
    var k=s.n+s.lat.toFixed(4); if(seen[k])return; seen[k]=1;
    pois.push({n:s.n,c:HP_CAT[s.genre]||'食',lat:s.lat,lng:s.lng,gname:s.gname,
      budget:s.budget,photo:s.photo||'',src:'hp'});n++;});
  return n;
}
const WSKIP=/学校|高校|中学|小学|大学|病院|株式会社|放送局|変電|工場/;
function wikiCat(s){s=String(s||'');
  if(/寺|神社|大社|神宮|教会/.test(s))return '社';
  if(/公園|庭園/.test(s))return '園';
  if(/温泉|銭湯/.test(s))return '湯';
  return '景';}
async function loadWiki(){
  try{
    var c=map.getCenter(),b=map.getBounds();
    var rad=Math.min(10000,Math.max(500,Math.round(Math.abs(b.getNorth()-c.lat)*111000)));
    var u='https://ja.wikipedia.org/w/api.php?action=query&format=json&origin=*'+
      '&generator=geosearch&ggscoord='+c.lat.toFixed(6)+'%7C'+c.lng.toFixed(6)+
      '&ggsradius='+rad+'&ggslimit=60&prop=coordinates%7Cdescription%7Cpageimages'+
      '&piprop=thumbnail&pithumbsize=240';
    var r=await fetch(u); if(!r.ok)return 0;
    var j=await r.json(),pg=(j.query&&j.query.pages)||{},seen=dedupe(),n=0;
    Object.keys(pg).forEach(function(k){
      var p=pg[k],co=p.coordinates&&p.coordinates[0]; if(!co||!p.title)return;
      var ds=p.description||''; if(WSKIP.test(p.title+ds))return;
      var key=p.title+Number(co.lat).toFixed(4); if(seen[key])return; seen[key]=1;
      pois.push({n:p.title,c:wikiCat(p.title+ds),lat:Number(co.lat),lng:Number(co.lon),
        gname:ds,photo:p.thumbnail?p.thumbnail.source:'',src:'wiki'});n++;});
    return n;
  }catch(e){return 0;}
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
    var rg=await api('/api/gsearch?q='+encodeURIComponent(v)+
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

  // ③ 地名。検索語を第三者へ直接送らず、Worker がキャッシュ・制限した
  // 同一オリジンの窓口を通す。公開の地理サービスは Worker 側だけが使う。
  try{
    var r2=await fetch(SERVER+'/api/geocode?limit=4&q='+encodeURIComponent(v.slice(0,120)));
    if(!r2.ok)throw new Error('geocode unavailable');
    var j2=await r2.json();
    var places=Array.isArray(j2)?j2:(j2.places||[]);
    places.forEach(function(p){
      var lat=Number(p.lat),lng=Number(p.lng==null?p.lon:p.lng);
      if(!isFinite(lat)||!isFinite(lng))return;
      out.push({k:'地名',n:p.name||String(p.display_name).split(',')[0],
        sub:p.display_name||'',lat:lat,lng:lng});});
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
