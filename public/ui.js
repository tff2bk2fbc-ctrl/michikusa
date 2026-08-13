/* ============================================================
   指の動きで隠す・出す
   ・下のカード：下へ払うと畳む。上へ払うと戻る
   ・右のボタン：素早く上へ払うと隠れる。下へ払うと戻る
   ============================================================ */
(function(){
  var fabs=document.querySelector('.fabs');
  var pull=document.getElementById('fabpull');

  function setFabs(hide){
    fabs.classList.toggle('hide',hide);
    pull.classList.toggle('on',hide);
  }
  var fy=0,ft=0,fmoved=false;
  function onStart(e){ fy=e.touches[0].clientY; ft=Date.now(); fmoved=false; }
  function onMove(e){ if(Math.abs(e.touches[0].clientY-fy)>8)fmoved=true; }
  function onEnd(e){
    var dy=e.changedTouches[0].clientY-fy, dt=Date.now()-ft;
    if(!fmoved){ if(fabs.classList.contains('hide')) setFabs(false); return; }
    var fast=dt<420;
    if(dy> 30&&fast) setFabs(true);    // 下へ払うと隠す
    if(dy<-30&&fast) setFabs(false);   // 上へ払うと戻す
  }
  [fabs,pull].forEach(function(el2){
    el2.addEventListener('touchstart',onStart,{passive:true});
    el2.addEventListener('touchmove',onMove,{passive:true});
    el2.addEventListener('touchend',onEnd,{passive:true});
  });
  pull.addEventListener('click',function(){ setFabs(false); });
  pull.addEventListener('mousedown',function(){ setFabs(false); });
})();


/* ============================================================
   片手ズーム

   ・画面中央右側の短いレーンだけが開始範囲
   ・レーンに触れた瞬間に開始し、指が外へ出ても継続
   ・進行方向が上半円（3時→12時→9時）なら拡大
   ・進行方向が下半円（3時→6時→9時）なら縮小
   ・移動速度と加速度が大きいほど変化量を増やす
   ============================================================ */
(function(){
  var el2=document.getElementById('map');
  var zoomMap=window.__michikusaMap;
  if(!el2||!zoomMap){ window.__oneHandZoom='missing-map'; return; }
  var armed=false, activeId=null, dragWasEnabled=false;
  var lastY=0, lastT=0, lastVelocity=0;
  var hint=null;

  function showBar(v){
    if(!hint){
      hint=document.createElement('div');
      hint.className='zoombar';
      hint.innerHTML='<b></b>';
      document.body.appendChild(hint);
    }
    hint.classList.toggle('on',v);
  }
  function setBar(z){
    if(!hint)return;
    var t=(z-zoomMap.getMinZoom())/(zoomMap.getMaxZoom()-zoomMap.getMinZoom());
    hint.querySelector('b').style.height=Math.max(4,t*100)+'%';
  }

  function inStartLane(e){
    // 画像の赤枠に合わせ、右端約16%・画面高の中央約24%だけを開始範囲にする。
    var laneWidth=Math.min(104,Math.max(64,window.innerWidth*0.16));
    var laneHeight=window.innerHeight*0.24;
    var centerY=window.innerHeight*0.475;
    var minY=centerY-laneHeight/2;
    var maxY=centerY+laneHeight/2;
    return e.clientX>=window.innerWidth-laneWidth&&e.clientY>=minY&&e.clientY<=maxY;
  }

  el2.addEventListener('pointerdown',function(e){
    if(activeId!==null){ cancel(); return; }
    if(!e.isPrimary||(e.pointerType==='mouse'&&e.button!==0)||!inStartLane(e))return;
    e.stopPropagation();
    e.preventDefault();
    activeId=e.pointerId;
    armed=true;
    lastY=e.clientY; lastT=performance.now(); lastVelocity=0;
    dragWasEnabled=zoomMap.dragPan.isEnabled();
    zoomMap.stop();
    zoomMap.dragPan.disable();
    try{ el2.setPointerCapture(activeId); }catch(err){}
    showBar(true); setBar(zoomMap.getZoom());
    if(navigator.vibrate)navigator.vibrate(8);
  },{passive:false,capture:true});

  el2.addEventListener('pointermove',function(e){
    if(!armed||e.pointerId!==activeId)return;
    e.stopPropagation();
    e.preventDefault();
    var y=e.clientY, now=performance.now();
    var step=lastY-y;                 // 上方向が正、下方向が負
    var dt=Math.max(8,now-lastT)/1000;
    var velocity=step/dt;
    var acceleration=(velocity-lastVelocity)/dt;
    var speedBoost=1+Math.min(2,Math.abs(velocity)/900);
    var accelBoost=1+Math.min(1.5,Math.abs(acceleration)/8000);
    var delta=(step/window.innerHeight)*7*speedBoost*accelBoost;
    if(Math.abs(step)<0.5)delta=0;

    var z=zoomMap.getZoom()+delta;
    z=Math.min(zoomMap.getMaxZoom(),Math.max(zoomMap.getMinZoom(),z));
    zoomMap.setZoom(z);
    setBar(z);

    lastY=y; lastT=now;
    lastVelocity=lastVelocity*0.55+velocity*0.45;
  },{passive:false,capture:true});

  function cancel(){
    if(armed&&dragWasEnabled){ zoomMap.dragPan.enable(); }
    if(activeId!==null){
      try{
        if(el2.hasPointerCapture(activeId))el2.releasePointerCapture(activeId);
      }catch(err){}
    }
    activeId=null;
    armed=false;
    dragWasEnabled=false;
    lastVelocity=0;
    showBar(false);
  }
  el2.addEventListener('pointerup',cancel,{passive:true,capture:true});
  el2.addEventListener('pointercancel',cancel,{passive:true,capture:true});
  el2.addEventListener('lostpointercapture',function(){ if(activeId!==null)cancel(); },{passive:true});
  el2.addEventListener('contextmenu',function(e){ if(armed)e.preventDefault(); },{capture:true});
  window.__oneHandZoom='right-middle-lane-v1';
})();

