'use strict';

/* ==========================================================================
   AquaRemind — app.js
   Sections:
     1. Storage layer          6. Intake tracking
     2. State & defaults       7. UI feedback (toasts, ripples, sounds)
     3. Theme                  8. Settings drawer
     4. Notifications          9. Background sync (BroadcastChannel/SW)
     5. Timer & scheduler     10. Init & event wiring
   ========================================================================== */

/* ============================================================
   1. STORAGE LAYER — thin, safe localStorage wrapper
   ============================================================ */

const Store = {
  /** Read & JSON-parse a key; return fallback on miss/corrupt data. */
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  /** JSON-serialize and write a key (silently ignore quota errors). */
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full/blocked */ }
  },
  remove(key) { localStorage.removeItem(key); }
};

const KEYS = {
  SETTINGS: 'wr_settings',
  NEXT_REMINDER: 'wr_nextReminder',      // epoch ms timestamp
  LAST_NOTIFIED: 'wr_lastNotifiedAt',    // epoch ms — duplicate prevention
  day: (d) => `wr_day_${d}`               // per-day intake record
};

/** Default user settings; merged over stored values on load. */
const DEFAULT_SETTINGS = {
  interval: 30,          // minutes, 10–120
  startHour: 8,          // active window start (24h)
  endHour: 22,           // active window end (24h)
  goal: 2000,            // ml per day
  sound: true,           // Web Audio chime on reminder
  notificationsEnabled: false,
  pauseOnGoalMet: true,  // stop reminding once goal is reached
  wakeLock: false,       // keep screen awake (avoids hidden-tab timer throttling)
  theme: null            // null = follow prefers-color-scheme
};

/** Interval bounds (per spec) — single source of truth. */
const INTERVAL_MIN = 10;
const INTERVAL_MAX = 120;

/* ============================================================
   2. STATE & DEFAULTS
   ============================================================ */

let settings = { ...DEFAULT_SETTINGS, ...Store.get(KEYS.SETTINGS, {}) };
/** Clamp persisted interval defensively (edge case: hand-edited storage). */
settings.interval = clamp(settings.interval, INTERVAL_MIN, INTERVAL_MAX);
settings.goal = Math.max(250, Math.round(settings.goal) || DEFAULT_SETTINGS.goal);

let currentDayKey = localDateKey();
/** Today's intake record: { intake, glasses, goalMet } */
let today = loadDay(currentDayKey);

let nextReminderTime = Store.get(KEYS.NEXT_REMINDER, null);
let lastFireAt = 0; // in-memory cross-tab fire dedupe

