/* ============================================================
   VenueFlow v2 — Application Logic
   - Dark / Light theme persistence
   - Pretext.js canvas text layout (CDN via dynamic import)
   - XSS-safe DOM helpers (no raw innerHTML with user data)
   - SOS rate-limiting
   - Keyboard shortcuts
   - Zone drill-down modal
   - CSV export
   - Search / filter
   - All simulation logic
   ============================================================ */

'use strict';

// ─────────────────────────────────────────────
// SECURITY HELPERS
// Safely build DOM nodes instead of raw innerHTML
// where user-controlled data could appear.
// ─────────────────────────────────────────────
const DOM = {
  /** Create element with optional props */
  el(tag, props = {}) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;   // only used with hard-coded strings
      else e.setAttribute(k, v);
    }
    return e;
  },
  /** Safely set text content */
  setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = String(text);
  },
  /** Sanitise any string that might hold user input before display */
  sanitise(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  },
};

// ─────────────────────────────────────────────
// RATE LIMITER (SOS abuse prevention)
// ─────────────────────────────────────────────
const RateLimiter = (maxCalls, windowMs) => {
  const calls = [];
  return {
    check() {
      const now = Date.now();
      while (calls.length && calls[0] < now - windowMs) calls.shift();
      if (calls.length >= maxCalls) return false;
      calls.push(now);
      return true;
    },
  };
};
const sosRateLimit = RateLimiter(2, 30000); // max 2 SOS per 30s

// ─────────────────────────────────────────────
// PRETEXT INTEGRATION
// Used for accurate canvas text measurement
// on the heatmap zone labels.
// ─────────────────────────────────────────────
let pretextReady = false;
let pretextPrepare = null;
let pretextLayout = null;

// Attempt to load Pretext from jsDelivr ESM
async function loadPretext() {
  try {
    // Try unpkg first (most reliable for ESM), fall back gracefully if unavailable
    const mod = await import('https://unpkg.com/@chenglou/pretext/dist/index.esm.js');
    pretextPrepare = mod.prepare;
    pretextLayout = mod.layout;
    pretextReady = true;
  } catch {
    // Pretext not available — fallback to canvas measureText (still correct, just no line-wrap logic)
    pretextReady = false;
  }
}

/**
 * Measure how wide a text string will render at a given font.
 * Uses Pretext if available; Canvas measureText as fallback.
 */
function measureText(text, font) {
  if (pretextReady && pretextPrepare && pretextLayout) {
    try {
      const p = pretextPrepare(text, font);
      // Use a very wide max width so it stays one line
      const { lineCount } = pretextLayout(p, 9999, 20);
      return lineCount;   // 1 = fits, >1 = overflows
    } catch { /* fallback */ }
  }
  // Canvas fallback
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  return ctx.measureText(text).width;
}

// ─────────────────────────────────────────────
// DATA
// ─────────────────────────────────────────────
const ZONES = [
  { id: 'N1', name: 'North Gate 1', x: .08, y: .10, density: .92, wait: 28 },
  { id: 'N2', name: 'North Gate 2', x: .28, y: .10, density: .55, wait: 9 },
  { id: 'E1', name: 'East Concourse', x: .83, y: .28, density: .82, wait: 21 },
  { id: 'E2', name: 'East Restrooms', x: .87, y: .52, density: .41, wait: 5 },
  { id: 'S1', name: 'South Exit Gate', x: .18, y: .84, density: .35, wait: 4 },
  { id: 'S2', name: 'South Concession 4', x: .50, y: .88, density: .73, wait: 16 },
  { id: 'W1', name: 'West Medical Bay', x: .06, y: .54, density: .20, wait: 2 },
  { id: 'W2', name: 'West Stand Bar', x: .12, y: .72, density: .88, wait: 25 },
  { id: 'C1', name: 'Centre Concourse', x: .44, y: .44, density: .65, wait: 12 },
];

const STAFF = [
  { name: 'Raj Patel', role: 'Security', loc: 'Gate North 1', dispatched: false },
  { name: 'Emma Clarke', role: 'Medic', loc: 'West Bay', dispatched: false },
  { name: 'Liam Torres', role: 'Concessions', loc: 'Stand 4', dispatched: false },
  { name: 'Aisha Yusuf', role: 'Security', loc: 'East Gate 2', dispatched: false },
  { name: 'Ben Kowalski', role: 'Steward', loc: 'South Exit', dispatched: false },
  { name: 'Priya Sharma', role: 'Medic', loc: 'First Aid 2', dispatched: false },
];

const AI_EVENTS = [
  { type: 'crit', msg: 'CRITICAL: Gate N1 at 92% capacity. Average wait 28 min. Recommend immediate staff redeployment.' },
  { type: 'warn', msg: 'Queue surge detected at West Stand Bar — 40 persons joining per minute. Incentive trigger recommended.' },
  { type: 'good', msg: 'AI dispatched Emma Clarke to North medical bay pre-emptively. Crowd crush risk mitigated.' },
  { type: 'info', msg: 'Parking Lot C clearing faster than predicted. 80% empty in approximately 14 minutes.' },
  { type: 'crit', msg: 'East Concourse Stand queue reached 21 min wait. Discount payload sent to 1,240 nearby devices.' },
  { type: 'good', msg: 'Dynamic incentive at South Concession active: +19% sales uplift, crowd density reduced 18% in 8 min.' },
  { type: 'warn', msg: 'Weather shift incoming — North terraces may see crowd movement in approximately 20 minutes.' },
  { type: 'good', msg: 'Staff Raj Patel redeployed to Gate N1. Queue throughput improved by 34%.' },
  { type: 'info', msg: '2,140 fans received smart rerouting push notification. 68% accepted alternate gate routing.' },
  { type: 'warn', msg: 'Concession Stand 4 POS terminal at low power. Backup unit dispatched.' },
];

const INCIDENTS = [
  { type: 'open', title: 'Medical — Chest Pain', loc: 'Section 114, Row J', time: '4:02 PM' },
  { type: 'resolved', title: 'Spill — Concourse West', loc: 'Gate W2 corridor', time: '3:48 PM' },
  { type: 'open', title: 'Lost Child Report', loc: 'South Family Zone', time: '3:55 PM' },
  { type: 'progress', title: 'Smoke Alarm — Kitchen Block 3', loc: 'Kitchen Block 3', time: '4:07 PM' },
  { type: 'open', title: 'Altercation — East Block D', loc: 'East Block, Section D', time: '4:09 PM' },
];

const INCENTIVES = [
  {
    zone: 'West Stand Bar (Gate W2)', crowd: 88, wait: 25, status: 'trigger',
    offer: '20% discount on all beverages — redirect fans to Stand 7 (3 min walk, low crowd)',
    fillClass: 'fill-red',
  },
  {
    zone: 'East Concourse Stand', crowd: 82, wait: 21, status: 'live',
    offer: 'Complimentary nachos with any drink purchase — Stand 9 (4 min walk, quiet)',
    fillClass: 'fill-red',
  },
  {
    zone: 'North Gate 2', crowd: 55, wait: 9, status: 'idle',
    offer: 'No current offer — density within acceptable threshold',
    fillClass: 'fill-green',
  },
  {
    zone: 'South Concession 4', crowd: 73, wait: 16, status: 'trigger',
    offer: 'Reduced coffee — Concession 6 (2 min walk, nearly empty)',
    fillClass: 'fill-amber',
  },
];

const MENU_ITEMS = [
  { emoji: '🍔', name: 'Stadium Burger', price: 8.50 },
  { emoji: '🍕', name: 'BBQ Chicken Pizza', price: 7.00 },
  { emoji: '🍺', name: 'Craft Beer (Pint)', price: 5.50 },
  { emoji: '🥤', name: 'Soft Drink', price: 3.00 },
  { emoji: '🌮', name: 'Nachos + Dip', price: 5.00 },
  { emoji: '🍟', name: 'Loaded Fries', price: 4.50 },
];

const PUSH_NOTIFS = [
  { type: 'pn-alert', title: 'Gate N1 is congested', sub: 'Switch to Gate N2 — same section, 7 min shorter wait.' },
  { type: 'pn-discount', title: 'Exclusive offer near you', sub: 'West Bar Stand 7 is quiet. 20% off all beverages right now.' },
  { type: 'pn-info', title: 'Half-time in 8 minutes', sub: 'Pre-order food now and skip the half-time rush entirely.' },
];

const PUSH_ICONS = {
  'pn-alert': { svg: '<path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>', cls: 'pni-alert' },
  'pn-discount': { svg: '<path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/>', cls: 'pni-discount' },
  'pn-info': { svg: '<path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/>', cls: 'pni-info' },
};

const REWARDS = [
  { title: '20% off — West Bar Stand 7', desc: 'Valid 15 min · Low crowd', tag: 'Save £1.10' },
  { title: 'Reduced coffee — Concession 6', desc: 'Valid 10 min · 2 min walk', tag: 'Save £1.50' },
  { title: 'Free nachos with any drink', desc: 'While stocks last · Stand 9', tag: 'FREE' },
];

const NAV_ITEMS = [
  { dest: 'Nearest Restrooms (Block C)', dist: '1 min · 45 m', crowd: 'c-low' },
  { dest: 'Express Collection Window 3', dist: '3 min · 120 m', crowd: 'c-low' },
  { dest: 'First Aid Bay (West)', dist: '4 min · 180 m', crowd: 'c-low' },
  { dest: 'Exit Gate S1 (Recommended)', dist: '6 min · 250 m', crowd: 'c-med' },
  { dest: 'Shuttle Bus Stop B', dist: '8 min · 340 m', crowd: 'c-high' },
  { dest: 'Car Park Lot C', dist: '10 min · 420 m', crowd: 'c-med' },
];

const NAV_ICONS = {
  'c-low': '<path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>',
  'c-med': '<path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>',
  'c-high': '<path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>',
};
const CROWD_LABELS = { 'c-low': 'Quiet', 'c-med': 'Moderate', 'c-high': 'Busy' };

const WAIT_ITEMS = [
  { name: 'Restrooms Block C', time: '2 min', pct: 15, cls: 'wb-green' },
  { name: 'Concession Stand 4', time: '16 min', pct: 80, cls: 'wb-red' },
  { name: 'Concession Stand 7', time: '4 min', pct: 28, cls: 'wb-green' },
  { name: 'Concession Stand 9', time: '5 min', pct: 32, cls: 'wb-green' },
  { name: 'West Stand Bar', time: '25 min', pct: 95, cls: 'wb-red' },
  { name: 'South Bar & Grill', time: '8 min', pct: 45, cls: 'wb-amber' },
  { name: 'Exit Gate N1', time: '28 min', pct: 92, cls: 'wb-red' },
  { name: 'Exit Gate S1', time: '4 min', pct: 24, cls: 'wb-green' },
];

const ROUTE_MSGS = [
  'Route clear — all nearby facilities under 5 min wait.',
  'Gate N1 congested — use Gate N2 (+2 min walk, saves 18 min queue).',
  'Restrooms Block C empty right now — recommended.',
  'Avoid West Stand Bar — 25 min queue. Stand 7 has same items, 4 min wait.',
];

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
const orderQty = new Array(MENU_ITEMS.length).fill(0);
let aiIdx = 0;
let routeIdx = 0;
let routeTick = 0;
let qChart = null;
let activeFilter = 'all';
let searchQuery = '';