/* ============================================================
   下のバナーの動き

   ・押した場所へ、丸い枠が滑って動く
   ・そのとき、上端に光が一度だけ走る
   ============================================================ */
(function(){
  var bar=document.getElementById('fabs');
  var pill=document.getElementById('pill');
  if(!bar||!pill)return;

  var btns=Array.prototype.slice.call(bar.querySelectorAll('.nav-btn'));

  function movePill(b){
    if(!b){ pill.classList.remove('on'); return; }
    var p=b.parentElement.getBoundingClientRect();
    var r=b.getBoundingClientRect();
    pill.style.width=r.width+'px';
    pill.style.transform='translateX('+(r.left-p.left)+'px)';
    pill.classList.add('on');
  }
  function sweep(){
    bar.classList.add('pressed');
    setTimeout(function(){ bar.classList.remove('pressed'); },180);
  }

  btns.forEach(function(b){
    b.addEventListener('pointerdown',function(){
      btns.forEach(function(x){x.classList.remove('on');});
      b.classList.add('on');
      movePill(b);
      sweep();
      // 少し置いてから枠を戻す。押した感触だけ残す
      clearTimeout(window.__pillT);
      window.__pillT=setTimeout(function(){
        b.classList.remove('on');
        pill.classList.remove('on');
      },1400);
    });
  });

  document.getElementById('btn-cam').addEventListener('pointerdown',sweep);
  var bs=document.getElementById('btn-style');
  if(bs) bs.addEventListener('pointerdown',sweep);
  window.addEventListener('resize',function(){ pill.classList.remove('on'); });
})();

/* ============================================================
   診断画面
   ・URL の末尾に ?diag=1 を付けると出る
   ・画面の左上を3回続けて叩いても出る
   ============================================================ */
