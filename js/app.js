// app.js — FMDN Finder UI controller. Pure client-side; no network requests.
import {
  fmdnFromServiceData, distanceMeters, formatDistance, shortUuid, parseDultReply,
  classify, rssiToPercent, selectTarget, capSeenLog, DULT_SERVICE, DULT_CONTROL,
  INSPECT_SERVICES, DULT_READS, DULT_SOUND_START, DULT_SOUND_STOP,
} from './fmdn.js';

const REPO_URL = 'https://github.com/grappeq/fmdn-finder';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- persistence (localStorage only; nothing leaves the device) ---------- */
const store = {
  load(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
  save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};
let names = store.load('fmdnNames', {});            // id -> name
let seenLog = store.load('fmdnSeen', {});           // id -> {ts,rssi,state}
let settings = Object.assign({ ref: -59, ple: 2.5 }, store.load('fmdnSettings', {}));
const saveNames = () => store.save('fmdnNames', names);
const saveSeen = () => store.save('fmdnSeen', seenLog);
const saveSettings = () => store.save('fmdnSettings', settings);
const MAX_UNNAMED_SEEN = 12; // rotating addresses pile up; keep history bounded
function pruneSeen() { seenLog = capSeenLog(seenLog, names, MAX_UNNAMED_SEEN); }
const persistSeen = () => { pruneSeen(); saveSeen(); };

/* ---------- state ---------- */
let scan = null, mode = 'normal', lockedId = null, audioCtx = null;
const tags = new Map();   // id -> {id,name,state,ema,rssi,last,hist,device}
let advCount = 0, sdCount = 0, feaaCount = 0, lastSvc = '', saveTick = 0;

/* ---------- small helpers ---------- */
const nameFor = (id) => names[id];
function setStatus(t, cls) { const c = $('status'); c.textContent = t; c.className = 'chip' + (cls ? ' ' + cls : ''); }
function showErr(t) { $('err').textContent = t || ''; }
function relTime(ts) { const s = (Date.now() - ts) / 1000;
  if (s < 60) return Math.round(s) + 's ago'; if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago'; return Math.round(s / 86400) + 'd ago'; }
const MODAL_IDS = ['inputModal', 'confirmModal', 'inspectModal', 'settingsModal', 'aboutModal'];
const anyModalOpen = () => MODAL_IDS.some((id) => !$(id).hidden);

/* ---------- modals (non-blocking; never suspend the scan) ---------- */
function openInput(title, val, onSave) {
  $('inputTitle').textContent = title; $('inputField').value = val || '';
  $('inputModal').hidden = false; setTimeout(() => $('inputField').focus(), 40);
  $('inputOk').onclick = () => { $('inputModal').hidden = true; onSave($('inputField').value); };
  $('inputCancel').onclick = () => { $('inputModal').hidden = true; };
}
function confirmDo(title, body, onOk) {
  $('confirmTitle').textContent = title; $('confirmBody').textContent = body || '';
  $('confirmModal').hidden = false;
  $('confirmOk').onclick = () => { $('confirmModal').hidden = true; onOk(); };
  $('confirmCancel').onclick = () => { $('confirmModal').hidden = true; };
}
function rename(id) {
  openInput('Name this tag', names[id] || '', (v) => {
    const t = v.trim(); if (t) names[id] = t; else delete names[id];
    saveNames(); renderList();
  });
}

/* ---------- scanning ---------- */
function note(id, rssi, state, name, device) {
  const now = performance.now();
  let t = tags.get(id);
  if (!t) { t = { id, name, state, ema: rssi, rssi, last: now, hist: [], device }; tags.set(id, t); }
  t.rssi = rssi; t.state = state; t.last = now; if (device) t.device = device;
  t.ema = t.ema == null ? rssi : t.ema * 0.7 + rssi * 0.3;
  t.hist.push({ t: now, v: t.ema }); if (t.hist.length > 40) t.hist.shift();
  seenLog[id] = { ts: Date.now(), rssi, state };
}
function prune() { const now = performance.now(); for (const [id, t] of tags) if (now - t.last > 8000) tags.delete(id); }
function pickTarget() {
  prune();
  return selectTarget(tags, mode, lockedId);
}
function onAdv(ev) {
  advCount++;
  const sd = ev.serviceData; let uuids = [];
  if (sd && sd.size) { sdCount++; sd.forEach((_, k) => uuids.push(shortUuid(k))); lastSvc = uuids.join(','); }
  const f = fmdnFromServiceData(sd);
  if (f) { feaaCount++; note(ev.device.id, ev.rssi, f.state, ev.device.name, ev.device); }
  if (advCount % 5 === 0 || f) updateDbg();
}
function updateDbg() {
  $('dbg').textContent = `debug — adverts:${advCount} · serviceData:${sdCount} · FEAA:${feaaCount} · last:[${lastSvc || '—'}]`;
}
function ensureAudio() {
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* no audio */ } }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}
async function startScan() {
  showErr('');
  if (scan) return;                                  // already scanning — ignore re-clicks
  if (!navigator.bluetooth || !navigator.bluetooth.requestLEScan) {
    showErr('Live scanning isn’t available — see the banner / About for how to enable it.');
    openAbout(); return;
  }
  try {
    if ($('beep').checked) ensureAudio();
    navigator.vibrate && navigator.vibrate(10);
    advCount = sdCount = feaaCount = 0; lastSvc = '';
    scan = await navigator.bluetooth.requestLEScan({ acceptAllAdvertisements: true, keepRepeatedDevices: true });
    setStatus('scanning', 'on');
    navigator.bluetooth.addEventListener('advertisementreceived', onAdv);
    updateDbg();
  } catch (e) { showErr('Scan error: ' + e.message); setStatus('error', 'err'); }
}
function stopScan() {
  try { scan && scan.stop(); } catch { /* ignore */ }
  navigator.bluetooth && navigator.bluetooth.removeEventListener('advertisementreceived', onAdv);
  scan = null; setStatus('idle'); persistSeen();
}

