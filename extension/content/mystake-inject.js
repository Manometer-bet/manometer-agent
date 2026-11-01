// mystake-inject.js — MAIN world on mystake.com / jackbit.com. Copied verbatim from the operator
// extension (production-verified). Reads ONLY the result of a placement: the sportsbook calls
// POST /api/game/p/messagetosport name "createticketnew"; its response ({Status, Tickets, Errors})
// is the reliable success signal, and the SENT Items are the audit key (placed ItemID must equal
// the intended one — a mismatch means a wrong bet).
(() => {
  if (window.__msInject) return;
  window.__msInject = true;
  // Seit v1.2.1 laeuft dieses Script per Manifest in JEDEM Frame (document_start) — auch in
  // Sandbox-/Fremd-Frames, in denen fetch/XHR nicht ueberschreibbar sind. Dort darf es still
  // aussteigen statt einen Chrome-Extension-Fehler zu werfen (Fund 30.07.).
  try {

  function relayTicket(reqBodyText, resText) {
    try {
      const rb = JSON.parse(reqBodyText);
      if (!rb || rb.name !== "createticketnew") return;
      let res; try { res = JSON.parse(resText); } catch (_) { res = { raw: (resText || "").slice(0, 200) }; }
      let sent = null;
      try {
        const m = JSON.parse(rb.message);
        const it = (m && Array.isArray(m.Items) && m.Items[0]) || null;
        sent = it ? { itemId: String(it.ItemID), odd: it.Odd, amount: (m.Amount != null ? m.Amount : it.Amount), nItems: m.Items.length } : null;
      } catch (_) {}
      window.postMessage({ source: "ms-inject", kind: "ticket", sent,
        result: { ID: res.ID, Status: res.Status, Tickets: res.Tickets, Errors: res.Errors, ts: Date.now() } }, "*");
    } catch (_) {}
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    let body = null;
    try { if (/messagetosport/.test(url)) { const b = (init && init.body); if (typeof b === "string") body = b; } } catch (_) {}
    const p = origFetch.apply(this, arguments);
    if (typeof body === "string" && /createticketnew/.test(body)) {
      p.then((r) => { try { r.clone().text().then((t) => relayTicket(body, t)).catch(() => {}); } catch (_) {} }).catch(() => {});
    }
    return p;
  };

  const oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__msUrl = u; return oOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    try {
      if (/messagetosport/.test(this.__msUrl || "") && typeof b === "string" && /createticketnew/.test(b)) {
        this.addEventListener("load", () => { try { relayTicket(b, this.responseText); } catch (_) {} });
      }
    } catch (_) {}
    return oSend.apply(this, arguments);
  };
  } catch (_) { /* Frame erlaubt kein Hooking — irrelevant, der Sportsbook-Frame erlaubt es */ }
})();
