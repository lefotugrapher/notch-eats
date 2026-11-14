// Runs in the PAGE world (manifest "world": "MAIN") at document_start.
// Watches the JSON the Uber Eats page downloads from its own API and forwards to the content script:
//   - latitude/longitude pairs (courier, drop-off, store) for the map
//   - the request itself (url, method, body, headers) plus the text strings in the response,
//     so the extension can find the request that carries the order status and repeat it from the
//     background worker. That keeps the notch live even when this tab is hidden or asleep.
// Read-only: nothing leaves the machine except to the local Notch Eats app.
(() => {
  if (window.__notchEatsHook) return;
  window.__notchEatsHook = true;

  const URL_RE = /\/_p\/api\/|order|track|courier|driver|eta|location|active|delivery/i;

  function walkPoints(o, path, out, depth) {
    if (!o || typeof o !== "object" || depth > 14 || out.length > 60) return;
    const lat = typeof o.latitude === "number" ? o.latitude : typeof o.lat === "number" ? o.lat : null;
    const lon = typeof o.longitude === "number" ? o.longitude
      : typeof o.lng === "number" ? o.lng : typeof o.lon === "number" ? o.lon : null;
    if (lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat || lon)) {
      out.push({ path: path.split(".").slice(-5).join("."), lat, lon });
    }
    for (const k in o) walkPoints(o[k], path + "." + k, out, depth + 1);
  }

  function walkStrings(o, out, depth) {
    if (out.length > 600 || depth > 20 || o == null) return;
    if (typeof o === "string") { if (o.length && o.length <= 160 && !/^https?:/.test(o)) out.push(o); return; }
    if (typeof o !== "object") return;
    for (const k in o) walkStrings(o[k], out, depth + 1);
  }

  function handle(url, text, req) {
    if (!text || text.length > 3e6 || text[0] !== "{" && text[0] !== "[") return;
    let json;
    try { json = JSON.parse(text); } catch (e) { return; }
    const points = [];
    walkPoints(json, "", points, 0);
    const strings = [];
    if (req && /\/_p\/api\//.test(url)) walkStrings(json, strings, 0);
    if (points.length || strings.length) {
      window.postMessage({ __notchEats: true, points, api: strings.length ? { url, ...req, strings } : null }, "*");
    }
  }

  function headersToObject(h) {
    const out = {};
    try {
      if (!h) return out;
      if (h instanceof Headers) h.forEach((v, k) => { out[k] = v; });
      else if (Array.isArray(h)) h.forEach(([k, v]) => { out[k] = v; });
      else Object.assign(out, h);
    } catch (e) {}
    return out;
  }

  async function describeRequest(args) {
    try {
      const [input, init] = args;
      if (input instanceof Request) {
        const c = input.clone();
        return { method: c.method, headers: headersToObject(c.headers), body: c.method === "GET" ? null : await c.text() };
      }
      const body = init && typeof init.body === "string" ? init.body : null;
      return { method: (init && init.method) || "GET", headers: headersToObject(init && init.headers), body };
    } catch (e) {
      return null;
    }
  }

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    try {
      const reqP = describeRequest(args);
      p.then((r) => {
        const u = (r && r.url) || "";
        if (URL_RE.test(u)) Promise.all([r.clone().text(), reqP]).then(([t, req]) => handle(u, t, req)).catch(() => {});
      }).catch(() => {});
    } catch (e) {}
    return p;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ne = { method, url: String(url), headers: {} };
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try { if (this.__ne) this.__ne.headers[k] = v; } catch (e) {}
    return origSetHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      const ne = this.__ne;
      if (ne && URL_RE.test(ne.url)) {
        const abs = new URL(ne.url, location.href).href;
        this.addEventListener("load", () => {
          try {
            if (typeof this.responseText === "string") {
              handle(abs, this.responseText, { method: ne.method, headers: ne.headers, body: typeof body === "string" ? body : null });
            }
          } catch (e) {}
        });
      }
    } catch (e) {}
    return origSend.apply(this, arguments);
  };
})();
