/* 一度読んだものを端末に残しておく仕組み。
   次に開くときは、待たずにそこから出す。
   同時に裏で新しいものを取りに行き、次回はそれを使う。 */
const CACHE='spota-v28';

self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('message', function(e){
  if(e.data && e.data.type==='SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('activate', function(e){
  // 古い版は捨てる
  e.waitUntil(caches.keys().then(function(ks){
    return Promise.all(ks.filter(function(k){return k!==CACHE;})
      .map(function(k){return caches.delete(k);}));
  }).then(function(){ return clients.claim(); }));
});

self.addEventListener('fetch', function(e){
  const req=e.request;
  if(req.method!=='GET') return;

  const url=new URL(req.url);
  if(url.pathname.startsWith('/api/')) return;      // 中身が変わるものは残さない

  const isSelf = url.origin===location.origin;
  // 地図タイルをCache Storageへ残すと閲覧地域の履歴になり得る。
  // アプリ本体だけを保存し、地図・外部サービスの応答はブラウザ既定に任せる。
  if(!isSelf) return;

  // HTMLは常にネットワークを優先する。古いindex.htmlが新しいJSへの更新を
  // 妨げないようにし、オフライン時だけ保存版へ戻る。
  if(req.mode==='navigate'){
    e.respondWith((async function(){
      const cache=await caches.open(CACHE);
      try{
        const res=await fetch(req);
        if(res&&res.status===200)cache.put(req,res.clone());
        return res;
      }catch(err){
        return (await cache.match(req))||Response.error();
      }
    })());
    return;
  }

  e.respondWith((async function(){
    const cache=await caches.open(CACHE);
    const hit=await cache.match(req);

    const net=fetch(req).then(function(res){
      if(res && res.status===200) cache.put(req, res.clone());
      return res;
    }).catch(function(){ return hit; });

    // 残してあるものがあれば、それを先に返す
    return hit || net;
  })());
});
