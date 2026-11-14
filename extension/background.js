// Background worker. Two jobs:
// 1. Forward order updates from the content script to the local Notch Eats app.
// 2. Keep the notch live when the Uber Eats tab is hidden, asleep or closed: the content script
//    tells us which of the page's own API requests carries the order status; we repeat that
//    request about every 10 s (logged in as you, same as the page) and read it with the same parser.
importScripts("parse.js");

const APP = "http://127.0.0.1:47321/update";
const POLL_EVERY_MS = 10_000;
const ENDPOINT_TTL_MS = 3 * 3600e3;

function postApp(payload, debug) {
  return fetch(APP, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
    .then((r) => chrome.storage.local.set({ last: { payload, debug, ok: r.ok, at: Date.now() } }))
    .catch((e) => chrome.storage.local.set({ last: { payload, debug, ok: false, err: String(e), at: Date.now() } }));
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === "order") {
    postApp(msg.payload, msg.debug);
    noteOrder(msg.payload);
  } else if (msg.type === "endpoint") {
    saveEndpoint(msg.endpoint, msg.path);
  }
});

// ---- state ------------------------------------------------------------------------------------

async function getState() {
  const { poll } = await chrome.storage.local.get("poll");
  return poll || { endpoint: null, lastActiveEta: null, lastActiveAt: 0, dur: null, durEta: null, misses: 0, lastPoll: 0, lastResult: "" };
}
async function setState(s) { await chrome.storage.local.set({ poll: s }); }

async function saveEndpoint(ep, path) {
  const s = await getState();
  s.endpoint = { ...ep, path, savedAt: Date.now() };
  s.misses = 0;
  await setState(s);
  chrome.alarms.create("poll", { periodInMinutes: 0.5 });
}

async function noteOrder(payload) {
  const s = await getState();
  if (payload.done) {
    s.endpoint = null; // order finished: stop polling
    await setState(s);
    chrome.alarms.clear("poll");
    return;
  }
  s.lastActiveEta = payload.etaMs || null;
  s.lastActiveAt = Date.now();
  await setState(s);
}

// ---- polling ----------------------------------------------------------------------------------

function classify(path) {
  const p = path.toLowerCase();
  if (/courier|driver|dasher|worker|deliveryperson|delivery_person|rider|vehicle/.test(p)) return "courier";
  if (/dropoff|drop_off|destination|customer|deliveryaddress|delivery_address|deliverylocation|targetlocation/.test(p)) return "dropoff";
  if (/pickup|pick_up|store|restaurant|merchant|origin/.test(p)) return "store";
  return null;
}

function walkStrings(o, out, depth) {
  if (out.length > 600 || depth > 20 || o == null) return;
  if (typeof o === "string") { if (o.length && o.length <= 160 && !/^https?:/.test(o)) out.push(o); return; }
  if (typeof o !== "object") return;
  for (const k in o) walkStrings(o[k], out, depth + 1);
}

function walkPoints(o, path, out, depth) {
  if (!o || typeof o !== "object" || depth > 14 || out.length > 60) return;
  const lat = typeof o.latitude === "number" ? o.latitude : typeof o.lat === "number" ? o.lat : null;
  const lon = typeof o.longitude === "number" ? o.longitude : typeof o.lng === "number" ? o.lng : typeof o.lon === "number" ? o.lon : null;
  if (lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat || lon)) {
    out.push({ path: path.split(".").slice(-5).join("."), lat, lon });
  }
  for (const k in o) walkPoints(o[k], path + "." + k, out, depth + 1);
}

let polling = false;
async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    const s = await getState();
    const ep = s.endpoint;
    if (!ep || Date.now() - ep.savedAt > ENDPOINT_TTL_MS) {
      chrome.alarms.clear("poll");
      return;
    }
    // Skip if the tab itself reported very recently (it's visible and live).
    if (Date.now() - s.lastActiveAt < 4000) return;

    const headers = { ...(ep.headers || {}) };
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "x-csrf-token")) headers["x-csrf-token"] = "x";
    const r = await fetch(ep.url, {
      method: ep.method || "GET",
      headers,
      body: ep.method && ep.method !== "GET" ? ep.body : undefined,
      credentials: "include",
    });
    s.lastPoll = Date.now();
    if (!r.ok) { s.lastResult = "HTTP " + r.status; s.misses++; await setState(s); return; }
    const json = await r.json();
    const strings = []; walkStrings(json, strings, 0);
    const res = UEParse.parse({ text: strings.join("\n"), headings: [], title: "", path: ep.path, now: Date.now() });

    if (!res) {
      s.misses++;
      // Order no longer in the API response and it was due (or nearly): it's been delivered.
      const due = s.lastActiveEta == null || s.lastActiveEta - Date.now() <= 5 * 60e3;
      if (s.lastActiveAt && due) {
        s.endpoint = null;
        s.lastResult = "order gone near ETA: delivered";
        await setState(s);
        chrome.alarms.clear("poll");
        await postApp({ active: false, done: true, status: "Delivered", etaMs: null }, { evidence: "background poll: order gone near ETA", path: ep.path });
        return;
      }
      s.lastResult = "no order found in response";
      if (s.misses > 60) { s.endpoint = null; chrome.alarms.clear("poll"); }
      await setState(s);
      return;
    }

    let etaMs = res.etaAbsMs;
    if (etaMs == null && res.durMin != null) {
      if (s.dur !== res.durMin) { s.dur = res.durMin; s.durEta = Date.now() + res.durMin * 60000; }
      etaMs = s.durEta;
    }
    const points = []; walkPoints(json, "", points, 0);
    const coords = {};
    for (const p of points) { const c = classify(p.path); if (c) coords[c] = { lat: p.lat, lon: p.lon }; }

    const payload = {
      active: !res.done,
      etaMs: etaMs || null,
      etaLowMs: res.etaLowAbsMs || null,
      status: res.status,
      done: !!res.done,
      stage: res.stage || null,
      headline: res.headline || null,
      pin: res.pin || null,
      courier: res.courier || null,
      vehicle: res.vehicle || null,
      plate: res.plate || null,
      store: res.store || null,
      total: res.total || null,
      topRated: res.topRated || null,
      coords: Object.keys(coords).length ? coords : null,
    };
    s.misses = 0;
    s.lastResult = "ok: " + res.status;
    if (!res.done) { s.lastActiveEta = payload.etaMs; s.lastActiveAt = Date.now() - 4000; }
    await setState(s);
    await postApp(payload, { evidence: "background poll: " + res.evidence, path: ep.path });
    if (res.done) { s.endpoint = null; await setState(s); chrome.alarms.clear("poll"); }
  } catch (e) {
    const s = await getState();
    s.lastResult = "error: " + String(e);
    s.misses++;
    await setState(s);
  } finally {
    polling = false;
  }
}

// Alarms fire at most every 30 s; within each wake-up poll three times, 10 s apart.
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== "poll") return;
  pollOnce();
  setTimeout(pollOnce, POLL_EVERY_MS);
  setTimeout(pollOnce, 2 * POLL_EVERY_MS);
});
