// trustdice-inject.js — MAIN world on trustdice.win. Copied verbatim from the operator extension.
// BetBy (sptpub.com) authorises placement ONLY via the x-session-id header (no bearer token), so we
// read along on every sptpub request: API host, brand id, the auth-relevant header set, and the BTC
// minimum stake from the identify response. Read-only; no request is modified.
(() => {
  if (window.__tdInject) return;
  window.__tdInject = true;

  const LAST = {};
  const SEEN = {};                                  // host -> Anzahl Anfragen (Diagnose: welchen Shard nutzt DIESER Rechner?)
  function post(obj) {
    try { Object.assign(LAST, obj); } catch (_) {}
    try { window.postMessage(Object.assign({ source: "td-inject" }, obj), "*"); } catch (_) {}
  }
  // Nachfrage-Brücke: ein spaet geladenes Skript fragt "need" — wir wiederholen den letzten Stand.
  window.addEventListener("message", (e) => {
    try {
      if (e.source !== window) return;
      const d = e.data;
      if (d && d.source === "td-place" && d.kind === "need") {
        window.postMessage(Object.assign({ source: "td-inject", seen: SEEN }, LAST), "*");
      }
    } catch (_) {}
  });

  const WANT = ["x-session-id", "x-ga-client-id", "x-ga-session-id", "x-ua-full-version-list", "x-ua-model", "x-ua-platform-version"];
  function grabHeaders(h) {
    const out = {};
    try {
      if (!h) return out;
      if (typeof Headers !== "undefined" && h instanceof Headers) { for (const k of WANT) { const v = h.get(k); if (v) out[k] = v; } return out; }
      if (Array.isArray(h)) { for (const p of h) { const k = String(p[0]).toLowerCase(); if (WANT.includes(k) && p[1]) out[k] = p[1]; } return out; }
      if (typeof h === "object") { for (const k in h) { const lk = k.toLowerCase(); if (WANT.includes(lk) && h[k]) out[lk] = h[k]; } }
    } catch (_) {}
    return out;
  }
  function fromUrl(url) {
    const out = {};
    try {
      if (!/sptpub\.com/.test(url)) return null;
      // NUR echte API-Shards melden. BetBy laedt auch von Theme-/Start-Servern
      // (bt-app-static-themes., start3.) — die als API_HOST zu uebernehmen laesst jeden
      // Quotenabruf mit "Failed to fetch" scheitern (Fund 30.07., TrustDice-Test 3).
      const h = new URL(url).host;
      SEEN[h] = (SEEN[h] || 0) + 1;                 // ALLE sptpub-Hosts mitzaehlen (fuer die Diagnose)
      if (!/^api-/.test(h)) return null;
      out.apiHost = h;
      const b = url.match(/\/brand\/(\d+)/);
      if (b) out.brand = b[1];
    } catch (_) { return null; }
    return out;
  }
  function maybeMinBet(url, text) {
    try {
      if (!/\/auth\/brand\/.*identify/.test(url)) return;
      const j = JSON.parse(text);
      const mb = j && j.currency_detail && j.currency_detail.min_bet;
      if (mb) post({ minBet: String(mb) });
    } catch (_) {}
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    try {
      const info = fromUrl(url);
      if (info) {
        const h = grabHeaders((init && init.headers) || (typeof input === "object" && input && input.headers));
        if (Object.keys(h).length) info.headers = h;
        post(info);
      }
    } catch (_) {}
    const p = origFetch.apply(this, arguments);
    try { if (/identify/.test(url)) p.then((r) => { try { r.clone().text().then((t) => maybeMinBet(url, t)).catch(() => {}); } catch (_) {} }).catch(() => {}); } catch (_) {}
    return p;
  };

  const oOpen = XMLHttpRequest.prototype.open, oSet = XMLHttpRequest.prototype.setRequestHeader, oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__tdUrl = u; this.__tdHeaders = {}; return oOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try { const lk = String(k).toLowerCase(); if (WANT.includes(lk)) (this.__tdHeaders = this.__tdHeaders || {})[lk] = v; } catch (_) {}
    return oSet.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    try {
      const info = fromUrl(this.__tdUrl || "");
      if (info) {
        if (this.__tdHeaders && Object.keys(this.__tdHeaders).length) info.headers = this.__tdHeaders;
        post(info);
      }
      if (/identify/.test(this.__tdUrl || "")) this.addEventListener("load", () => { try { maybeMinBet(this.__tdUrl, this.responseText); } catch (_) {} });
    } catch (_) {}
    return oSend.apply(this, arguments);
  };
})();
