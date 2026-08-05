/* 一度読んだものを端末に残しておく仕組み。
   次に開くときは、待たずにそこから出す。
   同時に裏で新しいものを取りに行き、次回はそれを使う。 */
const CACHE='spota-v2';

self.addEventListener('install', function(){ self.skipWaiting(); });
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
  const isLib  = /cdnjs|jsdelivr|unpkg|gstatic/.test(url.hostname);
  const isTile = /openfreemap|tiles/.test(url.hostname);
  if(!isSelf && !isLib && !isTile) return;

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