/* ---------- feedback ---------- */
let lastVib = 0, lastBeep = 0;
function feedback(t) {
  const now = performance.now(), r = t.ema;
  const interval = Math.max(120, Math.min(1200, 1200 - (r + 95) * 16));
  if ($('vib').checked && navigator.vibrate && now - lastVib > interval) { navigator.vibrate(20); lastVib = now; }
  if ($('beep').checked && audioCtx && now - lastBeep > interval) {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 440 + Math.max(0, r + 95) * 30; g.gain.value = 0.06;
    o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.05); lastBeep = now;
  }
}
function trendArrow(t) {
  if (!t || t.hist.length < 6) return '';
  const old = t.hist[Math.max(0, t.hist.length - 12)].v, d = t.ema - old;
  return d > 3 ? '🔥 warmer' : d < -3 ? '❄️ colder' : '· steady';
}
const fillColor = (r) => (r > -60 ? 'var(--hot)' : r > -75 ? 'var(--warm)' : 'var(--cold)');

/* ---------- rendering ---------- */
function makeRow(t, recent) {
  const div = document.createElement('div'); div.className = 'row';
  const left = document.createElement('div'); left.className = 'left';
  const pill = document.createElement('span'); pill.className = 'pill ' + t.state; pill.textContent = t.state;
  const label = document.createElement('span');
  const nm = nameFor(t.id);
  if (nm) { label.className = 'nm'; label.textContent = nm; }
  else { label.className = 'id'; label.textContent = t.id.slice(0, 8); }
  left.append(pill, label);
  const rt = document.createElement('div'); rt.className = 'rt';
  if (recent) { const ago = document.createElement('span'); ago.className = 'small'; ago.textContent = relTime(t.ts); rt.append(ago); }
  const dbm = document.createElement('b'); dbm.textContent = (recent ? t.rssi : Math.round(t.ema)) + ' dBm';
  const ren = document.createElement('button'); ren.className = 'iconbtn'; ren.textContent = '✎';
  ren.setAttribute('aria-label', 'Rename tag'); ren.title = 'Rename';
  ren.addEventListener('click', (e) => { e.stopPropagation(); rename(t.id); });
  rt.append(dbm, ren);
  div.append(left, rt);
  return div;
}
function renderList(targetId = (pickTarget() || {}).id) {
  const live = [...tags.values()].sort((a, b) => b.ema - a.ema);
  $('liveCount').textContent = live.length ? `(${live.length})` : '';
  const L = $('list'); L.replaceChildren();
  if (!live.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = '— none in range —'; L.append(e); }
  for (const t of live) {
    const row = makeRow(t, false); if (t.id === targetId) row.classList.add('sel');
    row.addEventListener('click', () => { if (mode === 'manual') lockedId = t.id; });
    L.append(row);
  }
  const liveIds = new Set(tags.keys());
  const rec = Object.entries(seenLog).filter(([id]) => !liveIds.has(id))
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => ((names[b.id] ? 1 : 0) - (names[a.id] ? 1 : 0)) || b.ts - a.ts).slice(0, 12);
  const R = $('recent'); R.replaceChildren();
  if (!rec.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = '— none yet —'; R.append(e); }
  for (const t of rec) {
    const row = makeRow(t, true);
    row.addEventListener('click', () => { mode = 'manual'; lockedId = t.id; syncSeg(); });
    R.append(row);
  }
}
function syncSeg() { [...$('modeSeg').children].forEach((b) => b.classList.toggle('on', b.dataset.mode === mode)); }

