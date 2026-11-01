// trustdice-kombi.js — KOMBIWETTE bei TrustDice (BetBy / sptpub).
// Geteilt und BYTE-GLEICH: Erweiterung (trustdice-kombi.js, vor trustdice-content.js geladen, auch im Service Worker) und Manometer Agent
// (engine/content/trustdice-kombi.js). Stellt TDKOMBI.place(msg, env), TDKOMBI.nachfragen(warteId) und die reinen Teile bereit.
//
// GELERNT (31.10., normaler Chrome, ALS GAST am echten Widget; ohne Anmeldung laesst sich dort nichts setzen):
//   * DER SCHEIN KOMMT UEBER DIE ADRESSE: Laedt die Seite mit ?btBets=[{eventId,marketId,specifier,outcomeId}, …] (JSON), legt das Widget genau diese
//     Auswahlen in den Schein, auch fuer Spiele, die auf der Seite gar nicht stehen, und holt die Quoten selbst. Danach nimmt es den Parameter aus der
//     Adresse. Gemessen mit Bundesliga + Serie A auf der Fussball-Startseite. Klicken je Bein ueber mehrere Seiten entfaellt.
//   * Ab zwei Auswahlen steht der Schein von selbst auf „combo“. Die Nummer einer Auswahl im Speicher des Widgets: <Spiel>_<Markt>_<Specifier>_<Ausgang>.
//   * Gesamtquote = genaues Produkt der Quoten (4,60 × 2,02 → „9.292“), angezeigter Gewinn = Einsatz × Gesamtquote (7,5 → 69,69).
//   * Einsatz: Es gibt je Auswahl ein Feld und zuletzt das Feld der Kombi; nur das letzte schreibt bets.combo.sum.
//   * Das Widget steht von Haus aus auf odds_change „any“ (Einstellung des Buchs, wird bei jedem Laden neu gesetzt): Schlechtere Quoten wuerden angenommen.
//     Darum stellt die Bruecke vor der Abgabe auf „none“ um (spt/bets/SET_ACCEPT_ODD_CHANGES) und liest es zurueck; nach dem Neuladen gilt wieder die Vorgabe des Buchs.
//   * KOMBI-BOOST: „Noch 2 Wetten bis zum x1.05-Boost auf deinen Gewinn“, Mindestquote je Auswahl 1,50. Er zaehlt NICHT fuer die Mindest-Gesamtquote (wie bei Superbet).
//   * Abgabe: Das SDK schickt POST …/coupon/brand/<brand>/bet/place mit Bearer-Schluessel, den ein eigener Abruf nicht hat (daher frueher 401). Darum drueckt dieser
//     Baustein den Knopf des Widgets. Angemeldet heisst er „WETTEN“; „BUCHEN“ ist nur ein Buchungscode, als Gast steht dort „EINLOGGEN“.
//   NICHT GEMESSEN (kein angemeldetes Konto): die Antwort auf eine Kombi, die Grenzen des Buchs (combo.minBet / maxBet) und der Knopf im angemeldeten Schein.
//   Die Antwort-Form stammt aus dem Code des Widgets (accepted[] / error[] / slips[]). Die erste echte Kombi setzt der Betreiber.
// SICHERUNGEN (fail-closed): Auftrags-Nummer Pflicht (derselbe Auftrag laeuft nie zweimal); im Schein stehen GENAU die Auswahlen des Auftrags; je Bein Mannschaften wie im
//   Auftrag, nicht angepfiffen, nicht gesperrt, Quote ≥ Mindestquote; Gesamtquote ≥ Mindest-Gesamtquote; Waehrung im Schein bekannt, kein Euro-Betrag in einem BTC-Feld;
//   Einsatz im Speicher des Widgets zurueckgelesen; „none“ zurueckgelesen; Grenzen des Buchs, soweit bekannt. armed:false endet vor dem Knopf („staged“), der Schein wird wieder geleert.
// OHNE ZEITGEBER IN DER SEITE (verdeckte Tabs werden gedrosselt): Jeder Aufruf macht einen Schritt und antwortet { status:"pending", warteId, nachMs }, der Service Worker wartet und fragt nach.
(() => {
  "use strict";
  const root = typeof self !== "undefined" ? self : globalThis;
  if (root.TDKOMBI && typeof root.TDKOMBI.beschaeftigt === "function" && root.TDKOMBI.beschaeftigt()) return;
  const VERSION = 1;
  const SPORT = { soccer: { markt: "1", aus: { "1": "1", X: "2", "2": "3" } }, basketball: { markt: "219", aus: { "1": "4", "2": "5" } } };
  const STARTSEITE = "https://trustdice.win/de/sports/soccer-1";
  const LADEN_MAX = 45, KLEIN_MAX = 12, ANTWORT_MAX = 90, OHNE_ABGABE_MAX = 14;
  const norm = (s) => String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");

  // ---- Rein ---------------------------------------------------------------------------------------------------------------------
  // Bein des Auftrags → Auswahl beim Buch. Fehlt etwas: { fehler }.
  function auswahl(L) {
    const sp = L && Object.prototype.hasOwnProperty.call(SPORT, String(L.sport || "soccer")) ? SPORT[String(L.sport || "soccer")] : null;
    if (!sp) return { fehler: "sport " + String(L && L.sport) + " is not connected for parlays" };
    if (!/^\d{10,22}$/.test(String(L.eventId == null ? "" : L.eventId))) return { fehler: "game number unreadable" };
    const aus = Object.prototype.hasOwnProperty.call(sp.aus, String(L.tip)) ? sp.aus[String(L.tip)] : null;
    if (!aus) return { fehler: "outcome " + String(L.tip) + " does not exist in this market" };
    return { eventId: String(L.eventId), marketId: sp.markt, specifier: "", outcomeId: aus, id: String(L.eventId) + "_" + sp.markt + "__" + aus };
  }
  function adresse(legs) {
    const a = legs.map(auswahl);
    const f = a.find((x) => x.fehler);
    if (f) return { fehler: f.fehler };
    return { url: STARTSEITE + "?btBets=" + encodeURIComponent(JSON.stringify(a.map((x) => ({ eventId: x.eventId, marketId: x.marketId, specifier: x.specifier, outcomeId: x.outcomeId })))) };
  }
  function gesamtQuote(legs) { return legs.reduce((p, L) => p * Number(L.k), 1); }
  // Liegt der Schein so, wie der Auftrag es will? null = ja, sonst der Grund. Prueft den Stand, den die Bruecke aus dem Speicher des Widgets liest.
  function scheinFehler(st, auftrag, jetzt) {
    if (!st || !st.ok) return "the widget's betslip is not readable";
    const legs = st.legs || [], soll = auftrag.legs.map(auswahl);
    const f = soll.find((x) => x.fehler);
    if (f) return f.fehler;
    if (legs.length !== soll.length) return "betslip has " + legs.length + " selections, the order " + soll.length;
    if (st.tab !== "combo") return "betslip is not on the combo tab (" + String(st.tab) + ")";
    for (let i = 0; i < soll.length; i++) {
      const s = soll[i], L = legs.find((x) => x.id === s.id), A = auftrag.legs[i], nr = "leg " + (i + 1);
      if (!L) return nr + ": selection " + s.id + " is not in the betslip";
      if (L.eventId !== s.eventId || L.marketId !== s.marketId || L.spec !== "" || L.outcomeId !== s.outcomeId) return nr + ": selection in the betslip differs from the order";
      if (L.closed || L.suspended) return nr + ": market closed or suspended";
      if (L.confirm) return nr + ": odds changed, the book asks for confirmation";
      if (!L.home || !L.away) return nr + ": game not loaded";
      if (norm(L.home) !== norm(A.team1) || norm(L.away) !== norm(A.team2)) return nr + ": teams differ (" + L.home + " – " + L.away + " / " + A.team1 + " – " + A.team2 + ")";
      if (!(Number(L.ko) > jetzt)) return nr + ": game already started or kick-off unknown";
      if (!(Number(L.k) > 1)) return nr + ": no price";
      if (Number(L.k) < Number(A.minOdds)) return nr + ": odds " + L.k + " below minimum " + A.minOdds;
    }
    const q = gesamtQuote(legs);
    if (!(q >= Number(auftrag.minTotalOdds))) return "total odds " + q.toFixed(3) + " below minimum " + auftrag.minTotalOdds;
    return null;
  }
  // Einsatz-Text fuer das Feld: Euro nur auf einem Schein, der sichtbar Fiat oder Stablecoin fuehrt. Sonst der umgerechnete Betrag, ohne Kurs nichts. Unbekannte Waehrung: nichts.
  function einsatzText(cur, amountBtc, amount) {
    const c = String(cur || "").toUpperCase(), b = Number(amountBtc) > 0 ? Math.round(Number(amountBtc) * 1e8) / 1e8 : null, e = Number(amount);
    if (c === "EUR" || c === "USD" || c === "USDT") return e > 0 ? e.toFixed(2) : null;
    if (c === "BTC") return b != null ? b.toFixed(8) : null;
    if (c === "MBTC") return b != null ? (b * 1000).toFixed(5) : null;
    return null;
  }
  // Mitgelesene Abgabe und Antwort → Ergebnis. Unklar bleibt unklar, nie „nicht gesetzt“.
  function antwortAuswerten(g, auftrag, text) {
    if (!g) return null;
    if (g.fehler) return { status: "uncertain", reason: "trustdice: network error at submission (" + g.fehler + ") — POSSIBLY placed, check the bet history" };
    if (g.status == null) return null;
    const a = g.antwort, anf = g.anfrage || {}, n = auftrag.legs.length;
    const zuerst = a && a.accepted && a.accepted[0], sl = a && a.slips && a.slips[0];
    if (zuerst || (sl && sl.accepted)) {
      const soll = auftrag.legs.map(auswahl).map((x) => x.eventId + "_" + x.marketId + "__" + x.outcomeId).sort().join();
      const passt = anf.type === n + "/" + n && Array.isArray(anf.ids) && anf.ids.slice().sort().join() === soll && Number(anf.sum) === Number(text) && anf.oc === "none";
      const ticket = (zuerst && zuerst.id) || (sl && sl.id) || null;
      if (!passt) return { status: "uncertain", ticket, reason: "trustdice: the book accepted a slip that differs from the order (" + String(anf.type) + ", " + String(anf.oc) + ") — check the bet history" };
      return { status: "placed", ticket };
    }
    const fe = a && a.error && a.error[0];
    if (fe || (sl && !sl.accepted)) return { status: "blocked", reason: "trustdice: the book refused the parlay" + (fe ? " (" + String(fe.code || "?") + (fe.message ? ": " + fe.message : "") + ")" : sl.code ? " (" + sl.code + ")" : "") };
    if (g.status >= 400 && g.status < 500) return { status: "blocked", reason: "trustdice: the book refused the parlay (HTTP " + g.status + ")" };
    return { status: "uncertain", reason: "trustdice: no clear answer from the book (HTTP " + g.status + ") — POSSIBLY placed, check the bet history" };
  }

  // ---- Seite -----------------------------------------------------------------------------------------------------------------
  function alle(w) {
    const out = [], st = [w];
    while (st.length) { const r = st.pop(); let els; try { els = r.querySelectorAll("*"); } catch (_) { els = []; } for (const e of els) { out.push(e); if (e.shadowRoot) st.push(e.shadowRoot); } }
    return out;
  }
  const sichtbar = (e) => { try { return e.offsetParent !== null || (e.getClientRects && e.getClientRects().length > 0); } catch (_) { return false; } };
  const eigenText = (el) => { let t = ""; for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue; return t.trim(); };
  function schein() { return alle(document).find((e) => e.getAttribute && e.getAttribute("data-editor-id") === "betslipContent") || null; }
  function waehrung() {
    const s = schein(); if (!s) return null;
    for (const el of alle(s)) {
      if (!sichtbar(el)) continue;
      const raw = eigenText(el); if (!raw || raw.length > 24) continue;
      const m = raw.toUpperCase().match(/\b(MBTC|BTC|USDT|EUR|USD)\b/); if (m) return m[1];
      if (raw === "€") return "EUR";
      if (raw === "$") return "USD";
    }
    return null;
  }
  function setzKnopf() {
    const s = schein(); if (!s) return { fehler: "betslip not visible" };
    const treffer = alle(s).filter((e) => e.tagName === "BUTTON" && sichtbar(e) && /^(wetten|jetzt wetten|wette platzieren|platzieren|place bet)$/i.test(String(e.innerText || e.textContent || "").trim()));
    if (treffer.length !== 1) return { fehler: treffer.length ? "more than one place button" : "no place button in the betslip" };
    if (treffer[0].disabled) return { fehler: "place button is inactive" };
    return { el: treffer[0] };
  }
  function echterKlick(el) {
    const r = el.getBoundingClientRect(), o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    for (const t of ["pointerover", "pointerenter", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) el.dispatchEvent(new ((t.indexOf("pointer") === 0 && window.PointerEvent) ? PointerEvent : MouseEvent)(t, o));
  }
  function leeren() {
    try { for (const e of alle(document).filter((x) => x.getAttribute && x.getAttribute("data-editor-id") === "betslipSelectionRemoveButton" && sichtbar(x))) echterKlick(e); } catch (_) {}
  }
  let _nr = 0;
  function bruecke(kind, extra) {
    return new Promise((fertig) => {
      const id = "k" + (++_nr);
      const an = (e) => { if (e.source !== window) return; const d = e.data; if (!d || d.source !== "td-kombi-antwort" || d.id !== id) return; window.removeEventListener("message", an); clearTimeout(t); fertig(d); };
      const t = setTimeout(() => { window.removeEventListener("message", an); fertig({ stand: { ok: false }, keine: true }); }, 2500);
      window.addEventListener("message", an);
      window.postMessage(Object.assign({ source: "td-kombi", id, kind }, extra || {}), location.origin);
    });
  }
  const SEITE = { bruecke, waehrung, setzKnopf, klick: echterKlick, leeren, jetzt: () => Date.now() };

  // ---- Ablauf: je Aufruf ein Schritt --------------------------------------------------------------------------------------------
  const FERTIG = new Map(), LAEUFT = new Map();
  const warte = (w, ms) => ({ status: "pending", warteId: w.id, nachMs: ms });
  function ende(w, r) {
    LAEUFT.delete(w.id);
    const aus = Object.assign({ legs: w.auftrag.legs.length, ms: w.env.jetzt() - w.start, cur: w.cur || undefined }, r);
    FERTIG.set(w.id, aus);
    if (aus.status === "blocked" || aus.status === "staged") { try { w.env.leeren(); } catch (_) {} }
    return aus;
  }
  const nein = (w, reason) => ende(w, { status: "blocked", reason: "trustdice: " + reason + " — nothing sent" });
  async function schritt(w) {
    const env = w.env, jetzt = env.jetzt();
    if (w.schritt === "laden") {
      const st = (await env.bruecke("stand")).stand;
      const soll = w.auftrag.legs.length, da = st && st.ok && st.legs.length >= soll && st.legs.every((L) => L.k != null && L.home);
      if (!da) return ++w.n > LADEN_MAX ? nein(w, "betslip did not load (" + ((st && st.ok) ? st.legs.length + " of " + soll + " selections" : "widget not readable") + ")") : warte(w, 400);
      w.schritt = "quoten"; w.n = 0;
      await env.bruecke("quoten");
      return warte(w, 250);
    }
    if (w.schritt === "quoten") {
      const st = (await env.bruecke("stand")).stand;
      if (!st || st.oc !== "none") { if (++w.n > KLEIN_MAX) return nein(w, "could not switch off accepting changed odds (" + String(st && st.oc) + ")"); await env.bruecke("quoten"); return warte(w, 300); }
      const f = scheinFehler(st, w.auftrag, jetzt);
      if (f) return nein(w, f);
      w.cur = env.waehrung();
      w.text = einsatzText(w.cur, w.auftrag.amountBtc, w.auftrag.amount);
      if (!w.text) return nein(w, "betslip is on " + (w.cur || "an unknown currency") + " and there is no stake for it (BTC rate missing?)");
      const a = await env.bruecke("einsatz", { text: w.text });
      if (!a.gesetzt) return nein(w, "stake field not found");
      w.schritt = "einsatz"; w.n = 0;
      return warte(w, 300);
    }
    if (w.schritt === "einsatz") {
      const st = (await env.bruecke("stand")).stand, c = (st && st.combo) || {};
      if (Number(c.sum) !== Number(w.text)) { if (++w.n > KLEIN_MAX) return nein(w, "stake was not taken (" + String(c.sum) + " instead of " + w.text + ")"); await env.bruecke("einsatz", { text: w.text }); return warte(w, 300); }
      // Die Grenzen holt das Widget selbst, wenn angemeldet (coupon/max). Bleiben sie aus, entscheidet das Buch beim Abgeben.
      if (st.angemeldet && c.maxBet == null && !c.error && ++w.n <= KLEIN_MAX) return warte(w, 300);
      if (c.error) return nein(w, "betslip reports: " + c.error);
      if (c.maxBet != null && Number(w.text) > c.maxBet) return nein(w, "stake " + w.text + " above the book's limit " + c.maxBet);
      if (c.minBet != null && Number(w.text) < c.minBet) return nein(w, "stake " + w.text + " below the book's minimum " + c.minBet);
      const f = scheinFehler(st, w.auftrag, env.jetzt());
      if (f) return nein(w, f);
      const q = gesamtQuote(st.legs);
      w.quote = q;
      if (w.auftrag.armed !== true) return ende(w, { status: "staged", odds: q, stake: w.text, note: "Parlay built and checked, not placed." });
      if (!st.angemeldet) return nein(w, "not signed in at trustdice.win");
      const k = env.setzKnopf();
      if (k.fehler) return nein(w, k.fehler);
      const v = await env.bruecke("vergessen");
      if (v.keine) return nein(w, "bridge to the widget does not answer");
      env.klick(k.el);
      w.schritt = "antwort"; w.n = 0;
      return warte(w, 400);
    }
    // Der Knopf ist gedrueckt. Ab hier gibt es kein „nichts gesendet“ mehr ohne Beleg.
    const st = (await env.bruecke("stand")).stand, g = st && st.gefangen;
    const r = antwortAuswerten(g, w.auftrag, w.text);
    if (r) {
      const stakeEur = String(w.cur).toUpperCase() === "EUR" ? Number(w.text) : undefined;
      return ende(w, Object.assign({ odds: w.quote, stake: stakeEur, cur: w.cur }, r, r.status === "placed" ? { note: "TrustDice parlay accepted. Combo boost, if any, is not counted." } : {}));
    }
    ++w.n;
    if (!g && st && st.ok && (st.legs || []).some((L) => L.confirm)) return nein(w, "odds changed before submission, the book asks for confirmation");   // Beleg: Der Schein wartet noch auf Bestaetigung, also ging nichts raus
    if (g ? w.n > ANTWORT_MAX : w.n > OHNE_ABGABE_MAX) return ende(w, { status: "uncertain", odds: w.quote, reason: "trustdice: pressed the place button, no " + (g ? "answer from the book" : "submission seen") + " — POSSIBLY placed, check the bet history" });
    return warte(w, 500);
  }
  async function place(msg, env) {
    const e = Object.assign({}, SEITE, env || {}), id = String((msg && msg.auftragId) || "");
    if (!id) return { status: "blocked", reason: "trustdice: order number missing — nothing sent" };
    if (FERTIG.has(id)) return FERTIG.get(id);
    if (LAEUFT.has(id)) return warte(LAEUFT.get(id), 500);
    const legs = Array.isArray(msg.legs) ? msg.legs : [];
    if (legs.length < 2 || legs.length > 12) return { status: "blocked", reason: "trustdice: a parlay needs 2 to 12 legs — nothing sent" };
    if (!(Number(msg.amount) > 0) || !(Number(msg.minTotalOdds) > 1)) return { status: "blocked", reason: "trustdice: stake or minimum total odds missing — nothing sent" };
    const w = { id, auftrag: { legs, amount: Number(msg.amount), amountBtc: msg.amountBtc, minTotalOdds: Number(msg.minTotalOdds), armed: msg.armed === true }, env: e, schritt: "laden", n: 0, start: e.jetzt() };
    LAEUFT.set(id, w);
    return await schritt(w);
  }
  async function nachfragen(warteId) {
    const id = String(warteId || "");
    if (FERTIG.has(id)) return FERTIG.get(id);
    const w = LAEUFT.get(id);
    if (!w) return { status: "uncertain", reason: "trustdice: the page does not know this order any more (reloaded?) — POSSIBLY placed, check the bet history" };
    return await schritt(w);
  }
  root.TDKOMBI = { VERSION, place, nachfragen, beschaeftigt: () => LAEUFT.size > 0, adresse, auswahl, scheinFehler, einsatzText, antwortAuswerten, gesamtQuote, SPORT };
})();