/** Clamp helper: coerce to int and bound it. */
function clamp(value, min, max) {
  const n = Math.round(Number(value));
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Local (timezone-safe) YYYY-MM-DD key — robust against time-zone shifts. */
function localDateKey(d = new Date()) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Load a day's record, tolerating missing/corrupt entries. */
function loadDay(key) {
  const rec = Store.get(KEYS.day(key), {});
  const intake = Math.max(0, Math.round(Number(rec.intake)) || 0);
  return { intake, glasses: Math.round(intake / 250), goalMet: !!rec.goalMet };
}

function saveDay() { Store.set(KEYS.day(currentDayKey), today); }
function saveSettings() { Store.set(KEYS.SETTINGS, settings); }

/** Reset intake tracking if the calendar day changed (midnight rollover). */
function rolloverCheck() {
  const key = localDateKey();
  if (key !== currentDayKey) {
    currentDayKey = key;
    today = loadDay(key);
    updateIntakeUI();
    toast('🌅 New day — intake reset. Fresh start!', 'success');
  }
}

/** Streak = consecutive days (ending today or yesterday) where goal was met. */
function computeStreak() {
  let streak = 0;
  const d = new Date();
  if (!loadDay(localDateKey(d)).goalMet) d.setDate(d.getDate() - 1);
  for (let i = 0; i < 3660; i++) {
    if (loadDay(localDateKey(d)).goalMet) { streak++; d.setDate(d.getDate() - 1); }
    else break;
  }
  return streak;
}

/* ============================================================
   3. THEME — dark ocean / light sky, persisted
   ============================================================ */

const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');

function activeTheme() {
  return settings.theme || (darkMedia.matches ? 'dark' : 'light');
}

function applyTheme() {
  const t = activeTheme();
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')
    .setAttribute('content', t === 'dark' ? '#0a192f' : '#cdeeff');
  $('themeToggle').checked = t === 'dark';
  $('themeQuickBtn').querySelector('.theme-icon').textContent = t === 'dark' ? '🌙' : '☀️';
}

function toggleTheme() {
  settings.theme = activeTheme() === 'dark' ? 'light' : 'dark';
  saveSettings();
  applyTheme();
  broadcastState();
}

/* ============================================================
   4. NOTIFICATIONS — permission, system notify, fallback toast
   ============================================================ */

const MESSAGES = [
  'Your body is 60% water — top it up! 💙',
  'A quick sip now beats a headache later.',
  'Hydration check! Your skin will thank you.',
  'Water: the original energy drink. ⚡',
  'Future you says thanks for drinking now.',
  'Keep that glass half full — literally!',
  'Your kidneys are cheering for you. 📣',
  'Sip happens. Make it happen now! 😄'
];

function pickMessage() {
  return MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
}

/**
 * Show a system notification via the Service Worker registration when
 * available (works while backgrounded), else via the Notification ctor.
 * Returns true if a system notification was shown, false if the caller
 * should fall back to an in-page toast.
 */
async function showSystemNotification(title, options = {}) {
  if (!('Notification' in window)) return false;
  if (Notification.permission !== 'granted') return false;
  const payload = { icon: 'icon.svg', badge: 'icon.svg', tag: 'aquaremind', ...options };
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, payload);
      return true;
    }
  } catch { /* fall through to ctor */ }
  try {
    new Notification(title, payload);
    return true;
  } catch {
    return false; // blocked → caller shows a toast
  }
}

/**
 * Turn the Notifications switch ON with proper permission flow.
 * Explains first (toast), then requests. Handles granted/denied/default.
 */
async function enableNotifications() {
  if (!('Notification' in window)) {
    toast('This browser does not support notifications 😕', 'error');
    return false;
  }
  if (Notification.permission === 'granted') {
    settings.notificationsEnabled = true;
    saveSettings(); broadcastState();
    registerPeriodicSync();
    syncScheduleToCache();
    toast('Notifications enabled! 💧', 'success');
    return true;
  }
  if (Notification.permission === 'denied') {
    showPermNote(true);
    toast('Notifications are blocked — see Settings for how to re-enable', 'error');
    return false;
  }
  toast('Your browser will now ask for permission — please choose "Allow" 🙏');
  let perm;
  try { perm = await Notification.requestPermission(); }
  catch { perm = 'default'; }
  if (perm === 'granted') {
    settings.notificationsEnabled = true;
    saveSettings(); broadcastState();
    toast('Notifications enabled! 💧', 'success');
    registerPeriodicSync();
    scheduleNextReminder(settings.interval * 60000);
    return true;
  }
  if (perm === 'denied') showPermNote(true);
  toast(perm === 'denied'
    ? 'Permission blocked — enable it in browser site settings'
    : 'No problem — you will still get in-app reminders.', 'error');
  return false;
}

/** Show/hide the "how to re-enable" instructions block in the drawer. */
function showPermNote(show) {
  $('permNote').hidden = !show;
}

/** Keep the toggle in sync with reality (handles mid-session revocation). */
function syncNotifUI() {
  const supported = 'Notification' in window;
  $('notifToggle').checked = supported &&
    Notification.permission === 'granted' && settings.notificationsEnabled;
  showPermNote(supported && Notification.permission === 'denied');
}

/* ============================================================
   5. TIMER & SCHEDULER — survives reloads, sleep, tab throttling
   ============================================================ */

/** Persist the next reminder timestamp and refresh the countdown UI. */
function scheduleNextReminder(delayMs) {
  nextReminderTime = Date.now() + delayMs;
  Store.set(KEYS.NEXT_REMINDER, nextReminderTime);
  syncScheduleToCache(); // keep the service worker's copy in sync
  updateCountdown();
}

/** Is `date` inside the user's active-hours window? */
function isActiveNow(date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60;
  return h >= settings.startHour && h < settings.endHour;
}

