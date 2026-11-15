const CACHE='rafiq-shell-v07';
const FILES=['./','index.html','ai.js','voice.js','manifest.webmanifest','icon.svg','icon-192.png','icon-512.png','icon-maskable-512.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))));
// الشبكة أولاً للملفات المحلية (لتصل التحديثات)، ثم الكاش عند انقطاع الاتصال. لا نتدخل في /api/ ولا في الطلبات الخارجية (تنزيل النموذج).
self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin||url.pathname.includes('/api/'))return;
  event.respondWith(fetch(req).then(response=>{const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(req,copy));return response;}).catch(()=>caches.match(req).then(c=>c||caches.match('./'))));
});
