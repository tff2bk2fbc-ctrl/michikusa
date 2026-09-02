/* ============================================================
   Spota gestures

   ・下部5操作を横スワイプでも選べるようにする
   ・速度に応じて選択レンズへ短い伸びと傾きを与える
   ・地図を動かした直後の合成clickを場所選択へ渡さない

   認証、公開範囲、位置情報、API通信は変更しない。
   ============================================================ */
(function(){
  'use strict';

  var reduce=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var mapState={pointerId:null,startX:0,startY:0,moved:false,suppressUntil:0};

  function clamp(value,min,max){return Math.min(max,Math.max(min,value));}
  function now(){return window.performance&&performance.now?performance.now():Date.now();}

  function mapTapAllowed(){
    return !mapState.moved&&now()>=mapState.suppressUntil;
  }

  function installMapGesture(host,mapInstance){
    if(!host||host.__spotaMapGestureBound)return;
    host.__spotaMapGestureBound=true;

    function suppress(){
      mapState.moved=false;
      mapState.pointerId=null;
      mapState.suppressUntil=now()+210;
    }
    host.addEventListener('pointerdown',function(event){
      if(event.isPrimary===false||(event.pointerType==='mouse'&&event.button!==0))return;
      mapState.pointerId=event.pointerId;
      mapState.startX=event.clientX;
      mapState.startY=event.clientY;
      mapState.moved=false;
    },true);
    window.addEventListener('pointermove',function(event){
      if(mapState.pointerId===null||event.pointerId!==mapState.pointerId)return;
      if(Math.hypot(event.clientX-mapState.startX,event.clientY-mapState.startY)>=8)mapState.moved=true;
    },true);
    window.addEventListener('pointerup',function(event){
      if(mapState.pointerId===null||event.pointerId!==mapState.pointerId)return;
      if(mapState.moved)suppress();
      else mapState.pointerId=null;
    },true);
    window.addEventListener('pointercancel',function(event){
      if(mapState.pointerId!==null&&event.pointerId===mapState.pointerId)suppress();
    },true);
    host.addEventListener('lostpointercapture',function(event){
      if(mapState.pointerId!==null&&event.pointerId===mapState.pointerId)suppress();
    },true);

    // MapLibreがドラッグを確定した場合も同じ安全ロックへ接続する。
    if(mapInstance&&typeof mapInstance.on==='function'){
      mapInstance.on('dragstart',function(){mapState.moved=true;});
      mapInstance.on('dragend',suppress);
    }
  }

  function installNavigation(bar){
    if(!bar||bar.__spotaNavigationBound)return null;
    var pill=bar.querySelector('#pill');
    var lens=pill&&pill.querySelector('i');
    var items=Array.prototype.slice.call(bar.querySelectorAll('.nav-btn,.cam'));
    if(!pill||!lens||items.length!==5)return null;
    bar.__spotaNavigationBound=true;

    var active=clamp(Number(bar.dataset.activeIndex)||0,0,items.length-1);
    var drag=null,suppressClickUntil=0,invoking=false;

    function paint(index,offset,velocity,dragging){
      var button=items[index];if(!button)return;
      var parent=button.parentElement.getBoundingClientRect();
      var rect=button.getBoundingClientRect();
      var speed=Math.min(2.2,Math.abs(Number(velocity)||0));
      var stretch=dragging?1+Math.min(speed*.22,.48):1;
      var squash=dragging?1-Math.min((stretch-1)*.22,.1):1;
      var tilt=dragging?clamp((Number(velocity)||0)*2.1,-4.5,4.5):0;
      pill.style.width=rect.width+'px';
      pill.style.transform='translate3d('+(rect.left-parent.left+(Number(offset)||0))+'px,0,0)';
      lens.style.transform='scaleX('+stretch+') scaleY('+squash+') rotate('+tilt+'deg)';
      bar.style.setProperty('--glass-glow-shift',clamp((Number(offset)||0)*.42,-44,44)+'px');
      bar.classList.toggle('is-dragging',!!dragging);
      pill.classList.add('on');
    }

    function settle(velocity,direction){
      if(reduce||!lens.animate){lens.style.transform='none';return;}
      var speed=Math.min(2.2,Math.abs(Number(velocity)||0));
      var stretch=1+Math.min(speed*.22+Math.abs(direction||0)*.11,.48);
      var tilt=clamp(((Number(velocity)||0)||(direction||0)*.7)*2.1,-4.5,4.5);
      Array.prototype.forEach.call(lens.getAnimations?lens.getAnimations():[],function(animation){animation.cancel();});
      lens.animate([
        {transform:'scaleX('+stretch+') scaleY('+(1-Math.min((stretch-1)*.22,.1))+') rotate('+tilt+'deg)'},
        {transform:'scaleX(.96) scaleY(1.025) rotate(0deg)',offset:.68},
        {transform:'scaleX(1) scaleY(1) rotate(0deg)'}
      ],{duration:clamp(300+speed*90,300,510),easing:'cubic-bezier(.17,.86,.25,1.16)'});
    }

    function setActive(index,velocity,direction){
      active=clamp(index,0,items.length-1);
      bar.dataset.activeIndex=String(active);
      items.forEach(function(button,i){
        button.classList.toggle('on',i===active);
        if(i===active)button.setAttribute('aria-current','page');
        else button.removeAttribute('aria-current');
      });
      paint(active,0,0,false);
      settle(velocity,direction);
    }

    function invoke(index,velocity,direction){
      var previous=active;
      setActive(index,velocity,direction);
      if(previous!==active&&window.SpotaMotion&&typeof window.SpotaMotion.haptic==='function'){
        window.SpotaMotion.haptic('light',.54);
      }
      invoking=true;
      try{items[active].click();}finally{invoking=false;}
    }

    bar.addEventListener('click',function(event){
      var button=event.target&&event.target.closest&&event.target.closest('.nav-btn,.cam');
      if(!button||items.indexOf(button)<0)return;
      if(!invoking&&now()<suppressClickUntil){
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      var index=items.indexOf(button),direction=Math.sign(index-active);
      setActive(index,0,direction);
    },true);

    bar.addEventListener('pointerdown',function(event){
      if(event.isPrimary===false||(event.pointerType==='mouse'&&event.button!==0))return;
      var time=now();
      drag={pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,axis:null,
        history:[{x:event.clientX,t:time}]};
      try{bar.setPointerCapture(event.pointerId);}catch(e){}
    });
    bar.addEventListener('pointermove',function(event){
      if(!drag||event.pointerId!==drag.pointerId)return;
      var time=now(),dx=event.clientX-drag.startX,dy=event.clientY-drag.startY;
      if(!drag.axis&&Math.hypot(dx,dy)>=8)drag.axis=Math.abs(dx)>Math.abs(dy)*1.15?'x':'blocked';
      if(drag.axis!=='x')return;
      event.preventDefault();
      drag.history.push({x:event.clientX,t:time});
      drag.history=drag.history.filter(function(point){return time-point.t<=90;});
      var first=drag.history[0];
      var velocity=first&&time>first.t?clamp((event.clientX-first.x)/(time-first.t),-2.2,2.2):0;
      var follow=.72+Math.min(Math.abs(velocity)/2.2,1)*.16;
      var edge=(active===0&&dx>0)||(active===items.length-1&&dx<0);
      paint(active,dx*follow*(edge ? .3 : 1),velocity,true);
    },{passive:false});

    function end(event,cancelled){
      if(!drag||event.pointerId!==drag.pointerId)return;
      var time=now(),state=drag;drag=null;
      var dx=event.clientX-state.startX;
      var first=state.history[0];
      var velocity=first&&time>first.t?clamp((event.clientX-first.x)/(time-first.t),-2.2,2.2):0;
      bar.classList.remove('is-dragging');
      bar.style.setProperty('--glass-glow-shift','0px');
      if(!cancelled&&state.axis==='x'){
        suppressClickUntil=time+190;
        var projected=dx+velocity*180;
        var delta=projected<=-32?1:projected>=32?-1:0;
        var next=clamp(active+delta,0,items.length-1);
        if(next!==active)invoke(next,velocity,delta);else setActive(active,velocity,0);
      }else setActive(active,0,0);
      try{if(bar.hasPointerCapture(event.pointerId))bar.releasePointerCapture(event.pointerId);}catch(e){}
    }
    bar.addEventListener('pointerup',function(event){end(event,false);});
    bar.addEventListener('pointercancel',function(event){end(event,true);});
    bar.addEventListener('lostpointercapture',function(event){if(drag)end(event,true);});
    bar.addEventListener('keydown',function(event){
      if(!/^(ArrowLeft|ArrowRight|Home|End)$/.test(event.key))return;
      event.preventDefault();
      var next=event.key==='Home'?0:event.key==='End'?items.length-1:
        clamp(active+(event.key==='ArrowRight'?1:-1),0,items.length-1);
      if(next===active)return;
      invoke(next,0,Math.sign(next-active));
      items[next].focus();
    });
    window.addEventListener('resize',function(){paint(active,0,0,false);});
    requestAnimationFrame(function(){setActive(active,0,0);});
    return {getIndex:function(){return active;},select:function(index){invoke(index,0,Math.sign(index-active));}};
  }

  installMapGesture(document.getElementById('map'),window.__michikusaMap);
  var navigation=installNavigation(document.getElementById('fabs'));
  window.SpotaGestures={
    installMapGesture:installMapGesture,
    installNavigation:installNavigation,
    mapTapAllowed:mapTapAllowed,
    navigation:navigation,
    _mapState:mapState
  };
})();