/** Milliseconds from now until the next active-window start. */
function msUntilWindowStart() {
  const d = new Date();
  const target = new Date(d);
  target.setHours(settings.startHour, 0, 0, 0);
  if (target <= d) target.setDate(target.getDate() + 1);
  return target - d;
}

/**
 * Fire a reminder: persist lastNotifiedAt (spam/duplicate prevention),
 * play the chime, show a system notification (or toast fallback),
 * then schedule the next reminder automatically.
 */
async function fireReminder({ force = false, silent = false } = {}) {
  const now = Date.now();

  // Duplicate prevention: another tab (or a refresh burst) fired recently.
  if (!force && (now - lastFireAt < 5000 || now - Store.get(KEYS.LAST_NOTIFIED, 0) < 5000)) {
    scheduleNextReminder(settings.interval * 60000);
    return;
  }
  lastFireAt = now;
  Store.set(KEYS.LAST_NOTIFIED, now);

  if (!silent) {
    playChime();
    const body = pickMessage();
    const shown = await showSystemNotification('💧 Time to drink water!', { body });
    if (!shown) toast(`💧 Time to drink water! ${body}`, 'success');
  }
  broadcast({ type: 'fired', at: now });

  // Pause-on-goal: keep the schedule alive but don't pester a hero.
  scheduleNextReminder(settings.interval * 60000);
}

/** Should reminders currently fire? (enabled + permission + within window) */
function remindersArmed() {
  return settings.notificationsEnabled &&
    'Notification' in window &&
    Notification.permission === 'granted';
}

/**
 * Once-per-second heartbeat: rollover check, due check, countdown UI.
 * The Date.now() vs persisted timestamp comparison means reloads,
 * device sleep and throttled background tabs can never skip or double-fire.
 */
let dueCheckRunning = false;

function tick() {
  rolloverCheck();

  // Mid-session permission revocation → disarm gracefully.
  if (settings.notificationsEnabled &&
    'Notification' in window && Notification.permission === 'denied') {
    settings.notificationsEnabled = false;
    saveSettings();
    syncNotifUI();
    toast('Notification permission was revoked — reminders paused', 'error');
  }

  if (nextReminderTime === null) {
    scheduleNextReminder(settings.interval * 60000);
  }

  updateCountdown();
  checkDueAndFire(); // async: adopts SW-fired reminders first, never double-fires
}

/**
 * Decide whether a reminder is due. Runs async so the schedule written by
 * the service worker (Periodic Background Sync) is adopted BEFORE the due
 * check — this is what prevents a duplicate reminder when the tab wakes up.
 */
async function checkDueAndFire() {
  if (dueCheckRunning) return; // don't overlap checks
  dueCheckRunning = true;
  try {
    await syncScheduleFromCache();
    const now = Date.now();
    if (now < nextReminderTime) return;

    if (!remindersArmed()) {
      scheduleNextReminder(settings.interval * 60000); // stay paused but keep clock fresh
    } else if (settings.pauseOnGoalMet && today.goalMet) {
      scheduleNextReminder(settings.interval * 60000); // hero already hydrated
    } else if (isActiveNow()) {
      fireReminder();
    } else {
      scheduleNextReminder(msUntilWindowStart()); // wait for the window to open
    }
  } finally {
    dueCheckRunning = false;
  }
}

