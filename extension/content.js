// Runs on ubereats.com pages. Reads the order details and hands them to the background worker.
(() => {
  const SEEN_KEY = "notchEatsSeenActive";
  const LAST_KEY = "notchEatsLastActive"; // {etaMs, at} of the last live-order update from this tab

  // Uber doesn't show a "delivered" page: it bounces the tab back to the home page.
  // So if we were tracking an order that was (nearly) due and the tracking page is gone, call it delivered.
  // Leaving early (courier still far away) is ignored so the countdown keeps running.
  function maybeFinish() {
    let last;
    try { last = JSON.parse(sessionStorage.getItem(LAST_KEY) || "null"); } catch (e) { return; }
    if (!last) return;
    if (Date.now() - last.at > 3 * 3600e3) { try { sessionStorage.removeItem(LAST_KEY); } catch (e) {} return; }
    if (/\/orders?\/[0-9a-z-]{8,}/i.test(location.pathname)) return; // still on an order page
    if (last.etaMs != null && last.etaMs - Date.now() > 5 * 60e3) return;
    try { sessionStorage.removeItem(LAST_KEY); } catch (e) {}
    try {
      chrome.runtime.sendMessage({
        type: "order",
        payload: { active: false, done: true, status: "Delivered", etaMs: null },
        debug: { evidence: "left tracking page near ETA", path: location.pathname, candidates: {} },
      });
    } catch (e) {}
  }
  let memo = { dur: null, etaMs: null }; // keeps the ETA stable while the page text is unchanged
  let pending = null;
  const coords = {};      // latest courier / dropoff / store position seen in page JSON
  const candidates = {};  // path -> "lat,lon" for the popup's debug view

  function classify(path) {
    const p = path.toLowerCase();
    if (/courier|driver|dasher|worker|deliveryperson|delivery_person|rider|vehicle/.test(p)) return "courier";
    if (/dropoff|drop_off|destination|customer|deliveryaddress|delivery_address|deliverylocation|targetlocation/.test(p)) return "dropoff";
    if (/pickup|pick_up|store|restaurant|merchant|origin/.test(p)) return "store";
    return null;
  }

  // Best effort: find the courier's profile photo next to their name so the card can show it.
  let photoCache = { name: null, url: null, tries: 0 };
  function courierPhoto(name) {
    if (photoCache.name !== name) photoCache = { name, url: null, tries: 0 };
    if (photoCache.url || photoCache.tries >= 6) return photoCache.url;
    photoCache.tries++;
    try {
      const needle = name.toLowerCase();
      const el = [...document.querySelectorAll("div,span,p")].find(
        (e) => e.children.length === 0 && e.textContent && e.textContent.length < 60 && e.textContent.trim().toLowerCase().startsWith(needle)
      );
      let n = el;
      for (let i = 0; n && i < 6; i++, n = n.parentElement) {
        for (const img of n.querySelectorAll("img")) {
          if (img.src && img.src.startsWith("https://") && img.naturalWidth >= 24) {
            photoCache.url = img.src;
            return photoCache.url;
          }
        }
      }
    } catch (e) {}
    return null;
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || !e.data.__notchEats || !Array.isArray(e.data.points)) return;
    // The page fetched something from Uber's API: if it carries the order, hand the request to the
    // background worker so it can keep polling even when this tab is hidden or asleep.
    const api = e.data.api;
    if (api && Array.isArray(api.strings)) {
      try {
        const probe = UEParse.parse({ text: api.strings.join("\n"), headings: [], title: "", path: location.pathname, now: Date.now() });
        if (probe && !probe.done) {
          chrome.runtime.sendMessage({
            type: "endpoint",
            endpoint: { url: api.url, method: api.method, headers: api.headers, body: api.body },
            path: location.pathname,
          });
        }
      } catch (err) {}
    }
    for (const p of (e.data.points || [])) {
      candidates[p.path] = p.lat.toFixed(4) + "," + p.lon.toFixed(4);
      const c = classify(p.path);
      if (c) coords[c] = { lat: p.lat, lon: p.lon };
    }
    schedule();
  });

  function scan() {
    pending = null;
    lastScan = Date.now();
    if (!document.body) return;
    let res;
    try {
      const headings = [...document.querySelectorAll("h1,h2,h3,h4,[role=heading]")]
        .map((e) => e.innerText)
        .filter(Boolean);
      res = UEParse.parse({
        text: document.body.innerText,
        headings,
        title: document.title,
        path: location.pathname,
        now: Date.now(),
      });
    } catch (e) {
      return;
    }
    if (!res) { maybeFinish(); return; }

    let etaMs = res.etaAbsMs;
    if (etaMs == null && res.durMin != null) {
      if (memo.dur !== res.durMin) memo = { dur: res.durMin, etaMs: Date.now() + res.durMin * 60000 };
      etaMs = memo.etaMs;
    }

    try {
      if (res.done) {
        // Only report "delivered" if we watched this order live in this tab.
        if (sessionStorage.getItem(SEEN_KEY) !== "1") return;
      } else {
        sessionStorage.setItem(SEEN_KEY, "1");
        sessionStorage.setItem(LAST_KEY, JSON.stringify({ etaMs: etaMs || null, at: Date.now() }));
      }
      if (res.done) sessionStorage.removeItem(LAST_KEY);
    } catch (e) {}

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
      photo: res.courier ? courierPhoto(res.courier) : null,
      coords: Object.keys(coords).length ? coords : null,
    };
    try {
      chrome.runtime.sendMessage({
        type: "order",
        payload,
        debug: { evidence: res.evidence, path: location.pathname, candidates },
      });
    } catch (e) {
      // extension was reloaded; this content script is orphaned
    }
  }

  let lastScan = 0;
  function schedule() {
    if (pending) return;
    // Throttle (the page mutates constantly), but when enough time has passed scan right away from
    // the observer callback itself: timers are throttled in background tabs, observer callbacks are not.
    const wait = 1500 - (Date.now() - lastScan);
    if (wait <= 0) { scan(); return; }
    pending = setTimeout(scan, wait);
  }

  new MutationObserver(schedule).observe(document.documentElement, {
    subtree: true, childList: true, characterData: true,
  });
  setInterval(scan, 15000); // heartbeat, also fires in background tabs (throttled to ~1/min by Chrome)
  scan();
})();
