chrome.storage.local.get("last", ({ last }) => {
  if (!last) return;
  const p = last.payload, d = last.debug || {};
  const ago = Math.round((Date.now() - last.at) / 1000);
  const eta = p.etaMs ? new Date(p.etaMs).toLocaleTimeString() : "none";
  const cands = Object.entries(d.candidates || {}).map(([k, v]) => `  ${k} = ${v}`).join("\n") || "  none seen yet";
  const out = document.getElementById("out");
  out.innerHTML =
    `<p class="${last.ok ? "ok" : "bad"}">${last.ok ? "Notch app reached" : "Notch app NOT reachable (is it running?)"} · ${ago}s ago</p>` +
    `<pre>status: ${p.status}\neta: ${eta}\ndone: ${p.done}\npin: ${p.pin ? "found" : "not found"}\n` +
    `courier: ${p.courier || "-"} (${p.vehicle || "-"})\nstore: ${p.store || "-"}\n` +
    `coords: ${p.coords ? Object.keys(p.coords).join(", ") : "none"}\nmatched: ${d.evidence}\npage: ${d.path}\n\nmap points in page data:\n${cands}</pre>`;
});

chrome.storage.local.get("poll", ({ poll }) => {
  const el = document.createElement("pre");
  if (!poll || !poll.endpoint) { el.textContent = "background polling: off (opens when an order page loads)"; }
  else {
    const ago = poll.lastPoll ? Math.round((Date.now() - poll.lastPoll) / 1000) + "s ago" : "not yet";
    el.textContent = "background polling: ON\nlast poll: " + ago + "\nresult: " + poll.lastResult;
  }
  document.body.appendChild(el);
});
