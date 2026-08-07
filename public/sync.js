/* ============================================================
   サーバーとの同期

   これまでは端末の中だけに置いていた。
   Safariは7日開かないと消してしまうので、思い出が消える。
   ログインしたら、サーバーへ預けて、どの端末からでも戻るようにする。
   ============================================================ */

/* 写真をサーバーへ。原本と表示用を別々に持つ */
async function uploadPhoto(postId, photoId, dataUrl){
  try{
    var blob=await (await fetch(dataUrl)).blob();
    var pid=photoId;
    async function put(kind,body,type){
      var r=await api('/api/photo?post_id='+encodeURIComponent(postId)+
        '&photo_id='+encodeURIComponent(pid)+'&kind='+kind,
        {method:'PUT',headers:{'Content-Type':type},body:body});
      if(!r.ok)throw new Error('photo upload '+r.status);
    }
    // 原本
    await put('orig',blob,blob.type||'image/jpeg');
    // 表示用（軽くしたもの）
    var view=await resize(dataUrl,2560,.90);
    if(view){
      var vb=await (await fetch(view)).blob();
      await put('view',vb,'image/jpeg');
    }
    var th=await resize(dataUrl,512,.82);
    if(th){
      var tb=await (await fetch(th)).blob();
      await put('thumb',tb,'image/jpeg');
    }
    return true;
  }catch(e){ return false; }
}
function resize(dataUrl,max,q){
  return new Promise(function(res){
    var im=new Image();
    im.onload=function(){
      var sc=Math.min(1,max/Math.max(im.width,im.height));
      var cv=document.createElement('canvas');
      cv.width=Math.round(im.width*sc); cv.height=Math.round(im.height*sc);
      var cx=cv.getContext('2d'); cx.imageSmoothingQuality='high';
      cx.drawImage(im,0,0,cv.width,cv.height);
      res(cv.toDataURL('image/jpeg',q));
    };
    im.onerror=function(){res(null);};
    im.src=dataUrl;
  });
}

/* 1件をサーバーへ送る */
async function pushOne(rec){
  try{
    // 他人に見せるものは、先に写真を確かめる
    if(rec.photo && rec.visibility!=='private'){
      try{
        var vr=await api('/api/vision',{method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({image:String(rec.photo)})});
        if(!vr.ok)throw new Error('moderation unavailable');
        var vj=await vr.json();
        if(!vj || vj.ok!==true)throw new Error('moderation rejected');
      }catch(e){
        rec.visibility='private';
        setTip('写真を確認できないため、自分だけの記録にしました');
      }
    }
    if(!rec.server_id){
      var r=await api('/api/posts',{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          title:rec.n, category:rec.c, tag:rec.tag||'', place_name:rec.place||'',
          lat:rec.lat, lng:rec.lng,
          taken_at:rec.d?Date.parse(rec.d):null,
          visibility:rec.visibility||null
        })});
      if(!r.ok)return false;
      var j=await r.json();
      rec.server_id=j.id;
      rec.visibility=j.visibility;
      await dbPut('spots',rec);
    }
    if(rec.photo){
      rec.server_photo_id=rec.server_photo_id||nid();
      await dbPut('spots',rec);
      if(!(await uploadPhoto(rec.server_id,rec.server_photo_id,rec.photo)))return false;
    }
    rec.synced=1;
    await dbPut('spots',rec);
    return true;
  }catch(e){ return false; }
}

/* まだ送っていないものをまとめて送る */
let syncing=false;
async function syncUp(){
  if(!fbUser||syncing)return;
  var todo=spots.filter(function(s){return !s.synced;});
  if(!todo.length)return;
  syncing=true;
  setTip('思い出をサーバーへ預けています…（'+todo.length+'件）');
  var ok=0;
  for(var i=0;i<todo.length;i++){ if(await pushOne(todo[i]))ok++; }
  syncing=false;
  setTip(ok?(ok+'件を預けました'):'預けられませんでした');
  render(true);
}

