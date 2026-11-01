// mystake-kombi-inject.js — MAIN-World im Sportsbook von MyStake (und baugleichen Marken), alle Frames. 04.10.2026.
// Geteilt und BYTE-GLEICH: Erweiterung (mystake-kombi-inject.js) und Manometer Agent der External Bettors
// (engine/content/mystake-kombi-inject.js). Gegenstueck im Content-Script: mystake-kombi.js.
//
// Dieses Script veraendert nichts. Es
//   (1) LIEST auf Anfrage den Stand des Wettscheins: der Sportsbook (/sportsbookv4/, Vue 3 + Pinia) haelt den Schein im
//       Speicher "betslipStore" — currentTicket.prices[] mit ID (= ItemID, die createticketnew sendet), matchID, marketID,
//       positionID, coef, chains (kombinierbar), dazu activeTab (1 Single · 2 Multiple · 3 System) und betAmount. Gelesen am
//       04.10. im echten Schein (vier Auswahlen, Reiter von selbst auf Multiple, Gesamtquote = Produkt). Zurueck gehen nur
//       diese Felder. Findet sich der Speicher nicht (Seite umgebaut), kommt { fehler } — dann wird keine Kombi gebaut.
//   (2) LIEST MIT, was createticketnew sendet (ALLE Auswahlen: ItemID + Quote, Einsatz) und was das Buch antwortet
//       (Status, Fehler) — fuer den Abgleich „gesendet = Auftrag". Kein hash, keine Sitzungswerte.
(() => {
  if (window.__msKombiInject) return;
  window.__msKombiInject = true;

  function slipStand() {
    try {
      const wurzel = document.querySelector("#sportsbook");
      const app = wurzel && wurzel.__vue_app__;
      const pinia = app && app.config && app.config.globalProperties && app.config.globalProperties.$pinia;
      const st = pinia && pinia._s && typeof pinia._s.get === "function" ? pinia._s.get("betslipStore") : null;
      const t = st && st.currentTicket;
      if (!st || !t || !Array.isArray(t.prices)) return { fehler: "betslip store not found" };
      return {
        ok: true, activeTab: Number(st.activeTab), tabMultiple: (st.tabType && st.tabType.MULTIPLE != null) ? Number(st.tabType.MULTIPLE) : null,
        priceCount: Number(st.priceCount), totalCoef: Number(t.totalCoef), betAmount: Number(t.betAmount), status: Number(t.status), waiting: !!st.waitingForBetResult,
        prices: t.prices.map((p) => ({ id: String(p.ID), matchId: String(p.matchID), marketId: String(p.marketID), pos: Number(p.positionID), coef: Number(p.coef),
          chains: p.chains === true, disabled: !!p.disabledInTicket, locked: !!(p.locked || p.lockedInTicket), live: !!p.isLivePrice, matchName: String(p.matchName || "") }))
      };
    } catch (e) { return { fehler: String((e && e.message) || e) }; }
  }
  window.addEventListener("message", (e) => {
    try {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.source !== "ms-kombi" || d.kind !== "slipStand") return;
      window.postMessage({ source: "ms-kombi-inject", kind: "slipStand", id: d.id, stand: slipStand() }, "*");
    } catch (_) {}
  });

  function relay(reqBodyText, resText) {
    try {
      const rb = JSON.parse(reqBodyText);
      if (!rb || rb.name !== "createticketnew") return;
      let res; try { res = JSON.parse(resText); } catch (_) { res = {}; }
      let items = null, amount = null;
      try { const m = JSON.parse(rb.message); if (m && Array.isArray(m.Items)) { items = m.Items.map((x) => ({ itemId: String(x.ItemID), odd: x.Odd })); amount = m.Amount != null ? m.Amount : null; } } catch (_) {}
      window.postMessage({ source: "ms-kombi-inject", kind: "ticket", items, amount, result: { ID: res.ID, Status: res.Status, Tickets: res.Tickets, Errors: res.Errors, ts: Date.now() } }, "*");
    } catch (_) {}
  }
  // Das Script laeuft in JEDEM Frame — auch in fremden oder abgeschotteten, in denen fetch/XHR nicht ueberschreibbar sind.
  // Dort steigt es still aus (wie mystake-inject.js der Engine).
  try {
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      let body = null;
      try { const u = typeof input === "string" ? input : (input && input.url) || ""; if (/messagetosport/.test(u)) { const b = init && init.body; if (typeof b === "string" && /createticketnew/.test(b)) body = b; } } catch (_) {}
      const p = origFetch.apply(this, arguments);
      if (body != null) { try { p.then((r) => { try { r.clone().text().then((t) => relay(body, t)).catch(() => {}); } catch (_) {} }).catch(() => {}); } catch (_) {} }
      return p;
    };
    const oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { try { this.__msKombiUrl = u; } catch (_) {} return oOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (b) {
      try { if (/messagetosport/.test(String(this.__msKombiUrl || "")) && typeof b === "string" && /createticketnew/.test(b)) this.addEventListener("load", () => { try { relay(b, this.responseText); } catch (_) {} }); } catch (_) {}
      return oSend.apply(this, arguments);
    };
  } catch (_) {}
})();
