var CACHE = "workout-tracker-v4";
var FILES = [
  "./",
  "./index.html",
  "./css/app.css",
  "./js/store.js",
  "./js/push-config.js",
  "./js/app.js",
  "./manifest.webmanifest",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/favicon-32.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(FILES);
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) { return key !== CACHE; }).map(function (key) {
          return caches.delete(key);
        })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("push", function (event) {
  var data = { title: "Тренировки", body: "Таймер завершён" };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (err) {}
  event.waitUntil(self.registration.showNotification(data.title || "Тренировки", {
    body: data.body || "Таймер завершён",
    tag: "workout-rest",
    renotify: true,
    icon: "./icons/icon-192.png",
    data: { url: "./" }
  }));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clients) {
      if (clients.length) return clients[0].focus();
      if (self.clients.openWindow) return self.clients.openWindow("./");
    })
  );
});

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;
  event.respondWith(
    fetch(request).then(function (response) {
      var copy = response.clone();
      caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
      return response;
    }).catch(function () {
      return caches.match(request).then(function (cached) {
        return cached || caches.match("./index.html");
      });
    })
  );
});
