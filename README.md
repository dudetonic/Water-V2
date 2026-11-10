💧 AquaRemind — Water Reminder Web App
A complete, production-ready, single-page hydration reminder. Beautiful water-themed UI, system notifications (even when the tab is in the background), live countdown, water intake tracking, streaks, dark/light modes, PWA support with offline caching.
Built with HTML5 + CSS3 + vanilla JavaScript (ES6+) — zero frameworks, zero build step, zero dependencies (one optional Google Font).
---
✨ Features
Reliable reminders — foreground `setInterval` + timestamp-based checks (`Date.now()` vs. persisted `nextReminderTime`) so schedules survive page reloads, tab sleeps and device sleep. Re-validated on `visibilitychange` and page load.
System notifications via the Notification API + a registered Service Worker (`self.registration.showNotification()`), so reminders fire even when the tab is backgrounded/minimized. Graceful fallback to in-app glassmorphism toasts when system notifications are unavailable.
No notification spam — the schedule and `lastNotifiedAt` are persisted; refreshing the page never re-triggers a reminder. Cross-tab dedupe via `BroadcastChannel` + `storage` events.
Flexible interval (10–120 min) — range slider (step 5), synced number input with clamping + friendly inline messages, preset chips (10/15/30/45/60/90/120).
Active hours — e.g. 8:00 AM – 10:00 PM; no notifications outside the window.
Periodic Background Sync — on Chromium with the PWA installed, the service worker wakes on roughly your interval and fires due reminders even when the tab is closed. The page mirrors its schedule to the Cache API (service workers can't read `localStorage`) and adopts the SW's schedule before firing, so nothing double-fires. Firefox/Safari lack this API and gracefully fall back to foreground timing.
Keep-awake toggle — optional Wake Lock keeps the screen on so hidden-tab timer throttling can't delay reminders while the app is open.
Intake tracking — quick-add 250 ml / 500 ml / 750 ml / 1 L + custom amount, daily goal (default 2 L), animated filling water glass with waves & bubbles, gradient progress ring, glasses count, remaining amount, day streak, auto-reset at midnight (per-date `localStorage` keys).
Celebration — droplet confetti + glowing ring + banner when the goal is reached.
Settings drawer — interval, active hours, goal, notification/sound/dark-mode toggles, pause-on-goal-met.
Sound chime — synthesized with the Web Audio API (no audio files).
Themes — deep-ocean dark / clear-sky light, respects `prefers-color-scheme`, persisted.
PWA — `manifest.json` + service worker with cache-first offline strategy; notification click focuses/opens the app.
Data — everything in `localStorage`; export history as JSON; Reset/Clear button.
---
🚀 Run it
No build needed. Because service workers and notifications require a secure context, serve it over HTTPS or localhost:
```bash
# Option A: Python
cd aquaremind
python3 -m http.server 8080
# open http://localhost:8080

# Option B: Node
npx serve .

# Option C: deploy the folder as-is to GitHub Pages / Netlify / Vercel
```
Then:
Open the app → tap the Notifications toggle in Settings → allow the browser prompt.
Tap 🔔 Test notification to verify.
Pick your interval, active hours and daily goal. Done. 💧
---
🌐 Browser support
Browser	Notifications	Service Worker / offline
Chrome / Edge (desktop & Android)	✅	✅
Firefox (desktop & Android)	✅	✅
Safari (macOS & iOS 16.4+)	✅ (requires user gesture / installed PWA on iOS)	✅
Notes:
iOS Safari only shows web push-style notifications for installed PWAs (Add to Home Screen) on iOS 16.4+, and only via the Push API (a server is required).
Periodic Background Sync needs the PWA installed on Chromium (Chrome/Edge, desktop & Android); Firefox and Safari ignore it gracefully and use foreground timing.
In-page toast fallback guarantees you always see a reminder even if the browser blocks system notifications.
Background timers throttle when a tab is hidden (Chrome: ~1 check/minute after 5 minutes). The timestamp re-check on `visibilitychange` catches up immediately when the tab returns, and the Periodic Background Sync path fires reminders while backgrounded on Chromium.
---
🧪 Testing checklist
[ ] First load: notification permission prompt with explanation (Settings → Notifications).
[ ] Interval slider 10–120 (step 5), number input sync, clamping messages, preset chips.
[ ] Change interval while timer runs → countdown restarts + toast confirmation.
[ ] Reload page → settings restored, countdown resumes from persisted `nextReminderTime` (no instant re-fire).
[ ] Log water → glass fills, ring updates, bounce animation, toast, stats update.
[ ] Reach goal → celebration + banner.
[ ] Midnight rollover → intake resets, streak preserved.
[ ] Test Notification button fires immediately (system + toast fallback).
[ ] Permission denied → re-enable instructions shown; toggle reflects state.
[ ] Two tabs open → no duplicate notifications.
[ ] Close the tab (installed Chromium PWA) → next reminder still arrives via Periodic Background Sync.
[ ] Keep-awake toggle holds the screen on; the lock re-acquires after the tab hides and returns.
[ ] Toggle dark/light → persisted across reloads.
[ ] Airplane/offline after first load → app still opens (SW cache).
[ ] Export JSON downloads intake history; Reset clears everything.
---
📁 Files
```
index.html    — markup (header, hero glass + ring, stats, quick-add, drawer, toasts)
styles.css    — water theme, glassmorphism, animations, dark/light modes
app.js        — storage, scheduler, notifications, intake, UI, sound, theming
sw.js         — service worker (cache-first offline + notificationclick focus)
manifest.json — PWA manifest (installable, water droplet icon)
icon.svg      — app icon (SVG droplet on deep navy)
README.md     — this file
```
🔧 How the scheduler stays honest
Every reminder schedules the next one by writing `nextReminderTime = Date.now() + interval` to `localStorage`.
A 1-second `setInterval` compares `Date.now()` against that timestamp — refresh/sleep safe.
On `visibilitychange` → visible and on page load, the same check re-runs immediately (catch-up if a reminder was missed while hidden, deduped by `lastNotifiedAt`).
`BroadcastChannel('aqua-remind')` + `storage` events keep multiple tabs in sync so only one tab fires.
Reminders only fire inside the active-hours window; otherwise they reschedule to the window start.
🌙 Background reliability — the honest tiers
Browsers deliberately stop timers when a tab or browser is fully closed, so no pure web app can fire local notifications with the browser killed. This app stacks three mechanisms, best first:
Tab open (even hidden/minimized) — reminders land within ~1 minute of the due time; the timestamp re-check catches up instantly when the tab regains focus. Enable Keep screen awake to avoid even that minute of delay.
Tab closed on Chromium — install the PWA (address bar → install icon). Periodic Background Sync then wakes the service worker about every interval and fires due notifications. The page adopts the SW schedule via the Cache API so nothing double-fires.
Browser fully closed, or iOS Safari — the only web-standard mechanism is the Push API, which needs a small always-on server: the server pushes to the device at your interval, so no timers run on the phone at all. Want guaranteed closed-app reminders everywhere? I can add a complete Push implementation (VAPID keys + a tiny Vercel/Netlify function using `web-push`) — just ask.
Made with 💧 — stay hydrated!