/* サーバーから取り込む。他人のぶんも含む */
let fetching=false;
async function syncDown(){
  if(!fbUser||fetching)return;
  fetching=true;
  try{
    var b=map.getBounds();
    var r=await api('/api/posts?s='+b.getSouth()+'&w='+b.getWest()+
      '&n='+b.getNorth()+'&e='+b.getEast()+'&limit=300');
    if(!r.ok)return;
    var j=await r.json();
    var mineIds={}; spots.forEach(function(s){ if(s.server_id)mineIds[s.server_id]=1; });
    var added=0;
    (j.posts||[]).forEach(function(p){
      if(p.mine){
        if(mineIds[p.id])return;                 // すでに手元にある
        var rec={id:nid(),server_id:p.id,synced:1,n:p.title,c:p.category,
          tag:p.tag||'',place:p.place_name||'',lat:p.lat,lng:p.lng,
          d:p.taken_at?new Date(p.taken_at).toISOString().slice(0,10):'',
          photo:'',visibility:p.visibility};
        spots.push(rec); dbPut('spots',rec); added++;
      }else{
        // 他人の思い出。地図には出すが端末には残さない
        var k=p.id;
        if(others[k])return;
        others[k]={n:p.title,c:p.category,lat:p.lat,lng:p.lng,
          gname:(p.author&&p.author.name?p.author.name+' の思い出':''),
          tag:p.tag||'',author:p.author,precision:p.precision,friend:true};
        added++;
      }
    });
    if(added)render(true);
  }catch(e){}finally{ fetching=false; }
}
let others={};



/* ============================================================
   届いたタグ

   フレンドがタグ付けすると、ここに出る。
   受け取れば、同じ思い出が自分の地図にも載る。
   ============================================================ */
async function checkTags(){
  if(!fbUser)return;
  try{
    var r=await api('/api/tags');
    if(!r.ok)return;
    var j=await r.json();
    var t=(j.tags||[])[0];
    if(!t)return;
    showInbox(t);
  }catch(e){}
}

function showInbox(t){
  var box=document.getElementById('inbox');
  if(!box){
    box=el('<div class="inbox" id="inbox"></div>');
    document.body.appendChild(box);
  }
  box.innerHTML='<div class="r">'+
    '<img id="ib-img">'+
    '<div class="t"><b>'+esc(t.from.name)+' がタグ付けしました</b>'+
    '<span>'+esc(t.title||t.place_name||'')+'</span></div></div>'+
    '<div class="b"><button id="ib-no">いらない</button>'+
    '<button class="y" id="ib-yes">自分の思い出にする</button></div>';
  box.classList.add('on');

  if(t.photo_id){
    api('/api/photo/'+encodeURIComponent(t.photo_id)+'/thumb')
      .then(function(r){if(!r.ok)throw new Error('photo '+r.status);return r.blob();})
      .then(function(blob){
        var im=box.querySelector('#ib-img');if(!im)return;
        var u=URL.createObjectURL(blob);im.onload=function(){URL.revokeObjectURL(u);};im.src=u;
      }).catch(function(){});
  }

  async function reply(take){
    box.classList.remove('on');
    try{
      var r=await api('/api/tags/accept',{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({post_id:t.post_id, take:take})});
      var j=await r.json();
      if(take&&j.ok){
        setTip('自分の思い出になりました');
        syncDown();
        map.easeTo({center:[t.lng,t.lat],zoom:16.4,duration:800});
      }
    }catch(e){}
    setTimeout(checkTags,600);      // 次があれば続けて出す
  }
  box.querySelector('#ib-yes').onclick=function(){ reply(true); };
  box.querySelector('#ib-no').onclick=function(){ reply(false); };
}

/* ============================================================
   ログイン
   ============================================================ */
const FB={apiKey:"AIzaSyAJFFjRk6zvAA_L9-1O7Y7Q43Yw86QQtxM",
  authDomain:"michikusa-e34df.firebaseapp.com",projectId:"michikusa-e34df",
  storageBucket:"michikusa-e34df.firebasestorage.app",
  messagingSenderId:"1058235183759",appId:"1:1058235183759:web:8d0741be89ad707c07b6fa"};
let fbUser=null,meP=null;