function updateGauge(t) {
  if (t) {
    $('tname').textContent = nameFor(t.id) || ('id ' + t.id.slice(0, 8));
    $('dist').textContent = formatDistance(distanceMeters(t.ema, settings.ref, settings.ple));
    $('rssi').textContent = Math.round(t.ema);
    const fill = $('fill'); fill.style.width = rssiToPercent(t.ema) + '%'; fill.style.background = fillColor(t.ema);
    $('trend').textContent = trendArrow(t);
    $('targetMeta').textContent = `${t.state} · raw ${t.rssi} dBm · id ${t.id.slice(0, 8)}`;
    if (!anyModalOpen()) feedback(t);                 // no buzzing while a sheet is open
  } else {
    $('rssi').textContent = '--'; $('fill').style.width = '0'; $('trend').textContent = ''; $('dist').textContent = '';
    $('tname').textContent = (mode === 'manual' && lockedId) ? (nameFor(lockedId) || 'locked') : '—';
    $('targetMeta').textContent = (mode === 'manual' && lockedId) ? 'locked — waiting for it to come in range' : 'no target in range';
  }
}

let frame = 0;
function loop() {
  const t = pickTarget();
  updateGauge(t);                                    // gauge stays smooth (~8/s)
  if (frame % 4 === 0) renderList(t ? t.id : null);  // lists rebuild less often (~2/s)
  if (++saveTick % 40 === 0) persistSeen();
  frame++;
  requestAnimationFrame(() => setTimeout(loop, 120));
}

/* ---------- calibrate & settings ---------- */
$('calBtn').addEventListener('click', () => {
  const t = pickTarget();
  if (!t) { showErr('Lock a target first, stand ~1 m from it, then calibrate.'); return; }
  settings.ref = Math.round(t.ema); saveSettings(); showErr('');
  const prev = $('status').textContent, prevCls = scan ? 'on' : '';
  setStatus(`✓ ${settings.ref} dBm = 1 m`, 'on'); setTimeout(() => setStatus(prev, prevCls), 1800);
});
function openSettings() {
  $('setRef').value = settings.ref; $('setRefOut').textContent = settings.ref + ' dBm';
  $('setPle').value = Math.round(settings.ple * 10); $('setPleOut').textContent = settings.ple.toFixed(1);
  $('settingsModal').hidden = false;
}
$('setRef').addEventListener('input', (e) => { settings.ref = +e.target.value; $('setRefOut').textContent = settings.ref + ' dBm'; saveSettings(); });
$('setPle').addEventListener('input', (e) => { settings.ple = +e.target.value / 10; $('setPleOut').textContent = settings.ple.toFixed(1); saveSettings(); });
$('clearData').addEventListener('click', () => confirmDo('Clear all saved data?',
  'Removes tag names, recent history and calibration from this browser. Cannot be undone.',
  () => { names = {}; seenLog = {}; settings = { ref: -59, ple: 2.5 };
    saveNames(); saveSeen(); saveSettings(); renderList(); $('settingsModal').hidden = true; }));
$('settingsClose').addEventListener('click', () => { $('settingsModal').hidden = true; });
$('settingsBtn').addEventListener('click', openSettings);

