const CACHE_NAME = "adam-qbank-admin-v16-1.4.0";

const STATIC_CACHE = [
  "./",
  "./index.html",
  "./about.html",
  "./privacy.html",
  "./specialty-core.js",
  "./specialty-registry.js",
  "./app.js",
  "./taxonomy-store.js",
  "./specialty-admin.js",
  "./ui-icons.js",
  "./ui-icons.css",
  "./search-engine.js",
  "./classification-guide.js",
  "./jszip_min.js",
  "./update-package.js",
  "./firebase-config.js",
  "./cloud-admin.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
];

// Install
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_CACHE))
      .then(() => self.skipWaiting())
  );
});

// Activate
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const reqUrl = new URL(event.request.url);
  if (reqUrl.origin !== self.location.origin) return;

  // The owner's settings files change when the owner edits them (Firebase keys, WhatsApp number): network first,
  // so an old empty copy kept in the cache can never hide new values. Offline, the cached copy is used.
  if (/\/(firebase-config|subscription-config)\.js$/.test(reqUrl.pathname)) {
    event.respondWith(
      fetch(event.request, { cache: "no-cache" })
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(event.request).then((hit) => hit || Response.error()))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }

        return fetch(event.request)
          .then((networkResponse) => {
            if (
              networkResponse &&
              networkResponse.status === 200 &&
              networkResponse.type === "basic"
            ) {
              const responseClone = networkResponse.clone();

              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, responseClone);
              });
            }

            return networkResponse;
          });
      })
      .catch(() => {
        return caches.match("./index.html");
      })
  );
});
