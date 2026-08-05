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
    // 外部ライブラリは必ず同じ版を読む。版なしURLは配布元の更新だけで
    // 動作や供給物が変わるので使わない。SRI はビルドで検証したハッシュを
    // 持てるセルフホスト化のタイミングで追加する（推測した値は設定しない）。
    exifr:  ['https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/lite.umd.js',
             'https://unpkg.com/exifr@7.1.3/dist/lite.umd.js'],
    qrcode: ['https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js',
             'https://unpkg.com/qrcode@1.5.4/build/qrcode.min.js'],
    firebase:['https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js',
              'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js']
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
    function one(src,ok,ng){
      var s=document.createElement('script');
      s.src=src; s.async=true; s.crossOrigin='anonymous';
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