/* ---------- about / help ---------- */
function aboutHtml() {
  return `
  <h3>📡 FMDN Finder</h3>
  <p class="small">A 100% client-side tool to locate and inspect Google <b>Find My Device (FMDN)</b>
  / Eddystone Bluetooth trackers using your phone’s radio. No servers, no accounts, no tracking —
  everything runs in your browser.</p>
  <div class="aboutSec"><h4>Requirements</h4><p class="small">
  Works in <b>Chrome / Edge</b> (Android, or desktop with a Bluetooth adapter). <b>iOS is not
  supported</b> (no Web Bluetooth). The live <b>signal hunt</b> needs Chrome’s scanning API:
  enable <code>chrome://flags/#enable-experimental-web-platform-features</code> and, if you self-host
  over plain HTTP, add the origin to <code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>,
  then relaunch Chrome and keep <b>Location ON</b>. <b>Connect &amp; Inspect</b> works without any flag.
  </p></div>
  <div class="aboutSec"><h4>How to hunt</h4><p class="small">
  Start scan → the strongest <b>normal</b> tag auto-locks → walk around; the bar, distance and
  🔥/❄️ trend rise as you close in (with haptics/beep). Stand 1 m away and tap <b>Calibrate</b> for
  better distance. Name tags with ✎; they persist locally.</p></div>
  <div class="aboutSec"><h4>Privacy &amp; security</h4><p class="small">
  Strict Content-Security-Policy, no external requests, no analytics. Names, history and calibration
  live only in this browser’s <code>localStorage</code> (clear them in Settings).</p></div>
  <div class="aboutSec"><h4>Responsible use</h4><p class="small">
  DULT reads and ringing are part of the anti-stalking standard and are meant to help you find
  unknown trackers near <i>you</i>. Don’t use the ring action to disturb others.</p></div>
  <p class="small"><a href="${REPO_URL}" target="_blank" rel="noopener noreferrer">Source code &amp; docs on GitHub ↗</a></p>
  <div class="mbtns"><button class="ok" id="aboutClose">Close</button></div>`;
}
function openAbout() { $('aboutSheet').innerHTML = aboutHtml(); $('aboutModal').hidden = false;
  $('aboutClose').addEventListener('click', () => { $('aboutModal').hidden = true; }); }
$('aboutBtn').addEventListener('click', openAbout);

/* ---------- inspect (GATT / DULT) ---------- */
let inspectServer = null, dultCtrl = null, wasScanning = false, lastInspectTarget = null;
const ib = (h) => { $('inspectBody').innerHTML = h; };
const ibAdd = (h) => { $('inspectBody').innerHTML += h; };
const kv = (k, v) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;

$('inspectBtn').addEventListener('click', () => {
  lastInspectTarget = pickTarget(); $('inspectActions').replaceChildren();
  const t = lastInspectTarget;
  $('inspectBody').innerHTML = t
    ? `Target: <b>${esc(nameFor(t.id) || ('id ' + t.id.slice(0, 8)))}</b> `
      + `<span class="pill ${t.state}">${t.state}</span><br>`
      + `<span class="small"><b>Connect</b> reconnects instantly once this tag has been granted. `
      + `First time, it opens the system picker — choose an <i>“Unknown / unsupported device”</i> `
      + `(named entries like TVs/speakers aren’t trackers). A wrong pick is flagged so you can retry.</span>`
    : `<span class="small"><b>Connect</b> opens the system picker — choose an <i>“Unknown / unsupported device”</i> `
      + `(named entries like TVs/speakers aren’t trackers). A wrong pick is flagged so you can retry.</span>`;
  $('inspectModal').hidden = false;
});
$('inspectClose').addEventListener('click', () => {
  $('inspectModal').hidden = true;
  try { if (inspectServer && inspectServer.connected) inspectServer.disconnect(); } catch { /* ignore */ }
  inspectServer = dultCtrl = null;
  if (wasScanning && !scan) { wasScanning = false; startScan(); }
});
$('inspectConnect').addEventListener('click', () => runInspect());

