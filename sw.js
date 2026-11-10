/* ==========================================================================
   AquaRemind Service Worker
   - Caches static assets (cache-first) for offline use
   - Handles notificationclick (focus/open the app)
   ========================================================================== */

const CACHE_NAME = 'aquaremind-v1';
/* The page mirrors its reminder schedule into the Cache API under this URL
   (service workers cannot read localStorage). Periodic Background Sync
   reads it to decide whether a reminder is due. */
const SCHEDULE_URL = '/aqua-schedule';
const STATIC_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon.svg'
];

/* ---------- Install: pre-cache static assets ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

/* ---------- Activate: clean up old caches ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ---------- Fetch: cache-first, fall back to network ---------- */
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          // Cache same-origin successful responses for next time
          if (response && response.status === 200 && event.request.url.startsWith(self.location.origin)) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});

/* ---------- Notification click: focus an existing tab or open a new one ---------- */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('./index.html');
    })
  );
});

/* ---------- Notification close: nothing extra needed ---------- */
self.addEventListener('notificationclose', (event) => {
  // Analytics hook could go here; intentionally minimal.
});

/* ==========================================================================
   Periodic Background Sync — fire due reminders while the app is closed
   (Chromium only, requires the PWA to be installed; the browser decides
   the exact wake-up time, so treat this as best-effort, not exact.)
   ========================================================================== */
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'check-reminders') {
    event.waitUntil(fireDueReminder());
  }
});

async function fireDueReminder() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const resp = await cache.match(SCHEDULE_URL);
    if (!resp) return;
    const schedule = await resp.json();
    const now = Date.now();

    // Only fire when the user has armed reminders AND granted permission
    if (!schedule.enabled || schedule.permission !== 'granted') return;

    // Respect the user's active-hours window
    const d = new Date();
    const h = d.getHours() + d.getMinutes() / 60;
    if (h < schedule.startHour || h >= schedule.endHour) return;

    // Not due yet, or already fired (duplicate prevention)
    if (schedule.nextReminderTime && now < schedule.nextReminderTime) return;
    if (schedule.lastNotifiedAt && now - schedule.lastNotifiedAt < 5000) return;

    await self.registration.showNotification('💧 Time to drink water!', {
      body: schedule.message || 'Time for a sip!',
      icon: 'icon.svg',
      badge: 'icon.svg',
      tag: 'aquaremind',
      vibrate: [200, 100, 200]
    });

    // Reschedule + persist; open tabs adopt this via the Cache API
    schedule.nextReminderTime = now + schedule.interval * 60000;
    schedule.lastNotifiedAt = now;
    schedule.updatedAt = now;
    await cache.put(SCHEDULE_URL, new Response(JSON.stringify(schedule)));
  } catch {
    /* Never let a background check break the service worker */
  }
}