function showDiag(){
  try{
    var all=[]; try{ scanSprite(); all=Object.keys(SPRITE||{}).sort(); }catch(e){}
    var picks=CATS.map(function(c){return c+' → '+(pickIcon(c)||'（無し）');}).join('<br>');
    var withPhoto=spots.filter(function(s){return s.photo;}).length+
                  pois.filter(function(p){return p.photo;}).length;
    var s=showSheet('<div class="grab"></div><div class="pad" style="padding-top:16px">'+
      '<div style="font-size:17px;font-weight:700;margin-bottom:12px">診断</div>'+
      '<div style="font-size:13px;line-height:2.1;margin-bottom:14px">'+
        'アプリ <b>'+BUILD+'</b>　サーバー <b id="srv">…</b><br>'+
        '<span id="srvq" style="color:var(--dim)"></span><br>'+
        '起動：'+TT.map(function(x){return x[0]+' '+x[1]+'ms';}).join(' / ')+
        (window.__tStyle?('　見た目の取得 '+window.__tStyle+'ms'):'')+'<br>'+
        'ズーム <b>'+map.getZoom().toFixed(2)+'</b>（写真は '+PHOTO_ZOOM+' 以上）<br>'+
        '思い出 '+spots.length+' 件／読み込んだ場所 <b>'+pois.length+'</b> 件<br>'+
        '取得：実行 '+loadLog.run+' 回／自前 '+(loadLog.ours||0)+
          '／飲食 '+loadLog.hp+'／名所 '+loadLog.wiki+'／宿 '+loadLog.rk+
        (loadLog.skip?('<br><span style="color:var(--warn)">走らない理由：'+
          esc(loadLog.skip)+'</span>'):'')+
        (loadLog.err?('<br><span style="color:var(--warn)">エラー：'+
          esc(loadLog.err)+'</span>'):'')+'<br>'+
        '写真つきの場所 <b>'+withPhoto+'</b> 件<br>'+
        '観光地らしい場所 '+pois.filter(function(p){return (p.spot||0)>=3;}).length+
          ' 件／話題 '+pois.filter(function(p){return p.hot;}).length+' 件<br>'+
        '写真の丸：作成 <b>'+photoDiag.try+'</b>／成功 <b>'+photoDiag.ok+'</b>'+
          '／読込失敗 <b>'+photoDiag.ngLoad+'</b>／登録失敗 <b>'+photoDiag.ngAdd+'</b>'+
        (photoDiag.last?('<br><span style="color:var(--warn)">直近のエラー：'+
          esc(photoDiag.last)+'</span>'):'')+
        '<br>地図の絵：数えた '+all.length+
        '／listImages '+(typeof map.listImages==='function'?
          (function(){try{return (map.listImages()||[]).length;}catch(e){return 'エラー';}})():'なし')+
        '<br>取得の失敗：'+(loadLog.err||'なし')+
      '</div>'+
      '<div style="font-size:12.5px;line-height:2;margin-bottom:14px">'+picks+'</div>'+
      '<button class="btn" id="reload">この辺りを読み込む</button>'+
      '<button class="btn g" id="x" style="margin-top:8px">とじる</button></div>');
    s.querySelector('#x').onclick=closeSheet;

    /* サーバー側の版も見る。
       片方だけ古いと、原因の切り分けに時間がかかるため */
    fetch(SERVER+'/api/health?d='+Date.now())
      .then(function(r){return r.json();})
      .then(function(j){
        var e2=s.querySelector('#srv');
        if(!e2)return;
        e2.textContent=j.build||'?';
        var q=j.quota||{};
        var line=s.querySelector('#srvq');
        if(line){
          line.innerHTML='使用量：検索 '+((q.gsearch||{}).used||0)+'／'+((q.gsearch||{}).limit||0)+
            '　写真判定 '+((q.vision||{}).used||0)+'　提案 '+((q.gemini||{}).used||0)+
            '　合計 '+(q['合計円']||0)+'円';
        }
      })
      .catch(function(){
        var e2=s.querySelector('#srv');
        if(e2){ e2.textContent='つながらない'; e2.style.color='var(--warn)'; }
      });

    var rl=s.querySelector('#reload');
    if(rl) rl.onclick=async function(){
      rl.textContent='読み込んでいます…';
      closeSheet();
      await autoLoad(true);
      setTimeout(showDiag,500);
    };
  }catch(e){ showErr('[diag] '+dump(e)); }
}
if(location.search.indexOf('diag=1')>=0) setTimeout(showDiag,1500);

(function(){
  var n=0,t=0;
  document.addEventListener('click',function(e){
    if(e.clientY>150||e.clientX>130){n=0;return;}
    var now=Date.now();
    if(now-t>900)n=0;
    t=now; n++;
    if(n>=3){n=0;showDiag();}
  },true);
})();

/* ---------- 起動 ---------- */
(async function(){
 try{
  var ok=await openDB();
  if(ok) spots=(await dbAll('spots')).filter(valid);
  mark('記録を読んだ');
  if(map.getSource&&map.getSource('mine'))render(true);
  preload();                      // 部品はいちばん最後でいい
 }catch(e){showErr('[init] '+dump(e));}
})();
