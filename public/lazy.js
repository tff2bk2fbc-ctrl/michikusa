/* ============================================================
   部品は、使うときになってから読む

   起動のたびに5つも取りに行くと、地図が出るまで待たされる。
   写真を触るまで exifr は要らないし、
   QRはフレンド画面を開くまで要らない。
   ============================================================ */
var _loaded={}, _loading={};
function need(name){
  if(_loaded[name]) return Promise.resolve(true);
  if(_loading[name]) return _loading[name];

  var SRC={
    // 監査済みの固定版をアプリへ同梱し、起動時に外部CDNのコードを実行しない。
    exifr:  [{src:'/vendor/exifr-7.1.3-lite.umd.js',integrity:'sha384-KRanV2NRwHPanp7iM6nlLQC5jPCTscSYMko30dLJHzNXJaUNtcucWv+SOi3jV3PE'}],
    qrcode: [{src:'/vendor/qrcodejs-1.0.0.min.js',integrity:'sha384-3zSEDfvllQohrq0PHL1fOXJuC/jSOO34H46t6UQfobFOmxE5BpjjaIJY5F2/bMnU'}],
    firebase:[{src:'/vendor/firebase-app-compat-10.14.1.js',integrity:'sha384-ZaR6mWzmJtrRibZ1Vm7SoHFr8OXjyAuGAXalGDKqbxFT18oi/z+oZLIRFkpeNor1'},
              {src:'/vendor/firebase-auth-compat-10.14.1.js',integrity:'sha384-I1LYojsZ5RM1cOda44Z2h42Qa6YfsQ1XkXxREnhp4ueYBR/4d1pG1K+NZM537Vsj'}]
  };
  var list=SRC[name]||[];

  _loading[name]=new Promise(function(res){
    if(name==='firebase'){
      // これは2つとも、順に読む必要がある
      one(list[0],function(){ one(list[1],function(){ done(); },function(){res(false);}); },
        function(){res(false);});
      return;
    }
    var i=0;
    (function next(){
      if(i>=list.length) return res(false);
      one(list[i++],done,next);
    })();

    function done(){ _loaded[name]=1; res(true); }
    function one(asset,ok,ng){
      var s=document.createElement('script');
      s.src=asset.src; s.integrity=asset.integrity;
      s.async=true;
      s.onload=ok; s.onerror=ng;
      document.head.appendChild(s);
    }
  });
  return _loading[name];
}

/* 手が空いたころに、こっそり読んでおく。
   実際に使うときには、たいてい用意できている */
function preload(){
  var go=function(){ need('exifr'); need('firebase').then(function(o){ if(o&&window.initAuth)initAuth(); }); };
  if(window.requestIdleCallback) requestIdleCallback(go,{timeout:2500});
  else setTimeout(go,1200);
}