/* 部品が用意できてから、ログインの仕組みを立ち上げる */
window.initAuth=function(){
  if(typeof firebase==='undefined')return;
  if(window.__authReady)return;
  window.__authReady=1;
  try{
    firebase.initializeApp(FB);
    try{ firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL); }catch(e){}

    firebase.auth().onAuthStateChanged(function(u){
      fbUser=u; var b=document.getElementById('btn-me');
      if(!b)return;
      if(u){
        b.innerHTML='<b>'+esc((u.displayName||'?').trim().charAt(0))+'</b>';
        loadMe().then(function(){ syncUp(); syncDown(); askHandle(); setupPush(); checkTags(); });
      }else{
        b.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>';
        meP=null;
      }
    });

    firebase.auth().getRedirectResult().then(function(r){
      if(r&&r.user) setTip('ログインしました');
    }).catch(function(e){
      if(e&&e.code&&e.code!=='auth/no-auth-event') setTip('ログイン失敗: '+e.code);
    });
  }catch(e){}
};

async function api(path,opt){
  opt=opt||{}; var h=Object.assign({},opt.headers||{});
  if(fbUser)h['Authorization']='Bearer '+(await fbUser.getIdToken());
  return fetch(SERVER+path,Object.assign({},opt,{headers:h}));
}
async function loadMe(){try{var r=await api('/api/me');if(r.ok)meP=await r.json();}catch(e){}}
document.getElementById('btn-me').onclick=async function(){
  if(typeof firebase==='undefined'){
    setTip('準備しています…');
    await need('firebase');
    if(window.initAuth)initAuth();
    await new Promise(function(r){setTimeout(r,300);});   // 状態が定まるのを少し待つ
  }
  openMe();
};



/* ============================================================
   ログイン

   アプリの中では別窓（ポップアップ）が開けないので、
   画面ごと移って戻ってくる方式にする。
   ============================================================ */

/* ============================================================
   はじめてのID

   ログインした直後に一度だけ尋ねる。
   あとから変えられない（配ったQRやリンクが死ぬため）ので、
   決める前にそのことを伝える。
   ============================================================ */
let askingHandle=false;

async function askHandle(){
  if(askingHandle)return;
  if(!fbUser||!meP||meP.handle)return;
  askingHandle=true;

  var base=(fbUser.displayName||'').replace(/[^A-Za-z0-9_]/g,'').slice(0,12).toLowerCase();
  var s=showSheet('<div class="grab"></div><div class="pad" style="padding-top:20px">'+
    '<div style="font-size:19px;font-weight:700;margin-bottom:8px">あなたのIDを決めます</div>'+
    '<div style="font-size:13px;color:var(--dim);line-height:1.85;margin-bottom:18px">'+
      'フレンドはこのIDであなたを見つけます。<br>'+
      '<b style="color:var(--warn)">あとから変えられません。</b>よく考えて決めてください。</div>'+
    '<input class="fld" id="h-in" placeholder="例：damo" autocomplete="off" '+
      'autocapitalize="none" spellcheck="false" value="'+esc(base)+'">'+
    '<div id="h-msg" style="font-size:12px;color:var(--dim);line-height:1.7;'+
      'min-height:34px;margin-bottom:4px">英数字と _ で、3〜20文字</div>'+
    '<button class="btn" id="h-ok">このIDにする</button></div>');

  var inp=s.querySelector('#h-in'), msg=s.querySelector('#h-msg'), ok=s.querySelector('#h-ok');

  function check(){
    var v=inp.value.trim();
    if(!/^[A-Za-z0-9_]{3,20}$/.test(v)){
      msg.textContent='英数字と _ で、3〜20文字にしてください';
      msg.style.color='var(--dim)';
      ok.disabled=true; return false;
    }
    msg.textContent='@'+v+' でよければ、下のボタンを押してください';
    msg.style.color='var(--dim)';
    ok.disabled=false; return true;
  }
  inp.oninput=check; check();

  ok.onclick=async function(){
    if(!check())return;
    var v=inp.value.trim();
    ok.disabled=true; ok.textContent='確かめています…';
    try{
      var r=await api('/api/me',{method:'PATCH',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({handle:v})});
      var j=await r.json().catch(function(){return {};});
      if(r.status===409){
        msg.textContent=(j.code==='taken')
          ? 'そのIDは既に使われています。別のものを入れてください'
          : (j.error||'そのIDは使えません');
        msg.style.color='var(--warn)';
        ok.disabled=false; ok.textContent='このIDにする';
        inp.focus(); inp.select();
        return;
      }
      if(!r.ok){
        msg.textContent=j.error||'保存できませんでした';
        msg.style.color='var(--warn)';
        ok.disabled=false; ok.textContent='このIDにする';
        return;
      }
      meP.handle=v;
      askingHandle=false;
      closeSheet();
      setTip('@'+v+' に決まりました');
    }catch(e){
      msg.textContent='通信できませんでした';
      msg.style.color='var(--warn)';
      ok.disabled=false; ok.textContent='このIDにする';
    }
  };
  setTimeout(function(){inp.focus();},380);
}

