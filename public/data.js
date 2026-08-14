/* ============================================================
   データの取り込み
   ============================================================ */
let busy=false;
const cells={};
let loadLog={run:0,ours:0,err:'',skip:''};

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

    // 起動や地図移動だけでは、現在地を第三者サービスへ送らない。
    // 国交省・デジタル庁などから作った自前DBだけを読む。
    var mine=0;
    try{ mine=await loadOurs(); }catch(e){ loadLog.err='自前: '+e; }
    loadLog.ours+=mine;

    var t=mine;
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
    var r=await fetch(SERVER+'/api/places',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({s:b.getSouth(),w:b.getWest(),n:b.getNorth(),e:b.getEast(),limit:400})});
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
  // 入力中は端末内と自前DBから既に読んだ候補だけ。外部検索は送信しない。
  qT=setTimeout(function(){search(v,false);},350);
};
qx.onclick=function(){qEl.value='';qx.style.display='none';resEl.classList.remove('on');};
qEl.onkeydown=function(e){if(e.key==='Enter'){e.preventDefault();qEl.blur();search(qEl.value.trim(),true);}};
document.getElementById('map').addEventListener('touchstart',function(){
  resEl.classList.remove('on');},{passive:true});

async function search(v,remote){
  if(!v)return;
  var out=[];
  spots.filter(function(s){return s.n.indexOf(v)>=0;}).slice(0,3).forEach(function(s){
    out.push({k:'記録',img:s.photo,n:s.n,sub:s.place||'',lat:s.lat,lng:s.lng,p:s,mine:true});});
  pois.filter(function(p){return p.n.indexOf(v)>=0;}).slice(0,4).forEach(function(p){
    out.push({k:'地図',img:p.photo,n:p.n,sub:p.gname||'',lat:p.lat,lng:p.lng,p:p});});
  draw(out,null);
  if(!remote)return;

  // Enterで明示的に検索したときだけ、Worker経由で地名検索する。
  // 検索語をURLへ入れず、端末からNominatimへ直接送らない。
  draw(out,'地名を探しています…');
  try{
    var r2=await fetch(SERVER+'/api/geocode',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({q:v,limit:4})});
    if(!r2.ok)throw new Error('地名検索 '+r2.status);
    var j2=await r2.json();
    (j2.places||[]).forEach(function(p){
      out.push({k:'地名',n:p.name||String(p.display_name).split(',')[0],
        sub:p.display_name,lat:Number(p.lat),lng:Number(p.lng||p.lon)});});
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