const $ = id => document.getElementById(id);

// ─────────────────────────────────────────────
// THEME
// ─────────────────────────────────────────────
function getTheme() { return localStorage.getItem('vf-theme') || 'light'; }
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('vf-theme', theme);
  // Rebuild chart with correct grid colors after theme change
  setTimeout(buildQueueChart, 50);
}
function toggleTheme() {
  applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
}
$('theme-toggle').addEventListener('click', toggleTheme);

// ─────────────────────────────────────────────
// CLOCK
// ─────────────────────────────────────────────
function updateClock() {
  DOM.setText('live-clock', new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }));
}
setInterval(updateClock, 1000);
updateClock();

// ─────────────────────────────────────────────
// TAB SWITCHING
// ─────────────────────────────────────────────
document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach(t => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    const view = $(`view-${tab.dataset.tab}`);
    if (view) {
      view.classList.add('active');
      if (tab.dataset.tab === 'attendee') setTimeout(drawMiniHeatmap, 60);
    }
  });
});

// ─────────────────────────────────────────────
// KEYBOARD SHORTCUTS
// ─────────────────────────────────────────────
document.addEventListener('keydown', e => {
  // Don't fire shortcuts when typing in inputs
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  switch (e.key.toLowerCase()) {
    case 'm': $('tab-manager').click(); break;
    case 'a': $('tab-attendee').click(); break;
    case 't': toggleTheme(); break;
    case 'e': exportCSV(); break;
    case '?': showModal('modal-help'); break;
    case 'escape': closeAllModals(); break;
  }
});

$('btn-help').addEventListener('click', () => showModal('modal-help'));
$('btn-export').addEventListener('click', exportCSV);

// ─────────────────────────────────────────────
// SEARCH & FILTER
// ─────────────────────────────────────────────
$('zone-search').addEventListener('input', e => {
  searchQuery = DOM.sanitise(e.target.value).toLowerCase();
  renderZoneAlerts();
  renderIncidents();
});

document.querySelectorAll('.filter-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    activeFilter = pill.dataset.filter;
    renderZoneAlerts();
    renderIncidents();
    renderIncentives();
    updateFilterCounts();
  });
});

function updateFilterCounts() {
  const all = ZONES.length;
  const critical = ZONES.filter(z => z.density > .75).length;
  const warning = ZONES.filter(z => z.density > .50 && z.density <= .75).length;
  const clear = ZONES.filter(z => z.density <= .50).length;
  const fa = $('filter-all'); if (fa) fa.textContent = `All (${all})`;
  const fc = $('filter-critical'); if (fc) fc.innerHTML = `<span class="dot dot-red"></span>Critical (${critical})`;
  const fw = $('filter-warning'); if (fw) fw.innerHTML = `<span class="dot dot-amber"></span>Warning (${warning})`;
  const fcl = $('filter-clear'); if (fcl) fcl.innerHTML = `<span class="dot dot-green"></span>Clear (${clear})`;
}

function zoneMatchesFilter(z) {
  if (activeFilter === 'critical' && z.density <= .75) return false;
  if (activeFilter === 'warning' && (z.density <= .50 || z.density > .75)) return false;
  if (activeFilter === 'clear' && z.density > .50) return false;
  if (searchQuery && !z.name.toLowerCase().includes(searchQuery)) return false;
  return true;
}

function incidentMatchesFilter(inc) {
  // 'warning' shows open + progress; 'critical' shows only open; 'clear' shows resolved
  if (activeFilter === 'critical' && inc.type !== 'open') return false;
  if (activeFilter === 'warning' && !['open', 'progress'].includes(inc.type)) return false;
  if (activeFilter === 'clear' && inc.type !== 'resolved') return false;
  if (searchQuery && !inc.title.toLowerCase().includes(searchQuery) && !inc.loc.toLowerCase().includes(searchQuery)) return false;
  return true;
}

// ─────────────────────────────────────────────
// CSV EXPORT
// ─────────────────────────────────────────────
function exportCSV() {
  const rows = [['Zone / Incident', 'Status', 'Wait (min)', 'Density %', 'Time']];
  ZONES.forEach(z => {
    rows.push([z.name, z.density > .75 ? 'Critical' : z.density > .5 ? 'Warning' : 'Clear', z.wait, Math.round(z.density * 100), new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })]);
  });
  rows.push(['---', '---', '---', '---', '---']);
  INCIDENTS.forEach(inc => {
    rows.push([inc.title, inc.type, '—', '—', inc.time]);
  });

  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `venueflow-report-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
  showToast('success', 'Report exported', 'CSV saved to your downloads folder');
}

// ─────────────────────────────────────────────
// HEATMAP
// ─────────────────────────────────────────────
function drawHeatmap(canvasId, zones) {
  const canvas = $(canvasId);
  if (!canvas) return;
  const W = canvas.offsetWidth || 600;
  const H = canvas.offsetHeight || 400;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Stadium dark background
  ctx.fillStyle = '#060a12';
  ctx.fillRect(0, 0, W, H);

  // Stadium outline — oval bowl
  ctx.save();
  ctx.strokeStyle = 'rgba(40,75,140,.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(W / 2, H / 2, W * .44, H * .44, 0, 0, Math.PI * 2);
  ctx.stroke();
  // Inner track
  ctx.strokeStyle = 'rgba(40,75,140,.2)';
  ctx.beginPath();
  ctx.ellipse(W / 2, H / 2, W * .36, H * .36, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // Pitch rectangle
  ctx.save();
  ctx.strokeStyle = 'rgba(34,197,94,.28)';
  ctx.lineWidth = 1.2;
  const pw = W * .38, ph = H * .42;
  const px = (W - pw) / 2, py = (H - ph) / 2;
  ctx.strokeRect(px, py, pw, ph);
  // Centre circle + line
  ctx.beginPath(); ctx.arc(W / 2, H / 2, ph * .19, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(px, H / 2); ctx.lineTo(px + pw, H / 2); ctx.stroke();
  // Penalty boxes
  const baW = pw * .30, baH = ph * .18;
  ctx.strokeRect(px, py, baW, baH);
  ctx.strokeRect(px + pw - baW, py + ph - baH, baW, baH);
  // Goal boxes (smaller)
  ctx.strokeRect(px, py, baW * .5, baH * .55);
  ctx.strokeRect(px + pw - baW * .5, py + ph - baH * .55, baW * .5, baH * .55);
  ctx.restore();

  // Section labels around the bowl
  ctx.save();
  ctx.fillStyle = 'rgba(138,154,184,.2)';
  ctx.font = 'bold 8px Outfit, sans-serif';
  ctx.textAlign = 'center';
  const sections = [
    { t: 'NORTH STAND', x: W * .5, y: H * .04 },
    { t: 'SOUTH STAND', x: W * .5, y: H * .97 },
    { t: 'WEST STAND', x: W * .03, y: H * .5 },
    { t: 'EAST STAND', x: W * .97, y: H * .5 },
  ];
  sections.forEach(s => ctx.fillText(s.t, s.x, s.y));
  ctx.restore();

  // Gate labels with subtle markers
  ctx.save();
  ctx.fillStyle = 'rgba(138,154,184,.18)';
  ctx.font = '600 7px Outfit, sans-serif';
  ctx.textAlign = 'center';
  [{ t: 'GATE A', x: W * .3, y: H * .02 }, { t: 'GATE B', x: W * .7, y: H * .02 },
  { t: 'GATE C', x: W * .95, y: H * .3 }, { t: 'GATE D', x: W * .95, y: H * .7 },
  { t: 'GATE E', x: W * .7, y: H * .99 }, { t: 'GATE F', x: W * .3, y: H * .99 },
  { t: 'GATE G', x: W * .05, y: H * .7 }, { t: 'GATE H', x: W * .05, y: H * .3 }
  ].forEach(g => ctx.fillText(g.t, g.x, g.y));
  ctx.restore();

  // Heat blobs with multi-stop gradients for richer look
  zones.forEach(z => {
    const cx = z.x * W, cy = z.y * H;
    const r = Math.min(W, H) * (.12 + z.density * .12);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    const a1 = .35 + z.density * .50;
    const a2 = .10 + z.density * .15;
    if (z.density > .75) {
      g.addColorStop(0, `rgba(255,50,50,${a1})`);
      g.addColorStop(.5, `rgba(239,68,68,${a2})`);
    } else if (z.density > .50) {
      g.addColorStop(0, `rgba(255,180,30,${a1})`);
      g.addColorStop(.5, `rgba(245,158,11,${a2})`);
    } else {
      g.addColorStop(0, `rgba(34,220,100,${a1})`);
      g.addColorStop(.5, `rgba(34,197,94,${a2})`);
    }
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();

    // Pulsing outer ring on critical zones
    if (z.density > .75) {
      ctx.save();
      ctx.strokeStyle = `rgba(239,68,68,${.15 + Math.sin(Date.now() / 400) * .1})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, r * 1.15, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    // Dot indicator
    ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fillStyle = z.density > .75 ? '#ef4444' : z.density > .50 ? '#f59e0b' : '#22c55e';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1; ctx.stroke();

    // Label: zone name + density %
    const label = `${z.name}`;
    const sub = `${Math.round(z.density * 100)}% · ${z.wait}m`;
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.font = 'bold 9px Outfit, sans-serif';
    ctx.fillText(label, cx + 8, cy - 5);
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.font = '500 8px Outfit, sans-serif';
    ctx.fillText(sub, cx + 8, cy + 6);
  });

  // Store zones for click detection
  canvas._zones = zones.map(z => ({ ...z, cx: z.x * W, cy: z.y * H }));
}

function nudgeDensities() {
  ZONES.forEach(z => {
    z.density = Math.max(.08, Math.min(1, z.density + (Math.random() - .47) * .06));
    z.wait = Math.max(1, Math.round(z.density * 32));
  });
}

function renderZoneAlerts() {
  const el = $('zone-alerts');
  if (!el) return;
  const filtered = [...ZONES]
    .sort((a, b) => b.density - a.density)
    .filter(zoneMatchesFilter)
    .slice(0, 6);

  el.innerHTML = '';
  filtered.forEach(z => {
    const cls = z.density > .75 ? 'zi-red' : z.density > .50 ? 'zi-amber' : 'zi-green';
    const row = DOM.el('div', { class: 'zone-row', role: 'listitem', 'data-zone-id': z.id });
    row.innerHTML = `
      <div class="zone-indicator ${cls}"></div>
      <span class="zone-name">${DOM.sanitise(z.name)}</span>
      <span class="zone-wait-label">${z.wait} min</span>`;
    row.addEventListener('click', () => openZoneModal(z));
    el.appendChild(row);
  });
}