/** Render the live countdown (h:mm:ss or m:ss), pulsing every second. */
function updateCountdown() {
  const el = $('countdown');
  const sub = $('countdownSub');
  if (!remindersArmed()) {
    el.textContent = '⏸';
    el.classList.remove('pulse');
    sub.textContent = 'reminders are off — enable in Settings';
    return;
  }
  const remaining = Math.max(0, (nextReminderTime || Date.now()) - Date.now());
  const total = Math.floor(remaining / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  el.textContent = h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  el.classList.remove('pulse');
  void el.offsetWidth; // restart the pulse animation each second
  el.classList.add('pulse');
  if (settings.pauseOnGoalMet && today.goalMet) {
    sub.textContent = 'goal reached — reminders paused 🏆';
  } else if (!isActiveNow()) {
    sub.textContent = 'next reminder at the start of your active hours';
  } else {
    sub.textContent = `until next reminder · every ${settings.interval} min`;
  }
}

/* ============================================================
   6. WATER INTAKE TRACKING
   ============================================================ */

/** Log water intake, update UI, celebrate on goal, sync other tabs. */
function logWater(ml) {
  ml = Math.round(Number(ml));
  if (!Number.isFinite(ml) || ml <= 0 || ml > 5000) {
    toast('Enter an amount between 1 and 5000 ml', 'error');
    return;
  }
  rolloverCheck();
  today.intake += ml;
  today.glasses = Math.round(today.intake / 250);
  const justMet = today.intake >= settings.goal && !today.goalMet;
  today.goalMet = today.intake >= settings.goal;
  saveDay();
  updateIntakeUI();
  bounceGlass();
  if (justMet) celebrate();
  else toast(`Logged ${formatMl(ml)}! 💧`, 'success');
  broadcastState();
}

/** Refresh glass fill, progress ring, stats and streak. */
function updateIntakeUI() {
  const pct = Math.min(100, Math.round((today.intake / settings.goal) * 100));

  // Water glass fill + wave speed hint via hue shift
  $('waterFill').style.height = `${pct}%`;

  // Progress ring (circumference 2πr = 326.7 for r = 52)
  const C = 326.7;
  $('ringFg').style.strokeDashoffset = C - (C * pct) / 100;
  // Gradient shifts blue → mint as goal approaches
  $('ringStop').setAttribute('offset', `${Math.min(85, 10 + pct * 0.75)}%`);
  $('pctLabel').textContent = `${pct}%`;

  // Stats
  $('intakeAmount').textContent = formatMl(today.intake);
  $('remainingAmount').textContent = formatMl(Math.max(0, settings.goal - today.intake));
  $('glassesCount').textContent = today.glasses;
  $('streakCount').textContent = `${computeStreak()} 🔥`;

  // Celebration state persists while goal is met
  $('mainCard').classList.toggle('celebrating', today.goalMet);
}

/** Format ml → "1.25 L" when ≥ 1000, else "750 ml". */
function formatMl(ml) {
  return ml >= 1000 ? `${(ml / 1000).toFixed(2).replace(/\.?0+$/, '')} L` : `${ml} ml`;
}

/** Little bounce on the glass when water is logged. */
function bounceGlass() {
  const cup = $('glassCup');
  cup.classList.remove('bounce');
  void cup.offsetWidth;
  cup.classList.add('bounce');
}

/** Goal-reached celebration: droplet confetti + banner + toast. */
function celebrate() {
  const layer = $('confetti');
  layer.innerHTML = '';
  for (let i = 0; i < 34; i++) {
    const drop = document.createElement('span');
    drop.style.left = `${Math.random() * 100}%`;
    drop.style.animationDelay = `${Math.random() * 0.6}s`;
    drop.style.animationDuration = `${1.6 + Math.random() * 1.2}s`;
    drop.style.transform = `scale(${0.6 + Math.random() * 0.9})`;
    layer.appendChild(drop);
  }
  setTimeout(() => { layer.innerHTML = ''; }, 3600);
  toast('🏆 Goal reached! You are a hydration hero!', 'success');
}

/* ============================================================
   7. UI FEEDBACK — toasts, ripples, Web Audio chime
   ============================================================ */

/** Slide-in glassmorphism toast; auto-dismisses after 3.5s. */
function toast(message, type = '') {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`.trim();
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, 3500);
}

/** Expanding-circle ripple on any button press. */
function attachRipples() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-primary, .btn-secondary, .chip-btn, .icon-btn');
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const span = document.createElement('span');
    span.className = 'ripple';
    span.style.width = span.style.height = `${size}px`;
    span.style.left = `${e.clientX - rect.left - size / 2}px`;
    span.style.top = `${e.clientY - rect.top - size / 2}px`;
    btn.appendChild(span);
    setTimeout(() => span.remove(), 650);
  });
}

/* Web Audio water-drop chime — no external files needed. */
let audioCtx = null;
function playChime() {
  if (!settings.sound) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = audioCtx || new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime;

    // Drop: quick pitch glide down (like a droplet hitting water)
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1250, t0);
    osc.frequency.exponentialRampToValueAtTime(520, t0 + 0.16);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.28, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0); osc.stop(t0 + 0.4);

    // Sparkle: short high ping after the drop
    const osc2 = audioCtx.createOscillator();
    const gain2 = audioCtx.createGain();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(1760, t0 + 0.14);
    gain2.gain.setValueAtTime(0.0001, t0 + 0.14);
    gain2.gain.exponentialRampToValueAtTime(0.12, t0 + 0.17);
    gain2.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);
    osc2.connect(gain2).connect(audioCtx.destination);
    osc2.start(t0 + 0.14); osc2.stop(t0 + 0.5);
  } catch { /* audio unavailable — stay silent */ }
}

/* ============================================================
   8. SETTINGS DRAWER
   ============================================================ */

function openDrawer() {
  const d = $('drawer'), o = $('overlay');
  d.hidden = false; o.hidden = false;
  requestAnimationFrame(() => { d.classList.add('show'); o.classList.add('show'); });
  $('closeDrawerBtn').focus();
}
function closeDrawer() {
  const d = $('drawer'), o = $('overlay');
  d.classList.remove('show'); o.classList.remove('show');
  setTimeout(() => { d.hidden = true; o.hidden = true; }, 350);
}

/* ---------- Interval controls (slider + number + presets) ---------- */

function syncIntervalUI() {
  $('intervalSlider').value = settings.interval;
  $('intervalInput').value = settings.interval;
  $('intervalLabel').textContent = `Every ${settings.interval} minute${settings.interval === 1 ? '' : 's'}`;
  document.querySelectorAll('.preset').forEach((p) =>
    p.classList.toggle('active', Number(p.dataset.min) === settings.interval));
}

/** Set an inline hint message under the interval input (empty string clears). */
function intervalHint(msg) { $('intervalHint').textContent = msg; }

/**
 * Commit a new interval: clamp to 10–120, persist, restart the countdown
 * from the new interval and confirm with a toast.
 */
function applyInterval(raw, { announce = true } = {}) {
  const n = Number(raw);
  let msg = '';
  if (raw === '' || Number.isNaN(n)) {
    intervalHint('Please enter a number between 10 and 120.');
    syncIntervalUI();
    return;
  }
  let v = Math.round(n);
  if (v < INTERVAL_MIN) { msg = 'Minimum reminder interval is 10 minutes'; v = INTERVAL_MIN; }
  else if (v > INTERVAL_MAX) { msg = 'Maximum reminder interval is 120 minutes'; v = INTERVAL_MAX; }
  intervalHint(msg);

  const changed = v !== settings.interval;
  settings.interval = v;
  saveSettings();
  syncIntervalUI();
  if (changed) {
    scheduleNextReminder(v * 60000); // restart countdown with new interval
    registerPeriodicSync();        // update the background-sync interval too
    broadcastState();
    if (announce) toast(`Reminders set to every ${v} minutes 💧`, 'success');
  }
}

/* ---------- Active hours ---------- */

function fmtHour(h) {
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:00 ${ampm}`;
}

function buildHourSelects() {
  for (const sel of [$('startHourSel'), $('endHourSel')]) {
    sel.innerHTML = '';
    for (let h = 0; h < 24; h++) {
      const opt = document.createElement('option');
      opt.value = h;
      opt.textContent = fmtHour(h);
      sel.appendChild(opt);
    }
  }
  $('startHourSel').value = settings.startHour;
  $('endHourSel').value = settings.endHour;
}

/** Keep start < end: adjusting one nudges the other if they collide. */
function applyHours(changed) {
  let s = Number($('startHourSel').value);
  let e = Number($('endHourSel').value);
  if (s >= e) {
    if (changed === 'start') { e = Math.min(23, s + 1); $('endHourSel').value = e; }
    else { s = Math.max(0, e - 1); $('startHourSel').value = s; }
    toast('Active hours adjusted — start must be before end');
  }
  settings.startHour = s;
  settings.endHour = e;
  saveSettings();
  if (!isActiveNow()) scheduleNextReminder(msUntilWindowStart());
  updateCountdown();
  broadcastState();
}

/* ---------- Goal ---------- */

function applyGoal() {
  const n = Number($('goalInput').value);
  if ($('goalInput').value === '' || Number.isNaN(n)) {
    $('goalInput').value = settings.goal;
    toast('Please enter a valid goal in ml', 'error');
    return;
  }
  const v = clamp(n, 500, 10000);
  if (v !== n) toast('Goal adjusted to the 500–10 000 ml range');
  settings.goal = v;
  $('goalInput').value = v;
  today.goalMet = today.intake >= v;
  saveSettings(); saveDay();
  updateIntakeUI();
  broadcastState();
}

/* ---------- Data: export & reset ---------- */

function exportData() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k.startsWith('wr_')) data[k] = Store.get(k);
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `aquaremind-history-${localDateKey()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('History exported ⬇️', 'success');
}

function resetAll() {
  if (!confirm('Delete all AquaRemind data (settings, logs, streaks)?')) return;
  Object.keys(localStorage)
    .filter((k) => k.startsWith('wr_'))
    .forEach((k) => localStorage.removeItem(k));
  toast('All data cleared. Starting fresh! 🌊');
  setTimeout(() => location.reload(), 700);
}

/* ============================================================
   9. CROSS-TAB SYNC & SERVICE WORKER
   ============================================================ */

const bc = 'BroadcastChannel' in window
  ? new BroadcastChannel('aqua-remind')
  : null;

function broadcast(msg) { if (bc) bc.postMessage(msg); }
/** Tell other tabs to re-read localStorage and refresh their UI. */
function broadcastState() { broadcast({ type: 'state' }); }

if (bc) {
  bc.onmessage = (e) => {
    const { type, at } = e.data || {};
    if (type === 'fired') {
      lastFireAt = at;                       // suppress duplicate fire in this tab
      Store.set(KEYS.LAST_NOTIFIED, at);
      scheduleNextReminder(settings.interval * 60000);
    } else if (type === 'state') {
      settings = { ...DEFAULT_SETTINGS, ...Store.get(KEYS.SETTINGS, {}) };
      today = loadDay(currentDayKey);
      nextReminderTime = Store.get(KEYS.NEXT_REMINDER, nextReminderTime);
      syncIntervalUI(); applyTheme(); syncNotifUI(); updateIntakeUI(); updateCountdown();
    }
  };
}

/* storage event = fallback sync for browsers without BroadcastChannel */
window.addEventListener('storage', (e) => {
  if (!e.key || !e.key.startsWith('wr_')) return;
  if (e.key === KEYS.NEXT_REMINDER) nextReminderTime = Store.get(KEYS.NEXT_REMINDER, nextReminderTime);
  if (e.key === KEYS.SETTINGS) settings = { ...DEFAULT_SETTINGS, ...Store.get(KEYS.SETTINGS, {}) };
  syncIntervalUI(); syncNotifUI(); updateIntakeUI(); updateCountdown();
});

/** Register the Service Worker (cache-first offline + background notifications). */
function registerSW() {
  const isSecure = location.protocol === 'https:' ||
    ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && isSecure) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline dev etc. */ });
  }
}

/* ============================================================
   BACKGROUND RELIABILITY
   Service workers can't read localStorage or run timers, so the
   page mirrors its schedule into the Cache API; Periodic Background
   Sync (Chromium, installed PWA) wakes the SW to fire due reminders.
   ============================================================ */

const SW_CACHE = 'aquaremind-v1';
const SCHEDULE_URL = '/aqua-schedule';
let lastScheduleSeenAt = 0;

/**
 * Write the current schedule into the Cache API so the service worker
 * can read it during Periodic Background Sync checks.
 */
async function syncScheduleToCache() {
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open(SW_CACHE);
    await cache.put(SCHEDULE_URL, new Response(JSON.stringify({
      enabled: remindersArmed(),
      permission: 'Notification' in window ? Notification.permission : 'unsupported',
      interval: settings.interval,
      startHour: settings.startHour,
      endHour: settings.endHour,
      nextReminderTime: nextReminderTime || Date.now() + settings.interval * 60000,
      lastNotifiedAt: Store.get(KEYS.LAST_NOTIFIED, 0),
      message: pickMessage(),
      updatedAt: Date.now()
    })));
  } catch { /* cache unavailable — non-fatal */ }
}

/**
 * Adopt the schedule written by the service worker. If the SW fired a
 * reminder while this tab was hidden/closed, we take over its timestamps
 * — that is the duplicate-prevention link between the two contexts.
 */
async function syncScheduleFromCache() {
  if (!('caches' in window)) return;
  try {
    const resp = await caches.match(SCHEDULE_URL);
    if (!resp) return;
    const s = await resp.json();
    if (!s.updatedAt || s.updatedAt <= lastScheduleSeenAt) return;
    lastScheduleSeenAt = s.updatedAt;
    if ((s.lastNotifiedAt || 0) > Store.get(KEYS.LAST_NOTIFIED, 0)) {
      Store.set(KEYS.LAST_NOTIFIED, s.lastNotifiedAt);
      lastFireAt = s.lastNotifiedAt;
    }
    if (s.nextReminderTime && s.nextReminderTime !== nextReminderTime) {
      nextReminderTime = s.nextReminderTime;
      Store.set(KEYS.NEXT_REMINDER, s.nextReminderTime);
    }
  } catch { /* ignore — foreground schedule still authoritative */ }
}

/**
 * Ask Chromium to wake the service worker every `interval` to check for
 * due reminders. Requires the PWA to be installed + permission granted;
 * Firefox/Safari lack this API and silently keep the foreground fallback.
 */
async function registerPeriodicSync() {
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!('periodicSync' in reg)) return;
    const status = await navigator.permissions.query({ name: 'periodic-background-sync' }).catch(() => null);
    if (status && status.state !== 'granted') return;
    await reg.periodicSync.register('check-reminders', {
      minInterval: settings.interval * 60000
    });
  } catch { /* not installed / not granted — foreground timing still works */ }
}

async function unregisterPeriodicSync() {
  try {
    const reg = await navigator.serviceWorker.ready;
    if ('periodicSync' in reg) await reg.periodicSync.unregister('check-reminders');
  } catch { /* ignore */ }
}

/* ---------- Wake Lock (optional keep-alive) ----------
   Keeps the screen awake so hidden-tab timer throttling can't delay
   reminders. Only helps while the screen is on and the tab is open. */

let wakeLock = null;

async function setWakeLock(on) {
  if (!('wakeLock' in navigator)) {
    toast('Keep-awake is not supported in this browser', 'error');
    return false;
  }
  try {
    if (on) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
        if (settings.wakeLock) {
          settings.wakeLock = false;
          $('wakeLockToggle').checked = false;
          saveSettings();
        }
      });
      return true;
    }
    if (wakeLock) { await wakeLock.release(); wakeLock = null; }
    return true;
  } catch {
    toast('Could not keep the screen awake', 'error');
    return false;
  }
}

/* ============================================================
   10. INIT & EVENT WIRING
   ============================================================ */

const $ = (id) => document.getElementById(id);

function initAmbientDroplets() {
  const layer = $('droplets');
  for (let i = 0; i < 16; i++) {
    const d = document.createElement('span');
    d.className = 'droplet';
    d.style.left = `${Math.random() * 100}%`;
    d.style.animationDuration = `${7 + Math.random() * 9}s`;
    d.style.animationDelay = `${-Math.random() * 14}s`;
    d.style.transform = `scale(${0.5 + Math.random() * 0.9})`;
    layer.appendChild(d);
  }
}

function setDate() {
  $('dateLabel').textContent = new Date().toLocaleDateString(undefined,
    { weekday: 'short', month: 'short', day: 'numeric' });
}

function wireEvents() {
  /* Water logging */
  $('drankBtn').addEventListener('click', () => logWater(250));
  document.querySelectorAll('.quick-add-btn').forEach((b) =>
    b.addEventListener('click', () => logWater(Number(b.dataset.ml))));
  $('customAddBtn').addEventListener('click', () => {
    logWater($('customAmount').value);
    $('customAmount').value = '';
  });
  $('customAmount').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { logWater(e.target.value); e.target.value = ''; }
  });

  /* Drawer */
  $('settingsBtn').addEventListener('click', openDrawer);
  $('settingsBtn2').addEventListener('click', openDrawer);
  $('closeDrawerBtn').addEventListener('click', closeDrawer);
  $('overlay').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('drawer').hidden) closeDrawer();
  });

  /* Toggles */
  $('notifToggle').addEventListener('change', async (e) => {
    if (e.target.checked) {
      const ok = await enableNotifications();
      if (!ok) e.target.checked = false;
    } else {
      settings.notificationsEnabled = false;
      saveSettings(); broadcastState();
      unregisterPeriodicSync();
      syncScheduleToCache();
      toast('Reminders paused ⏸');
      updateCountdown();
    }
  });
  $('soundToggle').addEventListener('change', (e) => {
    settings.sound = e.target.checked;
    saveSettings(); broadcastState();
    if (e.target.checked) playChime();
    toast(e.target.checked ? 'Sound on 🔊' : 'Sound off 🔇');
  });
  $('themeToggle').addEventListener('change', toggleTheme);
  $('themeQuickBtn').addEventListener('click', toggleTheme);
  $('pauseGoalToggle').addEventListener('change', (e) => {
    settings.pauseOnGoalMet = e.target.checked;
    saveSettings(); broadcastState(); updateCountdown();
    toast(e.target.checked ? 'Reminders pause when goal is met 🏆' : 'Reminders always on 💧');
  });
  $('wakeLockToggle').addEventListener('change', async (e) => {
    const ok = await setWakeLock(e.target.checked);
    if (!ok) { e.target.checked = false; return; }
    settings.wakeLock = e.target.checked;
    saveSettings();
    toast(e.target.checked
      ? 'Screen stays awake while the app is open ☀️'
      : 'Keep-awake off');
  });

  /* Interval: slider (live label on input, commit on change) */
  $('intervalSlider').addEventListener('input', (e) => {
    $('intervalLabel').textContent = `Every ${e.target.value} minutes`;
    $('intervalInput').value = e.target.value;
  });
  $('intervalSlider').addEventListener('change', (e) => applyInterval(e.target.value));
  /* Number input: validate + clamp on change */
  $('intervalInput').addEventListener('change', (e) => applyInterval(e.target.value));
  $('intervalInput').addEventListener('input', () => intervalHint(''));
  /* Presets */
  document.querySelectorAll('.preset').forEach((p) =>
    p.addEventListener('click', () => applyInterval(Number(p.dataset.min))));

  /* Active hours */
  $('startHourSel').addEventListener('change', () => applyHours('start'));
  $('endHourSel').addEventListener('change', () => applyHours('end'));

  /* Goal */
  $('goalInput').addEventListener('change', applyGoal);

  /* Test notification — fires immediately regardless of schedule */
  $('testBtn').addEventListener('click', async () => {
    if (!remindersArmed()) {
      const ok = await enableNotifications();
      if (!ok) return;
    }
    playChime();
    const body = pickMessage();
    const shown = await showSystemNotification('💧 Test notification', { body });
    toast(shown ? 'Test notification sent! Check your system notifications 🔔'
      : `💧 Test: ${body} (system notifications unavailable — toast shown)`, 'success');
  });

  /* Data */
  $('exportBtn').addEventListener('click', exportData);
  $('resetBtn').addEventListener('click', resetAll);

  /* Re-validate schedule the moment the tab becomes visible again */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    tick();
    syncScheduleFromCache();                    // adopt any reminder the SW fired while hidden
    if (settings.wakeLock) setWakeLock(true);   // wake locks auto-release when hidden
  });
  /* Follow OS theme changes when user hasn't picked a theme manually */
  darkMedia.addEventListener('change', () => { if (!settings.theme) applyTheme(); });
}

function init() {
  setDate();
  initAmbientDroplets();
  buildHourSelects();
  syncIntervalUI();
  applyTheme();
  syncNotifUI();

  /* Restore persisted control states */
  $('soundToggle').checked = settings.sound;
  $('pauseGoalToggle').checked = settings.pauseOnGoalMet;
  $('goalInput').value = settings.goal;

  /* Restore schedule without re-triggering:
     if no schedule exists yet (or it is hopelessly stale), start fresh from now. */
  if (nextReminderTime === null || nextReminderTime < Date.now() - 86400000) {
    scheduleNextReminder(settings.interval * 60000);
  }

  $('wakeLockToggle').checked = settings.wakeLock;
  if (settings.wakeLock) setWakeLock(true);

  updateIntakeUI();
  updateCountdown();
  attachRipples();
  wireEvents();
  registerSW();
  syncScheduleFromCache();
  setInterval(syncScheduleFromCache, 30000); // adopt SW-fired reminders

  /* Heartbeat — foreground timing plus timestamp re-checks. */
  setInterval(tick, 1000);
}

document.addEventListener('DOMContentLoaded', init);