function doLogin(){
  if(typeof firebase==='undefined'){ setTip('ログインの部品がありません'); return; }
  var pv=new firebase.auth.GoogleAuthProvider();
  pv.setCustomParameters({prompt:'select_account'});

  // アプリの中では、画面を移さずにその場で済ませる
  var FA=plugin('FirebaseAuthentication');
  if(isApp&&FA){
    setTip('ログインしています…');
    FA.signInWithGoogle().then(function(r){
      // 受け取った証をこちら側にも渡す
      var tok=r&&r.credential&&r.credential.idToken;
      var acc=r&&r.credential&&r.credential.accessToken;
      if(!tok&&!acc){ setTip('ログインできませんでした'); return; }
      var cred=firebase.auth.GoogleAuthProvider.credential(tok||null,acc||null);
      return firebase.auth().signInWithCredential(cred);
    }).then(function(){
      setTip('ログインしました');
    }).catch(function(e){
      var c=(e&&(e.code||e.message))||e;
      if(/cancel/i.test(String(c)))return;      // 自分でやめた場合
      setTip('ログイン失敗: '+c);
    });
    return;
  }

  if(isApp){
    // 部品が無い場合は、画面遷移で
    firebase.auth().signInWithRedirect(pv).catch(function(e){
      setTip('ログイン失敗: '+(e&&e.code||e));
    });
    return;
  }

  firebase.auth().signInWithPopup(pv).catch(function(e){
    if(e&&/popup|blocked|cancel/i.test(e.code||'')){
      firebase.auth().signInWithRedirect(pv);
    }else{
      setTip('ログイン失敗: '+(e&&e.code||e));
    }
  });
}

/** ログアウト。アプリのときは両方から出る */
function doLogout(){
  var FA=plugin('FirebaseAuthentication');
  if(isApp&&FA){ try{ FA.signOut(); }catch(e){} }
  try{ firebase.auth().signOut(); }catch(e){}
  setTip('ログアウトしました');
}