// ─────────────────────────────────────────────
// MINI HEATMAP
// ─────────────────────────────────────────────
function drawMiniHeatmap() {
  const c = $('mini-heatmap');
  if (!c) return;
  const W = c.offsetWidth || 270, H = c.offsetHeight || 115;
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  // Stadium dark background
  ctx.fillStyle = '#060a12';
  ctx.fillRect(0, 0, W, H);

  // Stadium outline — oval bowl (cropped for mini view)
  ctx.save();
  ctx.strokeStyle = 'rgba(40,75,140,.35)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  // Draw a larger ellipse to simulate we are looking at a cross section
  ctx.ellipse(W / 2, H / 2 + 20, W * .6, H * .8, 0, 0, Math.PI * 2);
  ctx.stroke();

  // Inner track
  ctx.strokeStyle = 'rgba(40,75,140,.2)';
  ctx.beginPath();
  ctx.ellipse(W / 2, H / 2 + 20, W * .45, H * .6, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // Pitch edge visible at the bottom
  ctx.save();
  ctx.strokeStyle = 'rgba(34,197,94,.28)';
  ctx.lineWidth = 1;
  ctx.strokeRect(W * .15, H * .6, W * .7, H * .5);
  ctx.restore();

  // Rich Heat blobs
  const blobs = [{ x: .2, y: .4, d: .82 }, { x: .55, y: .3, d: .35 }, { x: .85, y: .45, d: .45 }];
  blobs.forEach(b => {
    const cx = b.x * W, cy = b.y * H, r = W * .25;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    const a1 = .35 + b.d * .50;
    const a2 = .10 + b.d * .15;
    if (b.d > .75) {
      g.addColorStop(0, `rgba(255,50,50,${a1})`);
      g.addColorStop(.5, `rgba(239,68,68,${a2})`);
    } else if (b.d > .50) {
      g.addColorStop(0, `rgba(255,180,30,${a1})`);
      g.addColorStop(.5, `rgba(245,158,11,${a2})`);
    } else {
      g.addColorStop(0, `rgba(34,220,100,${a1})`);
      g.addColorStop(.5, `rgba(34,197,94,${a2})`);
    }
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  });

  // Location pin
  const mx = W * .55, my = H * .3;
  // Pin outer halo
  ctx.beginPath(); ctx.arc(mx, my, 8, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(59,130,246,0.3)'; ctx.fill();

  // Pin core
  ctx.beginPath(); ctx.arc(mx, my, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#3b82f6'; ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();

  // Tag box
  const pw = 36, ph = 14;
  ctx.fillStyle = 'rgba(15,23,42,0.85)';
  ctx.beginPath(); ctx.roundRect(mx + 8, my - 20, pw, ph, 4); ctx.fill();
  ctx.strokeStyle = 'rgba(59,130,246,0.5)'; ctx.lineWidth = 1; ctx.stroke();

  ctx.fillStyle = '#fff'; ctx.font = 'bold 9px Inter,sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('You', mx + 8 + (pw / 2), my - 20 + (ph / 1.5));
}

// ─────────────────────────────────────────────
// HEATMAP CLICK — Zone Drill-Down
// ─────────────────────────────────────────────
document.getElementById('venue-heatmap').addEventListener('click', function (e) {
  if (!this._zones) return;
  const rect = this.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  let closest = null, closestDist = 60; // px threshold
  this._zones.forEach(z => {
    const d = Math.hypot(mx - z.cx, my - z.cy);
    if (d < closestDist) { closestDist = d; closest = z; }
  });
  if (closest) openZoneModal(closest);
});

function openZoneModal(z) {
  const statusText = z.density > .75 ? 'Critical' : z.density > .50 ? 'Warning' : 'Clear';
  const statusCls = z.density > .75 ? 'st-open' : z.density > .50 ? 'st-progress' : 'st-resolved';
  const body = $('zone-modal-body');
  $('zone-title').textContent = DOM.sanitise(z.name);
  body.innerHTML = `
    <div class="zone-detail-grid">
      <div class="zone-stat">
        <div class="zone-stat-label">Crowd Density</div>
        <div class="zone-stat-value">${Math.round(z.density * 100)}%</div>
      </div>
      <div class="zone-stat">
        <div class="zone-stat-label">Est. Wait Time</div>
        <div class="zone-stat-value">${z.wait} min</div>
      </div>
      <div class="zone-stat">
        <div class="zone-stat-label">Status</div>
        <div class="zone-stat-value"><span class="inc-status ${statusCls}">${statusText}</span></div>
      </div>
      <div class="zone-stat">
        <div class="zone-stat-label">Zone ID</div>
        <div class="zone-stat-value">${DOM.sanitise(z.id)}</div>
      </div>
    </div>
    <p style="font-size:.78rem;color:var(--text-secondary);line-height:1.55">
      ${z.density > .75
      ? 'This zone is critically congested. Consider dispatching additional staff and activating a nearby incentive to redistribute crowd flow.'
      : z.density > .50
        ? 'This zone is moderately busy. Monitor closely and prepare an incentive if density continues to increase.'
        : 'This zone is operating within normal parameters. No immediate action required.'}
    </p>`;
  showModal('modal-zone');
}

// ─────────────────────────────────────────────
// QUEUE CHART
// ─────────────────────────────────────────────
function buildQueueChart() {
  const canvas = $('queue-chart');
  if (!canvas) return;
  // Ensure canvas has a proper height via its container
  const wrapper = canvas.parentElement;
  if (wrapper && wrapper.offsetHeight < 10) wrapper.style.minHeight = '195px';

  const isDark = getTheme() === 'dark';
  const tickClr = isDark ? '#8a9ab8' : '#4a5a72';
  const gridClr = isDark ? 'rgba(30,45,66,.4)' : 'rgba(209,219,237,.6)';
  const labels = ['Gate N1', 'Gate N2', 'East Cse', 'Bar W2', 'Conces.4', 'Exit S1'];
  const data = [ZONES[0], ZONES[1], ZONES[2], ZONES[7], ZONES[5], ZONES[4]].map(z => Math.round(z.wait));
  const colors = data.map(v => v > 20 ? 'rgba(239,68,68,.78)' : v > 12 ? 'rgba(245,158,11,.78)' : 'rgba(34,197,94,.78)');

  if (qChart) { qChart.destroy(); qChart = null; }
  qChart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Wait (min)', data, backgroundColor: colors, borderRadius: 6, barThickness: 18 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 600 },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => `${c.raw} min wait`, title: t => `${t[0].label}: ${data[t[0].dataIndex] > 20 ? 'CRITICAL' : data[t[0].dataIndex] > 12 ? 'WARNING' : 'CLEAR'}` } }
      },
      scales: {
        x: { ticks: { color: tickClr, font: { size: 9, family: 'Outfit', weight: '600' } }, grid: { color: gridClr } },
        y: {
          beginAtZero: true, max: 35,
          ticks: { color: tickClr, font: { size: 9, family: 'Outfit' }, callback: v => v + 'm' },
          grid: { color: gridClr }
        },
      },
    },
  });
}

// ─────────────────────────────────────────────
// AI FEED
// ─────────────────────────────────────────────
const AI_ICON_SVG = {
  crit: { cls: 'ae-crit', svg: '<path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>' },
  warn: { cls: 'ae-warn', svg: '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>' },
  good: { cls: 'ae-good', svg: '<path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>' },
  info: { cls: 'ae-info', svg: '<path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/>' },
};

function pushAIEvent() {
  const feed = $('ai-feed');
  if (!feed) return;
  const e = AI_EVENTS[aiIdx % AI_EVENTS.length]; aiIdx++;
  const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  const icon = AI_ICON_SVG[e.type] || AI_ICON_SVG.info;
  const div = DOM.el('div', { class: `ai-event ${e.type}` });
  div.innerHTML = `
    <div class="ai-event-icon ${icon.cls}">
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${icon.svg}</svg>
    </div>
    <div>
      <div class="ai-event-msg">${DOM.sanitise(e.msg)}</div>
      <div class="ai-event-time">${time}</div>
    </div>`;
  feed.prepend(div);
  while (feed.children.length > 12) feed.lastChild.remove();
}

// ─────────────────────────────────────────────
// STAFF DISPATCH
// ─────────────────────────────────────────────
function renderDispatch() {
  const grid = $('dispatch-grid');
  if (!grid) return;
  grid.innerHTML = '';
  STAFF.forEach((s, i) => {
    const card = DOM.el('div', { class: 'dispatch-card', role: 'listitem' });
    card.innerHTML = `
      <div class="dispatch-info">
        <div class="dispatch-name">${DOM.sanitise(s.name)}</div>
        <div class="dispatch-role">${DOM.sanitise(s.role)}</div>
      </div>
      <span class="dispatch-loc">${DOM.sanitise(s.loc)}</span>
      <button class="dispatch-btn ${s.dispatched ? 'dispatched' : ''}"
        ${s.dispatched ? 'disabled' : ''} aria-label="Dispatch ${DOM.sanitise(s.name)}">
        ${s.dispatched ? 'Deployed' : 'Dispatch'}
      </button>`;
    card.querySelector('.dispatch-btn').addEventListener('click', () => dispatchStaff(i));
    grid.appendChild(card);
  });
}

function dispatchStaff(i) {
  STAFF[i].dispatched = true;
  renderDispatch();
  const rVal = $('val-resolved');
  if (rVal) rVal.textContent = parseInt(rVal.textContent) + 1;
  showToast('success', 'Staff Dispatched', `${DOM.sanitise(STAFF[i].name)} is en route to position`);
}

// ─────────────────────────────────────────────
// INCIDENT FEED
// ─────────────────────────────────────────────
const INC_ICONS = {
  open: { svg: '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>', cls: 'inc-icon-open' },
  progress: { svg: '<path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>', cls: 'inc-icon-warn' },
  resolved: { svg: '<path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>', cls: 'inc-icon-resolved' },
};

function renderIncidents() {
  const feed = $('incident-feed');
  const counter = $('incident-count');
  if (!feed) return;
  const filtered = INCIDENTS.filter(incidentMatchesFilter);
  const open = INCIDENTS.filter(x => x.type !== 'resolved').length;
  if (counter) counter.textContent = `${open} open`;
  feed.innerHTML = '';

  if (filtered.length === 0) {
    const empty = DOM.el('div', { class: 'feed-empty', text: activeFilter === 'clear' ? 'No resolved incidents.' : activeFilter === 'critical' ? 'No critical incidents active.' : 'No incidents match the search.' });
    feed.appendChild(empty);
    return;
  }

  filtered.forEach((inc, idx) => {
    const icon = INC_ICONS[inc.type] || INC_ICONS.open;
    const rowCls = inc.type === 'resolved' ? 'resolved' : inc.type === 'progress' ? 'warning' : '';
    const stCls = inc.type === 'resolved' ? 'st-resolved' : inc.type === 'progress' ? 'st-progress' : 'st-open';
    const stText = inc.type === 'resolved' ? 'Resolved' : inc.type === 'progress' ? 'In Progress' : 'Open';
    const item = DOM.el('div', { class: `incident-item ${rowCls}` });
    item.innerHTML = `
      <div class="inc-icon-wrap ${icon.cls}">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${icon.svg}</svg>
      </div>
      <div class="inc-body">
        <div class="inc-title">${DOM.sanitise(inc.title)}</div>
        <div class="inc-loc">${DOM.sanitise(inc.loc)}</div>
      </div>
      <span class="inc-time">${DOM.sanitise(inc.time)}</span>
      <div class="inc-actions">
        <span class="inc-status ${stCls}">${stText}</span>
        ${inc.type !== 'resolved' ? `<button class="inc-resolve-btn" data-idx="${idx}" aria-label="Mark resolved">Resolve</button>` : ''}
      </div>`;
    const resolveBtn = item.querySelector('.inc-resolve-btn');
    if (resolveBtn) resolveBtn.addEventListener('click', () => resolveIncident(resolveBtn.dataset.idx));
    feed.appendChild(item);
  });
}

