/* ============================================================
   初回起動

   権限は、理由を説明してから本人の操作でOSへ尋ねる。
   同意前は現在地取得と周辺データ読み込みを始めない。
   ============================================================ */
(function(){
  var root=document.getElementById('onboarding');
  var panel=document.getElementById('onboarding-panel');
  var content=document.getElementById('onboarding-content');
  var progress=document.getElementById('onboarding-progress');
  var legal=document.getElementById('onboarding-legal');
  var legalTitle=document.getElementById('onboarding-legal-title');
  var legalBody=document.getElementById('onboarding-legal-body');
  var legalClose=document.getElementById('onboarding-legal-close');
  var version=window.__spotaOnboardingVersion||'2026-08-17.1';
  var stageKey='spota_onboarding_stage_'+String(version).replace(/[^A-Za-z0-9_.-]/g,'_');
  var stage=0,total=7,background=[];
  var permissionResult={};

  if(!root||!panel||!content||!progress||!legal)return;
  window.openSpotaLegal=openLegal;
  legalClose.onclick=function(){legal.close();};
  legal.addEventListener('click',function(event){if(event.target===legal)legal.close();});
  if(!window.__spotaNeedsOnboarding){
    window.__spotaOnboardingActive=false;
    return;
  }

  try{
    // 以前の版や開発中の途中位置を、新しい規約版へ持ち越さない。
    localStorage.removeItem('spota_onboarding_stage');
    stage=Math.max(0,Math.min(total-1,Number(localStorage.getItem(stageKey)||0)));
    if(stage>4&&!legalAccepted())stage=4;
  }catch(e){stage=0;}

  function legalAccepted(){
    try{
      var value=JSON.parse(localStorage.getItem('spota_legal_acceptance')||'null');
      return !!(value&&value.terms===version&&value.privacy===version&&value.accepted_at);
    }catch(e){return false;}
  }

  function saveStage(next){
    stage=next;
    try{localStorage.setItem(stageKey,String(stage));}catch(e){}
  }
  function setProgress(){progress.style.width=Math.max(8,((stage+1)/total)*100)+'%';}
  function frame(body){
    content.innerHTML=body;
    setProgress();
    panel.focus({preventScroll:true});
  }
  function controls(primary,secondary){
    return '<div class="onboarding-actions">'+primary+(secondary||'')+'</div>';
  }
  function statusText(text){
    var status=document.getElementById('onboarding-status');
    if(status)status.textContent=text||'';
  }
  function next(){saveStage(Math.min(total-1,stage+1));render();}
  function back(){saveStage(Math.max(0,stage-1));render();}
  function bindBack(){var b=document.getElementById('onboarding-back');if(b)b.onclick=back;}

  function welcome(){
    frame('<div class="onboarding-hero"><img src="/icon-192.png?v=123" alt=""><span>Spota</span></div>'+
      '<h1 id="onboarding-title">地図に、思い出を。</h1>'+
      '<p class="onboarding-lead">写真に残った場所を、自分の地図へ静かに重ねます。公開する相手と位置の精度は、あとから自分で選べます。</p>'+
      controls('<button class="onboarding-primary" id="onboarding-next" type="button">はじめる</button>'));
    document.getElementById('onboarding-next').onclick=next;
  }

  function permissionScreen(kind,title,body,allowLabel){
    var result=permissionResult[kind];
    frame('<button class="onboarding-back" id="onboarding-back" type="button">戻る</button>'+
      '<h1 id="onboarding-title">'+title+'</h1>'+
      '<p class="onboarding-lead">'+body+'</p>'+
      '<p class="onboarding-status" id="onboarding-status" role="status">'+(result||'')+'</p>'+
      controls(
        result
          ? '<button class="onboarding-primary" id="onboarding-next" type="button">次へ</button>'
          : '<button class="onboarding-primary" id="onboarding-allow" type="button">'+allowLabel+'</button>',
        result?'':'<button class="onboarding-secondary" id="onboarding-skip" type="button">今はしない</button>'
      ));
    bindBack();
    var skip=document.getElementById('onboarding-skip');if(skip)skip.onclick=next;
    var go=document.getElementById('onboarding-next');if(go)go.onclick=next;
    var allow=document.getElementById('onboarding-allow');
    if(allow)allow.onclick=async function(){
      allow.disabled=true;statusText('OSの確認画面を開いています');
      var fn=kind==='notification'?window.requestSpotaNotificationPermission:
        kind==='media'?window.requestSpotaMediaPermissions:window.requestSpotaLocationPermission;
      try{
        var resultValue=fn?await fn():{supported:false,granted:false};
        permissionResult[kind]=resultValue&&resultValue.granted
          ? '許可されました。設定はOSからいつでも変更できます。'
          : resultValue&&resultValue.supported===false
            ? 'この環境では確認画面を開けません。必要になった時にもう一度確認します。'
            : '許可されませんでした。必要になった時に設定から変更できます。';
      }catch(e){permissionResult[kind]='確認できませんでした。必要になった時に設定から変更できます。';}
      render();
    };
  }

  function terms(){
    var accepted=legalAccepted();
    frame('<button class="onboarding-back" id="onboarding-back" type="button">戻る</button>'+
      '<h1 id="onboarding-title">大切なことを確認</h1>'+
      '<p class="onboarding-lead">写真、位置情報、公開範囲の扱いを確認してください。全文はいつでもプロフィールから開けます。</p>'+
      '<div class="onboarding-legal-links">'+
        '<button type="button" data-legal="/terms.html">利用規約全文を開く</button>'+
        '<button type="button" data-legal="/privacy.html">プライバシーポリシー全文を開く</button>'+
      '</div>'+
      '<form id="onboarding-terms-form" novalidate>'+
        '<fieldset><legend>同意の確認</legend>'+
          '<label class="onboarding-check"><input id="onboarding-consent" type="checkbox" required '+(accepted?'checked':'')+'><span>利用規約とプライバシーポリシーを確認し、同意します。</span></label>'+
        '</fieldset>'+
        '<p class="onboarding-error" id="onboarding-consent-error" tabindex="-1" hidden>同意する場合は、チェックを入れてください。</p>'+
        controls('<button class="onboarding-primary" type="submit">同意して次へ</button>')+
      '</form>');
    bindBack();
    Array.prototype.forEach.call(content.querySelectorAll('[data-legal]'),function(button){
      button.onclick=function(){openLegal(button.dataset.legal);};
    });
    var form=document.getElementById('onboarding-terms-form');
    var check=document.getElementById('onboarding-consent');
    var error=document.getElementById('onboarding-consent-error');
    form.onsubmit=function(event){
      event.preventDefault();
      if(!check.checked){
        check.setAttribute('aria-invalid','true');check.setAttribute('aria-describedby','onboarding-consent-error');
        error.hidden=false;error.focus();return;
      }
      check.removeAttribute('aria-invalid');check.removeAttribute('aria-describedby');error.hidden=true;
      try{localStorage.setItem('spota_legal_acceptance',JSON.stringify({terms:version,privacy:version,accepted_at:new Date().toISOString()}));}catch(e){}
      next();
    };
    check.onchange=function(){if(check.checked){check.removeAttribute('aria-invalid');check.removeAttribute('aria-describedby');error.hidden=true;}};
  }

  async function openLegal(path){
    legalTitle.textContent='文書を読み込んでいます';
    legalBody.innerHTML='<p class="onboarding-legal-loading" role="status">読み込んでいます</p>';
    if(!legal.open)legal.showModal();
    try{
      var response=await fetch(path,{headers:{Accept:'text/html'}});
      if(!response.ok)throw new Error('load failed');
      var doc=new DOMParser().parseFromString(await response.text(),'text/html');
      var main=doc.querySelector('.legal-document');if(!main)throw new Error('document missing');
      var home=main.querySelector('.legal-home');if(home)home.remove();
      legalTitle.textContent=main.dataset.legalTitle||doc.title||'文書';
      legalBody.replaceChildren.apply(legalBody,Array.from(main.childNodes));
    }catch(e){
      legalTitle.textContent='文書を開けませんでした';
      legalBody.innerHTML='<p>通信を確認して、もう一度お試しください。</p>';
    }
  }
  function login(){
    var auth=window.getSpotaAuthState&&window.getSpotaAuthState();
    if(auth&&auth.user){saveStage(6);profile();return;}
    frame('<button class="onboarding-back" id="onboarding-back" type="button">戻る</button>'+
      '<h1 id="onboarding-title">思い出を端末の外にも残す</h1>'+
      '<p class="onboarding-lead">ログインすると、写真を安全に保存し、機種変更後も戻せます。iPhoneではAppleまたはGoogleを選べます。</p>'+
      '<p class="onboarding-status" id="onboarding-status" role="status"></p>'+
      controls('<button class="onboarding-primary" id="onboarding-apple-login" type="button">Appleでログイン</button>',
        '<button class="onboarding-secondary" id="onboarding-google-login" type="button">Googleでログイン</button>'+
        '<button class="onboarding-secondary" id="onboarding-guest" type="button">ログインせず地図を見る</button>'));
    bindBack();
    document.getElementById('onboarding-guest').onclick=complete;
    document.getElementById('onboarding-google-login').onclick=async function(){
      var button=this;button.disabled=true;statusText('ログインを準備しています');
      try{
        var loaded=typeof firebase!=='undefined'||await need('firebase');
        if(!loaded)throw new Error('login unavailable');
        if(window.initAuth)window.initAuth();
        if(!window.startSpotaLogin)throw new Error('login unavailable');
        statusText('Googleの確認画面でアカウントを選んでください');
        await window.startSpotaLogin();
      }catch(e){button.disabled=false;statusText('ログインを始められませんでした。通信を確認してもう一度お試しください。');}
    };
    document.getElementById('onboarding-apple-login').onclick=async function(){
      var button=this;button.disabled=true;statusText('Appleの確認画面を準備しています');
      try{
        var loaded=typeof firebase!=='undefined'||await need('firebase');
        if(!loaded)throw new Error('login unavailable');
        if(window.initAuth)window.initAuth();
        if(!window.startSpotaAppleLogin)throw new Error('login unavailable');
        statusText('Appleの画面で本人確認をしてください');
        await window.startSpotaAppleLogin();
      }catch(e){
        button.disabled=false;
        var code=String(e&&(e.code||e.message)||'');
        if(/cancel|canceled|1001/i.test(code)){statusText('Appleログインをキャンセルしました。もう一度試せます。');return;}
        statusText(window.describeSpotaAppleAuthError
          ? window.describeSpotaAppleAuthError(e)
          : 'Appleログインを始められませんでした。設定を確認してもう一度お試しください。');
      }
    };
  }

  function iconChoices(current){
    return PROFILE_ICONS.map(function(key){
      var id='onboarding-icon-'+key;
      return '<label class="onboarding-icon" for="'+id+'"><input type="radio" id="'+id+'" name="profile_icon" value="'+key+'" '+(key===current?'checked':'')+'>'+profileIconSvg(key)+'<span>'+esc(PROFILE_ICON_LABELS[key])+'</span></label>';
    }).join('');
  }

  function profile(){
    var auth=window.getSpotaAuthState&&window.getSpotaAuthState();
    if(!auth||!auth.user){saveStage(5);login();return;}
    var existing=auth.profile&&auth.profile.handle||'';
    var initial=(auth.user.displayName||'').replace(/[^A-Za-z0-9_]/g,'').slice(0,12).toLowerCase();
    frame('<button class="onboarding-back" id="onboarding-back" type="button">戻る</button>'+
      '<h1 id="onboarding-title">あなたの印を決める</h1>'+
      '<p class="onboarding-lead">利用者IDはフレンド検索とQRに使います。設定後は変更できません。</p>'+
      '<form id="onboarding-profile-form" novalidate>'+
        '<div class="onboarding-field"><label for="onboarding-handle">利用者ID</label>'+
          '<input id="onboarding-handle" name="handle" value="'+esc(existing||initial)+'" '+(existing?'readonly':'required')+' autocomplete="username" autocapitalize="none" spellcheck="false" aria-describedby="onboarding-handle-hint onboarding-handle-error">'+
          '<p id="onboarding-handle-hint">英数字と _ で3〜20文字。あとから変更できません。</p>'+
          '<p class="onboarding-error" id="onboarding-handle-error" tabindex="-1" hidden></p></div>'+
        '<fieldset class="onboarding-icons"><legend>プロフィールアイコン</legend><div>'+iconChoices(auth.profile&&auth.profile.profile_icon||'pin')+'</div></fieldset>'+
        '<p class="onboarding-status" id="onboarding-status" role="status"></p>'+
        controls('<button class="onboarding-primary" type="submit">設定を完了</button>')+
      '</form>');
    bindBack();
    var form=document.getElementById('onboarding-profile-form');
    var input=document.getElementById('onboarding-handle');
    var error=document.getElementById('onboarding-handle-error');
    form.onsubmit=async function(event){
      event.preventDefault();
      var handle=input.value.trim();
      if(!/^[A-Za-z0-9_]{3,20}$/.test(handle)){
        input.setAttribute('aria-invalid','true');error.textContent='英数字と _ で3〜20文字にしてください。';error.hidden=false;error.focus();return;
      }
      input.removeAttribute('aria-invalid');error.hidden=true;
      var selected=form.querySelector('input[name="profile_icon"]:checked');
      var submit=form.querySelector('[type="submit"]');submit.disabled=true;statusText('プロフィールを保存しています');
      try{
        if(!window.saveSpotaOnboardingProfile)throw new Error('save unavailable');
        await window.saveSpotaOnboardingProfile(handle,selected&&selected.value||'pin');
        complete();
      }catch(e){
        submit.disabled=false;
        var message=e&&e.message||'プロフィールを保存できませんでした。';
        error.textContent=message;error.hidden=false;error.focus();statusText('');
      }
    };
    input.oninput=function(){input.removeAttribute('aria-invalid');error.hidden=true;};
  }

  function complete(){
    try{
      localStorage.setItem('spota_onboarding_complete',version);
      localStorage.removeItem(stageKey);
    }catch(e){}
    window.__spotaNeedsOnboarding=false;
    window.__spotaOnboardingActive=false;
    document.body.classList.remove('onboarding-active');
    background.forEach(function(node){node.inert=false;});background=[];
    root.hidden=true;
    if(typeof window.resumeSpotaAfterOnboarding==='function')window.resumeSpotaAfterOnboarding();
    var mapWasDeferred=false;
    if(typeof window.startSpotaMapAfterOnboarding==='function'){
      mapWasDeferred=window.startSpotaMapAfterOnboarding();
    }
    // 遅延した地図は style.load 後の afterStyle が現在地取得と周辺読込を行う。
    // ここでも同時に始めると、空の地図へ二重リクエストしてしまう。
    if(mapWasDeferred){
      if(typeof setTip==='function')setTip('初回設定が完了しました');
      return;
    }
    if(typeof window.requestInitialHome==='function'){
      window.__homed=0;window.requestInitialHome();
    }
    if(typeof window.autoLoad==='function')window.autoLoad(true);
    if(typeof setTip==='function')setTip('初回設定が完了しました');
  }

  function render(){
    if(stage===0)return welcome();
    if(stage===1)return permissionScreen('notification','大切な反応を知らせる','フレンド申請、メッセージ、写真への反応を通知します。許可しなくてもSpotaは使えます。','通知を許可');
    if(stage===2)return permissionScreen('media','選んだ写真だけを使う','撮影と写真の追加に使います。写真に撮影位置がある場合は端末内で読み取り、投稿前に場所を確認できます。','写真とカメラを許可');
    if(stage===3)return permissionScreen('location','現在地を地図に映す','現在地ボタンと投稿場所の候補に使います。許可しない場合も、地図から場所を選べます。','位置情報を許可');
    if(stage===4)return terms();
    if(stage===5)return login();
    return profile();
  }

  root.hidden=false;
  document.body.classList.add('onboarding-active');
  Array.prototype.forEach.call(document.body.children,function(node){
    if(node!==root&&node!==legal&&node.id!=='splash'&&node.id!=='err'&&node.tagName!=='SCRIPT'&&!node.inert){node.inert=true;background.push(node);}
  });
  window.addEventListener('spota:auth-changed',function(event){
    if(!window.__spotaOnboardingActive||stage!==5||!(event.detail&&event.detail.user))return;
    saveStage(6);profile();
  });
  render();
  if(typeof need==='function')need('firebase').then(function(ok){if(ok&&window.initAuth)window.initAuth();});
})();
