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
      var ghost=document.createElement('div');
      ghost.className='motion-photo-drop';
      ghost.style.left=(startX-70)+'px';ghost.style.top=(startY-70)+'px';
      var image=document.createElement('img');image.alt='';image.src=photo;ghost.appendChild(image);
      document.body.appendChild(ghost);
      if(!ghost.animate){ghost.remove();resolve();return;}
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
      function finish(){clearTimeout(ringTimer);ghost.remove();setTimeout(function(){ring.remove();},700);resolve();}
      animation.onfinish=finish;animation.oncancel=finish;
    });
  }

  function pulseLocation(marker){
    if(!marker||reduce)return;
    marker.classList.remove('is-locating');
    void marker.offsetWidth;
    marker.classList.add('is-locating');
    clearTimeout(marker.__spotaLocationTimer);
    marker.__spotaLocationTimer=setTimeout(function(){marker.classList.remove('is-locating');},3500);
  }

  function viewerTransition(viewer,origin,target){
    if(reduce||!viewer||!origin||!target||!target.animate)return false;
    var from=origin.getBoundingClientRect(),to=target.getBoundingClientRect();
    if(from.width<8||from.height<8||to.width<8||to.height<8)return false;
    viewer.classList.add('viewer-photo-transition');
    var dx=from.left-to.left,dy=from.top-to.top,sx=from.width/to.width,sy=from.height/to.height;
    target.animate([
      {transformOrigin:'top left',transform:'translate3d('+dx+'px,'+dy+'px,0) scale('+sx+','+sy+')',borderRadius:'16px'},
      {transformOrigin:'top left',transform:'translate3d(0,0,0) scale(1)',borderRadius:'0'}
    ],{duration:680,easing:'cubic-bezier(.22,.61,.36,1)'});
    viewer.animate([{backgroundColor:'rgba(0,0,0,0)'},{backgroundColor:'#000'}],
      {duration:520,easing:'ease-out'});
    var chrome=viewer.querySelectorAll('.vw-bar,.vw-dots,.vw-cap,.vw-tags,.vw-meta');
    Array.prototype.forEach.call(chrome,function(node){
      node.animate([{opacity:0,transform:'translateY(8px)'},{opacity:1,transform:'none'}],
        {duration:360,delay:300,easing:'cubic-bezier(.22,.61,.36,1)'});
    });
    setTimeout(function(){if(viewer.isConnected)viewer.classList.remove('viewer-photo-transition');},720);
    return true;
  }

  function restartClass(node,name,duration){
    if(!node||reduce)return;
    node.classList.remove(name);void node.offsetWidth;node.classList.add(name);
    setTimeout(function(){node.classList.remove(name);},duration||900);
  }

  window.SpotaMotion={
    beginWait:beginWait,
    endWait:endWait,
    withWait:withWait,
    photoLanding:photoLanding,
    pulseLocation:pulseLocation,
    viewerTransition:viewerTransition,
    restartClass:restartClass
  };
})();