// FMDN tags advertise 0xFEAA as *service data* (AD 0x16), not as a listed
// service UUID, so requestDevice filters:[{services:[0xfeaa]}] matches nothing.
// Filter by serviceData when the browser supports it; otherwise the system
// picker lists all nearby devices (it can't be narrowed any other way).
function requestFmdnDevice() {
  return navigator.bluetooth.requestDevice({
    filters: [{ serviceData: [{ service: 0xfeaa }] }], optionalServices: INSPECT_SERVICES,
  }).catch((e) => {
    if (e.name === 'TypeError' || e.name === 'NotSupportedError') return requestAllDevices();
    throw e; // NotFoundError (user cancelled) or a real error
  });
}
function requestAllDevices() {
  return navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: INSPECT_SERVICES });
}
// Smart connect: reuse a remembered grant or the live scan object (no picker);
// only fall back to the system picker when the tag hasn't been granted yet.
async function obtainConnection(target) {
  let dev = null;
  try { if (navigator.bluetooth.getDevices) { const g = await navigator.bluetooth.getDevices();
    if (target) dev = g.find((d) => d.id === target.id); } } catch { /* ignore */ }
  if (!dev && target && target.device) dev = target.device;
  if (dev) {
    try {
      const server = await dev.gatt.connect();
      const services = await server.getPrimaryServices();
      return { dev, server, services, how: (target && dev === target.device) ? 'locked target' : 'remembered grant' };
    } catch { /* not granted yet → fall through to the picker */ }
  }
  const picked = await requestFmdnDevice();
  const server = await picked.gatt.connect();
  const services = await server.getPrimaryServices();
  return { dev: picked, server, services, how: 'picker' };
}
async function runInspect() {
  showErr('');
  if (!navigator.bluetooth || !navigator.bluetooth.requestDevice) { ib('Web Bluetooth not available on this browser.'); return; }
  try { if (inspectServer && inspectServer.connected) inspectServer.disconnect(); } catch { /* ignore */ }
  inspectServer = dultCtrl = null;
  wasScanning = !!scan; if (scan) stopScan();
  ib('Connecting…');
  let res;
  try { res = await obtainConnection(lastInspectTarget); }
  catch (e) {
    if (e.name === 'NotFoundError') { ib('No device chosen. Tap <b>Connect</b> and pick an <i>“Unknown / unsupported device”</i> — named entries (TVs, speakers) aren’t trackers.'); return; }
    ib('Could not connect: ' + esc(e.message)); return;
  }
  inspectServer = res.server;
  try { await readAndRender(res); }
  catch (e) { ibAdd('<br><span class="fail">read failed: ' + esc(e.message) + '</span>'); }
}
async function readAndRender(res) {
  const { dev, services, how } = res;
  ib(kv('device', `${dev.name || dev.id.slice(0, 12)} · via ${how}`));
  const present = new Set(services.map((s) => shortUuid(s.uuid)));
  ibAdd(kv('services', [...present].join(', ')));
  const trackerish = ['feaa', 'feb3', 'fa25', 'fe2c'].some((s) => present.has(s))
    || services.some((s) => s.uuid.toLowerCase() === DULT_SERVICE);
  if (!trackerish) ibAdd('<div class="badge unknown">⚠ This isn’t an FMDN tracker — pick a different “Unknown device”.</div>');
  const DISN = { '2a29': 'Manufacturer', '2a24': 'Model', '2a25': 'Serial', '2a26': 'Firmware', '2a27': 'Hardware' };
  let disEncrypted = false, mfrBlank = false;
  const dis = services.find((s) => shortUuid(s.uuid) === '180a');
  if (dis) for (const c of await dis.getCharacteristics()) {
    const cu = shortUuid(c.uuid); if (!DISN[cu]) continue;
    try { const v = await c.readValue(); const txt = new TextDecoder().decode(v).replace(/\0/g, '').trim();
      if (cu === '2a29' && /^manufacturer/i.test(txt)) mfrBlank = true;
      ibAdd(kv(DISN[cu], txt || '(empty)')); }
    catch (e) { disEncrypted = true; ibAdd(kv(DISN[cu], '🔒 ' + e.name)); }
  }
  const bat = services.find((s) => shortUuid(s.uuid) === '180f');
  if (bat) try { const c = await bat.getCharacteristic(0x2a19); const v = await c.readValue(); ibAdd(kv('Battery', v.getUint8(0) + ' %')); } catch { /* ignore */ }
  dultCtrl = null;
  const dult = services.find((s) => s.uuid.toLowerCase() === DULT_SERVICE);
  if (dult) try {
    dultCtrl = await dult.getCharacteristic(DULT_CONTROL); await dultCtrl.startNotifications();
    for (const { label, op } of DULT_READS) {
      const r = await dultRead(dultCtrl, Uint8Array.from(op)); ibAdd(kv('DULT ' + label, parseDultReply(r)));
    }
  } catch (e) { ibAdd(kv('DULT', 'error ' + e.name)); }
  const verdict = classify({ present, mfrBlank, disEncrypted });
  ibAdd(`<div class="badge ${verdict.cls}">${esc(verdict.text)}</div>`);
  renderInspectActions();
}
function dultRead(ctrl, req, timeout = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const h = (e) => { if (done) return; done = true; ctrl.removeEventListener('characteristicvaluechanged', h);
      resolve(new Uint8Array(e.target.value.buffer)); };
    ctrl.addEventListener('characteristicvaluechanged', h);
    ctrl.writeValueWithResponse(req).catch(() => { if (!done) { done = true; ctrl.removeEventListener('characteristicvaluechanged', h); resolve(null); } });
    setTimeout(() => { if (!done) { done = true; ctrl.removeEventListener('characteristicvaluechanged', h); resolve(null); } }, timeout);
  });
}
function renderInspectActions() {
  const A = $('inspectActions'); A.replaceChildren();
  if (!dultCtrl) return;
  const ring = document.createElement('button'); ring.className = 'danger'; ring.textContent = '🔔 Ring (DULT)';
  ring.addEventListener('click', () => confirmDo('Ring this tag?',
    'Sends DULT Sound_Start. Only works while the tag is in the separated state, and it may beep audibly (including in a neighbour’s space).',
    () => dultCtrl.writeValueWithResponse(Uint8Array.from(DULT_SOUND_START))
      .then(() => ibAdd(kv('Ring', 'sent'))).catch((e) => ibAdd(kv('Ring', 'err ' + e.name)))));
  const stop = document.createElement('button'); stop.className = 'cancel'; stop.textContent = '🔕 Stop';
  stop.addEventListener('click', () => dultCtrl.writeValueWithResponse(Uint8Array.from(DULT_SOUND_STOP))
    .then(() => ibAdd(kv('Ring', 'stopped'))).catch(() => {}));
  A.append(ring, stop);
}

