// stoiximan-place.js — PLACEMENT ONLY content script for Stoiximan (en.stoiximan.gr).
//
// Stoiximan runs the Kaizen/"Danae" sportsbook engine (same platform family as Betano). Two facts
// from the recon HAR drive this design:
//   1) Live prices arrive over a SignalR websocket (DanaeHub) — NOT replayable with a plain fetch,
//      so odds are read from the rendered DOM (like Tipwin), not from a read-only odds API.
//   2) The real placement POST /api/betslip/v3/place is gated by a login-auth check AND a Cloudflare
//      Turnstile token (cf-turnstile-response injected into the body). We do NOT mint that token or
//      bypass anything — placement goes through the page's own "Place bet" button so Stoiximan's own
//      anti-bot + auth run exactly as they do for a human. We only drive the UI and then VERIFY.
//
// Verification is API-solid: GET /api/bets/open (same-origin, session cookie). We snapshot open bets
// BEFORE placing and confirm a NEW open bet carrying the event's team name appears AFTER. Only then
// "placed"; otherwise "failed"/"uncertain" — never a phantom "placed" (operator's core rule).
//
// The engine never resolves events: the operator supplies bookRef.eventId (Stoiximan event id) and
// eventIdentity.{home,away}. This script opens what it is told and matches the selection by TEAM NAME
// inside the located market — removing the whole "wrong event" failure class.
//
// !!! FIRST-RUN DELTA  — three heuristics are best-effort from an
// empty-account HAR that structurally could not contain the rendered betslip. They FAIL SAFE (return
// blocked/uncertain, never a wrong bet). Confirm/adjust once against a real funded page:
//   A) PLACE_RX  — the "Place bet" button label (English site → "Place bet"; add the live wording).
//   B) STAKE_SEL — the stake <input> in the betslip.
//   C) market-title / selection-label wording per market (MARKET_TITLE_RX, DRAW_RX).
(() => {
  "use strict";
  const SCRIPT_VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return "?"; } })();
  if (window.__engineSxPlace) return;
  window.__engineSxPlace = SCRIPT_VERSION;

  const API = location.origin;                     // https://en.stoiximan.gr
  const IS_TOP = (window.top === window);

  // ---- (A) place button / (B) stake input / (C) market wording — the DELTA knobs -----------------
  const PLACE_RX  = /place\s*bet|place\s*wager|τοποθέτηση|στοίχημα|υποβολή/i;   // add live wording if it differs
  const STAKE_SEL = 'input[inputmode="decimal"], input[type="tel"], input[data-qa*="stake" i], input[name*="stake" i], input[placeholder*="stake" i], input[placeholder*="ποσό" i]';
  const DRAW_RX   = /^(x|draw|ισοπαλία)$/i;
  const MARKET_TITLE_RX = {
    // fb ml (1X2)
    "fb.ml.match":     /match\s*result|1x2|full\s*time\s*result|result\s*1x2|τελικό\s*αποτέλεσμα/i,
    "fb.ah.match":     /asian\s*handicap|handicap|χάντικαπ/i,
    // cs2 match ML
    "cs2.ml.match":    /match\s*(result|winner)|to\s*win\s*match|winner\s*2\s*way|νικητής\s*αγώνα/i,
    // cs2 map winner
    "cs2.mapWinner.map1": /map\s*1[^0-9].*(winner|result)|map\s*1\s*winner|χάρτης\s*1/i,
    "cs2.mapWinner.map2": /map\s*2[^0-9].*(winner|result)|map\s*2\s*winner|χάρτης\s*2/i,
    "cs2.mapWinner.map3": /map\s*3[^0-9].*(winner|result)|map\s*3\s*winner|χάρτης\s*3/i,
  };

  // ---- generic DOM toolkit (mirrors mystake-place.js) --------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, { timeout = 9000, interval = 200 } = {}) {
    const t0 = Date.now();
    for (;;) { let v; try { v = fn(); } catch (_) { v = null; } if (v) return v; if (Date.now() - t0 > timeout) return null; await sleep(interval); }
  }
  const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");
  const looksLikeOdd = (t) => /^\d{1,4}[.,]\d{1,2}$/.test((t || "").trim());
  const parseOdd = (t) => parseFloat(String(t).trim().replace(",", "."));
  function ownText(el) { let t = ""; for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue; return t.trim(); }
  function deepEls(root) {
    const out = [];
    const walk = (r) => { let list; try { list = r.querySelectorAll("*"); } catch (_) { return; } for (const e of list) { out.push(e); if (e.shadowRoot) walk(e.shadowRoot); } };
    walk(root); return out;
  }
  function isVisible(el) { try { return el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0); } catch (_) { return true; } }
  function clickableAncestor(el) {
    let n = el;
    for (let i = 0; i < 7 && n; i++) {
      if (n.tagName === "BUTTON" || n.tagName === "A" || (n.getAttribute && n.getAttribute("role") === "button")) return n;
      try { if (getComputedStyle(n).cursor === "pointer") return n; } catch (_) {}
      n = n.parentElement;
    }
    return el;
  }
  function realClick(el) {
    try {
      const r = el.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      for (const t of ["pointerover", "pointerenter", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        const E = (t.indexOf("pointer") === 0 && window.PointerEvent) ? PointerEvent : MouseEvent;
        el.dispatchEvent(new E(t, o));
      }
    } catch (_) { try { el.click(); } catch (__) {} }
  }
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value") || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  // Stake entry WITH read-back (widget can DISPLAY a value while its internal state stays empty).
  async function enterStakeVerified(input, str) {
    const nz = (v) => String(v == null ? "" : v).replace(",", ".").replace(/\s+/g, "");
    const want = nz(str);
    const taken = () => { const v = nz(input.value); if (!v) return false; const n = Number(v); return v === want || (n > 0 && Math.abs(n - Number(want)) < 1e-9); };
    setNativeValue(input, str); await sleep(350);
    if (taken()) return { ok: true, method: "native" };
    try { input.focus(); if (typeof input.select === "function") input.select(); document.execCommand("insertText", false, str); input.dispatchEvent(new Event("change", { bubbles: true })); } catch (_) {}
    await sleep(350);
    return taken() ? { ok: true, method: "insertText" } : { ok: false, value: String(input.value == null ? "" : input.value) };
  }

  // ---- event id from the URL (/live/<slug>/<id>/ or /.../<id>/) ----------------------------------
  function currentEventId() {
    let p = ""; try { p = (IS_TOP ? location : window.top.location).pathname; } catch (_) { p = location.pathname; }
    const m = p.match(/\/(\d{6,})(?:\/|$)/);
    return m ? m[1] : null;
  }

  // ---- read-back: GET /api/bets/open (session cookie) --------------------------------------------
  // Returns a flat list of { id, text } for every currently open bet, robust to shape drift.
  async function openBets() {
    let j;
    try {
      const r = await fetch(`${API}/api/bets/open`, { credentials: "include", headers: { accept: "application/json" }, cache: "no-store" });
      if (!r.ok) return { ok: false, http: r.status, bets: [] };
      j = await r.json();
    } catch (e) { return { ok: false, err: String((e && e.message) || e), bets: [] }; }
    const root = (j && j.data) ? j.data : j;
    let arr = (root && (root.bets || root.unsettledBets || root.openBets || root.coupons)) || [];
    if (!Array.isArray(arr)) arr = [];
    const flat = arr.map((b) => {
      let id = b && (b.id || b.betId || b.couponId || b.betslipId || b.code || b.trackId);
      let text = "";
      try { text = JSON.stringify(b); } catch (_) { text = String(b); }
      return { id: id != null ? String(id) : null, text: norm(text) };
    });
    return { ok: true, bets: flat };
  }
  const betKey = (b) => (b.id || b.text.slice(0, 60));

  // ---- login / balance guard (so a logged-out session fails clearly, not silently) ---------------
  async function sessionState() {
    try {
      const r = await fetch(`${API}/api/balance`, { credentials: "include", headers: { accept: "application/json" }, cache: "no-store" });
      if (r.status === 401 || r.status === 403) return { loggedIn: false };
      if (!r.ok) return { loggedIn: null };
      const j = await r.json();
      const root = (j && j.data) ? j.data : j;
      const bal = root && (root.balance != null ? root.balance : (root.total != null ? root.total : null));
      return { loggedIn: true, balance: bal != null ? Number(bal) : null };
    } catch (_) { return { loggedIn: null }; }
  }

  // ---- market + selection resolution (name-anchored) ---------------------------------------------
  function marketKey(p) {
    if (p.sport === "cs2" && p.mkt === "mapWinner") return "cs2.mapWinner." + String(p.scope || "map1");
    if (p.sport === "cs2") return "cs2.ml.match";
    if (p.sport === "fb" && p.mkt === "ah") return "fb.ah.match";
    return "fb.ml.match";
  }
  // The label we expect on the selection button: the team name for home/away, else 1/X/2 fallback.
  function wantedLabels(p) {
    const id = p.eventIdentity || {};
    const out = [];
    if (p.sel === "home" && id.home) out.push(norm(id.home));
    if (p.sel === "away" && id.away) out.push(norm(id.away));
    if (p.sport === "fb" && p.mkt === "ml") {
      if (p.sel === "home") out.push("1");
      if (p.sel === "draw") out.push("x", "draw");
      if (p.sel === "away") out.push("2");
    }
    return out.filter(Boolean);
  }
  // Find the market section whose heading matches, then the odd button inside it whose label matches
  // one of the wanted labels AND whose own odd is a number. Returns {btn, odd} or null.
  function findSelection(p) {
    const rx = MARKET_TITLE_RX[marketKey(p)];
    const wants = wantedLabels(p);
    if (!rx || !wants.length) return null;
    // candidate market containers: any element whose visible heading text matches rx
    const heads = deepEls(document).filter((e) => {
      if (!isVisible(e)) return false;
      const t = ownText(e); if (!t || t.length > 60) return false;
      return rx.test(t);
    });
    for (const h of heads) {
      // climb to a container that holds several odd cells
      let box = h;
      for (let i = 0; i < 5 && box.parentElement; i++) { box = box.parentElement; if (deepEls(box).filter((e) => looksLikeOdd(ownText(e))).length >= 2) break; }
      // every odd cell in this market
      const oddCells = deepEls(box).filter((e) => isVisible(e) && looksLikeOdd(ownText(e)));
      for (const cell of oddCells) {
        const btn = clickableAncestor(cell);
        const odd = parseOdd(ownText(cell));
        if (!isFinite(odd)) continue;
        // the selection label sits next to the odd inside the same button
        const label = norm(ownText(btn) || (btn.textContent || ""));
        const btnAll = norm(btn.textContent || "");
        const hit = wants.some((w) => w.length >= 2 ? btnAll.indexOf(w) >= 0 : label === w || btnAll === w);
        // for 1/X/2 single-char labels require an exact short label to avoid matching odds digits
        if (hit) return { btn, odd, market: ownText(h) };
      }
    }
    return null;
  }

  // ---- betslip helpers ---------------------------------------------------------------------------
  function stakeInput() {
    for (const el of deepEls(document)) { try { if (el.matches && el.matches(STAKE_SEL) && isVisible(el)) return el; } catch (_) {} }
    return null;
  }
  function placeButton() {
    let best = null;
    for (const el of deepEls(document)) {
      if (!isVisible(el)) continue;
      if (el.tagName !== "BUTTON" && !(el.getAttribute && el.getAttribute("role") === "button")) continue;
      const t = ownText(el) || (el.textContent || "");
      if (t && t.length <= 40 && PLACE_RX.test(t)) best = el;
    }
    return best;
  }
  function btnDisabled(b) {
    try { return !!(b.disabled || b.getAttribute("aria-disabled") === "true" || /(^|\s|-)(is-dis|disabled)/i.test(String(b.className || ""))); } catch (_) { return false; }
  }

  // ---- ROBUST API-Platzierung: Stoiximan Betslip v3 (HAR-verifiziert 06.09.) ---------------------
  // plain-leg → updatebets → place. Cookie-Auth der eingeloggten Session. plain-leg liefert die VOLLEN
  // server-gebauten legs (kein Rekonstruieren, kein Token-Minting, kein Turnstile im Bet-Call) — wir setzen
  // nur den Einsatz und geben sie weiter. place bestätigt selbst (accepted + betId). Nur 1X2/ML.
  const _API = location.origin;
  const _SLIP_H = { "content-type": "application/json", accept: "application/json" };
  const _selName = (sel) => sel === "home" ? "1" : sel === "draw" ? "X" : sel === "away" ? "2" : String(sel || "").toUpperCase();
  async function _matchOddsIds(eventId) {
    try {
      const r = await fetch(`${_API}/api/match-odds/-/${eventId}`, { credentials: "include", headers: { accept: "application/json" }, cache: "no-store" });
      if (!r.ok) return { err: "HTTP " + r.status };
      const j = await r.json(); const d = (j && j.data) ? j.data : j; const ev = d && d.event ? d.event : d;
      const markets = (ev && Array.isArray(ev.markets)) ? ev.markets : [];
      const mres = markets.find((m) => m && (m.type === "MRES" || m.typeId === 1 || /match\s*result/i.test(m.name || "")));
      if (!mres || !Array.isArray(mres.selections)) return { err: "kein MRES-Markt" };
      const ids = {}, all = {};
      for (const s of mres.selections) { const n = String(s.name || "").toUpperCase(); if (n === "1" || n === "X" || n === "2") { ids[n] = s.id || null; all[n] = Number(s.price) || null; } }
      return { ids, all };
    } catch (e) { return { err: String((e && e.message) || e) }; }
  }
  // ---- LIVE (04.10.2026): Auswahl-Nummern eines LAUFENDEN Spiels ----------------------------------
  // /api/match-odds/-/<id> ist die VORSPIEL-Schnittstelle: fuer ein laufendes Spiel fehlt dort der Markt MRES (gemessen
  // 04.10.2026 08:11 UTC: Live-Vorschlag → „kein MRES-Markt“, nichts gesetzt). Die Live-Seite liest je Spiel
  // GET /danae-webapi/api/live/events/<id>/latest mit den Kopfzeilen x-language 1 / x-operator 2 (Aufzeichnung 07.09.):
  // { event:{id,isLive,…}, markets:{<mid>:{type:"MRES",selectionIdList:[…]}}, selections:{<sid>:{id,name:"1"|"X"|"2",price}} }.
  const _LIVE_H = { accept: "application/json, text/plain, */*", "x-language": "1", "x-operator": "2" };
  async function _liveIds(eventId) {
    try {
      const r = await fetch(`${_API}/danae-webapi/api/live/events/${eventId}/latest`, { credentials: "include", headers: _LIVE_H, cache: "no-store" });
      if (!r.ok) return { err: "Live-Schnittstelle HTTP " + r.status };
      const j = await r.json(); const d = (j && j.data && j.data.event) ? j.data : j;
      const ev = d && d.event;
      if (!ev || String(ev.id) !== String(eventId)) return { err: "Live-Schnittstelle ohne dieses Spiel" };
      if (ev.isLive === false) return { err: "Spiel laeuft beim Buch nicht" };
      const maerkte = (d.markets && typeof d.markets === "object") ? Object.values(d.markets) : [];
      const mres = maerkte.find((m) => m && m.type === "MRES") || maerkte.find((m) => m && m.typeId === 1 && /match\s*result/i.test(m.name || ""));
      if (!mres || !Array.isArray(mres.selectionIdList)) return { err: "kein MRES-Markt (live) — gesperrt oder nicht angeboten" };
      const ids = {}, all = {}, sel = (d.selections && typeof d.selections === "object") ? d.selections : {};
      for (const sid of mres.selectionIdList) { const x = sel[sid]; if (!x) continue; const n = String(x.name || "").toUpperCase(); if (n === "1" || n === "X" || n === "2") { ids[n] = x.id || sid; all[n] = Number(x.price) || null; } }
      return { ids, all };
    } catch (e) { return { err: String((e && e.message) || e) }; }
  }

  // ---- Antwort des Buchs auswerten (04.10.2026) ---------------------------------------------------
  // So verfaehrt die Seite selbst mit der place-Antwort (main-Bundle: checkBetslipResponse / pollStatus, gelesen 04.10.):
  //   data.accepted              → gesetzt (receipts[0].betId)
  //   data.pending               → das Buch WARTET (Live-Verzoegerung oder Pruefung): mit data.uniqueId jede Sekunde
  //                                POST /api/betslip/v3/placed/<uniqueId> { betslip:<derselbe Schein>, fbt:<fullbetId> },
  //                                bis accepted oder ein Fehler kommt
  //   data.pending + counterOffer→ Gegenangebot des Buchs; die Seite fragt den Betreiber. Wir nehmen es NIE an.
  //   HTTP 422 / data.errors     → abgelehnt
  //   HTTP 502                   → nachfragen (bis 10x alle 3 s)
  // Vorher endete alles ohne „accepted“ als „uncertain“ — auch eine Absage (HTTP 422) und jede Live-Wette (pending).
  // Bleibt das Ergebnis offen, entscheidet der Abgleich mit /api/bets/open (Stand VOR dem Senden gemerkt): eine NEUE
  // offene Wette auf dieses Spiel = gesetzt. Sonst „uncertain“ — nie eine erfundene Platzierung, nie ein stilles „nicht gesetzt“.
  // WARTEN OHNE ZEITGEBER IN DER SEITE: Chrome drosselt die Zeitgeber eines verdeckten Tabs (nach 5 min auf einmal je
  // Minute). Deshalb wartet hier nichts. Ist das Ergebnis noch offen, antwortet dieses Script mit
  // { status:"pending", warteId, nachMs } — der Service Worker der Engine (books/stoiximan.js) wartet und schickt dann
  // sxNachfragen. Jeder Aufruf macht genau EINEN Abruf.
  const POLL_MS = 1000, POLL_MAX_MS = 30000, POLL_502_MS = 3000, POLL_502_MAX = 10, ABGLEICH_MS = 1500, ABGLEICH_MAX = 3;
  const _wartend = new Map();                          // warteId → Stand eines Scheins, dessen Ergebnis noch offen ist
  let _warteNr = 0;
  async function _slipSend(pfad, body) {
    const r = await fetch(`${_API}${pfad}`, { method: "POST", credentials: "include", headers: _SLIP_H, cache: "no-store", body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (_) {}
    return { http: r.status, j };
  }
  async function _neueWette(k) {
    const jetzt = await openBets();
    if (!k.vorOk || !jetzt.ok) return { lesbar: false, treffer: null };
    const neu = (jetzt.bets || []).filter((b) => !k.vorKeys.has(betKey(b)));
    return { lesbar: true, treffer: neu.find((b) => b.text.indexOf(String(k.eventId)) >= 0) || null };
  }
  const _felder = (o) => (o && typeof o === "object") ? Object.keys(o).slice(0, 14).join(",") : "—";
  const _perKonto = (z, t, text) => ({ status: "placed", odds: z.k.curOdds, ticket: t.id || null, ticketId: t.id || null, verified: true, reason: text + (t.id ? " (id " + t.id + ")" : "") });
  // Liest EINE Antwort des Buchs. Rueckgabe: { ende:<Endergebnis> } | { absage:<Text> } | { nach:<ms> } | { abgleich:<warum offen> }.
  function _lies(z, a) {
    const d = a && a.j && a.j.data;
    if (d && d.accepted && Array.isArray(d.receipts) && d.receipts.length) {
      const rc = d.receipts[0];
      return { ende: { status: "placed", odds: Number(rc.totalOdds) || z.k.curOdds, ticket: String(rc.betId || ""), ticketId: String(rc.betId || ""), reason: "Stoiximan Betslip v3 accepted (betId " + rc.betId + ")" + (z.gewartet ? " nach " + z.gewartet + " Nachfrage(n)" : "") } };
    }
    if (d && d.pending) {
      if (d.counterOffer) return { ende: { status: "failed", reason: "Gegenangebot des Buchs (anderer Einsatz oder andere Quote) — nicht angenommen, nichts gesetzt" } };
      if (d.uniqueId) z.uid = String(d.uniqueId);
      if (d.fullbetId) z.fbt = d.fullbetId;
      if (!z.uid) return { abgleich: "Buch wartet, nennt aber keine Nachfrage-Nummer" };
      if (Date.now() - z.t0 >= POLL_MAX_MS) return { abgleich: "Buch wartet nach " + Math.round((Date.now() - z.t0) / 1000) + " s noch" };
      return { nach: POLL_MS };
    }
    const fehler = (d && Array.isArray(d.errors) && d.errors.length) ? d.errors : ((a && a.j && Array.isArray(a.j.errors) && a.j.errors.length) ? a.j.errors : null);
    if (fehler || (a && a.http === 422)) return { absage: fehler ? JSON.stringify(fehler).slice(0, 180) : "HTTP 422" };
    if (a && a.http === 502 && z.uid && z.n502 < POLL_502_MAX && Date.now() - z.t0 < POLL_MAX_MS) { z.n502++; return { nach: POLL_502_MS }; }
    return { abgleich: a && a.netz ? "Netzfehler: " + a.netz : "unklare Antwort (HTTP " + (a && a.http) + ", Felder: " + _felder(d || (a && a.j)) + ")" };
  }
  // Setzt eine gelesene Antwort um: Endergebnis oder „spaeter nachfragen“.
  async function _weiter(z, a) {
    const e = _lies(z, a);
    if (e.ende) { _wartend.delete(z.id); return e.ende; }
    if (e.absage) {
      // Absage. Zur Sicherheit gegen das Konto pruefen: steht trotzdem eine neue Wette auf das Spiel da, zaehlt die.
      _wartend.delete(z.id);
      const rb = await _neueWette(z.k);
      if (rb.treffer) return _perKonto(z, rb.treffer, "Antwort des Buchs war eine Absage, im Konto steht aber eine neue Wette auf dieses Spiel");
      return { status: "failed", reason: "place abgelehnt: " + e.absage };
    }
    if (e.nach) { z.gewartet++; _wartend.set(z.id, z); return { status: "pending", warteId: z.id, nachMs: e.nach }; }
    z.offen = e.abgleich; z.abgleiche = 0;
    return await _abgleich(z);
  }
  // Ergebnis offen → Konto fragen (bis zu dreimal im Abstand von 1,5 s; die Wette erscheint manchmal verzoegert).
  async function _abgleich(z) {
    z.abgleiche++;
    const rb = await _neueWette(z.k);
    if (rb.treffer) { _wartend.delete(z.id); return _perKonto(z, rb.treffer, "per Abgleich mit den offenen Wetten bestaetigt — " + z.offen); }
    if (rb.lesbar && z.abgleiche < ABGLEICH_MAX) { _wartend.set(z.id, z); return { status: "pending", warteId: z.id, nachMs: ABGLEICH_MS }; }
    _wartend.delete(z.id);
    return { status: "uncertain", reason: "place: " + z.offen + " — im Konto prüfen" };
  }
  // Befehl sxNachfragen: ein weiterer Schritt fuer einen wartenden Schein.
  async function nachfragen(warteId) {
    const z = _wartend.get(String(warteId));
    if (!z) return { status: "uncertain", reason: "wartender Schein nicht mehr bekannt (Seite neu geladen?) — im Konto prüfen" };
    if (z.offen != null) return await _abgleich(z);
    let a;
    try { a = await _slipSend("/api/betslip/v3/placed/" + encodeURIComponent(z.uid), Object.assign({ betslip: z.slip }, z.fbt ? { fbt: z.fbt } : {})); }
    catch (e) { a = { netz: String((e && e.message) || e) }; }
    return await _weiter(z, a);
  }

  async function placeViaApi(p, stakeEur, minOdds) {
    const eventId = String((p.bookRef && p.bookRef.eventId) || "");
    if (!eventId || eventId === "undefined") return { status: "blocked", reason: "stoiximan: bookRef.eventId fehlt" };
    const t = _selName(p.sel);
    if (!/^[1X2]$/.test(t)) return { status: "blocked", reason: "stoiximan API nur 1X2 (sel=" + p.sel + ")" };
    // Live-Vorschlag → NUR die Live-Schnittstelle, Vorspiel-Vorschlag → NUR die Vorspiel-Schnittstelle. Kein Ausweichen:
    // ein laufendes Spiel wird nie zu einer Quote von vor dem Anpfiff gesetzt, ein Vorspiel-Vorschlag nie im laufenden Spiel.
    const live = p.live === true;
    const mo = live ? await _liveIds(eventId) : await _matchOddsIds(eventId);
    if (mo.err) return { status: "blocked", reason: "Quoten/IDs nicht lesbar: " + mo.err };
    const selId = mo.ids && mo.ids[t]; if (!selId) return { status: "blocked", reason: "keine Selection-ID für " + t };
    if (live && !(mo.all && mo.all[t] > 1)) return { status: "blocked", reason: "keine Live-Quote für " + t + " (Markt gesperrt?)" };
    if (mo.all && mo.all[t] && mo.all[t] < minOdds) return { status: "blocked", reason: `Odds ${mo.all[t]} unter Min ${minOdds}. Nicht gesetzt.` };
    return await _ueberSchein(eventId, selId, live, stakeEur, minOdds);
  }
  // Der Wettschein-Weg fuer EINE Auswahl-Nummer: plain-leg -> updatebets -> place (04.10.2026 aus placeViaApi herausgeloest,
  // damit Fussball-1X2 und der Sieger-Markt anderer Sportarten denselben, einzigen Absende-Weg nehmen).
  async function _ueberSchein(eventId, selId, live, stakeEur, minOdds) {
    const emptySlip = { hash: "", slipData: "", legs: [], bets: [], betslipTabId: 1, betslipTrackId: "" };
    let leg;
    try {
      const r = await fetch(`${_API}/api/betslip/v3/plain-leg/`, { method: "POST", credentials: "include", headers: _SLIP_H, cache: "no-store",
        // triggerPoint = wo die Auswahl angeklickt wurde (Seiten-Code): 6/1 = Top-Spiele der Startseite (Aufzeichnung 06.09.),
        // 10/3 = Maerkte auf der Live-Spielseite.
        body: JSON.stringify({ selectionIds: [String(selId)], betslip: emptySlip, eventId: eventId, triggerPoint: live ? { origin: 10, parentOrigin: 3 } : { origin: 6, parentOrigin: 1 } }) });
      if (!r.ok) return { status: "blocked", reason: "plain-leg HTTP " + r.status };
      leg = (await r.json()).data;
    } catch (e) { return { status: "uncertain", reason: "plain-leg Netzfehler: " + String((e && e.message) || e) + " — im Konto prüfen" }; }
    if (!leg || !Array.isArray(leg.bets) || !leg.bets.length) return { status: "blocked", reason: "plain-leg ohne bets" + (leg && leg.errors && leg.errors.length ? " (" + JSON.stringify(leg.errors).slice(0, 140) + ")" : "") };
    const curOdds = Number((leg.bets[0] && leg.bets[0].odds) || (leg.legs && leg.legs[0] && leg.legs[0].odds) || 0);
    if (curOdds && curOdds < minOdds) return { status: "blocked", reason: `Odds ${curOdds} unter Min ${minOdds} (plain-leg). Nicht gesetzt.` };
    // 26.09.2026: Stoiximan hat die Wettschein-API verschaerft (gleiche Aenderung wie in stoiximan-content.js des Haupt-Agenten).
    // Alte Form → HTTP 200 {errors:["Bad Request"]} → „updatebets ohne slip". Mitgeschnitten an einer echten Betreiber-Wette:
    // updatebets = Schein UNVERAENDERT + betslipTabId/betslipTrackId + geaenderte Wetten als eigenes Feld `bets`;
    // place = zusaetzlich betslipTabId/betslipTrackId und `oddschanges` ("0" keine Aenderung annehmen, "1" hoehere, "2" alle).
    const tabId = leg.betSlipTabId || leg.betslipTabId || 1, trackId = leg.betslipTrackId || "";
    const neueBets = leg.bets.map((b) => Object.assign({}, b, { amount: Number(stakeEur) }));
    let upd;
    try {
      const r = await fetch(`${_API}/api/betslip/v3/updatebets`, { method: "PATCH", credentials: "include", headers: _SLIP_H, cache: "no-store",
        body: JSON.stringify({ betslip: { hash: leg.hash, slipData: leg.slipData, legs: leg.legs, bets: leg.bets, betslipTabId: tabId, betslipTrackId: trackId }, bets: neueBets }) });
      if (!r.ok) return { status: "blocked", reason: "updatebets HTTP " + r.status };
      const uj = await r.json();
      upd = uj && uj.data;
      if (!upd || !upd.hash) return { status: "blocked", reason: "updatebets ohne slip" + (uj && uj.errors ? ": " + JSON.stringify(uj.errors).slice(0, 120) : "") };
    } catch (e) { return { status: "uncertain", reason: "updatebets Netzfehler: " + String((e && e.message) || e) + " — im Konto prüfen" }; }
    if (upd.errors && upd.errors.length) return { status: "blocked", reason: "updatebets: " + JSON.stringify(upd.errors).slice(0, 160) };
    const updOdds = Number((upd.bets && upd.bets[0] && upd.bets[0].odds) || 0);
    if (updOdds && updOdds < minOdds) return { status: "blocked", reason: `Odds ${updOdds} unter Min ${minOdds} (updatebets). Nicht gesetzt.` };
    const slip = { hash: upd.hash, slipData: upd.slipData, legs: upd.legs, bets: upd.bets, betslipTabId: upd.betSlipTabId || upd.betslipTabId || tabId, betslipTrackId: upd.betslipTrackId || trackId };
    const vorher = await openBets();                   // Stand der offenen Wetten VOR dem Senden (Grundlage des Abgleichs)
    const k = { eventId, curOdds: updOdds || curOdds, vorOk: !!vorher.ok, vorKeys: new Set((vorher.bets || []).map(betKey)) };
    const z = { id: "w" + (++_warteNr) + "-" + Date.now().toString(36), slip, k, t0: Date.now(), uid: null, fbt: null, n502: 0, gewartet: 0, offen: null, abgleiche: 0 };
    let erste;
    // oddschanges "0": keine Quotenaenderung annehmen (vorsichtigste Stufe) — aendert sich die Quote, lehnt Stoiximan ab.
    // EINZIGER Absende-Aufruf; alles danach fragt nur noch nach (placed/<uniqueId>) oder liest (bets/open).
    try { erste = await _slipSend("/api/betslip/v3/place", { betslip: Object.assign({}, slip, { oddschanges: "0" }) }); }
    catch (e) { erste = { netz: String((e && e.message) || e) }; }
    return await _weiter(z, erste);
  }

  // ---- SIEGER-MARKT ANDERER SPORTARTEN (04.10.2026, Basketball) -----------------------------------
  //
  // Basketball: Markt „Winner" (type H2HT, typeId 155) — 2-Weg INKLUSIVE Verlaengerung, dieselbe Wette wie die Pinnacle-
  // Moneyline. Gemessen 04.10.2026 (oeffentliche Antworten): live traegt ihn /danae-webapi/api/live/events/<id>/latest in
  // markets{} mit selectionIdList; vor dem Anpfiff steht er in /api/match-odds/-/<id> NICHT in event.markets, sondern in
  // event.sixPackLayout.columns[] (Sieger / Handicap FHOT / Punkte FTPO). Halbzeit- und Viertel-Maerkte (2DNB, H2RS, T4DN …)
  // haben andere Typen und werden nie genommen.
  // AUSWAHL: der Operator nennt die GENAUE Auswahl-Nummer des Buchs (bookRef.outcomeId). home/away wird hier nie in eine
  // Seite des Buchs uebersetzt — das Buch kann die Mannschaften andersherum fuehren. Die Nummer muss frisch gelesen im
  // Sieger-Markt DIESES Spiels stehen; ihr Preis muss die Mindestquote halten. Ohne Nummer wird nicht gesetzt.
  // Nur ueber die Wettschein-Schnittstelle (kein Klick-Weg): derselbe Absende-Weg wie Fussball (_ueberSchein).
  const SIEGER = { basket: { sportId: "BASK", typ: "H2HT", typeId: 155, name: "Basketball" } };
  // PURE: alle Markt-Objekte eines Typs mit Auswahl-Liste, wo immer sie in der Antwort stehen (je Markt-Nummer einmal).
  function _maerkteTief(wurzel, typ) {
    const fund = new Map();
    (function w(o, t) {
      if (!o || typeof o !== "object" || t > 8) return;
      if (o.type === typ && Array.isArray(o.selections) && o.id != null) fund.set(String(o.id), o);
      for (const k in o) { const v = o[k]; if (v && typeof v === "object") w(v, t + 1); }
    })(wurzel, 0);
    return [...fund.values()];
  }
  // PURE: Antwort der Vorspiel-Schnittstelle -> { markt, auswahlen:{<Nr>:{preis,name}} } | { err }.
  function _vorSiegerAus(j, eventId, S, jetzt) {
    const d = (j && j.data) ? j.data : j, ev = d && d.event;
    if (!ev || String(ev.id) !== String(eventId)) return { err: "Vorspiel-Schnittstelle ohne dieses Spiel" };
    if (String(ev.sportId) !== S.sportId) return { err: "kein " + S.name + " (" + String(ev.sportId) + ")" };
    if (ev.isLive === true || !(Number(ev.startTime) > jetzt)) return { err: "Spiel laeuft schon oder Anstoss unbekannt — Vorspiel-Vorschlag nur vor dem Anpfiff" };
    const ms = _maerkteTief(ev, S.typ);
    if (ms.length !== 1) return { err: ms.length ? "mehrere Sieger-Maerkte" : "kein Sieger-Markt (" + S.typ + ") — gesperrt oder nicht angeboten" };
    const m = ms[0];
    if (Number(m.typeId) !== S.typeId) return { err: "Sieger-Markt mit unerwarteter Art (" + String(m.typeId) + ")" };
    const sel = (m.selections || []).filter((x) => x && x.id != null);
    if (sel.length !== 2 || (m.selections || []).length !== 2) return { err: "Sieger-Markt hat nicht genau zwei Auswahlen" };
    const aus = {};
    for (const x of sel) { if (!(Number(x.price) > 1)) return { err: "Auswahl ohne Quote (Markt gesperrt?)" }; aus[String(x.id)] = { preis: Number(x.price), name: String(x.name || "") }; }
    if (Object.keys(aus).length !== 2) return { err: "Sieger-Markt hat nicht genau zwei Auswahlen" };
    return { markt: String(m.id), auswahlen: aus };
  }
  // PURE: Antwort der Live-Schnittstelle -> { markt, auswahlen } | { err }.
  function _liveSiegerAus(j, eventId, S) {
    const d = (j && j.data && j.data.event) ? j.data : j, ev = d && d.event;
    if (!ev || String(ev.id) !== String(eventId)) return { err: "Live-Schnittstelle ohne dieses Spiel" };
    if (String(ev.sportId) !== S.sportId) return { err: "kein " + S.name + " (" + String(ev.sportId) + ")" };
    if (ev.isLive !== true) return { err: "Spiel laeuft beim Buch nicht — Live-Vorschlag nur im laufenden Spiel" };
    if (ev.isSuspended === true) return { err: "Spiel gesperrt" };
    const ms = ((d.markets && typeof d.markets === "object") ? Object.values(d.markets) : []).filter((m) => m && m.type === S.typ);
    if (ms.length !== 1) return { err: ms.length ? "mehrere Sieger-Maerkte" : "kein Sieger-Markt (" + S.typ + ", live) — gesperrt oder nicht angeboten" };
    const m = ms[0];
    if (m.isSuspended === true) return { err: "Sieger-Markt gesperrt" };
    if (Number(m.typeId) !== S.typeId) return { err: "Sieger-Markt mit unerwarteter Art (" + String(m.typeId) + ")" };
    const liste = Array.isArray(m.selectionIdList) ? m.selectionIdList : [], alle = (d.selections && typeof d.selections === "object") ? d.selections : {};
    if (liste.length !== 2) return { err: "Sieger-Markt hat nicht genau zwei Auswahlen" };
    const aus = {};
    for (const sid of liste) { const x = alle[sid]; if (!x || !(Number(x.price) > 1)) return { err: "Auswahl ohne Quote (Markt gesperrt?)" }; aus[String(x.id != null ? x.id : sid)] = { preis: Number(x.price), name: String(x.name || "") }; }
    if (Object.keys(aus).length !== 2) return { err: "Sieger-Markt hat nicht genau zwei Auswahlen" };
    return { markt: String(m.id), auswahlen: aus };
  }
  async function _siegerLesen(eventId, live, S) {
    try {
      const r = live
        ? await fetch(`${_API}/danae-webapi/api/live/events/${eventId}/latest`, { credentials: "include", headers: _LIVE_H, cache: "no-store" })
        : await fetch(`${_API}/api/match-odds/-/${eventId}`, { credentials: "include", headers: { accept: "application/json" }, cache: "no-store" });
      if (!r.ok) return { err: (live ? "Live-Schnittstelle" : "Vorspiel-Schnittstelle") + " HTTP " + r.status + " (Seite " + location.hostname + ")" };
      const j = await r.json();
      return live ? _liveSiegerAus(j, eventId, S) : _vorSiegerAus(j, eventId, S, Date.now());
    } catch (e) { return { err: String((e && e.message) || e) }; }
  }
  async function placeViaApiNr(p, stakeEur, minOdds) {
    const S = Object.prototype.hasOwnProperty.call(SIEGER, String(p.sport)) ? SIEGER[String(p.sport)] : null;
    if (!S) return { status: "blocked", reason: "stoiximan: Sportart " + String(p.sport) + " nicht unterstuetzt" };
    if ((p.mkt || "ml") !== "ml") return { status: "blocked", reason: "stoiximan: Markt " + String(p.mkt) + " nicht unterstuetzt" };
    if (p.sel !== "home" && p.sel !== "away") return { status: "blocked", reason: "stoiximan: ungueltige Auswahl " + String(p.sel) + " (Sieger-Markt hat nur home/away)" };
    const eventId = String((p.bookRef && p.bookRef.eventId) || "");
    if (!/^\d{1,15}$/.test(eventId)) return { status: "blocked", reason: "stoiximan: bookRef.eventId fehlt oder unlesbar" };
    const nr = String((p.bookRef && p.bookRef.outcomeId) == null ? "" : p.bookRef.outcomeId);
    if (!/^\d{1,20}$/.test(nr)) return { status: "blocked", reason: "stoiximan: bookRef.outcomeId fehlt (ohne genaue Auswahl-Nummer des Operators wird nicht gesetzt)" };
    if (!(Number(minOdds) > 1)) return { status: "blocked", reason: "stoiximan: minOdds fehlt" };
    const live = p.live === true;
    const mo = await _siegerLesen(eventId, live, S);
    if (mo.err) return { status: "blocked", reason: "Quoten/IDs nicht lesbar: " + mo.err };
    const a = mo.auswahlen[nr];
    if (!a) return { status: "blocked", reason: "Auswahl-Nummer gehoert nicht (mehr) zum Sieger-Markt dieses Spiels" };
    if (a.preis < Number(minOdds)) return { status: "blocked", reason: `Odds ${a.preis} unter Min ${minOdds}. Nicht gesetzt.` };
    return await _ueberSchein(eventId, nr, live, stakeEur, Number(minOdds));
  }

  // ---- placement ---------------------------------------------------------------------------------
  async function place(p, stakeEur, minOdds) {
    const id = p.eventIdentity || {};
    // 0) session
    const ss = await sessionState();
    if (ss.loggedIn === false) return { status: "blocked", reason: "Stoiximan session not logged in (balance API 401/403). Log in first." };

    // 1) find the selection button (name-anchored) and price-check off the DOM odd
    const found = await waitFor(() => findSelection(p), { timeout: 8000 });
    if (!found) return { status: "blocked", reason: `Selection not found on page (market "${marketKey(p)}", team "${p.sel === "home" ? id.home : id.away || p.sel}"). Market may be collapsed or wording differs — see DELTA(C).` };
    if (!isFinite(found.odd)) return { status: "blocked", reason: "Odd not readable on the selection button." };
    if (found.odd < minOdds) return { status: "blocked", reason: `Odds ${found.odd} below min ${minOdds}. Not placed.` };

    // 2) snapshot open bets BEFORE (read-back baseline)
    const before = await openBets();
    const beforeKeys = new Set((before.bets || []).map(betKey));

    // 3) click the selection into the betslip
    realClick(found.btn); await sleep(800);

    // 4) stake
    const input = await waitFor(() => stakeInput(), { timeout: 7000 });
    if (!input) return { status: "blocked", reason: "Stake input not found in betslip — see DELTA(B). Nothing sent." };
    const st = await enterStakeVerified(input, String(stakeEur));
    if (!st.ok) return { status: "blocked", reason: `Stake did not register (field shows ${JSON.stringify(st.value)}). Nothing sent.` };

    // 5) place button must be present & enabled; re-check odd on the button one last time
    const btn = await waitFor(() => { const b = placeButton(); return (b && !btnDisabled(b)) ? b : null; }, { timeout: 9000 });
    if (!btn) { const b0 = placeButton(); return { status: "blocked", reason: b0 ? "Place button stayed disabled (stake/odds/limit) — nothing sent." : "Place button not found — see DELTA(A). Nothing sent." }; }
    const recheck = findSelection(p);
    if (recheck && isFinite(recheck.odd) && recheck.odd < minOdds) return { status: "blocked", reason: `Odds moved to ${recheck.odd} (< ${minOdds}) before submit. Not placed.` };

    // 6) submit — the site's own Turnstile + auth run here (we do not bypass them)
    realClick(btn);

    // 7) VERIFY via /api/bets/open — only a NEW open bet carrying the team name counts as placed
    const teamNorm = norm(id.home || "") + "|" + norm(id.away || "");
    const teamTokens = [norm(id.home || ""), norm(id.away || "")].filter((t) => t && t.length >= 3);
    const confirmed = await waitFor(async () => {
      const now = await openBets();
      if (!now.ok) return null;
      const fresh = (now.bets || []).filter((b) => !beforeKeys.has(betKey(b)));
      if (!fresh.length) return null;
      // prefer a fresh bet that mentions a team; if names unknown, any single fresh bet counts
      const named = fresh.find((b) => teamTokens.some((t) => b.text.indexOf(t) >= 0));
      if (named) return named;
      if (teamTokens.length === 0 && fresh.length === 1) return fresh[0];
      return null;
    }, { timeout: 14000, interval: 900 });

    if (confirmed) return { status: "placed", odds: found.odd, ticketId: confirmed.id || null, reason: `Confirmed in open bets${confirmed.id ? " (id " + confirmed.id + ")" : ""}.` };

    // no confirmation — POSSIBLY placed. Never claim "placed".
    const after = await openBets();
    const grew = after.ok && before.ok && (after.bets.length > before.bets.length);
    return { status: "uncertain", reason: `Clicked place but no matching new open bet within 14s${grew ? " (open-bet count DID grow — likely placed, verify history)" : ""}. teams=${teamNorm}. Check bet history.` };
  }

  // ---- message protocol (adapter opened the right event page already) ----------------------------
  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (!msg || !msg.cmd) return false;
    // 1.2.69 (05.10.2026) — NUR DER OBERSTE RAHMEN ANTWORTET, auf JEDEN Befehl (Kit 50-fallen.md P24). Dieses Script sitzt in
    // ALLEN Rahmen des Tabs (books/stoiximan.js spritzt mit allFrames ein) — auch in den leeren Hilfsrahmen der Seite
    // (about:blank, gemessen 05.10.2026: der des Cookie-Banners, „ot-text-resize“). Dort ist location.origin "null", jeder
    // Abruf geht ins Leere (HTTP 404), und diese Absage kam VOR der Antwort des obersten Rahmens bei der Engine an
    // (chrome.tabs.sendMessage nimmt die ERSTE Antwort): am 04.10.2026 endete so jede Live-Wette mit „Quoten/IDs nicht
    // lesbar: Live-Schnittstelle HTTP 404“ — der oberste Rahmen arbeitete den Schein derweil weiter ab, sein Ergebnis sah
    // die Engine nicht mehr. Bis 1.2.68 galt die Sperre nur fuer die Kombi-Befehle. (Wie mystake-place.js: dort antwortet
    // nur der Sportsbook-Rahmen.)
    // KOMBIWETTE (1.2.68): der Ablauf selbst steht in content/stoiximan-kombi.js (byte-gleich mit dem des Operators).
    if (!IS_TOP) return false;
    (async () => {
      try {
        if (msg.cmd === "sxKombiPing") return reply({ ok: true, top: true, version: SCRIPT_VERSION, host: location.hostname, kombi: (typeof SXKOMBI !== "undefined" && !!SXKOMBI && typeof SXKOMBI.place === "function" && typeof SXKOMBI.nachfragen === "function") });
        if (msg.cmd === "sxKombi" || msg.cmd === "sxKombiNachfragen") {
          if (typeof SXKOMBI === "undefined" || !SXKOMBI || typeof SXKOMBI.place !== "function") return reply({ status: "blocked", reason: "stoiximan: combo script not loaded — nothing sent" });
          if (msg.cmd === "sxKombiNachfragen") return reply(await SXKOMBI.nachfragen(msg.warteId));
          return reply(await SXKOMBI.place(msg, {}));
        }
        if (msg.cmd === "sxPing") return reply({ ok: true, eventId: currentEventId(), onEvent: !!currentEventId(), version: SCRIPT_VERSION, host: location.hostname });
        if (msg.cmd === "sxBalance") { const r = await fetch(`${API}/api/balance`, { credentials: "include", headers: { accept: "application/json" }, cache: "no-store" }); return reply(r.ok ? { ok: true, j: await r.json() } : { ok: false, http: r.status }); }   // 26.09.: Kontostand (books/stoiximan.js balance)
        if (msg.cmd === "sxNachfragen") return reply(await nachfragen(msg.warteId));
        if (msg.cmd === "sxPlace") {
          const p = msg.proposal || msg;
          const minO = msg.minOdds != null ? msg.minOdds : p.minOdds;
          // Sieger-Markt anderer Sportarten (Basketball): nur ueber die Wettschein-Schnittstelle mit der Auswahl-Nummer des
          // Operators — kein Klick-Weg, kein Rueckfall. Eine Sportart, die hier niemand kennt, wird nie gesetzt.
          if (Object.prototype.hasOwnProperty.call(SIEGER, String(p.sport))) return reply(await placeViaApiNr(p, msg.amount, minO));
          if (p.sport && p.sport !== "fb" && p.sport !== "cs2") return reply({ status: "blocked", reason: "stoiximan: Sportart " + String(p.sport) + " nicht unterstuetzt" });
          const is1x2 = (!p.mkt || p.mkt === "ml") && (p.sport === "fb" || !p.sport);
          if (is1x2) {
            const api = await placeViaApi(p, msg.amount, minO);       // Betslip-v3-API zuerst (robust)
            // LIVE: kein DOM-Rueckfall — der Tab steht nicht auf dem Spiel, und in diesen Sekunden laeuft die Quote weg.
            // pending = das Buch wartet noch; die Engine fragt mit sxNachfragen weiter (kein DOM-Rueckfall auf einen offenen Schein).
            if (p.live === true || (api && (api.status === "placed" || api.status === "uncertain" || api.status === "pending"))) return reply(api);
            const dom = await place(p, msg.amount, minO);             // sauberer API-No-Bet → DOM-Fallback
            return reply((dom && dom.status === "placed") ? dom : (api && api.status ? api : dom));
          }
          return reply(await place(p, msg.amount, minO));             // CS2/AH: weiterhin DOM
        }
        reply({ error: "unknown cmd" });
      } catch (e) { reply({ status: "uncertain", reason: "content script exception: " + String((e && e.message) || e) }); }
    })();
    return true;
  });
})();