function resolveIncident(filteredIdx) {
  // Find the actual index in INCIDENTS that matches what's currently filtered
  const filtered = INCIDENTS.filter(incidentMatchesFilter);
  const inc = filtered[filteredIdx];
  if (!inc) return;
  const realIdx = INCIDENTS.indexOf(inc);
  if (realIdx === -1) return;
  INCIDENTS[realIdx].type = 'resolved';
  const rVal = $('val-resolved');
  if (rVal) rVal.textContent = parseInt(rVal.textContent) + 1;
  renderIncidents();
  showToast('success', 'Incident Resolved', DOM.sanitise(INCIDENTS[realIdx].title));
}

// ─────────────────────────────────────────────
// INCENTIVE ENGINE
// ─────────────────────────────────────────────
// Incentive countdown timers
const incCountdowns = {};

function renderIncentives() {
  const grid = $('incentives-grid');
  if (!grid) return;

  // Filter by activeFilter: 'critical' shows trigger-ready, 'clear' shows idle/live, 'all'/'warning' shows all
  let list = INCENTIVES;
  if (activeFilter === 'critical') list = INCENTIVES.filter(x => x.status === 'trigger');
  if (activeFilter === 'clear') list = INCENTIVES.filter(x => x.status !== 'trigger');

  grid.innerHTML = '';

  if (list.length === 0) {
    grid.innerHTML = '<p class="feed-empty">No incentives match this filter.</p>';
    return;
  }

  list.forEach((inc, localIdx) => {
    const i = INCENTIVES.indexOf(inc);
    const sCls = inc.status === 'trigger' ? 's-trigger' : inc.status === 'live' ? 's-live' : 's-idle';
    const sText = inc.status === 'trigger' ? 'Trigger Ready' : inc.status === 'live' ? 'Live Now' : 'Idle';
    const fCls = inc.crowd > 75 ? 'fill-red' : inc.crowd > 55 ? 'fill-amber' : 'fill-green';
    const card = DOM.el('div', { class: `incentive-card ${inc.status === 'live' ? 'live' : ''}` });
    // Savings estimate
    const saving = inc.status === 'live' ? `Saving ${Math.round(inc.crowd * .18)}% crowd · +${Math.round(inc.wait * .22)}% sales` : `Est. impact: reduce wait by ~${Math.round(inc.wait * .35)} min`;
    const countdown = incCountdowns[i] ? `<span class="inc-countdown" id="countdown-${i}">Expires in ${incCountdowns[i]}s</span>` : '';
    card.innerHTML = `
      <div class="inc-head">
        <span class="inc-zone">${DOM.sanitise(inc.zone)}</span>
        <span class="inc-status-badge ${sCls}">${sText}</span>
      </div>
      <div class="inc-offer">${DOM.sanitise(inc.offer)}</div>
      <div class="inc-meta">${inc.crowd}% density &middot; ${inc.wait} min wait &middot; <em>${saving}</em></div>
      <div class="inc-bar"><div class="inc-bar-fill ${fCls}" style="width:${inc.crowd}%"></div></div>
      ${countdown}
      <div class="inc-btn-row">
        <button class="activate-btn ${inc.status === 'trigger' ? 'btn-activate' : inc.status === 'live' ? 'btn-active' : 'btn-idle'}"
          ${inc.status !== 'trigger' ? 'disabled' : ''} aria-label="${inc.status === 'trigger' ? 'Activate offer' : 'Offer ' + sText}">
          ${inc.status === 'trigger' ? 'Activate Offer' : inc.status === 'live' ? 'Active — Ongoing' : 'No Action Needed'}
        </button>
        ${inc.status === 'live' ? `<button class="deactivate-btn" aria-label="Deactivate">Deactivate</button>` : ''}
      </div>`;
    const actBtn = card.querySelector('.activate-btn');
    if (actBtn) actBtn.addEventListener('click', () => activateIncentive(i));
    const deBtn = card.querySelector('.deactivate-btn');
    if (deBtn) deBtn.addEventListener('click', () => deactivateIncentive(i));
    grid.appendChild(card);
  });
}

function activateIncentive(i) {
  if (INCENTIVES[i].status !== 'trigger') return;
  INCENTIVES[i].status = 'live';
  incCountdowns[i] = 120; // 120 second countdown
  renderIncentives();
  showToast('success', 'Incentive Activated', `Push sent to fans near ${DOM.sanitise(INCENTIVES[i].zone)}`);
  // Simulate crowd reduction
  const zoneIdx = Math.min(i, ZONES.length - 1);
  setTimeout(() => {
    ZONES[zoneIdx].density = Math.max(.2, ZONES[zoneIdx].density - .18);
    ZONES[zoneIdx].wait = Math.max(2, ZONES[zoneIdx].wait - 8);
    drawHeatmap('venue-heatmap', ZONES);
    renderZoneAlerts();
    updateKPIs();
  }, 3000);
  // Countdown ticker
  const tid = setInterval(() => {
    if (!incCountdowns[i]) { clearInterval(tid); return; }
    incCountdowns[i]--;
    const el = $(`countdown-${i}`);
    if (el) el.textContent = `Expires in ${incCountdowns[i]}s`;
    if (incCountdowns[i] <= 0) {
      clearInterval(tid);
      delete incCountdowns[i];
      INCENTIVES[i].status = 'idle';
      renderIncentives();
      showToast('info', 'Offer Expired', `Incentive at ${DOM.sanitise(INCENTIVES[i].zone)} ended`);
    }
  }, 1000);
}

function deactivateIncentive(i) {
  delete incCountdowns[i];
  INCENTIVES[i].status = 'idle';
  renderIncentives();
  showToast('info', 'Incentive Deactivated', DOM.sanitise(INCENTIVES[i].zone));
}

// ─────────────────────────────────────────────
// KPI UPDATES
// ─────────────────────────────────────────────
function updateKPIs() {
  const occ = $('val-occupancy');
  const fill = $('fill-occupancy');
  if (occ) {
    let n = parseInt(occ.textContent.replace(/,/g, '')) + Math.floor((Math.random() - .3) * 60);
    n = Math.max(62000, Math.min(80000, n));
    occ.textContent = n.toLocaleString();
    if (fill) fill.style.width = (n / 800) + '%';
  }
  const rev = $('val-revenue');
  if (rev) {
    const n = parseInt(rev.textContent.replace(/[^\d]/g, '')) + Math.floor(Math.random() * 280);
    rev.textContent = '£' + n.toLocaleString();
  }
  const sat = $('val-satisfaction');
  if (sat) {
    let v = parseFloat(sat.textContent) + (Math.random() - .5) * .08;
    sat.textContent = Math.max(3.6, Math.min(5, +v.toFixed(1))).toFixed(1);
  }
  const bn = $('val-bottlenecks'), bnSub = $('sub-bottlenecks');
  if (bn) {
    const hot = ZONES.filter(z => z.density > .75).length;
    bn.textContent = hot;
    if (bnSub) {
      const avg = hot ? Math.round(ZONES.filter(z => z.density > .75).reduce((s, z) => s + z.wait, 0) / hot) : 0;
      bnSub.textContent = `Avg wait: ${avg} min`;
    }
  }
}

// ─────────────────────────────────────────────
// ATTENDEE
// ─────────────────────────────────────────────
function renderPushNotifs() {
  const el = $('push-notifications');
  if (!el) return;
  el.innerHTML = '';
  PUSH_NOTIFS.forEach(n => {
    const icon = PUSH_ICONS[n.type] || PUSH_ICONS['pn-info'];
    const div = DOM.el('div', { class: `push-notif ${n.type}` });
    div.innerHTML = `
      <div class="pn-icon-wrap ${icon.cls}">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${icon.svg}</svg>
      </div>
      <div class="pn-body">
        <div class="pn-title">${DOM.sanitise(n.title)}</div>
        <div class="pn-sub">${DOM.sanitise(n.sub)}</div>
      </div>`;
    el.appendChild(div);
  });
}

function renderRewards() {
  const el = $('rewards-scroll');
  if (!el) return;
  el.innerHTML = '';
  REWARDS.forEach(r => {
    const card = DOM.el('div', { class: 'reward-card' });
    card.innerHTML = `
      <div class="reward-icon">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/></svg>
      </div>
      <div class="reward-body">
        <div class="reward-title">${DOM.sanitise(r.title)}</div>
        <div class="reward-desc">${DOM.sanitise(r.desc)}</div>
      </div>
      <span class="reward-tag">${DOM.sanitise(r.tag)}</span>`;
    el.appendChild(card);
  });
}

const ROUTE_STATUS = [
  { prefix: 'Clear', cls: '#22c55e' },
  { prefix: 'Advisory', cls: '#f59e0b' },
  { prefix: 'Clear', cls: '#22c55e' },
  { prefix: 'Avoid', cls: '#ef4444' },
];
function cycleRoute() {
  const el = $('route-suggestion');
  if (!el) return;
  const rs = ROUTE_STATUS[routeIdx % ROUTE_STATUS.length];
  const msg = ROUTE_MSGS[routeIdx % ROUTE_MSGS.length];
  el.innerHTML = `<strong style="color:${rs.cls}">${rs.prefix}:</strong> ${DOM.sanitise(msg)}`;
  routeIdx++;
}

// ─────────────────────────────────────────────
// MODALS
// ─────────────────────────────────────────────
window.showModal = function (id) {
  const el = $(id);
  if (!el) return;
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  // Focus first focusable element
  const first = el.querySelector('button, input, select, [tabindex]');
  if (first) setTimeout(() => first.focus(), 100);
  if (id === 'modal-order') renderMenuItems();
  if (id === 'modal-nav') renderNavList();
  if (id === 'modal-wait') renderWaitList();
};

window.closeModal = function (id) {
  const el = $(id);
  if (el) { el.classList.remove('open'); el.setAttribute('aria-hidden', 'true'); }
};

function closeAllModals() {
  document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
}

document.querySelectorAll('.modal-overlay').forEach(ov => {
  ov.addEventListener('click', e => { if (e.target === ov) ov.classList.remove('open'); });
});

// Order
function renderMenuItems() {
  const grid = $('menu-items');
  if (!grid) return;
  grid.innerHTML = '';
  MENU_ITEMS.forEach((m, i) => {
    const item = DOM.el('div', { class: 'menu-item' });
    item.innerHTML = `
      <span class="menu-emoji" aria-hidden="true">${m.emoji}</span>
      <div class="menu-info">
        <div class="menu-name">${DOM.sanitise(m.name)}</div>
        <div class="menu-price">£${m.price.toFixed(2)}</div>
      </div>
      <div class="menu-qty" role="group" aria-label="Quantity for ${DOM.sanitise(m.name)}">
        <button class="qty-btn" aria-label="Decrease quantity">−</button>
        <span class="qty-val" id="qty-${i}">${orderQty[i]}</span>
        <button class="qty-btn" aria-label="Increase quantity">+</button>
      </div>`;
    const [dec, inc] = item.querySelectorAll('.qty-btn');
    dec.addEventListener('click', () => changeQty(i, -1));
    inc.addEventListener('click', () => changeQty(i, +1));
    grid.appendChild(item);
  });
  calcTotal();
}

