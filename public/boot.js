/* ============================================================
   いちばん最初に走るもの

   版の番号、エラーの表示、起動の計測。
   ここが失敗すると何も出ないので、余計なものを書かない。
   ============================================================ */
var BUILD='v86';
/* 一度読んだものを端末に残す。次からは待たずに出せる */
if('serviceWorker' in navigator && location.protocol==='https:'){
  navigator.serviceWorker.register('/sw.js').then(function(reg){
    /* 版が変わったら、残してあるものを捨てて入れ替える。
       これをしないと、古いままの画面が出続ける */
    reg.update();
    var last=null;
    try{ last=localStorage.getItem('mk_build'); }catch(e){}
    if(last && last!==BUILD){
      if(window.caches) caches.keys().then(function(ks){
        ks.forEach(function(k){ caches.delete(k); });
      });
      if(reg.waiting) reg.waiting.postMessage({type:'SKIP_WAITING'});
    }
    try{ localStorage.setItem('mk_build',BUILD); }catch(e){}
  }).catch(function(){});
}
var T0=performance.now(), TT=[];
var splashIcon=document.getElementById('sp-icon');
var splashIconReady=!!(splashIcon&&splashIcon.complete&&splashIcon.naturalWidth);
var splashHidePending=false;
if(splashIcon&&!splashIconReady){
  splashIcon.addEventListener('load',function(){
    splashIconReady=true;
    if(splashHidePending)hideSplash();
  },{once:true});
  splashIcon.addEventListener('error',function(){
    splashIconReady=true;
    if(splashHidePending)hideSplash();
  },{once:true});
}
function mark(n){ TT.push([n, Math.round(performance.now()-T0)]); }
mark('開始');
/* 地図が出そろったら起動画面を引く。念のため時間でも消す */
function hideSplash(){
  /* 地図が先に出ても、ブランドマークが描画されるまでは起動画面を残す。 */
  if(!splashIconReady&&performance.now()-T0<1200){ splashHidePending=true; return; }
  if(!window.__sg){ window.__sg=1; mark('地図が見えた'); }
  var s=document.getElementById('splash');
  if(!s||s.classList.contains('gone'))return;
  s.classList.add('gone');
  setTimeout(function(){ s.remove(); },260);
}
setTimeout(function(){ hideSplash(); },6000);
function showErr(m){var e=document.getElementById('err');e.style.display='block';
  e.innerHTML='<b>エラー（そのまま貼ってください） BUILD='+BUILD+'</b>\n'+m;}
function dump(x){if(x===undefined)return'undefined';if(x===null)return'null';
  if(x.stack)return (x.message||'')+'\n--- 発生箇所 ---\n'+x.stack;return String(x);}
/* ファイルを分けたので、どこで失敗したかが分かるようにする */
window.addEventListener('error',function(e){
  var f=(e.filename||'').split('/').pop()||'?';
  showErr('['+f+' '+(e.lineno||'?')+'行] '+(e.message||'')+
    (e.error&&e.error.stack?'\n'+e.error.stack:''));
});
window.addEventListener('unhandledrejection',function(e){showErr('[promise] '+dump(e.reason));});
