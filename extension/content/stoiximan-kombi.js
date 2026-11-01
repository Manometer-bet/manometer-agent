// stoiximan-kombi.js — KOMBIWETTE bei Stoiximan (en.stoiximan.gr, Kaizen „Danae“). 05.10.2026.
// Geteilt und BYTE-GLEICH: Erweiterung (stoiximan-kombi.js, vor stoiximan-content.js geladen) und Manometer Agent der External
// Bettors (engine/content/stoiximan-kombi.js, vor stoiximan-place.js eingespritzt). Stellt SXKOMBI.place(msg, env) und
// SXKOMBI.nachfragen(warteId) bereit; die Befehls-Verdrahtung macht das jeweilige Content-Script.
//
// Betreiber (05.10.2026): „lasse uns Stück für Stück die anderen Bookies anbinden, sodass man auch bei denen die Parlays setzen
// kann … Zuerst bei den GR-Bookies bitte den GR-Chrome nutzen zum Testen.“
//
// GELERNT an der Wettschein-Schnittstelle (05.10., GR-Chrome, OHNE Anmeldung — nur Schein-Rechnung, nichts abgegeben):
//   * POST /api/betslip/v3/plain-leg/ { selectionIds:[Auswahl-Nr.], betslip:<bisheriger Schein>, eventId, triggerPoint } haengt
//     EIN Bein an. Antwort data { hash, slipData, legs[], bets[], errors[], betSlipTabId, betslipTrackId, … }. Der Schein lebt
//     nicht in der Seite, sondern wandert mit jeder Anfrage mit (der sichtbare Wettschein des Tabs bleibt unberuehrt).
//     Bein: { id (= Auswahl-Nr.), eventId, eventStartTime (ms), sportId (FOOT · BASK), marketSort (MRES = Fussball 1X2 ·
//     H2HT = Basketball-Sieger inklusive Verlaengerung), description (Mannschaft bzw. „Draw“), participants[{ name }] (Heim
//     zuerst), odds }.
//   * bets fuehrt je REITER des Scheins eigene Eintraege, Kennung "<Reiter>:<Typ>:<Nummern mit |>": Reiter 1 = Einzelwetten
//     (SGL je Bein), Reiter 2 = DIE KOMBI (genau ein Eintrag: DBL bei zwei, TBL bei drei Beinen …; numLines 1, multiples true,
//     odds = Produkt der Bein-Quoten — gemessen 1,8 × 2,27 × 1,17 = 4,7806), Reiter 3 = System (Singles, Doubles, Trixie …).
//     Fussball und Basketball lassen sich mischen.
//   * Zwei Auswahlen aus DEMSELBEN Spiel: beide Beine stehen im Schein, aber Reiter 2 bleibt leer (nicht kombinierbar).
//     Unbekannte Auswahl-Nr.: HTTP 200 mit errors[{ code:"SelectionResulted", description … }], keine Beine.
//     Dieselbe Auswahl noch einmal: der Schein bleibt, wie er ist.
//   * PATCH /api/betslip/v3/updatebets { betslip:{ …, betslipTabId:2, betslipTrackId }, bets:[Kopien mit amount] } rechnet den
//     Einsatz: Antwort betSlipTabId 2, der Kombi-Eintrag traegt amount und returns (2 € × 4,7806 = 9,56), alle anderen 0.
//   * GEWINNSTEUER (GR, je Schein auf den Gewinn: bis 100 € frei, dann 2,5 % / 5 % / 7,5 % ab 500 €): die Antwort nennt sie in
//     taxDetailsByTabId [{ tabId, potentialGrossWinnings, potentialNetWinnings, totalTax, taxBack, taxToPay }]. Gemessen 05.10.
//     (50 € × 84,7665 = 4238,33): totalTax 294,12 · taxBack 294,12 · taxToPay 0 — Stoiximan traegt die Steuer selbst. Bleibt
//     einmal etwas zu zahlen (taxToPay > 0), zaehlt fuer die Mindest-Gesamtquote die Auszahlung NACH Steuer.
//   * Abgeben: POST /api/betslip/v3/place { betslip:{ …, oddschanges:"0" } } wie bei der Einzelwette (dort seit 26.09. an echten
//     Wetten belegt; "0" = keine Quotenaenderung annehmen). Die Annahme einer KOMBI ist NICHT mitgeschnitten — es wurde keine
//     abgegeben. Ausgewertet wird wie bei der Einzelwette (so verfaehrt die Seite selbst, main-Bundle checkBetslipResponse /
//     pollStatus): accepted + receipts → gesetzt · pending → nachfragen (POST /api/betslip/v3/placed/<uniqueId>) ·
//     pending + counterOffer → Gegenangebot, wird NIE angenommen · errors / HTTP 422 → Absage · sonst Abgleich mit den
//     offenen Wetten des Kontos.
// SICHERUNGEN (fail-closed — bei jedem Zweifel wird nichts abgegeben; der Schein lebt nur in dieser Anfrage-Kette, es bleibt
// also auch nichts stehen):
//   scharf nur mit lesbaren offenen Wetten (= angemeldet); nach JEDEM Bein: keine Fehlermeldung des Buchs, der Schein fuehrt genau
//   so viele Beine wie gelegt, das neue Bein traegt die Auswahl-Nr. des Auftrags, sitzt auf DIESEM Spiel, im Sieger-Markt
//   seiner Sportart, die Mannschaften des Buchs = die des Auftrags, die Auswahl ist die Seite des Tipps (Name der Mannschaft
//   bzw. keiner von beiden beim Remis), das Spiel ist nicht angepfiffen, Quote ≥ Mindestquote des Beins;
//   am Ende: GENAU EIN Kombi-Eintrag ueber genau diese Auswahl-Nummern, eine Linie, Quote = Produkt ≥ Mindest-Gesamtquote;
//   nach der Einsatz-Rechnung: nur der Kombi-Eintrag traegt Einsatz (= Auftrag), Reiter 2, Beine unveraendert, Quoten halten.
//   armed:false endet hier („staged“) — abgegeben wird dann nichts.
//   Abgeben: EIN Aufruf, nie ein zweiter; danach nur noch nachfragen und lesen. GENAU EINE Quittung, sonst „uncertain“.
// WARTEN OHNE ZEITGEBER IN DER SEITE (Chrome drosselt Zeitgeber verdeckter Tabs): haelt das Buch die Antwort zurueck, kommt
//   { status:"pending", warteId, nachMs } — der Aufrufer (Service Worker) wartet und ruft nachfragen(warteId).
// EIN AUFTRAG LAEUFT NIE ZWEIMAL: jeder Auftrag traegt eine Nummer (auftragId, Pflicht). Kommt dieselbe Nummer noch einmal —
//   zwei Empfaenger im selben Tab (Content-Script nachgeladen UND aus dem Manifest), eine wiederholte Zustellung —, gibt es
//   DASSELBE Ergebnis zurueck, ausgefuehrt wird nur einmal. Ohne das bekaeme der zweite Empfaenger „es laeuft schon einer“ und
//   koennte mit dieser Absage VOR dem ersten antworten, waehrend der den Schein abgibt. Dasselbe gilt fuers Nachfragen.
// NACHLADEN: wird die Datei noch einmal in denselben Tab geladen, ersetzt sie die alte Fassung — ausser es laeuft gerade ein
//   Auftrag oder ein abgegebener Schein wartet auf sein Ergebnis (dessen Stand lebt in der alten Fassung).
(() => {
  "use strict";
  if (self.SXKOMBI && typeof self.SXKOMBI.beschaeftigt === "function" && self.SXKOMBI.beschaeftigt()) return;
  const API = location.origin, KOPF = { "content-type": "application/json", accept: "application/json" };
  // Sieger-Markt je Sportart: Markt-Kuerzel und Sportart-Kuerzel des Beins im Schein, erlaubte Tipps (Reihenfolge des Buchs).
  const MARKT = { soccer: { sort: "MRES", sport: "FOOT", tips: ["1", "X", "2"] }, basketball: { sort: "H2HT", sport: "BASK", tips: ["1", "2"] } };
  const MIN = 2, MAX = 12, REITER_KOMBI = 2;
  const POLL_MS = 1000, POLL_MAX_MS = 30000, POLL_502_MS = 3000, POLL_502_MAX = 10, ABGLEICH_MS = 1500, ABGLEICH_MAX = 3;
  const wartend = new Map();                             // warteId → Stand eines abgegebenen Scheins, dessen Ergebnis noch offen ist
  const auftraege = new Map();                           // Auftrags-Nr. → Promise des Ergebnisses (derselbe Auftrag laeuft nie zweimal)
  const erledigt = new Map();                            // warteId → Endergebnis eines Scheins, der gewartet hat (fuer eine doppelte Nachfrage)
  const MERKEN_MAX = 40, WARTEN_ALT_MS = 10 * 60 * 1000;
  const merke = (m, k, v) => { m.set(k, v); while (m.size > MERKEN_MAX) m.delete(m.keys().next().value); };
  let warteNr = 0, laeuft = false;
  const jetztMs = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  const klein = (s) => String(s == null ? "" : s).trim().toLowerCase();
  const cfgVon = (sport) => { const k = String(sport == null || sport === "" ? "soccer" : sport); return Object.prototype.hasOwnProperty.call(MARKT, k) ? MARKT[k] : null; };

  // EIN Abruf der Wettschein-Schnittstelle. → { http, j } | { netz }
  async function ruf(methode, pfad, body) {
    try {
      const r = await fetch(API + pfad, { method: methode, credentials: "include", headers: KOPF, cache: "no-store", body: body == null ? undefined : JSON.stringify(body) });
      let j = null; try { j = await r.json(); } catch (_) {}
      return { http: r.status, j };
    } catch (e) { return { netz: String((e && e.message) || e) }; }
  }
  // Offene Wetten des Kontos (nur lesen): Anmelde-Probe vor dem Abgeben und Grundlage des Abgleichs danach.
  async function offeneWetten() {
    let j;
    try {
      const r = await fetch(API + "/api/bets/open", { credentials: "include", headers: { accept: "application/json" }, cache: "no-store" });
      if (!r.ok) return { ok: false, http: r.status, bets: [] };
      j = await r.json();
    } catch (e) { return { ok: false, err: String((e && e.message) || e), bets: [] }; }
    const wurzel = (j && j.data) ? j.data : j;
    let arr = (wurzel && (wurzel.bets || wurzel.unsettledBets || wurzel.openBets || wurzel.coupons)) || (Array.isArray(wurzel) ? wurzel : []);
    if (!Array.isArray(arr)) arr = [];
    return { ok: true, bets: arr.map((b) => { const id = b && (b.id || b.betId || b.couponId || b.betslipId || b.code || b.trackId); let text = ""; try { text = JSON.stringify(b); } catch (_) { text = String(b); } return { id: id != null ? String(id) : null, text: klein(text) }; }) };
  }
  const wettKennung = (b) => (b.id || b.text.slice(0, 60));
  const fehlerText = (errs) => (Array.isArray(errs) ? errs : [errs]).map((e) => (e && typeof e === "object") ? [e.code, e.description].filter(Boolean).join(" ") || JSON.stringify(e) : String(e)).join("; ").slice(0, 200);
  const scheinVon = (d, reiter) => ({ hash: d.hash, slipData: d.slipData, legs: d.legs, bets: d.bets, betslipTabId: reiter != null ? reiter : (d.betSlipTabId || d.betslipTabId || 1), betslipTrackId: d.betslipTrackId || "" });
  // DER Kombi-Eintrag des Scheins: der einzige Eintrag im Reiter 2. Keiner (nicht kombinierbar) oder mehrere → null.
  function kombiEintrag(bets) { const k = (Array.isArray(bets) ? bets : []).filter((b) => b && Number(b.betslipTabId) === REITER_KOMBI); return k.length === 1 ? k[0] : null; }
  // Prueft EIN Bein des Scheins gegen den Auftrag. null = in Ordnung, sonst der Grund.
  function beinFehler(bein, L, jetzt) {
    const M = cfgVon(L.sport);
    if (String(bein.eventId) !== String(L.eventId)) return "the selection sits on another game (" + String(bein.eventId) + ")";
    if (String(bein.marketSort) !== M.sort || String(bein.sportId) !== M.sport) return "the selection is not in the " + String(L.sport || "soccer") + " winner market (" + String(bein.sportId) + " " + String(bein.marketSort) + ")";
    const p = Array.isArray(bein.participants) ? bein.participants : [];
    // Namen wie im Katalog des Dienstes (collectors/stoiximan.js: participants[].name, nur Leerraum am Rand entfernt)
    const n1 = p[0] ? String(p[0].name == null ? "" : p[0].name).trim() : "", n2 = p[1] ? String(p[1].name == null ? "" : p[1].name).trim() : "";
    if (p.length !== 2 || !n1 || !n2 || n1 !== String(L.team1).trim() || n2 !== String(L.team2).trim()) return "teams at the book (" + n1 + " – " + n2 + ") differ from the order";
    // Seite des Tipps: die Auswahl heisst wie die Mannschaft (1 = erste, 2 = zweite des Buchs); beim Remis wie keine von beiden.
    const was = klein(bein.description), h = klein(n1), a = klein(n2);
    if ((L.tip === "1" && was !== h) || (L.tip === "2" && was !== a) || (L.tip === "X" && (was === h || was === a || !was))) return "the selection (" + String(bein.description) + ") is not outcome " + L.tip + " of this game";
    if (!(Number(bein.eventStartTime) > jetzt)) return "the game has started or its kick-off is unknown";
    if (!(Number(bein.odds) >= Number(L.minOdds))) return String(bein.odds) + " is below the min odds " + Number(L.minOdds);
    return null;
  }

  // ---- nach dem Abgeben: Antwort des Buchs auswerten ---------------------------------------------------------------------
  async function neueWette(k) {
    const jetzt = await offeneWetten();
    if (!k.vorOk || !jetzt.ok) return { lesbar: false, treffer: null };
    const neu = (jetzt.bets || []).filter((b) => !k.vorKeys.has(wettKennung(b)));
    // Eine NEUE offene Wette, die ALLE Spiele des Scheins nennt, ist dieser Schein.
    return { lesbar: true, treffer: neu.find((b) => k.eventIds.every((id) => b.text.indexOf(String(id)) >= 0)) || null };
  }
  // Endergebnis eines abgegebenen Scheins: aus der Warteliste nehmen und merken (eine zweite Nachfrage bekommt dasselbe).
  const fertig = (z, o) => { z.ms.gesamt = Math.round(jetztMs() - z.T0); const e = Object.assign(o, { legs: z.gelegt, ms: z.ms }); wartend.delete(z.id); merke(erledigt, z.id, e); return e; };
  const perKonto = (z, t, text) => fertig(z, { status: "placed", odds: z.k.odds, ticket: t.id || null, verified: true, note: text + (t.id ? " (id " + t.id + ")" : "") });
  // Liest EINE Antwort des Buchs: { ende } | { absage } | { nach } | { abgleich }.
  function lies(z, a) {
    const d = a && a.j && a.j.data;
    if (d && d.accepted && Array.isArray(d.receipts) && d.receipts.length) {
      // GENAU EINE Quittung gehoert zu einem Kombi-Schein. Mehrere hiessen: es wurde mehr abgegeben als der eine Eintrag.
      if (d.receipts.length !== 1) return { ende: { status: "uncertain", odds: z.k.odds, reason: "AUDIT: the book answers with " + d.receipts.length + " receipts for one combo — check the bet history immediately" } };
      const rc = d.receipts[0], ein = Number(rc.totalAmount);
      return { ende: { status: "placed", odds: Number(rc.totalOdds) > 1 ? Number(rc.totalOdds) : z.k.odds, ticket: rc.betId != null ? String(rc.betId) : null,
        note: "Stoiximan betslip accepted" + (z.gewartet ? " after " + z.gewartet + " follow-up(s)" : "") + ((isFinite(ein) && ein > 0 && Math.abs(ein - z.k.einsatz) > 0.005) ? " — the receipt names a stake of " + ein + " instead of " + z.k.einsatz : "") } };
    }
    if (d && d.pending) {
      if (d.counterOffer) return { ende: { status: "failed", reason: "the book made a counter offer (other stake or odds) — not accepted, nothing placed" } };
      if (d.uniqueId) z.uid = String(d.uniqueId);
      if (d.fullbetId) z.fbt = d.fullbetId;
      if (!z.uid) return { abgleich: "the book is waiting but names no follow-up number" };
      if (Date.now() - z.t0 >= POLL_MAX_MS) return { abgleich: "the book is still waiting after " + Math.round((Date.now() - z.t0) / 1000) + " s" };
      return { nach: POLL_MS };
    }
    const fehler = (d && Array.isArray(d.errors) && d.errors.length) ? d.errors : ((a && a.j && Array.isArray(a.j.errors) && a.j.errors.length) ? a.j.errors : null);
    if (fehler || (a && a.http === 422)) return { absage: fehler ? fehlerText(fehler) : "HTTP 422" };
    if (a && a.http === 502 && z.uid && z.n502 < POLL_502_MAX && Date.now() - z.t0 < POLL_MAX_MS) { z.n502++; return { nach: POLL_502_MS }; }
    return { abgleich: a && a.netz ? "network error: " + a.netz : "unclear answer (HTTP " + (a && a.http) + ")" };
  }
  async function abgleich(z) {
    z.abgleiche++;
    const rb = await neueWette(z.k);
    if (rb.treffer) return perKonto(z, rb.treffer, "confirmed against the open bets of the account — " + z.offen);
    if (rb.lesbar && z.abgleiche < ABGLEICH_MAX) { wartend.set(z.id, z); return { status: "pending", warteId: z.id, nachMs: ABGLEICH_MS }; }
    return fertig(z, { status: "uncertain", odds: z.k.odds, reason: "Stoiximan combo: " + z.offen + " — POSSIBLY placed, check the bet history" });
  }
  async function weiter(z, a) {
    const e = lies(z, a);
    if (z.ms.abgeben == null) z.ms.abgeben = Math.round(jetztMs() - z.ta);
    if (e.ende) return fertig(z, e.ende);
    if (e.absage) {
      // Absage. Zur Sicherheit gegen das Konto pruefen: steht trotzdem eine neue Wette auf diese Spiele da, zaehlt die.
      const rb = await neueWette(z.k);
      if (rb.treffer) return perKonto(z, rb.treffer, "the book answered with a refusal, but the account shows a new bet on these games");
      return fertig(z, { status: "failed", reason: "The book rejected the combo: " + e.absage });
    }
    if (e.nach) { z.gewartet++; wartend.set(z.id, z); return { status: "pending", warteId: z.id, nachMs: e.nach }; }
    z.offen = e.abgleich; z.abgleiche = 0;
    return await abgleich(z);
  }
  // Ein weiterer Schritt fuer einen abgegebenen Schein, dessen Ergebnis noch offen ist: genau EIN Abruf (nachfragen oder lesen).
  // Laeuft fuer diesen Schein gerade eine Nachfrage (zweiter Empfaenger im selben Tab), gibt es deren Ergebnis — kein zweiter Abruf.
  function nachfragen(warteId) {
    const id = String(warteId), z = wartend.get(id);
    if (!z) return Promise.resolve(erledigt.has(id) ? erledigt.get(id) : { status: "uncertain", reason: "Stoiximan combo: the waiting slip is no longer known (page reloaded?) — POSSIBLY placed, check the bet history" });
    if (z.lauf) return z.lauf;
    z.lauf = (async () => {
      try {
        if (z.offen != null) return await abgleich(z);
        const a = await ruf("POST", "/api/betslip/v3/placed/" + encodeURIComponent(z.uid), Object.assign({ betslip: z.slip }, z.fbt ? { fbt: z.fbt } : {}));
        return await weiter(z, a);
      } finally { z.lauf = null; }
    })();
    return z.lauf;
  }

  // msg: { auftragId (Pflicht: Nummer DIESES Auftrags, 6–80 Zeichen — dieselbe Nummer wird nie zweimal ausgefuehrt),
  //        legs:[{ eventId, outcomeId (Auswahl-Nr. des Buchs), tip ("1"|"X"|"2" in der Reihenfolge des BUCHS), minOdds, team1, team2,
  //        sport? ("soccer" ohne Angabe · "basketball": nur "1"|"2") }], amount (€), minTotalOdds, armed (true = abgeben) }
  // env: { emit(text, daten) }
  // Antwort: { status: placed | failed | blocked | uncertain | staged | pending, odds (Gesamtquote), legs:[{ eventId, tip, outcomeId,
  //            odds, teams, sport }], ms:{ gesamt, beine:[…], rechnen, abgeben }, reason?, note?, ticket?, warteId?, nachMs? }
  function place(msg, env) {
    const id = (msg && msg.auftragId != null) ? String(msg.auftragId) : "";
    if (!/^[A-Za-z0-9_.:-]{6,80}$/.test(id)) return Promise.resolve({ status: "blocked", reason: "Stoiximan combo: order number missing — nothing sent", legs: [], ms: { gesamt: 0, beine: [], rechnen: null, abgeben: null } });
    if (auftraege.has(id)) return auftraege.get(id);     // derselbe Auftrag noch einmal: dasselbe Ergebnis, kein zweiter Lauf
    const lauf = ausfuehren(msg, env);
    merke(auftraege, id, lauf);
    return lauf;
  }
  async function ausfuehren(msg, env) {
    const legs = msg && msg.legs, armed = !!(msg && msg.armed === true);
    const emit = (t, d) => { try { if (env && typeof env.emit === "function") env.emit(t, d); } catch (_) {} };
    const T0 = jetztMs(), ms = { gesamt: 0, beine: [], rechnen: null, abgeben: null }, gelegt = [];
    const mit = (o) => { ms.gesamt = Math.round(jetztMs() - T0); return Object.assign(o, { ms }); };
    const nein = (reason) => { emit("Combo aborted — nothing placed", { reason, legsDone: gelegt.length }); return mit({ status: "blocked", reason: "Stoiximan combo: " + reason, legs: gelegt }); };
    if (!Array.isArray(legs) || legs.length < MIN || legs.length > MAX) return nein("needs " + MIN + " to " + MAX + " legs");
    const spiele = new Set(), nummern = new Set();
    for (const L of legs) {
      const M = L ? cfgVon(L.sport) : null;
      if (L && !M) return nein("sport " + String(L.sport) + " is not connected for combos");
      if (!L || !/^\d{4,12}$/.test(String(L.eventId)) || !/^\d{4,20}$/.test(String(L.outcomeId)) || M.tips.indexOf(L.tip) < 0 || !(Number(L.minOdds) > 1) || !L.team1 || !L.team2 || spiele.has(String(L.eventId)) || nummern.has(String(L.outcomeId))) return nein("invalid or duplicate leg");
      spiele.add(String(L.eventId)); nummern.add(String(L.outcomeId));
    }
    const amount = Number(msg.amount), minTotal = Number(msg.minTotalOdds);
    if (!(amount > 0)) return nein("stake missing");
    if (!(minTotal > 1)) return nein("minimum total odds missing");
    if (laeuft) return nein("another combo is being built right now");
    laeuft = true;
    let abgegeben = false;
    try {
      // 0) scharf nur angemeldet: die offenen Wetten muessen lesbar sein (zugleich der Stand VOR dem Abgeben fuer den Abgleich)
      let vorher = null;
      if (armed) {
        vorher = await offeneWetten();
        if (!vorher.ok) return nein((vorher.http === 401 || vorher.http === 403) ? "not logged in at Stoiximan (open bets answer HTTP " + vorher.http + ") — nothing sent" : "open bets not readable (" + String(vorher.http || vorher.err || "?") + ") — nothing sent");
      }
      // 1) Beine nacheinander anhaengen
      let schein = { hash: "", slipData: "", legs: [], bets: [], betslipTabId: 1, betslipTrackId: "" }, d = null;
      for (let i = 0; i < legs.length; i++) {
        const L = legs[i], nr = "leg " + (i + 1), tb = jetztMs();
        const a = await ruf("POST", "/api/betslip/v3/plain-leg/", { selectionIds: [String(L.outcomeId)], betslip: schein, eventId: String(L.eventId), triggerPoint: { origin: 6, parentOrigin: 1 } });
        if (a.netz) return nein(nr + ": betslip not reachable (" + a.netz + ")");
        if (a.http !== 200) return nein(nr + ": the betslip answers HTTP " + a.http);
        d = a.j && a.j.data;
        if (!d || !Array.isArray(d.legs) || !Array.isArray(d.bets)) return nein(nr + ": unexpected betslip answer");
        if (Array.isArray(d.errors) && d.errors.length) return nein(nr + ": the book refuses the selection (" + fehlerText(d.errors) + ")");
        const bein = d.legs.find((x) => x && String(x.id) === String(L.outcomeId));
        if (!bein) return nein(nr + ": the selection did not arrive in the betslip");
        if (d.legs.length !== i + 1) return nein("the betslip holds " + d.legs.length + " legs after " + nr);
        const grund = beinFehler(bein, L, Date.now());
        if (grund) return nein(nr + ": " + grund);
        gelegt.push({ eventId: String(L.eventId), tip: L.tip, outcomeId: String(L.outcomeId), odds: Number(bein.odds), minOdds: Number(L.minOdds), teams: String(L.team1) + " – " + String(L.team2), sport: String(L.sport || "soccer") });
        schein = scheinVon(d);
        ms.beine.push(Math.round(jetztMs() - tb));
      }
      // 2) Inhalt des Scheins = Auftrag (die Quoten koennen sich waehrend des Aufbaus bewegt haben), genau EIN Kombi-Eintrag
      const pruefeBeine = (liste, wo) => {
        if (!Array.isArray(liste) || liste.length !== legs.length) return "the betslip holds " + (Array.isArray(liste) ? liste.length : "no") + " legs " + wo;
        for (let i = 0; i < legs.length; i++) {
          const bein = liste.find((x) => x && String(x.id) === String(legs[i].outcomeId));
          if (!bein) return "a selection is missing in the betslip " + wo;
          const g = beinFehler(bein, legs[i], Date.now());
          if (g) return "leg " + (i + 1) + " " + wo + ": " + g;
          gelegt[i].odds = Number(bein.odds);
        }
        return null;
      };
      const pruefeKombi = (bets, wo) => {
        const kb = kombiEintrag(bets);
        if (!kb) return { fehler: "the betslip offers no combined bet for these selections " + wo + " (not combinable)" };
        if (Number(kb.numLines) !== 1) return { fehler: "the combined bet has " + kb.numLines + " lines " + wo };
        if (String(kb.tag == null ? "" : kb.tag).split("|").sort().join(",") !== legs.map((L) => String(L.outcomeId)).sort().join(",")) return { fehler: "the combined bet covers other selections than the order " + wo };
        const produkt = gelegt.reduce((p, b) => p * b.odds, 1), q = Number(kb.odds);
        if (!(Math.abs(q - produkt) <= Math.max(0.011, produkt * 0.002))) return { fehler: "the combined odds (" + kb.odds + ") are not the product of the legs (" + produkt.toFixed(3) + ") " + wo };
        if (!(q >= minTotal)) return { fehler: "total odds " + q.toFixed(2) + " are below the min total odds " + minTotal.toFixed(2) };
        return { kb };
      };
      let f = pruefeBeine(d.legs, "after building"); if (f) return nein(f);
      let k = pruefeKombi(d.bets, "after building"); if (k.fehler) return nein(k.fehler);
      // 3) Einsatz rechnen lassen: Reiter 2, NUR der Kombi-Eintrag traegt Einsatz
      const tr = jetztMs();
      const u = await ruf("PATCH", "/api/betslip/v3/updatebets", { betslip: scheinVon(d, REITER_KOMBI), bets: d.bets.map((b) => Object.assign({}, b, { amount: b === k.kb ? amount : 0 })) });
      ms.rechnen = Math.round(jetztMs() - tr);
      if (u.netz) return nein("stake could not be priced (" + u.netz + ")");
      if (u.http !== 200) return nein("pricing the stake answers HTTP " + u.http);
      const ud = u.j && u.j.data;
      const uFehler = (ud && Array.isArray(ud.errors) && ud.errors.length) ? ud.errors : ((u.j && Array.isArray(u.j.errors) && u.j.errors.length) ? u.j.errors : null);
      if (uFehler) return nein("the book refuses the stake (" + fehlerText(uFehler) + ")");
      if (!ud || !ud.hash || !Array.isArray(ud.legs) || !Array.isArray(ud.bets)) return nein("unexpected answer while pricing the stake");
      f = pruefeBeine(ud.legs, "after pricing"); if (f) return nein(f);
      k = pruefeKombi(ud.bets, "after pricing"); if (k.fehler) return nein(k.fehler);
      if (Number(ud.betSlipTabId != null ? ud.betSlipTabId : ud.betslipTabId) !== REITER_KOMBI) return nein("the betslip is not on the combined-bet tab after pricing");
      if (!(Math.abs(Number(k.kb.amount) - amount) <= 0.005)) return nein("the stake on the combined bet (" + k.kb.amount + ") is not the ordered stake (" + amount + ")");
      if (ud.bets.some((b) => b !== k.kb && Number(b.amount) > 0)) return nein("another bet of the betslip carries a stake");
      if (Number(k.kb.maxAmount) > 0 && amount > Number(k.kb.maxAmount) + 0.005) return nein("stake " + amount + " is above the book's maximum " + k.kb.maxAmount + " for this combo");
      if (Number(k.kb.minAmount) > 0 && amount < Number(k.kb.minAmount) - 0.005) return nein("stake " + amount + " is below the book's minimum " + k.kb.minAmount + " for this combo");
      const quote = Number(k.kb.odds), ertrag = Number(k.kb.returns);
      // Gewinnsteuer: was der Schein fuer den Kombi-Reiter nennt. Ist etwas zu ZAHLEN, muss die Auszahlung nach Steuer die
      // Mindest-Gesamtquote halten (die Mindestquote ist die EV-Grenze des Auftrags — sie gilt fuer das, was wirklich ankommt).
      const st = (Array.isArray(ud.taxDetailsByTabId) ? ud.taxDetailsByTabId : []).find((x) => x && Number(x.tabId) === REITER_KOMBI) || null;
      const steuer = st ? { total: Number(st.totalTax) || 0, back: Number(st.taxBack) || 0, toPay: Number(st.taxToPay) || 0 } : null;
      if (steuer && steuer.toPay > 0.005) {
        if (!(ertrag > 0)) return nein("a winnings tax is due (" + steuer.toPay.toFixed(2) + " €) but the returns of the combo are not readable");
        const netto = (ertrag - steuer.toPay) / amount;
        if (!(netto >= minTotal)) return nein("after the winnings tax (" + steuer.toPay.toFixed(2) + " €) the combo pays " + netto.toFixed(2) + " times the stake — below the min total odds " + minTotal.toFixed(2));
      }
      emit("Combo built and priced", { legs: gelegt.length, totalOdds: quote, amount, returns: ertrag || null, taxToPay: steuer ? steuer.toPay : null, armed, ms: Math.round(jetztMs() - T0) });
      // Sicherheits-Halt: nur abgeben, wenn ausdruecklich scharf.
      // slipLeft false: der Schein lebte nur in dieser Anfrage-Kette — im Tab steht nichts, was jemand abgeben oder leeren muesste.
      if (!armed) return mit({ status: "staged", slipLeft: false, odds: quote, legs: gelegt, returns: ertrag || null, tax: steuer, note: "Combo built and priced through the Stoiximan betslip interface — NOT placed (armed=false). Nothing is left in the tab." });
      // 4) Abgeben — EIN Aufruf. oddschanges "0": keine Quotenaenderung annehmen.
      const slip = scheinVon(ud, REITER_KOMBI);
      const z = { id: "k" + (++warteNr) + "-" + Date.now().toString(36), slip, t0: Date.now(), T0, ta: jetztMs(), ms, gelegt, uid: null, fbt: null, n502: 0, gewartet: 0, offen: null, abgleiche: 0,
        k: { eventIds: legs.map((L) => String(L.eventId)), odds: quote, einsatz: amount, vorOk: !!(vorher && vorher.ok), vorKeys: new Set(((vorher && vorher.bets) || []).map(wettKennung)) } };
      abgegeben = true;
      const erste = await ruf("POST", "/api/betslip/v3/place", { betslip: Object.assign({}, slip, { oddschanges: "0" }) });
      const erg = await weiter(z, erste);
      emit("Combo result", { status: erg.status, odds: erg.odds || null, reason: erg.reason || null });
      return erg;
    } catch (e) {
      const text = String((e && e.message) || e);
      // Nach dem Abgeben darf eine Ausnahme nie „nicht gesetzt“ heissen — der Schein kann beim Buch sein.
      if (abgegeben) return mit({ status: "uncertain", reason: "Stoiximan combo: exception after the slip was sent (" + text + ") — POSSIBLY placed, check the bet history", legs: gelegt });
      return nein("exception: " + text);
    } finally { laeuft = false; }
  }

  // beschaeftigt: laeuft ein Auftrag oder wartet ein abgegebener Schein (hoechstens 10 min alt) auf sein Ergebnis?
  const beschaeftigt = () => laeuft || [...wartend.values()].some((z) => Date.now() - z.t0 < WARTEN_ALT_MS);
  self.SXKOMBI = { place, nachfragen, laeuft: () => laeuft, beschaeftigt, MARKT, _kombiEintrag: kombiEintrag, _beinFehler: beinFehler };
})();