function changeQty(i, d) {
  orderQty[i] = Math.max(0, orderQty[i] + d);
  DOM.setText(`qty-${i}`, orderQty[i]);
  calcTotal();
}
function calcTotal() {
  const t = MENU_ITEMS.reduce((s, m, i) => s + m.price * orderQty[i], 0);
  DOM.setText('order-total', `Total: £${t.toFixed(2)}`);
}
window.placeOrder = function () {
  if (orderQty.every(q => q === 0)) { showToast('info', 'No items selected', 'Add at least one item to your order'); return; }
  closeModal('modal-order');
  orderQty.fill(0);
  showToast('success', 'Order Placed', 'Ready in approx. 8 min — Express Window 3');
};

// Nav
function renderNavList() {
  const el = $('nav-list');
  if (!el) return;
  el.innerHTML = '';
  NAV_ITEMS.forEach(n => {
    const item = DOM.el('div', { class: 'nav-item', role: 'listitem' });
    item.innerHTML = `
      <div class="nav-icon-wrap">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${NAV_ICONS[n.crowd]}</svg>
      </div>
      <div class="nav-body">
        <div class="nav-dest">${DOM.sanitise(n.dest)}</div>
        <div class="nav-dist">${DOM.sanitise(n.dist)}</div>
      </div>
      <span class="crowd-tag ${n.crowd}">${CROWD_LABELS[n.crowd]}</span>`;
    el.appendChild(item);
  });
}

// Wait times
function renderWaitList() {
  const el = $('wait-list');
  if (!el) return;
  el.innerHTML = '';
  WAIT_ITEMS.forEach(w => {
    const item = DOM.el('div', { class: 'wait-item', role: 'listitem' });
    item.innerHTML = `
      <div class="nav-icon-wrap">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/></svg>
      </div>
      <div class="wait-body">
        <div class="wait-name">${DOM.sanitise(w.name)}</div>
        <div class="wait-time">${DOM.sanitise(w.time)}</div>
      </div>
      <div class="wait-bar-outer">
        <div class="wait-bar-bg"><div class="wait-bar-fill ${w.cls}" style="width:${w.pct}%"></div></div>
      </div>`;
    el.appendChild(item);
  });
}

// SOS (rate-limited)
window.sendSOS = function (type) {
  if (!sosRateLimit.check()) {
    showToast('error', 'SOS Rate Limit', 'Please wait 30 seconds before sending another SOS');
    return;
  }
  closeModal('modal-sos');
  const safeType = DOM.sanitise(type);
  const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  INCIDENTS.unshift({ type: 'open', title: `SOS — ${safeType}`, loc: 'Section 114, Row J, Seat 12', time });
  renderIncidents();
  showToast('success', 'Help is on the way', `${safeType} · ETA approx. 2 min · Ref #${Math.floor(Math.random() * 90000 + 10000)}`);
};

// ─────────────────────────────────────────────
// TOAST SYSTEM
// ─────────────────────────────────────────────
const TOAST_ICONS = {
  success: '<path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>',
  error: '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>',
  info: '<path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/>',
};

function showToast(type, title, sub) {
  const container = $('toast-container');
  if (!container) return;
  const toast = DOM.el('div', { class: `toast ${type}`, role: 'alert', 'aria-live': 'assertive' });
  toast.innerHTML = `
    <div class="toast-icon-wrap toast-icon-${type}">
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${TOAST_ICONS[type] || TOAST_ICONS.info}</svg>
    </div>
    <div>
      <div class="toast-title">${DOM.sanitise(title)}</div>
      <div class="toast-sub">${DOM.sanitise(sub)}</div>
    </div>`;
  container.appendChild(toast);
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('show')));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, 3800);
}

// ─────────────────────────────────────────────
// MAIN RENDER CYCLE
// ─────────────────────────────────────────────
function fullRender() {
  nudgeDensities();
  drawHeatmap('venue-heatmap', ZONES);
  renderZoneAlerts();
  buildQueueChart();
  renderIncidents();
  renderIncentives();
  updateKPIs();
  updateFilterCounts();
  routeTick++;
  if (routeTick % 3 === 0) cycleRoute();
}

