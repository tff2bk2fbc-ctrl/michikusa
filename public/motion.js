/* ============================================================
   Spota motion

   操作結果を説明する短い動きと、長引いた通信だけに出す待機表示。
   API、認証、位置精度には触れず、表示だけを担当する。
   ============================================================ */
(function(){
  'use strict';

  var wait=document.getElementById('spota-wait');
  var waitStatus=document.getElementById('spota-wait-status');
  var reduce=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var serial=0,visible=0;
  var jobs=Object.create(null);
  var lastHapticAt=0;
  var undoToast=null,undoTimer=0;

  // UIで採用したモーション番号。機能のない場所へ演出だけを増やさないため、
  // 実際の操作が存在する画面から順に接続する。
  var catalog=Object.freeze({
    1:'press',4:'hold-haptic',5:'segment',6:'toggle',7:'number-roll',8:'success',9:'error',10:'undo',
    11:'photo-like',12:'heart-fill',13:'heart-remove',14:'save-burst',15:'follow',16:'comment-sheet',
    17:'comment-insert',18:'share-sheet',19:'avatar',20:'shared-photo',22:'pin-drop',27:'locate',28:'location',
    29:'map-crossfade',30:'map-flight',31:'one-hand-zoom',32:'image-quality',41:'flash-loader',43:'blur-up',
    44:'pull-refresh',45:'bottom-nav',46:'screen',47:'notification-insert',48:'message-state',49:'album-sort',50:'daily-swipe'
  });

  function haptic(style,intensity){
    var now=Date.now();
    // 誤作動や連打でTaptic Engineを連続駆動しない。
    if(now-lastHapticAt<70)return Promise.resolve(false);
    lastHapticAt=now;
    var cap=window.Capacitor,plugins=cap&&cap.Plugins||{};
    var nativePlugin=plugins.SpotaHaptics;
    if(nativePlugin&&typeof nativePlugin.impact==='function'){
      return Promise.resolve(nativePlugin.impact({style:style||'medium',intensity:Number(intensity)||.88}))
        .then(function(){return true;}).catch(function(){return false;});
    }
    // Haptics pluginが既にある環境も壊さず利用する。
    if(plugins.Haptics&&typeof plugins.Haptics.impact==='function'){
      return Promise.resolve(plugins.Haptics.impact({style:String(style||'medium').toUpperCase()}))
        .then(function(){return true;}).catch(function(){return false;});
    }
    var nav=window.navigator||(typeof navigator!=='undefined'?navigator:null);
    if(nav&&nav.vibrate){nav.vibrate(style==='rigid'?16:9);return Promise.resolve(true);}
    return Promise.resolve(false);
  }

  // 残り時間の輪は表示しない。押している間は面が沈み、成立時だけ一度「ぐっ」と返す。
  function bindHold(node,complete,options){
    if(!node||typeof node.addEventListener!=='function')return function(){};
    options=options||{};var duration=Math.max(360,Number(options.duration)||620);
    var pointer=null,timer=0,done=false;
    function reset(){clearTimeout(timer);timer=0;pointer=null;done=false;node.classList.remove('motion-holding','motion-hold-complete');}
    function finish(){
      if(pointer===null||done)return;done=true;node.classList.remove('motion-holding');node.classList.add('motion-hold-complete');
      haptic(options.style||'rigid',options.intensity||.92);
      if(typeof complete==='function')complete();
      setTimeout(function(){node.classList.remove('motion-hold-complete');},220);
    }
    function down(event){
      if(pointer!==null||event.isPrimary===false||(event.pointerType==='mouse'&&event.button!==0))return;
      pointer=event.pointerId;done=false;node.classList.add('motion-holding');
      try{node.setPointerCapture(pointer);}catch(e){}
      timer=setTimeout(finish,duration);
    }
    function end(event){if(pointer!==null&&event.pointerId===pointer)reset();}
    node.addEventListener('pointerdown',down);node.addEventListener('pointerup',end);
    node.addEventListener('pointercancel',reset);node.addEventListener('lostpointercapture',reset);
    return function(){reset();node.removeEventListener('pointerdown',down);node.removeEventListener('pointerup',end);node.removeEventListener('pointercancel',reset);node.removeEventListener('lostpointercapture',reset);};
  }

  function showWait(job){
    if(!job||!jobs[job.id]||job.shown)return;
    job.shown=true;visible++;
    if(waitStatus)waitStatus.textContent=job.label||'読み込んでいます';
    if(!wait)return;
    wait.hidden=false;
    wait.setAttribute('aria-hidden','false');
    if(visible===1){
      wait.classList.remove('is-running');
      void wait.offsetWidth;
      wait.classList.add('is-running');
    }
  }

  function beginWait(label){
    var id=++serial;
    var job={id:id,label:String(label||'読み込んでいます'),shown:false,timer:0};
    jobs[id]=job;
    job.timer=setTimeout(function(){showWait(job);},400);
    return id;
  }

  function endWait(id){
    var job=jobs[id];
    if(!job)return;
    clearTimeout(job.timer);
    delete jobs[id];
    if(!job.shown)return;
    visible=Math.max(0,visible-1);
    if(visible||!wait)return;
    wait.classList.remove('is-running');
    wait.hidden=true;
    wait.setAttribute('aria-hidden','true');
    if(waitStatus)waitStatus.textContent='読み込みが完了しました';
  }

  async function withWait(label,work){
    var id=beginWait(label);
    try{return await (typeof work==='function'?work():work);}
    finally{endWait(id);}
  }

  function landingPoint(lng,lat){
    try{
      if(typeof map!=='undefined'&&map&&map.project){
        var point=map.project([lng,lat]);
        if(point&&isFinite(point.x)&&isFinite(point.y))return {x:point.x,y:point.y};
      }
    }catch(e){}
    return {x:window.innerWidth*.62,y:window.innerHeight*.46};
  }

  function photoLanding(photo,lng,lat){
    return new Promise(function(resolve){
      if(!photo||reduce){resolve();return;}
      var camera=document.getElementById('btn-cam');
      if(!camera||!document.body){resolve();return;}
      var from=camera.getBoundingClientRect(),target=landingPoint(Number(lng),Number(lat));
      var startX=from.left+from.width/2,startY=from.top+from.height/2;
      var dx=target.x-startX,dy=target.y-startY;
      var flash=document.createElement('i');
      flash.className='motion-camera-flash';
      flash.setAttribute('aria-hidden','true');
      document.body.appendChild(flash);
      restartClass(camera,'motion-shutter-press',520);
      var ghost=document.createElement('div');
      ghost.className='motion-photo-drop';
      ghost.style.left=(startX-75)+'px';ghost.style.top=(startY-75)+'px';
      var image=document.createElement('img');image.alt='';image.src=photo;ghost.appendChild(image);
      document.body.appendChild(ghost);
      if(!ghost.animate){ghost.remove();flash.remove();resolve();return;}
      var animation=ghost.animate([
        {transform:'translate3d(0,0,0) scale(.2)',opacity:0,offset:0},
        {transform:'translate3d(0,-96px,0) scale(1)',opacity:1,offset:.10},
        {transform:'translate3d(0,-96px,0) scale(1)',opacity:1,offset:.30},
        {transform:'translate3d(0,-104px,0) scale(1.04)',opacity:1,offset:.42},
        {transform:'translate3d('+(dx*.65)+'px,'+(dy*.65-28)+'px,0) scale(.62)',opacity:1,offset:.70},
        {transform:'translate3d('+dx+'px,'+dy+'px,0) scale(.52)',opacity:1,offset:.84},
        {transform:'translate3d('+dx+'px,'+(dy+6)+'px,0) scale(.52,.45)',opacity:1,offset:.90},
        {transform:'translate3d('+dx+'px,'+dy+'px,0) scale(.52)',opacity:1,offset:1}
      ],{duration:2500,easing:'cubic-bezier(.22,.61,.36,1)',fill:'forwards'});
      var ring=document.createElement('i');ring.className='motion-land-ring';
      ring.style.left=(target.x-29)+'px';ring.style.top=(target.y-29)+'px';
      document.body.appendChild(ring);
      var ringTimer=setTimeout(function(){ring.classList.add('is-on');},2050);
      function finish(){clearTimeout(ringTimer);ghost.remove();flash.remove();setTimeout(function(){ring.remove();},700);resolve();}
      animation.onfinish=finish;animation.oncancel=finish;
    });
  }

  function pulseLocation(marker){
    if(!marker||reduce)return;
    marker.classList.remove('is-locating');
    void marker.offsetWidth;
    marker.classList.add('is-locating');
  }

  function viewerTransition(viewer,origin,target){
    if(reduce||!viewer||!origin||!target||!target.animate)return false;
    var from=origin.getBoundingClientRect(),to=target.getBoundingClientRect();
    if(from.width<8||from.height<8||to.width<8||to.height<8)return false;
    viewer.classList.add('viewer-photo-transition');
    var panel=document.createElement('i');
    panel.className='motion-detail-panel';
    panel.setAttribute('aria-hidden','true');
    viewer.insertBefore(panel,viewer.firstChild);
    var dx=from.left-to.left,dy=from.top-to.top,sx=from.width/to.width,sy=from.height/to.height;
    target.animate([
      {transformOrigin:'top left',transform:'translate3d('+dx+'px,'+dy+'px,0) scale('+sx+','+sy+')',borderRadius:'22%',offset:0},
      {transformOrigin:'top left',transform:'translate3d('+dx+'px,'+dy+'px,0) scale('+(sx*.94)+','+(sy*.94)+')',borderRadius:'22%',offset:.16},
      {transformOrigin:'top left',transform:'translate3d(0,0,0) scale(1)',borderRadius:'0',offset:.55},
      {transformOrigin:'top left',transform:'translate3d(0,0,0) scale(1)',borderRadius:'0',offset:1}
    ],{duration:1900,easing:'cubic-bezier(.22,.61,.36,1)',fill:'both'});
    viewer.animate([{backgroundColor:'rgba(0,0,0,0)'},{backgroundColor:'#000'}],
      {duration:600,delay:200,easing:'cubic-bezier(.22,.61,.36,1)',fill:'both'});
    panel.animate([{transform:'translate3d(0,110%,0)'},{transform:'translate3d(0,0,0)'}],
      {duration:1900,delay:280,easing:'cubic-bezier(.22,.61,.36,1)',fill:'both'});
    var chrome=viewer.querySelectorAll('.vw-bar,.vw-dots,.vw-cap,.vw-tags,.vw-meta');
    Array.prototype.forEach.call(chrome,function(node,index){
      node.animate([{opacity:0,transform:'translateY(8px)'},{opacity:1,transform:'none'}],
        {duration:700,delay:index?1050:900,easing:'cubic-bezier(.22,.61,.36,1)',fill:'both'});
    });
    setTimeout(function(){
      panel.remove();
      if(viewer.isConnected)viewer.classList.remove('viewer-photo-transition');
    },2210);
    return true;
  }

  function rollNumber(node,value){
    if(!node)return;
    var nextValue=String(value);
    var spans=node.querySelectorAll('span');
    var current=spans.length?spans[0]:null;
    if(!current){
      current=document.createElement('span');current.textContent=node.textContent||'0';
      node.textContent='';node.appendChild(current);
    }
    if(current.textContent===nextValue)return;
    Array.prototype.forEach.call(spans,function(span){if(span!==current)span.remove();});
    if(reduce||!current.animate||!node.appendChild){current.textContent=nextValue;return;}
    var previous=Number(current.textContent),nextNumber=Number(nextValue),direction=isFinite(previous)&&isFinite(nextNumber)&&nextNumber<previous?-1:1;
    var incoming=document.createElement('span');incoming.textContent=nextValue;node.appendChild(incoming);
    node.classList.add('motion-number-roll');var generation=(node.__spotaRollGeneration||0)+1;node.__spotaRollGeneration=generation;
    current.animate([{transform:'translateY(0)',opacity:1},{transform:'translateY('+(-direction*100)+'%)',opacity:.18}],
      {duration:240,easing:'cubic-bezier(.22,.61,.36,1)',fill:'forwards'});
    var animation=incoming.animate([{transform:'translateY('+(direction*100)+'%)',opacity:.18},{transform:'translateY(0)',opacity:1}],
      {duration:240,easing:'cubic-bezier(.22,.61,.36,1)',fill:'forwards'});
    animation.onfinish=animation.oncancel=function(){
      if(node.__spotaRollGeneration!==generation)return;
      node.textContent='';incoming.textContent=nextValue;node.appendChild(incoming);node.classList.remove('motion-number-roll');
    };
  }

  function restartClass(node,name,duration){
    if(!node||reduce)return;
    node.classList.remove(name);void node.offsetWidth;node.classList.add(name);
    setTimeout(function(){node.classList.remove(name);},duration||900);
  }

  // 成否は呼び出し側が実際の処理結果を受け取った後だけ渡す。
  // 演出側から通信を発生させたり、結果を推測したりしない。
  function tipFeedback(kind){
    var tip=document.getElementById('tip');
    if(!tip||!kind)return;
    restartClass(tip,kind==='success'?'motion-tip-success':'motion-tip-error',kind==='success'?500:420);
  }

  // 既に画面にあるプロフィールアイコンを目的地へ移す。複製画像や
  // 手書きの代替アセットは作らず、元要素と遷移先の実要素だけを使う。
  function avatarTransition(origin,target){
    if(reduce||!origin||!target||!target.animate)return false;
    var from=origin.getBoundingClientRect(),to=target.getBoundingClientRect();
    if(from.width<8||from.height<8||to.width<8||to.height<8)return false;
    var dx=from.left-to.left,dy=from.top-to.top,sx=from.width/to.width,sy=from.height/to.height;
    target.animate([
      {transformOrigin:'center',transform:'translate3d('+dx+'px,'+dy+'px,0) scale('+sx+','+sy+')',opacity:.72},
      {transformOrigin:'center',transform:'translate3d('+(dx*.18)+'px,'+(dy*.18)+'px,0) scale('+(1+(sx-1)*.18)+','+(1+(sy-1)*.18)+')',opacity:1,offset:.68},
      {transformOrigin:'center',transform:'none',opacity:1}
    ],{duration:520,easing:'cubic-bezier(.22,.61,.36,1)',fill:'both'});
    return true;
  }

  function saveSuccess(node){restartClass(node||document.getElementById('btn-cam'),'motion-save-confirm',560);}
  function shareLaunch(node){restartClass(node,'motion-share-launch',460);}
  function sharedPhotoReveal(node){restartClass(node,'motion-shared-photo',430);}
  function photoError(node){restartClass(node,'motion-photo-error',380);}
  // #27: 既存の現在地アイコン自体をピント合わせのように収束させる。
  // 新しい装飾アセットや進捗リングは作らず、取得中だけaria-busyも同期する。
  function locateStart(node){
    node=node||document.getElementById('map-locate');if(!node)return function(){};
    node.classList.add('motion-locating');node.setAttribute('aria-busy','true');
    var ended=false;return function(){if(ended)return;ended=true;node.classList.remove('motion-locating');node.removeAttribute('aria-busy');};
  }

  // #10: 見た目だけのUndoは出さない。実際に元へ戻す非同期処理を受け取った時だけ表示する。
  function dismissUndo(){
    clearTimeout(undoTimer);undoTimer=0;
    var node=undoToast;undoToast=null;
    if(!node)return;
    node.classList.remove('is-visible');node.classList.add('is-leaving');
    setTimeout(function(){if(node.parentNode)node.parentNode.removeChild(node);},reduce?0:180);
  }
  function showUndo(message,undo,options){
    if(!document.body||typeof undo!=='function')return function(){};
    dismissUndo();options=options||{};
    var host=document.createElement('div');host.className='motion-undo-toast';
    host.setAttribute('role','region');host.setAttribute('aria-label','操作を元に戻す');
    var label=document.createElement('span');label.textContent=String(message||'変更しました');
    label.setAttribute('role','status');label.setAttribute('aria-live','polite');
    var button=document.createElement('button');button.type='button';button.textContent='元に戻す';
    host.appendChild(label);host.appendChild(button);document.body.appendChild(host);undoToast=host;
    requestAnimationFrame(function(){if(host.isConnected)host.classList.add('is-visible');});
    button.addEventListener('click',async function(){
      if(button.disabled)return;button.disabled=true;clearTimeout(undoTimer);undoTimer=0;
      try{await Promise.resolve(undo());dismissUndo();}
      catch(e){label.textContent=String(e&&e.message||'元に戻せませんでした');tipFeedback('error');button.disabled=false;undoTimer=setTimeout(dismissUndo,5200);}
    });
    undoTimer=setTimeout(dismissUndo,Math.max(3200,Number(options.duration)||5200));
    return dismissUndo;
  }

  function installInteractionMotion(){
    if(!document||typeof document.addEventListener!=='function')return;
    // カメラを少し長く押すと、輪を出さずに一度だけ「ぐっ」と返す。
    // 撮影アクション自体は従来どおりpointerup後のclickで実行する。
    var camera=document.getElementById('btn-cam');
    if(camera)bindHold(camera,null,{duration:520,style:'rigid',intensity:.9});
    var pressed=null;
    function releasePress(){if(pressed){pressed.classList.remove('motion-pressing');pressed=null;}}
    document.addEventListener('pointerdown',function(event){
      var target=event.target&&event.target.closest&&event.target.closest('button,.chip,[role="tab"]');
      if(!target||target.disabled)return;releasePress();pressed=target;target.classList.add('motion-pressing');
    },true);
    document.addEventListener('pointerup',releasePress,true);document.addEventListener('pointercancel',releasePress,true);
    document.addEventListener('click',function(event){
      var segment=event.target&&event.target.closest&&event.target.closest('[role="tab"],.chip');
      if(segment)restartClass(segment,'motion-segment-confirm',300);
    },true);
    document.addEventListener('change',function(event){
      var input=event.target;if(!input||!/^(checkbox|radio)$/.test(input.type||''))return;
      var host=input.closest&&input.closest('label,button,fieldset');if(host)restartClass(host,'motion-toggle-confirm',300);
    },true);
  }

  installInteractionMotion();

  window.SpotaMotion={
    catalog:catalog,
    beginWait:beginWait,
    endWait:endWait,
    withWait:withWait,
    photoLanding:photoLanding,
    pulseLocation:pulseLocation,
    viewerTransition:viewerTransition,
    rollNumber:rollNumber,
    restartClass:restartClass,
    tipFeedback:tipFeedback,
    avatarTransition:avatarTransition,
    saveSuccess:saveSuccess,
    shareLaunch:shareLaunch,
    sharedPhotoReveal:sharedPhotoReveal,
    photoError:photoError,
    locateStart:locateStart,
    showUndo:showUndo,
    dismissUndo:dismissUndo,
    haptic:haptic,
    bindHold:bindHold
  };
})();
