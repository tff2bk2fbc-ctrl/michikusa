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

   指1本で拡大縮小したいが、地図を動かす操作と取り合ってしまう。
   そこで「長押ししてから上下」という合図にする。

   ・どこでも長押し（0.35秒）→ ズームに入る
   ・そのまま上へ → 寄る／下へ → 引く
   ・速く動かすほど大きく変わる

   長押しせずに動かせば、これまで通り地図が動く。
   ============================================================ */
(function(){
  var el2=document.getElementById('map');
  if(!el2||typeof map==='undefined')return;
  var armed=false;        // 長押しが成立したか
  var y0=0, x0=0, z0=0, timer=null;
  var lastY=0, lastT=0, speed=0;
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
    var t=(z-map.getMinZoom())/(map.getMaxZoom()-map.getMinZoom());
    hint.querySelector('b').style.height=Math.max(4,t*100)+'%';
  }

  el2.addEventListener('touchstart',function(e){
    if(e.touches.length!==1){ cancel(); return; }
    var t=e.touches[0];
    y0=t.clientY; x0=t.clientX;
    lastY=y0; lastT=performance.now(); speed=0;
    z0=map.getZoom();
    armed=false;
    clearTimeout(timer);
    timer=setTimeout(function(){
      armed=true;
      map.dragPan.disable();          // 地図が動かないようにする
      showBar(true); setBar(z0);
      if(navigator.vibrate) navigator.vibrate(8);   // 入ったことを指に伝える
    },350);
  },{passive:true,capture:true});

  el2.addEventListener('touchmove',function(e){
    if(e.touches.length!==1){ cancel(); return; }
    var t=e.touches[0];

    if(!armed){
      // 長押しの前に動いたら、地図を動かす操作とみなす
      if(Math.abs(t.clientY-y0)>10||Math.abs(t.clientX-x0)>10) clearTimeout(timer);
      return;
    }

    // キャプチャ段階でMapLibreより先に受け取り、ズーム中だけ地図移動を止める。
    e.stopPropagation();
    e.preventDefault();
    var y=t.clientY, now=performance.now();
    var dy=y0-y;                      // 上へ動かすと正 → 寄る

    /* 速く動かすほど大きく変える。
       ゆっくりなら細かく、素早くなら一気に */
    var dt=Math.max(1,now-lastT);
    var v=Math.abs(y-lastY)/dt*1000;
    speed=speed*0.7+v*0.3;
    var gain=3.5+Math.min(9, speed/260*9);
    lastY=y; lastT=now;

    var z=z0+(dy/window.innerHeight)*gain;
    z=Math.min(map.getMaxZoom(),Math.max(map.getMinZoom(),z));
    map.setZoom(z);
    setBar(z);
  },{passive:false,capture:true});

  function cancel(){
    clearTimeout(timer);
    if(armed){ map.dragPan.enable(); }
    armed=false;
    showBar(false);
  }
  el2.addEventListener('touchend',cancel,{passive:true,capture:true});
  el2.addEventListener('touchcancel',cancel,{passive:true,capture:true});
})();

/* ============================================================
   下のバナーの動き

   ・押した場所へ、丸い枠が滑って動く
   ・そのとき、上端に光が一度だけ走る
   ============================================================ */
(function(){
  var bar=document.getElementById('fabs');
  var pill=document.getElementById('pill');
  var glare=document.getElementById('glare');
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
    bar.classList.remove('lit');
    void bar.offsetWidth;          // ここで一度描かせないと、また流れない
    bar.classList.add('lit');
    setTimeout(function(){ bar.classList.remove('lit'); },1600);
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
  document.getElementById('btn-night').addEventListener('pointerdown',sweep);
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