/* ---------- wire up + feature detection ---------- */
$('startBtn').addEventListener('click', startScan);
$('stopBtn').addEventListener('click', stopScan);
$('modeSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return;
  mode = b.dataset.mode; if (mode !== 'manual') lockedId = null; syncSeg(); });
$('bannerHelp').addEventListener('click', openAbout);
$('bannerDismiss').addEventListener('click', () => { $('banner').hidden = true; });
$('beep').addEventListener('change', (e) => { if (e.target.checked) ensureAudio(); });
window.addEventListener('beforeunload', persistSeen);
document.addEventListener('keydown', (e) => {                 // Escape closes the top-most modal
  if (e.key !== 'Escape') return;
  for (const id of ['inputModal', 'confirmModal']) {          // these stack above the rest
    if (!$(id).hidden) { $(id).hidden = true; return; }
  }
  if (!$('inspectModal').hidden) { $('inspectClose').click(); return; }
  for (const id of ['settingsModal', 'aboutModal']) {
    if (!$(id).hidden) { $(id).hidden = true; return; }
  }
});

function detectSupport() {
  const b = $('banner'), bt = $('bannerText');
  if (!navigator.bluetooth) {
    bt.innerHTML = '<b>Web Bluetooth isn’t available.</b> Use Chrome or Edge on Android (or desktop with Bluetooth). iOS isn’t supported.';
    b.hidden = false; $('startBtn').disabled = true; $('inspectBtn').disabled = true; setStatus('unsupported', 'err');
  } else if (!navigator.bluetooth.requestLEScan) {
    bt.innerHTML = '<b>Live scanning needs a Chrome flag.</b> Connect &amp; Inspect still works. Tap “How to enable” for steps.';
    b.hidden = false; $('startBtn').disabled = true;
  }
}

detectSupport();
pruneSeen();
loop();
// Register the offline worker only in production (HTTPS). On http staging
// (sandbox / localhost) skip it so edits are always served fresh.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
