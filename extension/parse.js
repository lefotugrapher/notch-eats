// Heuristic reader for the Uber Eats order-tracking page text.
// Pure function, no DOM access, so it can be unit-tested with node.
(function (root) {
  function norm(s) {
    return (s || "")
      .replace(/[  ]/g, " ")
      .replace(/[‒-―−]/g, "-")
      .replace(/\b([ap])\.m\.?/gi, "$1m")
      .replace(/[ \t]+/g, " ")
      .trim();
  }

  function to24(h, m, ap) {
    h = +h; m = +m;
    if (ap) {
      ap = ap.toLowerCase();
      if (ap === "pm" && h < 12) h += 12;
      if (ap === "am" && h === 12) h = 0;
    }
    return [h, m];
  }

  function atToday(now, h, m) {
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    let t = d.getTime();
    if (t < now - 3 * 3600e3) t += 86400e3; // crossed midnight
    return t;
  }

  const T = "(\\d{1,2}):(\\d{2})\\s*(am|pm)?";
  const ARRIVE_KW =
    "(?:arriv(?:es|ing|al)?(?:\\s+(?:by|at|around|before))?|estimated(?:\\s+(?:arrival|delivery))?(?:\\s+(?:by|at|time))?|eta|delivery(?:\\s+(?:by|at))?|delivered\\s+by|expected(?:\\s+(?:by|at))?)";
  const RE_ARRIVE_TIME = new RegExp(ARRIVE_KW + "\\s*:?\\s*" + T + "(?:\\s*-\\s*" + T + ")?", "i");
  const RE_RANGE_LINE = new RegExp("^" + T + "\\s*-\\s*" + T + "$", "i");
  // "8 min away" is the label on the live map bubble
  const RE_DUR_AWAY = /\b(\d{1,3})(?:\s*-\s*(\d{1,3}))?\s*(?:min|mins|minutes)\s+away\b/i;
  const RE_DUR_KW =
    /(?:arriv(?:es|ing|al)?|delivery|delivered|ready|eta|estimated(?: arrival| delivery)?|\bin)\s*(?:in|time|:)?\s*(?:about|around|~)?\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?\s*(?:min|mins|minutes)\b/i;
  const RE_DUR_LINE = /^(\d{1,3})(?:\s*-\s*(\d{1,3}))?\s*(?:min|mins|minutes)$/i;

  // Returns { hi, lo|null } epoch ms. hi = the later time of a range (what the countdown targets).
  function timesFromMatch(m, o, now) {
    const h1 = m[o], mi1 = m[o + 1], ap1 = m[o + 2];
    const h2 = m[o + 3], mi2 = m[o + 4], ap2 = m[o + 5];
    if (h2 === undefined) {
      const [hh, mm] = to24(h1, mi1, ap1);
      if (hh > 23 || mm > 59) return null;
      return { hi: atToday(now, hh, mm), lo: null };
    }
    const [hh, mm] = to24(h2, mi2, ap2 || ap1);
    if (hh > 23 || mm > 59) return null;
    const hi = atToday(now, hh, mm);
    let [lh, lm] = to24(h1, mi1, ap1 || ap2);
    if (lh > 23 || lm > 59) return { hi, lo: null };
    let lo = atToday(now, lh, lm);
    if (lo > hi) lo -= 12 * 3600e3; // e.g. "11:50 - 12:10 PM" read the first half as PM
    if (lo > hi || hi - lo > 6 * 3600e3) lo = null;
    return { hi, lo };
  }

  function findEta(lines, now, allowStandalone) {
    for (const l of lines) {
      const m = RE_ARRIVE_TIME.exec(l);
      if (m) {
        const t = timesFromMatch(m, 1, now);
        if (t) return { etaAbsMs: t.hi, etaLowAbsMs: t.lo, evidence: l };
      }
    }
    for (const l of lines) {
      const m = RE_RANGE_LINE.exec(l);
      if (m) {
        const t = timesFromMatch(m, 1, now);
        if (t) return { etaAbsMs: t.hi, etaLowAbsMs: t.lo, evidence: l };
      }
    }
    for (const l of lines) {
      const m = RE_DUR_AWAY.exec(l);
      if (m) return { durMin: +(m[2] || m[1]), evidence: l };
    }
    for (const l of lines) {
      const m = RE_DUR_KW.exec(l);
      if (m) return { durMin: +(m[2] || m[1]), evidence: l };
    }
    if (allowStandalone) {
      for (const l of lines) {
        const m = RE_DUR_LINE.exec(l);
        if (m) return { durMin: +(m[2] || m[1]), evidence: l };
      }
    }
    return null;
  }

  // Order matters: first rule that matches a candidate wins.
  const STATUS = [
    { label: "Cancelled", done: true, re: /\b(?:order|delivery)\b.*\bcancel+ed\b|\bcancel+ed\b.*\border\b|^cancel+ed$/i },
    { label: "Delivered", done: true, re: /^(?:order )?delivered$|\b(?:order|food|meal) (?:was |has been |is )?delivered\b|\benjoy your (?:meal|order|food)\b/i },
    // "nearby" alone is NOT a signal: Uber's promo "Bundle any nearby shop..." contains it.
    { label: "Arriving", done: false, re: /\barriv(?:ing|es) (?:now|soon)\b|\balmost (?:there|here)\b|\b(?:is|are) nearby\b|\bat your (?:door|location)\b|\bis outside\b|\baround the corner\b|\bhas arrived\b|\bhave arrived\b/i },
    { label: "Picking up", done: false, re: /\bpicking up (?:your|the) order\b|\bheading to (?:the )?(?:restaurant|store|shop)\b|\bon (?:the|their|his|her) way to (?:the )?(?:restaurant|store|shop|pick)/i },
    { label: "On the way", done: false, re: /\bon (?:the|its|their|his|her) way\b|\bheading (?:your way|to you|to your)\b|\bpicked up\b|\bis delivering\b|\bout for delivery\b/i },
    { label: "Preparing", done: false, re: /\bprepar(?:ing|ed)\b|\bbeing made\b|\bmaking your\b|\bgetting your order ready\b|\bworking on your order\b|\bcooking\b|\bshopping (?:in progress|started)\b/i },
    { label: "Placed", done: false, re: /\border (?:placed|received|sent|confirmed)\b|\bwaiting for (?:the )?(?:restaurant|store|merchant)\b|\bconfirming\b|\bfinding (?:a |your )?(?:courier|driver|delivery)/i },
  ];

  // Uber's progress bar has 5 segments; this is our best mapping of status to filled segments.
  const STAGE = { Placed: 1, Preparing: 2, "Picking up": 3, "On the way": 4, Arriving: 5, Delivered: 5 };

  function pickStatus(cands) {
    for (const c of cands) {
      for (const s of STATUS) if (s.re.test(c)) return { label: s.label, done: s.done, evidence: c };
    }
    return null;
  }

  // ---- extra details -------------------------------------------------------
  const RE_PIN = [
    /\bPIN\b[^0-9\n]{0,20}(\d{4,6})\b/i,
    /\bOTP\b[^0-9\n]{0,15}(\d{4,6})\b/i,
    /\b(?:verification|security|confirmation|delivery) code\b[^0-9\n]{0,20}(\d{3,6})\b/i,
  ];
  const NAME = "([A-Za-z][A-Za-z'’.-]*(?: [A-Za-z][A-Za-z'’.-]*){0,2})";
  // "ALEX is in a car"
  const RE_COURIER_IS = new RegExp("^" + NAME + " is (?:in|on|riding|driving) an? ([a-z]{3,15})$", "i");
  // "ALEX · On a bicycle"
  const RE_COURIER_DOT = new RegExp("^" + NAME + " [·•|] (?:in|on) an? ([a-z ]{3,20})$", "i");
  // "ALEX · 99XY1234" (name · plate)
  const RE_COURIER_PLATE = /^[A-Za-z][A-Za-z '’.-]{1,30} [·•|] ([A-Z0-9][A-Z0-9 -]{3,9})$/;
  const RE_STORE_STATUS = /^(?:shopping (?:in progress|completed|started)|order (?:placed|confirmed|received)|preparing.*|.* is preparing your order|we['’]ll update you here.*)$/i;
  // Lines that are never a store name: nav, totals, payment method, prices, card digits.
  const NOT_STORE = /^(?:uber eats|help|order summary|total|menu|back|home)\b|mastercard|visa\b|amex|american express|maestro|paypal|apple pay|google pay|cash\b|card\b|[•·]{2,}|\d{4}\b.*\(|[€£$]\s?\d|\d+\s*x\b|^\d/i;

  function titleCase(s) {
    return s.toLowerCase().replace(/(^|[ '’-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  }

  function extractDetails(lines) {
    const d = { pin: null, courier: null, vehicle: null, plate: null, store: null, total: null, topRated: false };
    let courierIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!d.pin) for (const re of RE_PIN) { const m = re.exec(l); if (m) { d.pin = m[1]; break; } }
      if (!d.courier) {
        const m = RE_COURIER_DOT.exec(l) || RE_COURIER_IS.exec(l);
        if (m) { d.courier = titleCase(m[1]); d.vehicle = m[2].toLowerCase().trim(); courierIdx = i; }
      }
      if (!d.plate) { const m = RE_COURIER_PLATE.exec(l); if (m && /\d/.test(m[1])) d.plate = m[1].trim(); }
      if (!d.total) { const m = /^Total:?\s*([€£$]\s?[\d.,]+)$/i.exec(l); if (m) d.total = m[1].replace(/\s+/g, ""); }
      if (/^top-rated courier$/i.test(l)) d.topRated = true;
    }
    // Some layouts show the PIN only as a badge (4-6 digits) right above the courier line.
    if (!d.pin && courierIdx > 0 && /^\d{4,6}$/.test(lines[courierIdx - 1])) d.pin = lines[courierIdx - 1];
    for (let i = 1; i < lines.length; i++) {
      if (RE_STORE_STATUS.test(lines[i]) && lines[i - 1].length <= 50 && !NOT_STORE.test(lines[i - 1])) {
        d.store = lines[i - 1];
        break;
      }
    }
    return d;
  }

  function headlineOf(title, heads) {
    const t = (title || "").replace(/[….]+$/, "").trim();
    if (t && !/^uber eats\b/i.test(t) && t.length <= 60) return t;
    const h = (heads || []).find((x) => x.length <= 60 && !/^uber eats\b/i.test(x));
    return h || null;
  }

  // input: { text, headings[], title, path, now }
  // returns null when the page doesn't look like an order in progress.
  function parse(input) {
    const now = input.now || Date.now();
    const path = input.path || "";
    const lines = (input.text || "").split(/\n+/).map(norm).filter(Boolean);
    const heads = (input.headings || []).map(norm).filter(Boolean);
    const title = norm(input.title || "");
    const shortLines = lines.filter((l) => l.length <= 80);

    const onOrderPath = /\/orders?\/[0-9a-z-]{8,}/i.test(path) || /\/track(?:ing)?\b/i.test(path);
    const status = pickStatus([title, ...heads, ...shortLines].filter(Boolean));
    const eta = findEta(lines, now, onOrderPath);
    const headline = headlineOf(title, heads);

    if (status && status.done) {
      if (!onOrderPath) return null;
      return { done: true, status: status.label, stage: STAGE[status.label] || 5, headline, etaAbsMs: null, etaLowAbsMs: null, durMin: null, evidence: status.evidence, ...extractDetails(lines) };
    }
    if (!eta && status && status.label === "Arriving" && onOrderPath) {
      // "Almost here / Arriving now" pages drop the minutes: treat as due right now.
      return { done: false, status: "Arriving", stage: 5, headline, etaAbsMs: null, etaLowAbsMs: null, durMin: 0, evidence: status.evidence, ...extractDetails(lines) };
    }
    if (!eta) return null;
    if (!onOrderPath && !status) return null; // home page etc: need a status headline plus a keyworded ETA
    const label = status ? status.label : "Tracking";
    return {
      done: false,
      status: label,
      stage: STAGE[label] || null,
      headline,
      etaAbsMs: eta.etaAbsMs || null,
      etaLowAbsMs: eta.etaLowAbsMs || null,
      durMin: eta.durMin != null ? eta.durMin : null,
      evidence: eta.evidence,
      ...extractDetails(lines),
    };
  }

  const api = { parse, norm };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.UEParse = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