function openMe(){
  var html='<div class="grab"></div><div class="pad" style="padding-top:18px">';
  if(!fbUser){
    html+='<div style="font-size:19px;font-weight:700;margin-bottom:8px">ログイン</div>'+
      '<div style="font-size:13.5px;color:var(--dim);line-height:1.8;margin-bottom:18px">'+
      '思い出がこの端末から離れて残るようになります。機種を変えても戻ってきます。<br>'+
      'フレンドと見せあうこともできます。</div>'+
      '<button class="btn" id="g">Googleでログイン</button>'+
      '<button class="btn g" id="x" style="margin-top:8px">あとで</button></div>';
    var s0=showSheet(html);
    s0.querySelector('#x').onclick=closeSheet;
    s0.querySelector('#g').onclick=function(){ closeSheet(); doLogin(); };
    return;
  }

  var st=(meP&&meP.settings)||{};
  var unsynced=spots.filter(function(s){return !s.synced;}).length;
  html+='<div style="font-size:19px;font-weight:700">'+esc(fbUser.displayName||'名前未設定')+'</div>'+
    '<div style="font-size:12.5px;color:var(--dim);margin:4px 0 4px">'+
      spots.length+' の思い出'+(unsynced?('　未保存 '+unsynced+'件'):'　すべて保存済み')+'</div>'+
    '<div style="font-size:12px;color:var(--dim);margin-bottom:16px">'+
      'あなたのID：<b id="myhandle">'+esc((meP&&meP.handle)||'（未設定）')+'</b></div>'+

    '<button class="btn" id="fr">フレンド</button>'+



    '<div class="lab" style="margin-top:20px">あなたのID</div>'+
    ((meP&&meP.handle)
      ? ('<div class="fld" style="opacity:.7">@'+esc(meP.handle)+'</div>'+
         '<div style="font-size:11.5px;color:var(--dim);margin-top:-4px;line-height:1.7">'+
         'IDは変更できません。</div>')
      : ('<button class="btn" id="h-set">IDを決める</button>'+
         '<div style="font-size:11.5px;color:var(--dim);margin-top:6px;line-height:1.7">'+
         'フレンドはこのIDであなたを探します。</div>'))+

    '<div class="lab" style="margin-top:22px">地図の見た目</div>'+
    '<div class="chips" id="seg-theme">'+
      Object.keys(THEMES).map(function(k){
        return '<button class="chip '+(theme===k?'on':'')+'" data-v="'+k+'">'+
          esc(THEMES[k].name)+'</button>';
      }).join('')+'</div>'+

    '<div class="lab" style="margin-top:22px">新しい思い出をだれに見せるか</div>'+
    '<div class="chips" id="seg-vis">'+
      [['private','自分だけ'],['friends','フレンド'],['public','みんな']].map(function(o){
        return '<button class="chip '+(st.default_visibility===o[0]?'on':'')+'" data-v="'+o[0]+'">'+o[1]+'</button>';
      }).join('')+'</div>'+


    '<button class="btn g" id="push-test" style="margin-top:20px">通知を試す</button>'+
    '<button class="btn g" id="out" style="margin-top:8px">ログアウト</button>'+
    '<button class="btn g" id="x" style="margin-top:8px">とじる</button></div>';

  var s=showSheet(html);
  s.querySelector('#x').onclick=closeSheet;
  s.querySelector('#fr').onclick=function(){openFriends();};
  s.querySelector('#out').onclick=function(){ doLogout(); closeSheet(); };
  var pt=s.querySelector('#push-test');
  if(pt)pt.onclick=async function(){
    pt.textContent='送っています…';
    try{
      var r=await api('/api/push/test',{method:'POST'});
      var j=await r.json();
      setTip(j.sent?('通知を送りました（'+j.sent+'件）'):'届け先がありません。通知を許可してください');
    }catch(e){ setTip('送れませんでした'); }
    pt.textContent='通知を試す';
  };

  var hset=s.querySelector('#h-set');
  if(hset)hset.onclick=function(){ closeSheet(); askingHandle=false; askHandle(); };

  var th=s.querySelector('#seg-theme');
  if(th) Array.prototype.forEach.call(th.querySelectorAll('.chip'),function(b){
    b.onclick=function(){
      Array.prototype.forEach.call(th.querySelectorAll('.chip'),function(x){x.classList.remove('on');});
      b.classList.add('on');
      theme=b.dataset.v;
      try{ localStorage.setItem('mk_theme',theme); }catch(e){}
      applyTint();
    };
  });

  [['seg-vis','default_visibility']].forEach(function(pair){
    var box=s.querySelector('#'+pair[0]); if(!box)return;
    Array.prototype.forEach.call(box.querySelectorAll('.chip'),function(b){
      b.onclick=async function(){
        Array.prototype.forEach.call(box.querySelectorAll('.chip'),function(x){x.classList.remove('on');});
        b.classList.add('on');
        var body={}; body[pair[1]]=b.dataset.v;
        await api('/api/me',{method:'PATCH',
          headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        if(meP&&meP.settings)meP.settings[pair[1]]=b.dataset.v;
        setTip('設定を保存しました');
      };
    });
  });
}

/* ============================================================
   QRコード

   目の前にいる相手なら、IDを打つより早い。
   作るのも読むのも自前でやる（外の部品に頼らない）。
   ============================================================ */

/* --- 作る側 ---
   規格どおりのQRには誤り訂正が要る。自前で書くと読めないものができるので、
   実績のある部品に任せる。届かない場合は、外の画像づくりに頼る。 */
async function qrInto(el2,text,px){
  el2.innerHTML='<div style="font-size:12px;color:var(--dim)">QRを作っています…</div>';
  await need('qrcode');

  function byLib(){
    try{
      if(typeof QRCode==='undefined')return false;
      var cv=document.createElement('canvas');
      // 版によって呼び方が違うので、両方試す
      if(QRCode.toCanvas){
        el2.innerHTML=''; el2.appendChild(cv);
        QRCode.toCanvas(cv,text,{width:px,margin:2,errorCorrectionLevel:'M',
          color:{dark:'#000000',light:'#FFFFFF'}},function(err){
          if(err){ byImage(); return; }
          cv.style.borderRadius='10px'; cv.style.display='block';
        });
        return true;
      }
      if(QRCode.toDataURL){
        QRCode.toDataURL(text,{width:px,margin:2},function(err,url){
          if(err){ byImage(); return; }
          el2.innerHTML='<img src="'+url+'" width="'+px+'" height="'+px+
            '" style="border-radius:10px;display:block">';
        });
        return true;
      }
      return false;
    }catch(e){ return false; }
  }

  // 部品が無いときは、画像として作ってもらう
  function byImage(){
    var u='https://api.qrserver.com/v1/create-qr-code/?size='+px+'x'+px+
      '&margin=8&data='+encodeURIComponent(text);
    var im=new Image();
    im.width=px; im.height=px;
    im.style.cssText='border-radius:10px;display:block;background:#fff';
    im.onload=function(){ el2.innerHTML=''; el2.appendChild(im); };
    im.onerror=function(){
      el2.innerHTML='<div style="font-size:12px;color:var(--dim);line-height:1.8">'+
        'QRを作れませんでした。<br>下のIDを直接入れてもらってください。</div>';
    };
    im.src=u;
  }

  if(!byLib()) byImage();
}

/* --- 見せる --- */
function openMyQR(){
  var hd=(meP&&meP.handle)||'';
  if(!hd){
    setTip('先に自分のIDを決めてください');
    return;
  }
  var url=(SERVER||location.origin)+'/?add='+encodeURIComponent(hd);
  var s=showSheet('<div class="grab"></div><div class="pad" style="padding-top:18px;text-align:center">'+
    '<div style="font-size:18px;font-weight:700;margin-bottom:4px">わたしのQR</div>'+
    '<div style="font-size:13px;color:var(--dim);margin-bottom:18px">'+
      '相手にカメラで読んでもらってください</div>'+
    '<div id="qrbox" style="display:flex;justify-content:center;margin-bottom:16px;'+
      'min-height:240px;align-items:center"></div>'+
    '<div style="font-size:20px;font-weight:700;letter-spacing:.04em">@'+esc(hd)+'</div>'+
    '<div style="font-size:12px;color:var(--dim);margin-top:6px">'+
      '読めないときは、このIDを直接入れてもらってください</div>'+
    '<button class="btn" id="share" style="margin-top:20px">リンクを送る</button>'+
    '<button class="btn g" id="x" style="margin-top:8px">とじる</button></div>');
  qrInto(s.querySelector('#qrbox'),url,240);
  s.querySelector('#x').onclick=closeSheet;
  s.querySelector('#share').onclick=function(){
    if(navigator.share){
      navigator.share({title:'フレンドになりませんか',text:'@'+hd,url:url}).catch(function(){});
    }else if(navigator.clipboard){
      navigator.clipboard.writeText(url);
      setTip('リンクをコピーしました');
    }
  };
}

/* --- 読み取ったあと --- */
async function addByHandle(hd){
  if(!hd)return;
  if(!fbUser){ setTip('先にログインしてください'); return; }
  if(meP&&meP.handle===hd){ setTip('自分のIDです'); return; }
  var r=await api('/api/friends/request',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({handle:hd})});
  var j=await r.json();
  if(j.error){ setTip(j.error); return; }
  setTip(j.status==='accepted'?('@'+hd+' とフレンドになりました'):('@'+hd+' に申請しました'));
  syncDown();
}

/* リンクから開かれたとき */
(function(){
  var m=location.search.match(/[?&]add=([^&]+)/);
  if(!m)return;
  var hd=decodeURIComponent(m[1]);
  var t=setInterval(function(){
    if(!fbUser)return;
    clearInterval(t);
    var s=showSheet('<div class="grab"></div><div class="pad" style="padding-top:18px">'+
      '<div style="font-size:18px;font-weight:700;margin-bottom:8px">フレンドになりますか</div>'+
      '<div style="font-size:20px;font-weight:700;margin-bottom:18px">@'+esc(hd)+'</div>'+
      '<button class="btn" id="ok">申請する</button>'+
      '<button class="btn g" id="x" style="margin-top:8px">やめる</button></div>');
    s.querySelector('#x').onclick=closeSheet;
    s.querySelector('#ok').onclick=function(){ closeSheet(); addByHandle(hd); };
  },1200);
  setTimeout(function(){clearInterval(t);},20000);
})();

/* ============================================================
   フレンド
   ============================================================ */
async function openFriends(){
  var s=showSheet('<div class="grab"></div><div class="pad" style="padding-top:18px">'+
    '<div style="font-size:19px;font-weight:700;margin-bottom:14px">フレンド</div>'+
    '<div id="fbody" style="font-size:13px;color:var(--dim)">読み込んでいます…</div>'+
    '</div>');
  var body=s.querySelector('#fbody');
  var r=await api('/api/friends');
  if(!r.ok){body.textContent='読み込めませんでした';return;}
  var j=await r.json();

  var html='<button class="btn" id="b-qr" style="margin-bottom:10px">わたしのQRを見せる</button>'+
    '<div style="display:flex;gap:8px;margin-bottom:6px">'+
    '<input class="fld" id="f-add" placeholder="相手のID" style="margin:0">'+
    '<button class="btn" id="b-add" style="width:auto;padding:0 18px;margin:0">申請</button></div>'+
    '<div style="font-size:11.5px;color:var(--dim);margin-bottom:18px;line-height:1.7">'+
    'お互いが承認すると、正確な場所つきで思い出が見えるようになります。</div>';

  if((j.incoming||[]).length){
    html+='<div class="lab">届いている申請</div>';
    j.incoming.forEach(function(u){
      html+='<div class="post" style="align-items:center"><div class="av2"></div>'+
        '<div class="b"><b>'+esc(u.display_name||u.handle||'')+'</b>'+
        '<span>@'+esc(u.handle||'')+'</span></div>'+
        '<button class="chip on" data-ok="'+esc(u.id)+'" style="flex:0 0 auto">承認</button></div>';
    });
  }

  html+='<div class="lab" style="margin-top:18px">フレンド '+((j.friends||[]).length)+'人</div>';
  if((j.friends||[]).length){
    j.friends.forEach(function(u){
      html+='<div class="post" style="align-items:center"><div class="av2"></div>'+
        '<div class="b"><b>'+esc(u.display_name||u.handle||'')+'</b>'+
        '<span>@'+esc(u.handle||'')+'</span></div></div>';
    });
  }else{
    html+='<div class="empty" style="padding:16px 0">まだいません。<br>'+
      '相手のIDを入れて申請してみてください。</div>';
  }
  html+='<button class="btn g" id="back" style="margin-top:18px">もどる</button>';
  body.innerHTML=html;

  body.querySelector('#back').onclick=openMe;
  body.querySelector('#b-qr').onclick=openMyQR;
  body.querySelector('#b-add').onclick=async function(){
    var v=body.querySelector('#f-add').value.trim().replace(/^@/,'');
    if(!v){setTip('相手のIDを入れてください');return;}
    var rr=await api('/api/friends/request',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({handle:v})});
    var jj=await rr.json();
    if(jj.error){setTip(jj.error);return;}
    setTip(jj.status==='accepted'?'フレンドになりました':'申請しました');
    openFriends();
  };
  Array.prototype.forEach.call(body.querySelectorAll('[data-ok]'),function(b){
    b.onclick=async function(){
      await api('/api/friends/accept',{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({user_id:b.dataset.ok})});
      setTip('フレンドになりました');
      openFriends(); syncDown();
    };
  });
}
