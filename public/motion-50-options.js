(()=>{
  'use strict';
  const reduce=matchMedia('(prefers-reduced-motion:reduce)').matches;
  document.querySelectorAll('.option').forEach(option=>{
    const stage=option.querySelector('.stage'),card=option.querySelector('.decision-card'),status=option.querySelector('.status');
    let active=false,pointer=null,sx=0,sy=0,dx=0,dy=0,threshold=false;
    const paint=(choice,progress=1)=>{stage.classList.toggle('use',choice==='use');stage.classList.toggle('pass',choice==='pass');stage.style.setProperty('--progress',String(progress));};
    const clear=()=>{stage.classList.remove('use','pass');stage.style.removeProperty('--progress');card.style.transform='';card.style.opacity='';threshold=false;};
    const haptic=()=>{if(navigator.vibrate)navigator.vibrate(14);};
    const choose=choice=>{
      paint(choice,1);status.textContent=(choice==='use'?'USE':'PASS')+'を選択しました';if(!threshold)haptic();
      card.style.transition=reduce?'opacity .15s':'transform .26s var(--ease),opacity .2s';card.style.opacity='.12';
      card.style.transform=reduce?'none':`translate3d(${choice==='use'?'125%':'-125%'},${choice==='use'?'-14%':'3%'},0) rotate(${choice==='use'?7:-7}deg)`;
      setTimeout(()=>{card.style.transition='none';clear();requestAnimationFrame(()=>{card.style.transition='';card.focus({preventScroll:true});});},300);
    };
    card.addEventListener('pointerdown',event=>{if(!event.isPrimary||(event.pointerType==='mouse'&&event.button!==0))return;active=true;pointer=event.pointerId;sx=event.clientX;sy=event.clientY;dx=dy=0;card.style.transition='none';});
    card.addEventListener('pointermove',event=>{if(!active||event.pointerId!==pointer)return;dx=event.clientX-sx;dy=event.clientY-sy;if(Math.abs(dx)<8)return;event.preventDefault();try{card.setPointerCapture(pointer);}catch(e){}const progress=Math.min(1,Math.abs(dx)/(card.offsetWidth*.30));paint(dx>0?'use':'pass',progress);const y=Math.max(-110,Math.min(55,dy*.42));card.style.transform=`translate3d(${dx}px,${y}px,0) rotate(${dx/innerWidth*7}deg)`;if(progress>=1&&!threshold){threshold=true;haptic();}if(progress<1)threshold=false;});
    const end=event=>{if(!active||event.pointerId!==pointer)return;active=false;if(Math.abs(dx)>card.offsetWidth*.28)choose(dx>0?'use':'pass');else{card.style.transition='transform .28s var(--ease)';clear();}};
    card.addEventListener('pointerup',end);card.addEventListener('pointercancel',()=>{active=false;clear();});card.addEventListener('lostpointercapture',()=>{if(active){active=false;clear();}});
    card.addEventListener('keydown',event=>{if(event.key==='ArrowRight'){event.preventDefault();choose('use');}if(event.key==='ArrowLeft'){event.preventDefault();choose('pass');}});
    option.querySelectorAll('[data-choice]').forEach(button=>button.addEventListener('click',()=>choose(button.dataset.choice)));
  });
})();
