// trustdice-kombi-inject.js — MAIN-World auf trustdice.win.
// Geteilt und BYTE-GLEICH: Erweiterung (trustdice-kombi-inject.js) und Manometer Agent der External Bettors (engine/content/trustdice-kombi-inject.js).
// Gegenstueck im Content-Script: trustdice-kombi.js.
//
// Nur die Seiten-Welt erreicht den Speicher des BetBy-Widgets (Redux, ueber die React-Knoten). Dieses Script
//   * liest den Wettschein (Auswahlen, Quoten, Spiele, Einsatz, Grenzen des Buchs, angemeldet ja/nein; nie der Schluessel selbst),
//   * liest die Abgabe des Scheins und die Antwort des Buchs mit (Abruf .../bet/place),
//   * stellt „Quotenaenderungen nicht annehmen“ ein: Das Widget steht von Haus aus auf „any“ und nahme sonst auch schlechtere Quoten,
//   * traegt den Einsatz ins Feld des Kombi-Scheins ein (das letzte Einsatz-Feld, im Gast-Schein gemessen: es schreibt bets.combo.sum).
// Es gibt keine Wette ab und klickt nichts: Den Knopf drueckt das Content-Script, genau einmal.
(() => {
  "use strict";
  if (window.__tdKombiBruecke) return;
  window.__tdKombiBruecke = 1;
  let store = null, gefangen = null;

  function alle(wurzel) {
    const out = [], stapel = [wurzel];
    while (stapel.length) {
      const r = stapel.pop();
      let els; try { els = r.querySelectorAll("*"); } catch (_) { els = []; }
      for (const e of els) { out.push(e); if (e.shadowRoot) stapel.push(e.shadowRoot); }
    }
    return out;
  }
  function findeStore() {
    if (store) { try { if (store.getState().bets) return store; } catch (_) {} store = null; }
    for (const e of alle(document)) {
      const id = e.getAttribute && e.getAttribute("data-editor-id");
      if (!id) continue;
      const k = Object.keys(e).find((x) => x.startsWith("__reactFiber"));
      let f = k ? e[k] : null;
      for (let i = 0; f && i < 400; i++, f = f.return) {
        const p = f.memoizedProps;
        if (p && p.store && typeof p.store.getState === "function" && typeof p.store.dispatch === "function" && p.store.getState().bets) { store = p.store; return store; }
      }
      return null;   // ein Knoten des Widgets reicht: Alle haengen am selben Speicher
    }
    return null;
  }
  function stand() {
    const s = findeStore();
    if (!s) return { ok: false, gefangen };
    const st = s.getState(), b = st.bets || {}, ids = Array.isArray(b.betsQueue) ? b.betsQueue : [], c = b.combo || {};
    const legs = ids.map((id) => {
      const x = (b.byId && b.byId[id]) || {}, ev = x.event || {}, comp = Array.isArray(ev.competitors) ? ev.competitors : [];
      return { id: String(id), eventId: String(x.event_id == null ? "" : x.event_id), marketId: String(x.market_id == null ? "" : x.market_id), spec: String(x.specifiers == null ? "" : x.specifiers), outcomeId: String(x.outcome_id == null ? "" : x.outcome_id),
        k: x.k == null ? null : String(x.k), closed: !!x.closed, suspended: !!x.suspended, confirm: !!x.needConfirmation,
        home: comp[0] && comp[0].name ? String(comp[0].name) : "", away: comp[1] && comp[1].name ? String(comp[1].name) : "", ko: Number(ev.scheduled) > 0 ? Number(ev.scheduled) * 1000 : null, sportId: ev.sport && ev.sport.id != null ? String(ev.sport.id) : "" };
    });
    return { ok: true, tab: b.tabs && b.tabs.activeTabId, oc: b.acceptOddsChangesType, loading: !!b.loading, legs,
      combo: { sum: c.sum == null ? null : String(c.sum), error: c.error == null ? null : String(c.error && c.error.message ? c.error.message : c.error).slice(0, 160), minBet: c.minBet == null ? null : Number(c.minBet), maxBet: c.maxBet == null ? null : Number(c.maxBet), maxBetLoading: !!c.maxBetLoading },
      angemeldet: !!(st.app && st.app.token), gefangen };
  }
  function einsatz(text) {
    const felder = alle(document).filter((e) => e.tagName === "INPUT" && e.getAttribute("inputmode") === "decimal" && (e.offsetParent !== null || e.getClientRects().length > 0));
    const f = felder[felder.length - 1];
    if (!f) return false;
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(f), "value");
    if (!d || !d.set) return false;
    d.set.call(f, String(text));
    f.dispatchEvent(new Event("input", { bubbles: true }));
    f.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  // ---- Abgabe und Antwort mitlesen ------------------------------------------------------------------------------------------------
  const istAbgabe = (u) => /sptpub\.com\/api\/v\d+\/coupon\/brand\/\d+\/bet\/place(?:$|[?#])/.test(String(u || ""));
  function kurzAnfrage(text) {
    try {
      const j = JSON.parse(text), e = Array.isArray(j) ? j[0] : null;
      if (!e) return { form: "unbekannt" };
      return { type: String(e.type || ""), sum: String(e.sum == null ? "" : e.sum), k: String(e.k == null ? "" : e.k), oc: String(e.odds_change || ""), n: j.length,
        ids: (Array.isArray(e.selections) ? e.selections : []).map((x) => String(x.event_id) + "_" + String(x.market_id) + "_" + String(x.specifiers == null ? "" : x.specifiers) + "_" + String(x.outcome_id)) };
    } catch (_) { return { form: "unlesbar" }; }
  }
  function kurzAntwort(text) {
    try {
      const j = JSON.parse(text);
      const nimm = (l) => (Array.isArray(l) ? l : []);
      return { accepted: nimm(j && j.accepted).map((a) => ({ id: a && (a.bet_id || a.front_bet_id || a.id) ? String(a.bet_id || a.front_bet_id || a.id) : null, k: a && a.k != null ? String(a.k) : null, sum: a && a.sum != null ? String(a.sum) : null })),
        error: nimm(j && j.error).map((e) => ({ code: e && e.code != null ? String(e.code) : null, message: e && e.message ? String(e.message).slice(0, 200) : null })),
        slips: nimm(j && j.slips).map((x) => ({ accepted: !!(x && x.accepted), id: x && x.front_bet_id ? String(x.front_bet_id) : null, code: x && x.rm_code != null ? String(x.rm_code) : null })) };
    } catch (_) { return null; }
  }
  const merke = (body) => { gefangen = { ts: Date.now(), anfrage: kurzAnfrage(body), status: null, antwort: null, fehler: null }; return gefangen; };
  const f0 = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    let g = null;
    try { if (istAbgabe(url)) g = merke(init && init.body); } catch (_) {}
    const p = f0.apply(this, arguments);
    if (g) {
      p.then((r) => { g.status = r.status; return r.clone().text().then((t) => { g.antwort = kurzAntwort(t); }); }).catch((e) => { g.fehler = String((e && e.message) || e).slice(0, 160); });
    }
    return p;
  };
  const xOpen = XMLHttpRequest.prototype.open, xSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__tdKombiUrl = u; return xOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (istAbgabe(this.__tdKombiUrl)) {
        const g = merke(body);
        this.addEventListener("load", () => { g.status = this.status; g.antwort = kurzAntwort(this.responseText); });
        this.addEventListener("error", () => { g.fehler = "Netzfehler"; });
      }
    } catch (_) {}
    return xSend.apply(this, arguments);
  };

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== "td-kombi" || d.id == null) return;
    let a = {};
    try {
      if (d.kind === "quoten") { const s = findeStore(); if (s) s.dispatch({ type: "spt/bets/SET_ACCEPT_ODD_CHANGES", payload: "none" }); }
      else if (d.kind === "einsatz") a = { gesetzt: einsatz(d.text) };
      else if (d.kind === "vergessen") gefangen = null;
      a = Object.assign(a, { stand: stand() });
    } catch (err) { a = { fehler: String((err && err.message) || err).slice(0, 160), stand: { ok: false, gefangen } }; }
    window.postMessage(Object.assign({ source: "td-kombi-antwort", id: d.id }, a), location.origin);
  });
})();