async function init() {
  // Apply saved theme (light by default)
  applyTheme(getTheme());

  // Load Pretext in background (non-blocking)
  loadPretext();

  // Static renders
  renderDispatch();
  renderPushNotifs();
  renderRewards();
  cycleRoute();

  // Render data panels immediately
  nudgeDensities();
  drawHeatmap('venue-heatmap', ZONES);
  renderZoneAlerts();
  renderIncidents();
  renderIncentives();
  updateKPIs();
  updateFilterCounts();

  // Chart needs the canvas to be visible and sized — delay slightly
  setTimeout(buildQueueChart, 120);
  setTimeout(drawMiniHeatmap, 80);

  pushAIEvent();

  // Intervals
  setInterval(fullRender, 8000);
  setInterval(pushAIEvent, 5500);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// ─────────────────────────────────────────────
// FEEDBACK SYSTEM
// ─────────────────────────────────────────────
let fbRating = 0;
const fbStars = document.querySelectorAll('.star-btn');
const fbText = $('fb-rating-text');
const fbCats = document.querySelectorAll('.fb-cat');

fbStars.forEach(star => {
  star.addEventListener('click', (e) => {
    fbRating = parseInt(e.target.dataset.star);
    fbStars.forEach((s, idx) => {
      s.style.color = idx < fbRating ? 'var(--accent-amber)' : 'var(--text-muted)';
    });
    const messages = ['Poor', 'Fair', 'Good', 'Very Good', 'Excellent'];
    if (fbText) fbText.textContent = messages[fbRating - 1];
  });
});

fbCats.forEach(cat => {
  cat.addEventListener('click', (e) => {
    e.target.classList.toggle('selected');
  });
});

window.submitFeedback = function () {
  if (fbRating === 0) {
    showToast('error', 'Rating Required', 'Please select a star rating first');
    return;
  }
  closeModal('modal-feedback');
  // reset form
  fbRating = 0;
  fbStars.forEach(s => s.style.color = 'var(--text-muted)');
  if (fbText) fbText.textContent = 'Tap a star to rate';
  fbCats.forEach(c => c.classList.remove('selected'));
  if ($('fb-comment')) $('fb-comment').value = '';

  showToast('success', 'Feedback Submitted', 'Thank you for helping us improve!');
};


/* ============================================================
   ENHANCED ATTENDEE MODAL FUNCTIONS
   ============================================================ */

// ─── MENU CATEGORY FILTER ──────────────────────────────────
const MENU_CATEGORIES = {
  'food': [0, 1],      // Burger, Pizza
  'drinks': [2, 3],      // Beer, Soft Drink
  'snacks': [4, 5],      // Nachos, Fries
};
let currentMenuCat = 'all';

window.filterMenuCat = function (btn, cat) {
  document.querySelectorAll('.order-cat-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentMenuCat = cat;
  renderMenuItems();
};

// ─── ORDER MODAL OPEN ──────────────────────────────────────
window.openOrderModal = function () {
  const orderScreen = $('order-screen');
  const orderTrack = $('order-tracking');
  if (orderScreen) orderScreen.style.display = '';
  if (orderTrack) orderTrack.style.display = 'none';
  showModal('modal-order');
};

// ─── ORDER COUNTDOWN TIMER ─────────────────────────────────
let orderTimer = null;
let orderSeconds = 480;

function startOrderCountdown() {
  orderSeconds = 480;
  updateCountdownDisplay();
  clearInterval(orderTimer);
  orderTimer = setInterval(() => {
    orderSeconds--;
    if (orderSeconds <= 0) {
      clearInterval(orderTimer);
      // Step 3 — ready
      markOrderStep(3);
      showToast('success', 'Order Ready!', 'Collect at Express Window 3 now 🎉');
      return;
    }
    if (orderSeconds === 300) markOrderStep(2);
    updateCountdownDisplay();
  }, 1000);
}

function updateCountdownDisplay() {
  const m = Math.floor(orderSeconds / 60);
  const s = orderSeconds % 60;
  const el = $('order-countdown');
  if (el) el.textContent = `${m}:${s.toString().padStart(2, '0')}`;
}

function markOrderStep(step) {
  for (let i = 1; i <= step; i++) {
    const el = $(`ostep-${i}`);
    if (el) {
      el.classList.remove('active');
      el.classList.add('done');
    }
  }
  if (step < 3) {
    const next = $(`ostep-${step + 1}`);
    if (next) next.classList.add('active');
  }
}

window.resetOrder = function () {
  clearInterval(orderTimer);
  orderQty.fill(0);
  currentMenuCat = 'all';
  document.querySelectorAll('.order-cat-tab').forEach((b, i) => b.classList.toggle('active', i === 0));
  const orderScreen = $('order-screen');
  const orderTrack = $('order-tracking');
  if (orderScreen) orderScreen.style.display = '';
  if (orderTrack) orderTrack.style.display = 'none';
  // Reset steps
  ['ostep-1', 'ostep-2', 'ostep-3'].forEach(id => {
    const el = $(id);
    if (el) { el.classList.remove('active', 'done'); }
  });
  const s1 = $('ostep-1'); if (s1) s1.classList.add('active');
  updateCartBadge();
  renderMenuItems();
};

// Override renderMenuItems to support categories
window.renderMenuItems = function () {
  const grid = $('menu-items');
  if (!grid) return;
  grid.innerHTML = '';
  const visible = MENU_ITEMS.filter((m, i) => {
    if (currentMenuCat === 'all') return true;
    return MENU_CATEGORIES[currentMenuCat] && MENU_CATEGORIES[currentMenuCat].includes(i);
  });
  if (visible.length === 0) {
    grid.innerHTML = '<div class="feed-empty">No items in this category</div>';
    return;
  }
  MENU_ITEMS.forEach((m, i) => {
    const inCat = currentMenuCat === 'all' || (MENU_CATEGORIES[currentMenuCat] && MENU_CATEGORIES[currentMenuCat].includes(i));
    if (!inCat) return;
    const item = DOM.el('div', { class: 'menu-item' });
    item.innerHTML = `
      <span class="menu-emoji" aria-hidden="true">${m.emoji}</span>
      <div class="menu-info">
        <div class="menu-name">${DOM.sanitise(m.name)}</div>
        <div class="menu-price">£${m.price.toFixed(2)}</div>
      </div>
      <div class="menu-qty" role="group" aria-label="Quantity for ${DOM.sanitise(m.name)}">
        <button class="qty-btn" aria-label="Decrease">−</button>
        <span class="qty-val" id="qty-${i}">${orderQty[i]}</span>
        <button class="qty-btn" aria-label="Increase">+</button>
      </div>`;
    const [dec, inc] = item.querySelectorAll('.qty-btn');
    dec.addEventListener('click', () => { changeQty(i, -1); updateCartBadge(); });
    inc.addEventListener('click', () => { changeQty(i, +1); updateCartBadge(); });
    grid.appendChild(item);
  });
  calcTotal();
};

function updateCartBadge() {
  const total = orderQty.reduce((s, q) => s + q, 0);
  const badge = $('cart-badge');
  if (!badge) return;
  if (total > 0) {
    badge.style.display = 'flex';
    badge.textContent = total;
  } else {
    badge.style.display = 'none';
  }
}

// Override placeOrder to show tracking screen
window.placeOrder = function () {
  if (orderQty.every(q => q === 0)) {
    showToast('info', 'No items selected', 'Add at least one item to your order');
    return;
  }
  const ref = Math.floor(Math.random() * 90000 + 10000);
  const refEl = $('order-ref');
  if (refEl) refEl.textContent = ref;

  const orderScreen = $('order-screen');
  const orderTrack = $('order-tracking');
  if (orderScreen) orderScreen.style.display = 'none';
  if (orderTrack) orderTrack.style.display = '';

  orderQty.fill(0);
  updateCartBadge();
  startOrderCountdown();
  showToast('success', 'Order Placed!', `Ref #${ref} — Ready in ~8 min`);
};

// ─── SOS MODAL ────────────────────────────────────────────
let sosHoldTimer = null;
let sosHoldEl = null;

window.openSosModal = function () {
  const screen = $('sos-screen');
  const confirmed = $('sos-confirmed');
  if (screen) screen.style.display = '';
  if (confirmed) confirmed.style.display = 'none';
  showModal('modal-sos');
};

window.startSosHold = function (btn) {
  if (!sosRateLimit.check()) {
    showToast('error', 'Rate Limit', 'Please wait 30s before sending another SOS');
    return;
  }
  sosHoldEl = btn;
  btn.classList.add('holding');
  const fill = btn.querySelector('.sos-hold-fill');
  if (fill) {
    fill.style.transition = 'width 2s linear';
    fill.style.width = '100%';
  }
  sosHoldTimer = setTimeout(() => {
    triggerSOS(btn.dataset.type);
  }, 2000);
};

window.cancelSosHold = function () {
  clearTimeout(sosHoldTimer);
  if (sosHoldEl) {
    sosHoldEl.classList.remove('holding');
    const fill = sosHoldEl.querySelector('.sos-hold-fill');
    if (fill) {
      fill.style.transition = 'width .25s linear';
      fill.style.width = '0%';
    }
    sosHoldEl = null;
  }
};

function triggerSOS(type) {
  const safeType = DOM.sanitise(type);
  const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  INCIDENTS.unshift({ type: 'open', title: `SOS — ${safeType}`, loc: 'Section 114, Row J, Seat 12', time });
  renderIncidents();

  // Show confirmed screen
  const screen = $('sos-screen');
  const confirmed = $('sos-confirmed');
  const typeLabel = $('sos-type-label');
  const refNum = $('sos-ref-num');
  if (screen) screen.style.display = 'none';
  if (confirmed) confirmed.style.display = '';
  if (typeLabel) typeLabel.textContent = safeType;
  if (refNum) refNum.textContent = Math.floor(Math.random() * 90000 + 10000);

  // ETA countdown
  startSosEtaCountdown();
  showToast('success', 'Help Is On The Way', `${safeType} · ETA ~2 min`);
}

let sosEtaTimer = null;
function startSosEtaCountdown() {
  let secs = 120;
  const el = $('sos-eta');
  clearInterval(sosEtaTimer);
  sosEtaTimer = setInterval(() => {
    secs--;
    if (secs <= 0) { clearInterval(sosEtaTimer); if (el) el.textContent = '0:00'; return; }
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    if (el) el.textContent = `${m}:${s.toString().padStart(2, '0')}`;
  }, 1000);
}

window.closeSosConfirmed = function () {
  clearInterval(sosEtaTimer);
  closeModal('modal-sos');
};

// ─── NAVIGATION MODAL ────────────────────────────────────
const NAV_DESTINATIONS = [
  {
    dest: 'Nearest Restrooms (Block C)', dist: '1 min · 45 m', crowd: 'c-low', steps: [
      { dir: 'Exit Row J towards concourse', dist: '30 m', icon: '↑' },
      { dir: 'Turn left at Block C sign', dist: '10 m', icon: '←' },
      { dir: 'Restrooms on your right', dist: '5 m', icon: '📍' },
    ]
  },
  {
    dest: 'Express Collection Window 3', dist: '3 min · 120 m', crowd: 'c-low', steps: [
      { dir: 'Head towards North Concourse', dist: '60 m', icon: '↑' },
      { dir: 'Pass Gate B — keep left', dist: '40 m', icon: '←' },
      { dir: 'Window 3 — glass front', dist: '20 m', icon: '📍' },
    ]
  },
  {
    dest: 'First Aid Bay (West)', dist: '4 min · 180 m', crowd: 'c-low', steps: [
      { dir: 'Exit section via Stairwell W', dist: '80 m', icon: '↑' },
      { dir: 'Continue past Gate G', dist: '60 m', icon: '→' },
      { dir: 'First Aid — blue cross sign', dist: '40 m', icon: '📍' },
    ]
  },
  {
    dest: 'Exit Gate S1 (Recommended)', dist: '6 min · 250 m', crowd: 'c-med', steps: [
      { dir: 'Head south along concourse', dist: '100 m', icon: '↑' },
      { dir: 'Follow green exit signs', dist: '100 m', icon: '↑' },
      { dir: 'Gate S1 — clear route', dist: '50 m', icon: '📍' },
    ]
  },
  {
    dest: 'Shuttle Bus Stop B', dist: '8 min · 340 m', crowd: 'c-high', steps: [
      { dir: 'Exit via Gate F (South)', dist: '150 m', icon: '↑' },
      { dir: 'Cross car park — marked path', dist: '120 m', icon: '→' },
      { dir: 'Bus Stop B — blue shelter', dist: '70 m', icon: '📍' },
    ]
  },
  {
    dest: 'Car Park Lot C', dist: '10 min · 420 m', crowd: 'c-med', steps: [
      { dir: 'Exit Gate E (South-East)', dist: '180 m', icon: '↑' },
      { dir: 'Follow yellow Lot C signs', dist: '160 m', icon: '→' },
      { dir: 'Lot C entrance — barriers', dist: '80 m', icon: '📍' },
    ]
  },
];

let currentNavDest = null;
let navStepIndex = 0;
let navStepTimer = null;
let allNavDests = [...NAV_DESTINATIONS];

window.openNavModal = function () {
  stopNavigation();
  allNavDests = [...NAV_DESTINATIONS];
  showModal('modal-nav');
  renderNavList();
};

window.filterNavDests = function (query) {
  const q = query.toLowerCase();
  allNavDests = NAV_DESTINATIONS.filter(n => n.dest.toLowerCase().includes(q));
  renderNavList();
};

// Override renderNavList with enhanced version
window.renderNavList = function () {
  const el = $('nav-list');
  if (!el) return;
  el.innerHTML = '';
  (allNavDests.length ? allNavDests : NAV_DESTINATIONS).forEach(n => {
    const item = DOM.el('div', { class: 'nav-item', role: 'listitem' });
    const crowdColor = n.crowd === 'c-low' ? '#22c55e' : n.crowd === 'c-med' ? '#f59e0b' : '#ef4444';
    item.innerHTML = `
      <div class="nav-icon-wrap">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
      </div>
      <div class="nav-body">
        <div class="nav-dest">${DOM.sanitise(n.dest)}</div>
        <div class="nav-dist">${DOM.sanitise(n.dist)}</div>
      </div>
      <span class="crowd-tag ${n.crowd}">${CROWD_LABELS[n.crowd]}</span>
      <button class="nav-go-btn" style="background:linear-gradient(135deg,#3b82f6,#06b6d4);color:#fff;border:none;border-radius:8px;padding:.28rem .65rem;font-size:.68rem;font-weight:700;cursor:pointer;margin-left:.35rem">Go →</button>`;
    item.querySelector('.nav-go-btn').addEventListener('click', () => startNavigation(n));
    el.appendChild(item);
  });
};

function startNavigation(dest) {
  currentNavDest = dest;
  navStepIndex = 0;
  clearInterval(navStepTimer);

  $('nav-picker').style.display = 'none';
  $('nav-active').style.display = '';

  const destLabel = $('nav-dest-label');
  const eta = $('nav-eta');
  if (destLabel) destLabel.textContent = dest.dest;
  if (eta) eta.textContent = dest.dist.split('·')[0].trim() + ' away';

  drawNavMap(dest);
  renderNavSteps(dest.steps);

  // Auto-advance steps
  navStepTimer = setInterval(() => {
    if (navStepIndex < dest.steps.length - 1) {
      navStepIndex++;
      renderNavSteps(dest.steps);
    } else {
      clearInterval(navStepTimer);
      showToast('success', 'Arrived!', `You have reached: ${dest.dest}`);
      const arrive = $('nav-arrive-info');
      if (arrive) arrive.textContent = `✅ You've arrived at: ${dest.dest}`;
    }
  }, 5000);
}

function renderNavSteps(steps) {
  const list = $('nav-steps-list');
  if (!list) return;
  list.innerHTML = '';
  steps.forEach((s, i) => {
    const cls = i < navStepIndex ? 'nav-step done-step' : i === navStepIndex ? 'nav-step active-step' : 'nav-step';
    const div = DOM.el('div', { class: cls });
    div.innerHTML = `
      <div class="nav-step-num">${i < navStepIndex ? '✓' : i + 1}</div>
      <div class="nav-step-body">
        <div class="nav-step-dir">${DOM.sanitise(s.dir)}</div>
        <div class="nav-step-dist">${DOM.sanitise(s.dist)}</div>
      </div>
      <div class="nav-step-icon">${s.icon}</div>`;
    list.appendChild(div);
  });
}

function drawNavMap(dest) {
  const canvas = $('nav-map-canvas');
  if (!canvas) return;
  const W = 460, H = 140;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#060a12';
  ctx.fillRect(0, 0, W, H);

  // Corridor grid
  ctx.strokeStyle = 'rgba(40,75,140,.2)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 35) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // Route path (animated dashes)
  const steps = dest.steps;
  const pts = steps.map((s, i) => ({
    x: 40 + (i / (steps.length)) * (W - 80),
    y: H / 2 + Math.sin(i * 1.2) * 30
  }));
  pts.unshift({ x: 30, y: H / 2 });

  // Draw path
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 3;
  ctx.setLineDash([8, 5]);
  ctx.lineDashOffset = -(Date.now() / 60) % 13;
  ctx.beginPath();
  pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.stroke();
  ctx.setLineDash([]);

  // Step dots
  pts.slice(1).forEach((p, i) => {
    ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = i < navStepIndex ? '#22c55e' : i === navStepIndex ? '#3b82f6' : 'rgba(59,130,246,.3)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.3)'; ctx.lineWidth = 1; ctx.stroke();
  });

  // You-are-here
  const you = pts[navStepIndex];
  ctx.beginPath(); ctx.arc(you.x, you.y, 9, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(59,130,246,.25)'; ctx.fill();
  ctx.beginPath(); ctx.arc(you.x, you.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#3b82f6'; ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
}

window.stopNavigation = function () {
  clearInterval(navStepTimer);
  const picker = $('nav-picker');
  const active = $('nav-active');
  if (picker) picker.style.display = '';
  if (active) active.style.display = 'none';
  const arr = $('nav-arrive-info');
  if (arr) arr.textContent = '';
  const search = $('nav-dest-search');
  if (search) search.value = '';
  allNavDests = [...NAV_DESTINATIONS];
};

// Quick navigate from wait times
window.quickNavTo = function (destName) {
  closeModal('modal-wait');
  const dest = NAV_DESTINATIONS.find(n => n.dest.toLowerCase().includes(destName.toLowerCase()));
  openNavModal();
  if (dest) setTimeout(() => startNavigation(dest), 400);
};

// ─── WAIT TIMES MODAL ────────────────────────────────────
let waitSortMode = 'time';
let waitCountdownSecs = 10;
let waitCountdownTimer = null;

window.openWaitModal = function () {
  showModal('modal-wait');
  renderWaitList();
  startWaitCountdown();
};

window.sortWait = function (mode, btn) {
  document.querySelectorAll('.wait-sort-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  waitSortMode = mode;
  renderWaitList();
};

// Override renderWaitList with enhanced version
window.renderWaitList = function () {
  const el = $('wait-list');
  if (!el) return;
  el.innerHTML = '';

  let items = [...WAIT_ITEMS];
  if (waitSortMode === 'time') items.sort((a, b) => a.pct - b.pct);
  else items.sort((a, b) => a.name.localeCompare(b.name));

  const bestItem = [...WAIT_ITEMS].sort((a, b) => a.pct - b.pct)[0];

  items.forEach(w => {
    const isBest = w.name === bestItem.name;
    const item = DOM.el('div', { class: `wait-item${isBest ? ' best-pick' : ''}`, role: 'listitem' });
    item.innerHTML = `
      ${isBest ? '<span class="best-pick-badge">Best</span>' : ''}
      <div class="nav-icon-wrap">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/></svg>
      </div>
      <div class="wait-body">
        <div class="wait-name">${DOM.sanitise(w.name)}</div>
        <div class="wait-time">${DOM.sanitise(w.time)}</div>
      </div>
      <div class="wait-bar-outer">
        <div class="wait-bar-bg"><div class="wait-bar-fill ${w.cls}" style="width:${w.pct}%"></div></div>
      </div>`;
    el.appendChild(item);
  });

  // Update AI tip
  const aiText = $('wait-ai-text');
  if (aiText) aiText.textContent = `${bestItem.name} — only ${bestItem.time} wait right now`;
};

function startWaitCountdown() {
  clearInterval(waitCountdownTimer);
  waitCountdownSecs = 10;
  const el = $('wait-countdown');
  if (el) el.textContent = waitCountdownSecs;
  waitCountdownTimer = setInterval(() => {
    waitCountdownSecs--;
    if (el) el.textContent = waitCountdownSecs;
    if (waitCountdownSecs <= 0) {
      // Nudge wait times
      WAIT_ITEMS.forEach(w => {
        const delta = Math.floor((Math.random() - .4) * 8);
        w.pct = Math.max(5, Math.min(99, w.pct + delta));
        const mins = Math.max(1, Math.round(w.pct / 4));
        w.time = `${mins} min`;
        w.cls = w.pct > 70 ? 'wb-red' : w.pct > 40 ? 'wb-amber' : 'wb-green';
      });
      renderWaitList();
      waitCountdownSecs = 10;
    }
  }, 1000);
}

// Stop wait countdown when modal closes
const origCloseModal = window.closeModal;
window.closeModal = function (id) {
  origCloseModal(id);
  if (id === 'modal-wait') { clearInterval(waitCountdownTimer); }
  if (id === 'modal-nav') { stopNavigation(); }
  if (id === 'modal-sos') {
    cancelSosHold();
    const screen = $('sos-screen');
    const confirmed = $('sos-confirmed');
    if (screen) screen.style.display = '';
    if (confirmed) confirmed.style.display = 'none';
  }
  if (id === 'modal-feedback') {
    const form = $('fb-form');
    const succ = $('fb-success');
    if (form) form.style.display = '';
    if (succ) succ.style.display = 'none';
  }
};

// ─── FEEDBACK MODAL ─────────────────────────────────────
window.openFeedbackModal = function () {
  const form = $('fb-form');
  const succ = $('fb-success');
  if (form) form.style.display = '';
  if (succ) succ.style.display = 'none';
  showModal('modal-feedback');
};

// Override submitFeedback with success screen
window.submitFeedback = function () {
  if (fbRating === 0) {
    showToast('error', 'Rating Required', 'Please select a star rating first');
    return;
  }
  const form = $('fb-form');
  const succ = $('fb-success');
  if (form) form.style.display = 'none';
  if (succ) succ.style.display = '';

  // Animate SVG
  setTimeout(() => {
    const circle = document.querySelector('.fb-check-circle');
    const tick = document.querySelector('.fb-check-tick');
    if (circle) circle.style.strokeDashoffset = '0';
    if (tick) tick.style.strokeDashoffset = '0';
  }, 50);

  // Confetti
  spawnConfetti();

  // Reset state in background
  fbRating = 0;
  document.querySelectorAll('.star-btn').forEach(s => s.style.color = 'var(--text-muted)');
  const fbTextEl = $('fb-rating-text');
  if (fbTextEl) fbTextEl.textContent = 'Tap a star to rate';
  document.querySelectorAll('.fb-cat').forEach(c => c.classList.remove('selected'));
  const comment = $('fb-comment');
  if (comment) comment.value = '';
};

function spawnConfetti() {
  const container = $('fb-confetti');
  if (!container) return;
  container.innerHTML = '';
  const colors = ['#3b82f6', '#06b6d4', '#22c55e', '#f59e0b', '#a855f7', '#ef4444'];
  for (let i = 0; i < 18; i++) {
    const dot = document.createElement('div');
    const size = Math.random() * 6 + 4;
    const angle = (i / 18) * 360;
    const dist = 40 + Math.random() * 30;
    dot.style.cssText = `
      position:absolute; width:${size}px; height:${size}px;
      border-radius:${Math.random() > .5 ? '50%' : '2px'};
      background:${colors[i % colors.length]};
      left:50%; top:50%;
      transform:translate(-50%,-50%);
      animation:confetti-fly .7s ease forwards;
      animation-delay:${i * 0.03}s;
      --tx:${Math.cos(angle * Math.PI / 180) * dist}px;
      --ty:${Math.sin(angle * Math.PI / 180) * dist}px;
    `;
    container.appendChild(dot);
  }
}

// Add confetti keyframe dynamically
(function () {
  const style = document.createElement('style');
  style.textContent = `
    @keyframes confetti-fly {
      0%   { transform: translate(-50%,-50%) scale(1); opacity: 1; }
      100% { transform: translate(calc(-50% + var(--tx)), calc(-50% + var(--ty))) scale(0); opacity: 0; }
    }
    .fb-check-circle { transition: stroke-dashoffset .6s ease; }
    .fb-check-tick   { transition: stroke-dashoffset .4s ease .5s; }
  `;
  document.head.appendChild(style);
})();
// ==========================================
// ATTENDEE MENU TAB SWITCHER LOGIC
// ==========================================
// ATTENDEE INTERNAL TAB FIX (NO HTML CHANGE)
// ==========================================

// switchAttendeeTab: reserved for future in-phone tab use; modal approach is used instead.
window.switchAttendeeTab = function (tabId) {
  // no-op: attendee actions now use full modal overlays
};

// ─────────────────────────────────────────────
// GOOGLE MAPS INTEGRATION
// Real-time crowd heatmap overlay on Google Maps
// ─────────────────────────────────────────────
let googleMap = null;
let heatmapLayer = null;
let trafficLayer = null;
let trafficLayerActive = false;

// Wembley Stadium coordinates (demo venue)
const VENUE_COORDS = { lat: 51.5560, lng: -0.2795 };

// Map the ZONES data to geo-coordinates around Wembley
const ZONE_GEO_OFFSETS = [
  { id: 'N1', latOff: 0.0045, lngOff: -0.005 },
  { id: 'N2', latOff: 0.0045, lngOff: 0.002 },
  { id: 'E1', latOff: 0.0010, lngOff: 0.0085 },
  { id: 'E2', latOff: -0.0020, lngOff: 0.0090 },
  { id: 'S1', latOff: -0.0050, lngOff: -0.003 },
  { id: 'S2', latOff: -0.0050, lngOff: 0.002 },
  { id: 'W1', latOff: -0.0015, lngOff: -0.0090 },
  { id: 'W2', latOff: -0.0030, lngOff: -0.0085 },
  { id: 'C1', latOff: -0.0005, lngOff: -0.0005 },
];

/**
 * Called by Google Maps JS API when it has loaded.
 * Renders a live crowd heatmap overlay on the map.
 */
window.initGoogleMap = function () {
  try {
    const mapEl = document.getElementById('google-map');
    if (!mapEl || typeof google === 'undefined') return;

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

    googleMap = new google.maps.Map(mapEl, {
      center: VENUE_COORDS,
      zoom: 16,
      mapTypeId: google.maps.MapTypeId.ROADMAP,
      styles: isDark ? MAPS_DARK_STYLE : [],
      disableDefaultUI: false,
      zoomControl: true,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
    });

    trafficLayer = new google.maps.TrafficLayer();

    refreshMapHeatmap();

    // Venue marker
    new google.maps.Marker({
      position: VENUE_COORDS,
      map: googleMap,
      title: 'VenueFlow — Wembley Stadium',
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 10,
        fillColor: '#3b82f6',
        fillOpacity: 0.9,
        strokeColor: '#ffffff',
        strokeWeight: 2,
      },
    });

    // Update map every 5 seconds to reflect density changes
    setInterval(refreshMapHeatmap, 5000);

    // Sync theme changes
    document.getElementById('theme-toggle')?.addEventListener('click', () => {
      setTimeout(() => {
        const dark = document.documentElement.getAttribute('data-theme') === 'dark';
        googleMap.setOptions({ styles: dark ? MAPS_DARK_STYLE : [] });
      }, 100);
    });

    const statusEl = document.getElementById('maps-status');
    if (statusEl) statusEl.textContent = '✅ Live crowd heatmap active — Wembley Stadium';

    // Firebase real-time sync (if available)
    initFirebaseSync();

  } catch (err) {
    initGoogleMapFallback();
  }
};

/** Rebuild heatmap layer from current ZONES densities */
function refreshMapHeatmap() {
  if (!googleMap || typeof google === 'undefined') return;

  const heatData = ZONES.map((z, i) => {
    const offset = ZONE_GEO_OFFSETS[i] || { latOff: 0, lngOff: 0 };
    return {
      location: new google.maps.LatLng(
        VENUE_COORDS.lat + offset.latOff,
        VENUE_COORDS.lng + offset.lngOff
      ),
      weight: z.density,
    };
  });

  if (heatmapLayer) {
    heatmapLayer.setData(heatData);
  } else {
    heatmapLayer = new google.maps.visualization.HeatmapLayer({
      data: heatData,
      map: googleMap,
      radius: 60,
      opacity: 0.75,
      gradient: [
        'rgba(0,255,120,0)',
        'rgba(0,255,120,0.6)',
        'rgba(255,200,0,0.8)',
        'rgba(255,100,0,0.9)',
        'rgba(255,30,30,1)',
      ],
    });
  }
}

/** Toggle Google Maps traffic layer on/off */
window.toggleTrafficLayer = function () {
  if (!trafficLayer || !googleMap) return;
  trafficLayerActive = !trafficLayerActive;
  trafficLayer.setMap(trafficLayerActive ? googleMap : null);
  const btn = document.getElementById('btn-traffic-layer');
  if (btn) btn.style.background = trafficLayerActive ? 'var(--accent-blue)' : '';
};

/** Graceful fallback if Google Maps fails to load (CORS / key issue) */
window.initGoogleMapFallback = function () {
  const mapEl = document.getElementById('google-map');
  if (!mapEl) return;
  mapEl.style.display = 'flex';
  mapEl.style.alignItems = 'center';
  mapEl.style.justifyContent = 'center';
  mapEl.style.flexDirection = 'column';
  mapEl.style.gap = '12px';
  mapEl.innerHTML = `
    <div style="font-size:2.5rem;">🗺️</div>
    <div style="color:var(--text-secondary);font-size:.85rem;text-align:center;padding:0 2rem;">
      <strong style="color:var(--text-primary);">Google Maps</strong> requires a valid API key.<br>
      The crowd heatmap overlay is ready — add your key to <code>app.js → GOOGLE_MAPS_KEY</code>.
    </div>
    <div style="font-size:.75rem;color:var(--text-tertiary);">Venue: Wembley Stadium, London · 51.5560°N, 0.2795°W</div>
  `;
  const statusEl = document.getElementById('maps-status');
  if (statusEl) statusEl.textContent = '⚠️ Add Google Maps API key to enable live map';
};

/** Google Maps dark style theme */
const MAPS_DARK_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#1d2433' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#242f3e' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#746855' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#38414e' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#212a37' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#9ca5b3' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#17263c' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#515c6d' }] },
];

// ─────────────────────────────────────────────
// GOOGLE SERVICES MODULE — Places, Directions
// ─────────────────────────────────────────────
let placesService = null;
let placesMarkers = [];
let placesLayerActive = false;

window.toggleNearbyPlaces = function () {
  if (!googleMap) return;
  placesLayerActive = !placesLayerActive;
  const btn = document.getElementById('btn-places-layer');
  if (btn) btn.style.background = placesLayerActive ? 'var(--accent-blue)' : '';

  if (placesLayerActive) {
    if (!placesService) initPlacesService();
    const searchBar = document.querySelector('.places-search-bar');
    if (searchBar) searchBar.style.display = 'flex';
  } else {
    clearPlacesMarkers();
    const searchBar = document.querySelector('.places-search-bar');
    if (searchBar) searchBar.style.display = 'none';
  }
};

function initPlacesService() {
  if (!google.maps.places) return;
  placesService = new google.maps.places.PlacesService(googleMap);
  const input = document.getElementById('places-autocomplete');
  if (input) {
    const autocomplete = new google.maps.places.Autocomplete(input);
    autocomplete.bindTo('bounds', googleMap);
    autocomplete.addListener('place_changed', () => {
      const place = autocomplete.getPlace();
      if (!place.geometry || !place.geometry.location) return;

      clearPlacesMarkers();
      const marker = new google.maps.Marker({
        map: googleMap,
        position: place.geometry.location,
        title: place.name,
      });
      placesMarkers.push(marker);
      googleMap.setCenter(place.geometry.location);
      googleMap.setZoom(17);

      if (window._updateAnalyticsCounter) window._updateAnalyticsCounter('ana-places-queries', 1);
    });
  }

  // Search nearby parking and transit by default
  placesService.nearbySearch({
    location: VENUE_COORDS,
    radius: 1000,
    type: ['parking', 'transit_station']
  }, (results, status) => {
    if (status === google.maps.places.PlacesServiceStatus.OK && results) {
      results.forEach(place => {
        const marker = new google.maps.Marker({
          map: googleMap,
          position: place.geometry.location,
          icon: place.types.includes('parking') ? '🅿️' : '🚉',
          title: place.name
        });
        placesMarkers.push(marker);
      });
      if (window._updateAnalyticsCounter) window._updateAnalyticsCounter('ana-places-queries', results.length);
    }
  });
}

function clearPlacesMarkers() {
  placesMarkers.forEach(m => m.setMap(null));
  placesMarkers = [];
}

// Directions API Integration
let directionsService = null;
let directionsRenderer = null;
let directionsModeActive = false;

window.toggleDirectionsMode = function () {
  if (!googleMap) return;
  directionsModeActive = !directionsModeActive;
  const btn = document.getElementById('btn-directions-mode');
  if (btn) btn.style.background = directionsModeActive ? 'var(--accent-blue)' : '';

  const panel = document.getElementById('directions-panel');
  if (directionsModeActive) {
    if (!directionsService && google.maps.DirectionsService) {
      directionsService = new google.maps.DirectionsService();
      directionsRenderer = new google.maps.DirectionsRenderer({
        map: googleMap,
        panel: document.getElementById('directions-steps'),
        suppressMarkers: false,
      });
    }
    if (panel) panel.style.display = 'flex';
    fetchUserLocationAndRoute();
  } else {
    hideDirections();
  }
};

window.hideDirections = function () {
  directionsModeActive = false;
  const btn = document.getElementById('btn-directions-mode');
  if (btn) btn.style.background = '';
  const panel = document.getElementById('directions-panel');
  if (panel) panel.style.display = 'none';
  if (directionsRenderer) directionsRenderer.setDirections({ routes: [] });
};

function fetchUserLocationAndRoute() {
  if (!directionsService) return;
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(position => {
      const userLoc = new google.maps.LatLng(position.coords.latitude, position.coords.longitude);
      calculateAndDisplayRoute(userLoc);
    }, () => {
      // Fallback: King's Cross Station
      calculateAndDisplayRoute('Wembley Central Station, London');
    });
  } else {
    calculateAndDisplayRoute('Wembley Central Station, London');
  }
}

function calculateAndDisplayRoute(origin) {
  directionsService.route({
    origin: origin,
    destination: VENUE_COORDS,
    travelMode: google.maps.TravelMode.TRANSIT
  }, (response, status) => {
    if (status === 'OK') {
      directionsRenderer.setDirections(response);
      const leg = response.routes[0].legs[0];
      const summary = document.getElementById('directions-summary');
      if (summary) summary.textContent = `${leg.distance.text} · ${leg.duration.text}`;
    } else {
      showToast('error', 'Directions failed', 'Could not compute route.');
    }
  });
}

// ─────────────────────────────────────────────
// FIREBASE: FIRESTORE & FCM NOTIFICATIONS
// ─────────────────────────────────────────────
window._initFirestoreSync = function () {
  if (!window.VF_FIRESTORE) return;
  // Set up listener for real-time incidents over Firestore
  window.VF_FIRESTORE.collection('incidents').where('status', '==', 'open').onSnapshot(snap => {
    snap.docChanges().forEach(change => {
      if (change.type === 'added') {
        const data = change.doc.data();
        showToast('warning', 'New Incident Logged', `${data.type}: ${data.title}`);
      }
    });
    if (window._updateAnalyticsCounter) window._updateAnalyticsCounter('ana-firestore-reads', Math.max(1, snap.size));
  });
};

window._initFCM = function () {
  if (!window.VF_MESSAGING) return;
  const messaging = window.VF_MESSAGING;

  if (Notification && Notification.permission !== 'granted') {
    Notification.requestPermission().then(permission => {
      if (permission === 'granted') {
        _getFCMToken(messaging);
      }
    });
  } else if (Notification && Notification.permission === 'granted') {
    _getFCMToken(messaging);
  }
};

function _getFCMToken(messaging) {
  messaging.getToken({ vapidKey: 'BPlaceholderKeyForVAPIDFCMVenueFlow123' })
    .then(token => {
      if (window.VF_FIREBASE) {
        window.VF_FIREBASE.ref(`fcm_tokens/${token.slice(-12)}`).set({
          venue: 'wembley',
          ts: Date.now(),
        });
      }
    }).catch(err => console.log('FCM token missing', err));

  messaging.onMessage(payload => {
    const notification = payload.notification || {};
    showToast('info', notification.title || 'VenueFlow', notification.body || '');
    const badge = document.getElementById('notif-badge');
    if (badge) {
      badge.style.display = 'flex';
      badge.textContent = (parseInt(badge.textContent, 10) || 0) + 1;
    }
  });
}

// ─────────────────────────────────────────────
// FIREBASE REALTIME DATABASE SYNC
// Pushes live zone density data for attendee apps
// ─────────────────────────────────────────────
function initFirebaseSync() {
  if (!window.VF_FIREBASE) return; // offline / demo mode
  try {
    const db = window.VF_FIREBASE;
    // Push initial zone snapshot
    pushZonesToFirebase(db);
    // Keep pushing every 5s in sync with simulation
    setInterval(() => pushZonesToFirebase(db), 5000);
    showToast('success', 'Firebase Connected', 'Real-time crowd sync active for attendee devices');
  } catch (e) {
    // Firebase unavailable — silent degradation
  }
}

function pushZonesToFirebase(db) {
  try {
    const snapshot = {};
    ZONES.forEach(z => {
      snapshot[z.id] = {
        name: z.name,
        density: Math.round(z.density * 100),
        wait: z.wait,
        status: z.density > .75 ? 'critical' : z.density > .5 ? 'warning' : 'clear',
        ts: Date.now(),
      };
    });
    db.ref('venues/wembley/zones').set(snapshot);
  } catch (e) { /* offline */ }
}


// ───────────────
// FIREBASE: ANALYTICS & PERFORMANCE
// ───────────────
function _initAnalyticsAndPerf() {
  // Exposed tracking for the rest of the application
  window._logAnalyticsEvent = function (eventName, eventParams = {}) {
    if (window.VF_ANALYTICS) {
      window.VF_ANALYTICS.logEvent(eventName, eventParams);
    }
  };

  window._updateAnalyticsCounter = function (elementId, incrementValue) {
    const el = document.getElementById(elementId);
    if (el) {
      const current = parseInt(el.textContent.replace(/,/g, ''), 10) || 0;
      el.textContent = (current + incrementValue).toLocaleString();
    }
  };

  window._createPerfTrace = function (traceName) {
    if (window.VF_PERF) {
      return window.VF_PERF.trace(traceName);
    }
    return { start: () => { }, stop: () => { }, putAttribute: () => { } };
  };

  // Setup unhandled error tracking
  window.addEventListener('error', function (event) {
    window._logAnalyticsEvent('exception', {
      description: event.message,
      fatal: true
    });
  });

  // Track initial page load performance
  if (window.performance) {
    const pageLoadTrace = window._createPerfTrace('page_load_timing');
    pageLoadTrace.start();
    window.addEventListener('load', () => {
      setTimeout(() => {
        const perfData = window.performance.timing;
        const pageLoadTime = perfData.loadEventEnd - perfData.navigationStart;
        pageLoadTrace.putAttribute('load_time_ms', pageLoadTime.toString());
        pageLoadTrace.stop();

        // Update performance metric on dashboard
        const perfEl = document.getElementById('ana-perf-score');
        if (perfEl) perfEl.textContent = pageLoadTime + 'ms';
      }, 0);
    });
  }
}

// ─────────────────────────────────────────────────────────────────
// INITIALIZE ALL EXTENDED SERVICES
// ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Initialize Firebase extensions
  _initFirestoreSync();
  _initFCM();
  _initAnalyticsAndPerf();

  // Attach click listener for FCM requests to Attendee bell icon
  const notifBtn = document.getElementById('fcm-notif-btn');
  if (notifBtn) {
    notifBtn.addEventListener('click', () => {
      if (Notification.permission === 'default') {
        _initFCM();
      }
    });
  }

  // Set up mock auth users count update
  setInterval(() => {
    window._updateAnalyticsCounter('ana-auth-users', Math.floor(Math.random() * 3));
    window._updateAnalyticsCounter('ana-active-users', Math.floor(Math.random() * 5) - 2);
  }, 15000);
});
