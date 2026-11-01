// efbet-kombi.js — KOMBIWETTE bei efbet.gr (Plattform BetConstruct „Swarm“). 05.10.2026.
// Geteilt und BYTE-GLEICH: Erweiterung (efbet-kombi.js, vor efbet-content.js geladen) und Manometer Agent der External Bettors
// (engine/content/efbet-kombi.js, vor content/efbet-place.js eingespritzt). Stellt EFKOMBI.place(msg, env) und
// EFKOMBI.nachfragen(warteId, env) bereit. Den Weg zum Buch gibt das Setz-Script (efbet-content.js) als env mit:
//   env.lies(befehl, params)  lesender Befehl ueber den Socket der Seite            → { code, msg, data } | { fehler }
//   env.vorgaben()            oeffentliche Regeln des Partners (Steuer, Kombi-Quote) → Antwort der Seiten-Bruecke
//   env.sende(schein)         DIE Absende-Funktion des Buchs (einziger Punkt ohne Wiederkehr, wie bei der Einzelwette)
//   env.belegt / env.belegen / env.freigeben   Spiele, auf denen im selben Tab gerade ein Auftrag laeuft
//   env.emit(text, daten)     Protokoll
//
// Betreiber (05.10.2026): „lasse uns Stück für Stück die anderen Bookies anbinden, sodass man auch bei denen die Parlays setzen
// kann … Zuerst bei den GR-Bookies bitte den GR-Chrome nutzen zum Testen.“
//
// GELERNT am Wettschein-Code der Seite und am Swarm (05.10., GR-Chrome ohne Anmeldung + eigene anonyme Lese-Sitzung — es wurde
// nichts abgegeben):
//   * Die Seite baut eine Kombi mit DEMSELBEN Befehl wie die Einzelwette (useUserData.js): create_bets { bets:[{ Source 42,
//     Type 2 (Single 1 · Multiple 2 · System 3), AcceptTypeId, OddType, EachWay false, Events:[{ Coeficient, SelectionId } …
//     alle Auswahlen], IsSuperBet false, Amount, Tags }] } — Feld fuer Feld wie die beiden mitgelesenen Einzelwetten.
//   * Gesamtquote = Produkt der Quoten, auf multiple_price_decimals (2) Stellen ABGESCHNITTEN (price_round_method 0 =
//     possibleWinHelpers.js der Seite: Math.trunc), hoechstens max_odd_for_multiple_bet (10000). Hoechstens 30 Auswahlen.
//   * GEWINNSTEUER ist bei efbet ECHT (tax_type 1 = auf den Gewinn, kein „Fake“-Typ): gestaffelt 0 % bis 99,99 € · 2,5 % bis
//     199,99 € · 5 % bis 499,99 € · 7,5 % darueber. Die Rechnung hier ist die der Seite (TaxRules.js calculate) — gegen deren
//     eigenen Code geprueft: 15 Randwerte und 20000 Zufallswerte ohne Abweichung. Fuer die Mindest-Gesamtquote zaehlt die
//     Auszahlung NACH Steuer.
//   * Zwei Auswahlen aus demselben Spiel vertragen sich nicht (prematch_multiple_disabled) — der Auftrag nennt ohnehin je Spiel
//     nur ein Bein. Ein Spiel mit express_min_len 1 nimmt NUR Einzelwetten (gemessen: 7 von 1187 Fussball-, 2 von 85
//     Basketballspielen); ein groesserer Wert verlangt mindestens so viele Auswahlen im Schein.
//   * Alle Beine lassen sich in EINER Anfrage frisch lesen (get source betting, game id @in, market type @in — 85 ms). Beim
//     Basketball kommt dabei auch der 3-Weg-Markt der regulaeren Spielzeit (P1XP2 / MatchWinner3) mit: das ist eine ANDERE
//     Wette, gesetzt wird nur P1P2 / MatchWinner2 (Sieger inklusive Verlaengerung).
//   * Hoechsteinsatz der Kombi: get_max_bet { events:[{ event_id } …], type 2 } — nur angemeldet lesbar (Code 12 sonst).
//   NICHT GEMESSEN: die Annahme einer Kombi (es wurde keine abgegeben). Ausgewertet wird wie bei der Einzelwette
//   (StatusCode "0" + Data[0].bet_id = angenommen, { Key, ErrorData } = Absage), streng: die Antwort muss GENAU EINE Wette mit
//   GENAU den gesendeten Auswahlen nennen, sonst „uncertain“.
// SICHERUNGEN (fail-closed): Auftrags-Nummer Pflicht (derselbe Auftrag laeuft nie zweimal); scharf nur angemeldet (offene
//   Wetten lesbar) und nie, wenn derselbe Schein schon offen im Konto steht; je Bein: Spiel in der Antwort, Sportart, nicht
//   angepfiffen, nicht gesperrt, kombinierbar, GENAU EIN Sieger-Markt mit genau dessen Auswahlen, die Auswahl-Nr. sitzt auf der
//   Seite des Tipps, Quote ≥ Mindestquote; Gesamtquote (abgeschnitten) ≤ Hoechstquote des Buchs und — nach Steuer — ≥
//   Mindest-Gesamtquote; Einsatz zwischen Mindest- und Hoechsteinsatz des Buchs. armed:false endet hier („staged“).
// WARTEN OHNE ZEITGEBER IN DER SEITE: nach dem Absenden antwortet place sofort { status:"pending", warteId, nachMs } — der
//   Aufrufer (Service Worker) wartet und ruft nachfragen. Mannschaftsnamen werden hier NICHT verglichen: der Katalog des
//   Dienstes schreibt sie um („(Wom)“ → „(W)“); die Zuordnung haengt an Spiel-Nr., Auswahl-Nr. und Seite (wie die Einzelwette).
(() => {
  "use strict";
  if (self.EFKOMBI && typeof self.EFKOMBI.beschaeftigt === "function" && self.EFKOMBI.beschaeftigt()) return;
  const BUCH = "efbet";
  // Sieger-Markt je Sportart (wie efbet-content.js SIEGER): Swarm-Sportart, Markt-Typ, market_type, Tipp → Seite des Markts.
  const SIEGER = {
    soccer: { alias: "Soccer", typ: "P1XP2", art: "MatchResult", seiten: { "1": "W1", X: "X", "2": "W2" }, arten: ["W1", "X", "W2"] },
    basketball: { alias: "Basketball", typ: "P1P2", art: "MatchWinner2", seiten: { "1": "W1", "2": "W2" }, arten: ["W1", "W2"] }
  };
  // Schein-Felder wie die mitgelesenen Einzelwetten; Type 2 = Kombi. AcceptTypeId 0 = keine Quotenaenderung annehmen.
  const HERKUNFT = 42, KOMBIWETTE = 2, NIE_ANNEHMEN = 0, DEZIMAL = 0, MARKE = 216;
  const MIN = 2, MAX = 12, MIN_EINSATZ = 0.1, MAX_EINSATZ = 1000;
  const NACH_MS = 400, ABGLEICH_MS = 1200, ABGLEICH_MAX = 3, WARTE_MAX_MS = 75000, WARTE_ALT_MS = 10 * 60000, WETTEN_TAGE = 7, MERKEN_MAX = 40;
  const CODE_OK = 0, CODE_ABGEMELDET = 12;
  const CODES_ABGELEHNT = { 2: "command not accepted by the book", 5: "session of the page lost", 12: "not logged in at efbet", 27: "the book asks for a captcha", 32: "the book asks for a captcha", 33: "the book asks for a captcha", 34: "the book asks for a captcha", 41: "the book asks for a security check", 558: "session of the page already active" };
  const STAND_ANGENOMMEN = { 1: 1, 3: 1, 4: 1, 5: 1, 6: 1 };     // check_bet_status: Accepted, Lost, Won, CashOut, LostReturn
  const wartend = new Map(), auftraege = new Map(), erledigt = new Map();
  const merke = (m, k, v) => { m.set(k, v); while (m.size > MERKEN_MAX) m.delete(m.keys().next().value); };
  let warteNr = 0, laeuft = false;
  const jetztMs = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  const zahl = (x) => (typeof x === "number" && isFinite(x) ? x : (typeof x === "string" && x.trim() !== "" && isFinite(Number(x)) ? Number(x) : null));
  const fix = (e) => (e % 1 === 0 ? e : parseFloat(e.toPrecision(12)));   // wie die Seite: Gleitkomma-Rauschen entfernen
  const cfgVon = (sport) => { const k = String(sport == null || sport === "" ? "soccer" : sport); return Object.prototype.hasOwnProperty.call(SIEGER, k) ? SIEGER[k] : null; };
  const gleicheMenge = (a, b) => a.length === b.length && a.slice().sort().join(",") === b.slice().sort().join(",");

  // ---- PURE: Regeln des Partners ---------------------------------------------------------------------------------------------
  // Gesamtquote einer Kombi wie die Seite: Produkt (nach jedem Schritt entrauscht), auf d Stellen ABGESCHNITTEN. Eine andere
  // Rundungsart des Partners (price_round_method ≠ 0 rundet AUF) aendert nichts: abgeschnitten ist die untere Grenze.
  function gesamtQuote(preise, v) {
    const d = (v && Number.isInteger(v.multiple_price_decimals) && v.multiple_price_decimals >= 0 && v.multiple_price_decimals <= 6) ? v.multiple_price_decimals : 2, n = Math.pow(10, d);
    const produkt = preise.reduce((p, q) => fix(p * q), 1);
    return fix(Math.trunc(fix(produkt * n)) / n);
  }
  // Staffel wie TaxRules.calculate der Seite: gilt nur, wenn der Betrag in einer Stufe liegt; dann von der ersten Stufe an
  // aufsteigend je Stufenbreite. Sonst der feste Satz (pctOhne).
  function staffel(betrag, stufen, pctOhne) {
    if (!(betrag > 0)) return 0;
    let r = 0;
    if (stufen.length && stufen.some((x) => betrag >= x.from && betrag <= x.to)) {
      let n = Math.max(0, betrag - stufen[0].from), a = stufen[0].from;
      for (const x of stufen) { const breite = x.to - a; if (n > breite) { r += breite * x.percent / 100; n -= breite; } else { r += n * x.percent / 100; n = 0; break; } a = x.to; }
    } else r = betrag * (pctOhne || 0) / 100;
    return fix(r);
  }
  // Steuer des Buchs auf einen gewonnenen Schein → { ok, betrag, auf } | { ok:false, grund }. Verstanden werden die Arten der
  // Seite auf Gewinn (1, 21) und auf Auszahlung (2, 20) bei Integration 0 / 1; die „Fake“-Arten zaehlen hier wie echte (lieber
  // zu vorsichtig). Steuer auf den EINSATZ (4) oder eine unbekannte Art: nicht verstanden → der Aufrufer setzt nicht.
  function steuer(v, einsatz, auszahlung) {
    if (!v || typeof v !== "object") return { ok: false, grund: "rules of the book not readable" };
    const typ = zahl(v.tax_type), integ = zahl(v.tax_integration_type), pct = zahl(v.tax_percent) || 0;
    const roh = Array.isArray(v.tax_amount_ranges) ? v.tax_amount_ranges : (v.tax_amount_ranges == null ? [] : null);
    if (roh === null) return { ok: false, grund: "tax brackets of the book unreadable" };
    if ((typ == null || typ === 0) && !roh.length) return { ok: true, betrag: 0, auf: null };
    if (!(integ === 0 || integ === 1) || [1, 2, 20, 21].indexOf(typ) < 0) return { ok: false, grund: "tax rule of the book not understood (type " + String(v.tax_type) + ", integration " + String(v.tax_integration_type) + ")" };
    const je = {};
    for (const s of roh) {
      const x = s ? { from: zahl(s.from), to: zahl(s.to), percent: zahl(s.percent), type: zahl(s.type) } : null;
      if (!x || x.from == null || x.to == null || x.percent == null || x.type == null || x.to < x.from || x.percent < 0) return { ok: false, grund: "tax brackets of the book unreadable" };
      (je[x.type] = je[x.type] || []).push(x);
    }
    if (je[4]) return { ok: false, grund: "tax rule of the book not understood (tax on the stake)" };
    for (const k of Object.keys(je)) je[k].sort((a, b) => a.from - b.from);
    const aufGewinn = typ === 1 || !!je[1] || typ === 21, aufAuszahlung = typ === 2 || !!je[2] || typ === 20, schein = typ === 21 || typ === 20;
    if (aufGewinn) { const art = schein ? 21 : 1; return { ok: true, betrag: staffel(auszahlung - einsatz, je[art] || [], typ === art ? pct : 0), auf: "profit" }; }
    if (aufAuszahlung) { const art = schein ? 20 : 2; return { ok: true, betrag: staffel(auszahlung, je[art] || [], typ === art ? pct : 0), auf: "return" }; }
    return { ok: true, betrag: 0, auf: null };
  }

  // ---- PURE: frische Quoten aller Beine aus EINER Antwort -----------------------------------------------------------------
  function sammelAnfrage(legs) {
    const typen = []; for (const L of legs) { const M = cfgVon(L.sport); if (M && typen.indexOf(M.typ) < 0) typen.push(M.typ); }
    return { source: "betting",
      what: { sport: ["id", "alias"], game: ["id", "team1_name", "team2_name", "start_ts", "type", "is_blocked", "is_started", "info", "express_min_len"], market: ["id", "type", "market_type"], event: ["id", "type_1", "price"] },
      where: { game: { id: { "@in": legs.map((L) => Number(L.eventId)) } }, market: { type: { "@in": typen } } }, subscribe: false };
  }
  // → { beine:[{ preis, auswahlId, spielId, sport }] } | { fehler, bein (1 …), dauerhaft? } — dauerhaft: das Bein kann bei diesem
  // Buch grundsaetzlich nicht in eine Kombi (der Aufrufer nimmt es dann aus der Auswahl, statt es wieder zu versuchen).
  function quotenAus(a, legs, jetzt) {
    if (!a || a.fehler) return { fehler: "games not readable (" + String((a && a.fehler) || "no answer") + ")", bein: 0 };
    if (a.code !== CODE_OK) return { fehler: "games not readable (Swarm code " + String(a.code) + ")", bein: 0 };
    const S = a.data && a.data.data && a.data.data.sport && typeof a.data.data.sport === "object" ? a.data.data.sport : {};
    const beine = [];
    for (let i = 0; i < legs.length; i++) {
      const L = legs[i], M = cfgVon(L.sport), nr = i + 1;
      let g = null, alias = null, mehrfach = false;
      for (const sid of Object.keys(S)) {
        const G = S[sid] && S[sid].game && typeof S[sid].game === "object" ? S[sid].game : {};
        if (Object.prototype.hasOwnProperty.call(G, String(L.eventId)) && G[String(L.eventId)]) { if (g) mehrfach = true; g = G[String(L.eventId)]; alias = S[sid].alias; }
      }
      // Ein Spiel ohne offenen Sieger-Markt liefert der Swarm bei diesem Filter gar nicht.
      if (!g) return { fehler: "game or its winner market is not (any longer) on offer", bein: nr };
      if (mehrfach || String(g.id) !== String(L.eventId)) return { fehler: "another game in the answer", bein: nr };
      if (alias !== M.alias) return { fehler: "the game is not " + String(L.sport || "soccer") + " at the book (" + String(alias) + ")", bein: nr };
      const info = g.info && typeof g.info === "object" ? g.info : {}, zustand = String(info.current_game_state == null ? "" : info.current_game_state);
      const spielLaeuft = Number(g.type) === 1 && Number(g.is_started) !== 0 && zustand !== "notstarted";
      const anstoss = Number(g.start_ts) > 0 ? Number(g.start_ts) * 1000 : 0;
      if (spielLaeuft || !(anstoss > jetzt)) return { fehler: "the game has started or its kick-off is unknown — combos are pre-match only", bein: nr };
      if (Number(g.is_blocked) === 1) return { fehler: "the game is blocked at the book", bein: nr };
      const eml = g.express_min_len == null ? null : Number(g.express_min_len);
      if (eml === 1) return { fehler: "this game takes single bets only at the book (not combinable)", bein: nr, dauerhaft: true };
      if (eml != null && !(eml <= legs.length)) return { fehler: "this game needs a combo of at least " + String(g.express_min_len) + " selections at the book", bein: nr, dauerhaft: true };
      const MK = g.market && typeof g.market === "object" ? g.market : {};
      let markt = null, nM = 0;
      for (const mid of Object.keys(MK)) { const m = MK[mid]; if (!m || m.type !== M.typ || m.market_type !== M.art) continue; nM++; markt = m; }
      if (nM !== 1) return { fehler: nM ? "several winner markets in the answer" : "winner market not (any longer) open", bein: nr };
      const E = markt.event && typeof markt.event === "object" ? markt.event : {}, je = {}, arten = M.arten;
      let nE = 0;
      for (const eid of Object.keys(E)) {
        const e = E[eid]; if (!e) continue;
        nE++;
        const art = String(e.type_1 == null ? "" : e.type_1);
        if (arten.indexOf(art) < 0 || je[art]) return { fehler: "the winner market does not carry exactly the outcomes " + arten.join(" / "), bein: nr };
        je[art] = e;
      }
      if (nE !== arten.length || arten.some((x) => !je[x])) return { fehler: "the winner market does not carry exactly the outcomes " + arten.join(" / "), bein: nr };
      const e = je[M.seiten[L.tip]];
      if (!e || String(e.id) !== String(L.outcomeId)) return { fehler: "the selection number does not (any longer) sit on outcome " + L.tip + " of this game", bein: nr };
      const preis = Number(e.price);
      if (!(preis > 1) || !isFinite(preis)) return { fehler: "no odds", bein: nr };
      if (!(preis >= Number(L.minOdds))) return { fehler: String(preis) + " is below the min odds " + Number(L.minOdds), bein: nr };
      beine.push({ preis, auswahlId: String(e.id), spielId: String(g.id), sport: String(L.sport || "soccer"), tip: L.tip });
    }
    return { beine };
  }
  // PURE: der Schein — Feld fuer Feld und in der Reihenfolge der Seite (wie die Einzelwette, Type 2, alle Auswahlen).
  function baueSchein(beine, einsatz) {
    return { command: "create_bets", params: { bets: [{ Source: HERKUNFT, Type: KOMBIWETTE, AcceptTypeId: NIE_ANNEHMEN, OddType: DEZIMAL, EachWay: false,
      Events: beine.map((b) => ({ Coeficient: b.preis, SelectionId: Number(b.auswahlId) })), IsSuperBet: false, Amount: Number(einsatz), Tags: MARKE }] } };
  }
  // PURE: Wahrheitstabelle. Eingabe: die Rueckgabe von env.sende() und was gesendet wurde (soll = { ids:[Auswahl-Nrn.], quote }).
  function klassifiziere(antwort, soll) {
    if (!antwort || antwort.art === "gesperrt") return { status: "blocked", reason: BUCH + " combo: nothing sent — " + String((antwort && antwort.grund) || "the page bridge refused").slice(0, 160) };
    if (antwort.art === "netzfehler") return { status: "uncertain", reason: BUCH + " combo: connection of the page lost while sending (" + String(antwort.fehler).slice(0, 80) + ") — POSSIBLY placed, check the bet history" };
    if (antwort.art === "zeit") return { status: "uncertain", reason: BUCH + " combo: no answer of the book in time — POSSIBLY placed, check the bet history" };
    if (antwort.art !== "antwort" || !antwort.json) return { status: "uncertain", reason: BUCH + " combo: unknown answer — POSSIBLY placed, check the bet history" };
    const j = antwort.json, code = Number(j.code);
    if (code !== CODE_OK) {
      const zusatz = j.msg ? " — " + String(j.msg).slice(0, 80) : "";
      if (CODES_ABGELEHNT[code]) return { status: "failed", reason: "The book rejected the combo: " + CODES_ABGELEHNT[code] + " (Swarm code " + code + zusatz + ")" };
      return { status: "uncertain", reason: BUCH + " combo: unclear answer of the book (Swarm code " + String(j.code) + zusatz + ") — POSSIBLY placed, check the bet history" };
    }
    const d = j.data;
    if (!d || typeof d !== "object") return { status: "uncertain", reason: BUCH + " combo: empty answer of the book — POSSIBLY placed, check the bet history" };
    if (String(d.StatusCode) === "0") {
      // Angenommen: GENAU EINE Wette mit GENAU den gesendeten Auswahlen. Alles andere ist kein sauberes „gesetzt“.
      const liste = Array.isArray(d.Data) ? d.Data : [];
      const w = liste.length === 1 ? liste[0] : null;
      if (!w || w.bet_id == null) return { status: "uncertain", reason: liste.length > 1 ? "AUDIT: the book answers with " + liste.length + " bets for one combo — check the bet history immediately" : BUCH + " combo: accepted without a readable bet number — check the bet history" };
      const ticket = String(w.bet_id), k = Number(w.k) > 1 ? Number(w.k) : soll.quote, stake = Number(w.amount) > 0 ? Number(w.amount) : undefined;
      const ids = (Array.isArray(w.events) ? w.events : []).map((e) => String(e && e.selection_id));
      if (!gleicheMenge(ids, soll.ids)) return { status: "uncertain", ticket, odds: k, stake, reason: "AUDIT: the answer of the book names other selections than the ones sent — check the bet history immediately" };
      if (w.is_superbet === true) return { status: "uncertain", ticket, odds: k, stake, reason: BUCH + " combo: the bet is under review at the book (superbet) — check the bet history" };
      return { status: "placed", ticket, odds: k, stake };
    }
    const sc = d.StatusCode != null ? String(d.StatusCode) : "";
    const key = typeof d.Data === "string" ? d.Data : (d.Data && typeof d.Data === "object" && d.Data.Key != null ? String(d.Data.Key) : "");
    if (!sc && !key) return { status: "uncertain", reason: BUCH + " combo: no clear verdict of the book — POSSIBLY placed, check the bet history" };
    let was = key || "status " + sc;
    const ed = d.Data && typeof d.Data === "object" && d.Data.ErrorData && typeof d.Data.ErrorData === "object" ? d.Data.ErrorData : null;
    if (ed) { const teile = Object.keys(ed).filter((x) => typeof ed[x] === "number" || typeof ed[x] === "string").slice(0, 6).map((x) => x + " " + String(ed[x]).slice(0, 24)); if (teile.length) was += " (" + teile.join(", ") + ")"; }
    return { status: "failed", reason: "The book rejected the combo: " + was.slice(0, 200) };
  }

  // ---- Lesen ueber den Socket der Seite (env.lies) --------------------------------------------------------------------------
  // Offene Wetten des Kontos: Anmelde-Probe (nur angemeldet lesbar, sonst Code 12), Doppel-Schutz und Abgleich nach dem Senden.
  async function offeneWetten(env, jetzt) {
    const bis = Math.floor(jetzt / 1000) + 300, von = bis - WETTEN_TAGE * 86400;
    let a; try { a = await env.lies("bet_history", { where: { outcome: 0, from_date: von, to_date: bis, all_bet_types: true } }); } catch (e) { a = { fehler: String((e && e.message) || e) }; }
    if (!a || a.fehler) return { ok: false, grund: "account not readable (" + String((a && a.fehler) || "no answer").slice(0, 80) + ")" };
    if (a.code === CODE_ABGEMELDET) return { ok: false, grund: "not logged in at efbet" };
    if (a.code !== CODE_OK) return { ok: false, grund: "account not readable (Swarm code " + String(a.code) + ")" };
    const b = a.data && a.data.bets;
    if (!Array.isArray(b)) return { ok: false, grund: "account not readable (unexpected answer)" };
    return { ok: true, wetten: b };
  }
  async function vorgabenLesen(env) {
    let r; try { r = await env.vorgaben(); } catch (e) { r = { ok: false, fehler: String((e && e.message) || e) }; }
    const v = r && r.ok && r.antwort && r.antwort.code === CODE_OK && r.antwort.data ? r.antwort.data.vorgaben : null;
    if (!v || typeof v !== "object") return { ok: false, grund: "rules of the book (tax, combo odds) not readable" + (r && r.fehler ? " (" + String(r.fehler).slice(0, 80) + ")" : "") };
    return { ok: true, v };
  }
  // Hoechsteinsatz des Buchs fuer DIESE Kombi (nur angemeldet). Zahl oder null (nicht lesbar — dann entscheidet das Buch).
  async function maxEinsatz(env, legs) {
    try {
      const a = await env.lies("get_max_bet", { events: legs.map((L) => ({ event_id: Number(L.outcomeId) })), type: KOMBIWETTE });
      const m = a && a.code === CODE_OK && a.data && Number(a.data.result) === 0 && a.data.details ? Number(a.data.details.amount) : NaN;
      return isFinite(m) && m >= 0 ? m : null;
    } catch (_) { return null; }
  }
  // Steht dieser Schein im Konto? true / false, null = nicht lesbar. Ein Treffer steht in z.fund.
  async function imKonto(z, env) {
    if (z.ticket != null) {
      let a; try { a = await env.lies("check_bet_status", { bet_id: Number(z.ticket) }); } catch (_) { return null; }
      if (!a || a.fehler || a.code !== CODE_OK || !a.data) return null;
      const d = a.data.details;
      if (!d) return /BetNotFound/i.test(String(a.data.result_text || "")) ? false : null;
      if (String(d.Id) !== String(z.ticket) || d.IsSuperBet === true) return null;
      if (!gleicheMenge((Array.isArray(d.SelectionList) ? d.SelectionList : []).map((s) => String(s && s.SelectionId)), z.soll.ids)) return null;
      if (!STAND_ANGENOMMEN[Number(d.StateId)]) return null;
      z.fund = { id: String(d.Id), quote: Number(d.Price) > 1 ? Number(d.Price) : null, einsatz: Number(d.Amount) > 0 ? Number(d.Amount) : null };
      return true;
    }
    const o = await offeneWetten(env, Date.now());
    if (!o.ok) return null;
    for (const w of o.wetten) {
      if (!w || w.id == null || z.vorher[String(w.id)]) continue;
      if (!gleicheMenge((Array.isArray(w.auswahl) ? w.auswahl : []).map((x) => String(x && x.id)), z.soll.ids)) continue;
      if (Number(w.zeit) > 0 && Number(w.zeit) * 1000 < z.start - 120000) continue;         // aelter als der Auftrag: nicht unsere
      z.fund = { id: String(w.id), quote: Number(w.quote) > 1 ? Number(w.quote) : null, einsatz: Number(w.einsatz) > 0 ? Number(w.einsatz) : null };
      return true;
    }
    return false;
  }

  // ---- nach dem Absenden ---------------------------------------------------------------------------------------------------
  function fertig(z, o, env) {
    z.ms.gesamt = Math.round(jetztMs() - z.T0);
    const e = Object.assign(o, { legs: z.gelegt, ms: z.ms, tax: z.steuer, netOdds: z.netto });
    wartend.delete(z.id); merke(erledigt, z.id, e);
    try { if (env && env.freigeben) env.freigeben(z.spiele); } catch (_) {}
    try { if (env && env.emit) env.emit("Combo result", { status: e.status, odds: e.odds || null, ticket: e.ticket || null, reason: e.reason || null }); } catch (_) {}
    return e;
  }
  const nochOffen = (z, ms) => ({ status: "pending", warteId: z.id, nachMs: ms, odds: z.soll.quote });
  // EIN Schritt fuer einen abgegebenen Schein: ist die Antwort des Buchs da? Danach hoechstens ein Blick ins Konto je Aufruf.
  async function schritt(z, env) {
    if (!z.urteil) {
      if (!z.antwort) {
        if (Date.now() - z.start < WARTE_MAX_MS) return nochOffen(z, NACH_MS);
        z.antwort = { art: "zeit" };
      }
      if (z.ms.abgeben == null) z.ms.abgeben = Math.round(jetztMs() - z.ta);
      z.urteil = klassifiziere(z.antwort, z.soll);
      if (z.urteil.status === "blocked" || z.urteil.status === "failed") return fertig(z, z.urteil, env);
      if (z.urteil.ticket != null) z.ticket = z.urteil.ticket;
    }
    const u = z.urteil;
    z.abgleiche++;
    const da = await imKonto(z, env);
    if (u.status === "placed") {
      if (da === true || z.abgleiche >= ABGLEICH_MAX) return fertig(z, Object.assign({ status: "placed", ticket: u.ticket, odds: u.odds, stake: u.stake != null ? u.stake : z.einsatz, verified: da === true }, da === true ? {} : { note: "bet number given by the book, not (yet) confirmed by reading the account" }), env);
      return nochOffen(z, ABGLEICH_MS);
    }
    // uncertain: steht der Schein im Konto, ist er gesetzt — sonst bleibt der Ausgang offen.
    if (da === true) return fertig(z, { status: "placed", ticket: z.fund.id, odds: z.fund.quote || u.odds || z.soll.quote, stake: z.fund.einsatz || z.einsatz, verified: true, note: "confirmed by reading the account (the answer of the book was unclear)" }, env);
    if (da === false && z.abgleiche < ABGLEICH_MAX) return nochOffen(z, ABGLEICH_MS);
    return fertig(z, Object.assign({ odds: z.soll.quote }, u), env);
  }
  // Laeuft fuer diesen Schein gerade ein Schritt (zweiter Empfaenger), gibt es dessen Ergebnis — kein zweiter Abruf.
  function nachfragen(warteId, env) {
    const id = String(warteId), z = wartend.get(id);
    if (!z) return Promise.resolve(erledigt.has(id) ? erledigt.get(id) : { status: "uncertain", reason: BUCH + " combo: the waiting slip is no longer known (page reloaded?) — POSSIBLY placed, check the bet history" });
    if (z.lauf) return z.lauf;
    z.lauf = (async () => {
      try { return await schritt(z, env || z.env); }
      catch (e) { return fertig(z, { status: "uncertain", odds: z.soll.quote, reason: BUCH + " combo: " + String((e && e.message) || e) + " — POSSIBLY placed, check the bet history" }, env || z.env); }
      finally { z.lauf = null; }
    })();
    return z.lauf;
  }

  // msg: { auftragId (Pflicht, 6–80 Zeichen — dieselbe Nummer wird nie zweimal ausgefuehrt), legs:[{ eventId, outcomeId (Auswahl-Nr.
  //        des Buchs), tip ("1"|"X"|"2" in der Reihenfolge des BUCHS), minOdds, sport? ("soccer" ohne Angabe · "basketball": 1|2) }],
  //        amount (€), minTotalOdds, armed (true = abgeben) }
  // Antwort: { status: staged | pending | placed | failed | blocked | uncertain, odds (Gesamtquote), netOdds (nach Steuer),
  //            tax:{ total, back, toPay }, legs:[…], ms, ticket?, reason?, note?, bein?, dauerhaft?, warteId?, nachMs? }
  function place(msg, env) {
    const id = (msg && msg.auftragId != null) ? String(msg.auftragId) : "";
    if (!/^[A-Za-z0-9_.:-]{6,80}$/.test(id)) return Promise.resolve({ status: "blocked", reason: BUCH + " combo: order number missing — nothing sent", legs: [], ms: { gesamt: 0, lesen: null, abgeben: null } });
    if (auftraege.has(id)) return auftraege.get(id);
    const lauf = ausfuehren(msg, env || {});
    merke(auftraege, id, lauf);
    return lauf;
  }
  async function ausfuehren(msg, env) {
    const legs = msg && msg.legs, armed = !!(msg && msg.armed === true);
    const emit = (t, d) => { try { if (typeof env.emit === "function") env.emit(t, d); } catch (_) {} };
    const T0 = jetztMs(), ms = { gesamt: 0, lesen: null, abgeben: null }, gelegt = [];
    const mit = (o) => { ms.gesamt = Math.round(jetztMs() - T0); return Object.assign(o, { ms }); };
    const nein = (reason, mehr) => { emit("Combo aborted — nothing placed", { reason }); return mit(Object.assign({ status: "blocked", reason: BUCH + " combo: " + reason, legs: gelegt }, mehr || {})); };
    if (typeof env.lies !== "function" || typeof env.sende !== "function" || typeof env.vorgaben !== "function") return nein("placement script incomplete");
    if (!Array.isArray(legs) || legs.length < MIN || legs.length > MAX) return nein("needs " + MIN + " to " + MAX + " legs");
    const spieleSet = new Set(), nummern = new Set();
    for (const L of legs) {
      const M = L ? cfgVon(L.sport) : null;
      if (L && !M) return nein("sport " + String(L.sport) + " is not connected for combos");
      if (!L || !/^\d{1,15}$/.test(String(L.eventId)) || !/^\d{1,15}$/.test(String(L.outcomeId)) || !Object.prototype.hasOwnProperty.call(M.seiten, String(L.tip)) || !(Number(L.minOdds) > 1) || spieleSet.has(String(L.eventId)) || nummern.has(String(L.outcomeId))) return nein("invalid or duplicate leg");
      spieleSet.add(String(L.eventId)); nummern.add(String(L.outcomeId));
    }
    const amount = Math.round(Number(msg.amount) * 100) / 100, minTotal = Number(msg.minTotalOdds);
    if (!(amount >= MIN_EINSATZ) || amount > MAX_EINSATZ) return nein("stake " + String(msg.amount) + " outside " + MIN_EINSATZ + "–" + MAX_EINSATZ);
    if (!(minTotal > 1)) return nein("minimum total odds missing");
    if (laeuft) return nein("another combo is being built right now");
    const spiele = [...spieleSet], sollIds = legs.map((L) => String(L.outcomeId));
    try { if (typeof env.belegt === "function" && env.belegt(spiele)) return nein("a bet on one of these games is being placed in this tab right now"); } catch (_) {}
    laeuft = true;
    let gesendet = false;
    try {
      // 1) Konto (nur scharf: Anmeldung, Doppel-Schutz, Hoechsteinsatz) und die Regeln des Buchs — nebeneinander
      const tl = jetztMs();
      const [sess, vg, max] = await Promise.all([armed ? offeneWetten(env, Date.now()) : null, vorgabenLesen(env), armed ? maxEinsatz(env, legs) : null]);
      if (armed && !sess.ok) return nein(sess.grund + " — nothing sent");
      if (!vg.ok) return nein(vg.grund);
      const v = vg.v, vorher = {};
      if (armed) for (const w of sess.wetten) {
        if (!w || w.id == null) continue;
        vorher[String(w.id)] = 1;
        if (gleicheMenge((Array.isArray(w.auswahl) ? w.auswahl : []).map((x) => String(x && x.id)), sollIds)) return nein("the account already holds an open bet with exactly these selections (bet " + String(w.id) + ")");
      }
      const maxBeine = zahl(v.max_selections_in_multiple_bet);
      if (maxBeine != null && legs.length > maxBeine) return nein("the book allows at most " + maxBeine + " selections in a combo");
      // 2) frische Quoten ALLER Beine zuletzt: beim Senden sind sie einen Abruf alt
      let antwort; try { antwort = await env.lies("get", sammelAnfrage(legs)); } catch (e) { antwort = { fehler: String((e && e.message) || e) }; }
      const q = quotenAus(antwort, legs, Date.now());
      ms.lesen = Math.round(jetztMs() - tl);
      if (q.fehler) return nein((q.bein ? "leg " + q.bein + ": " : "") + q.fehler, q.bein ? Object.assign({ bein: q.bein }, q.dauerhaft ? { dauerhaft: true } : {}) : null);
      for (let i = 0; i < legs.length; i++) gelegt.push({ eventId: String(legs[i].eventId), tip: legs[i].tip, outcomeId: q.beine[i].auswahlId, odds: q.beine[i].preis, minOdds: Number(legs[i].minOdds), sport: q.beine[i].sport });
      // 3) Gesamtquote wie das Buch, Steuer, Grenzen
      const quote = gesamtQuote(q.beine.map((b) => b.preis), v), maxQuote = zahl(v.max_odd_for_multiple_bet);
      if (!(quote > 1)) return nein("total odds not computable");
      if (maxQuote != null && maxQuote > 1 && quote > maxQuote) return nein("total odds " + quote + " are above the book's maximum for combos (" + maxQuote + ")");
      const auszahlung = fix(quote * amount), maxAus = zahl(v.max_payout);
      if (maxAus != null && maxAus > 0 && auszahlung > maxAus) return nein("the payout " + auszahlung + " is above the book's maximum payout (" + maxAus + ")");
      const st = steuer(v, amount, auszahlung);
      if (!st.ok) return nein(st.grund);
      const steuerInfo = { total: st.betrag, back: 0, toPay: st.betrag }, netto = fix((auszahlung - st.betrag) / amount);
      if (!(quote >= minTotal)) return nein("total odds " + quote.toFixed(2) + " are below the min total odds " + minTotal.toFixed(2));
      if (!(netto >= minTotal)) return nein("after the winnings tax (" + st.betrag.toFixed(2) + " €) the combo pays " + netto.toFixed(2) + " times the stake — below the min total odds " + minTotal.toFixed(2));
      const minEin = v.min_bet_stakes && zahl(v.min_bet_stakes.EUR);
      if (minEin != null && amount < minEin) return nein("stake " + amount + " is below the book's minimum " + minEin);
      if (max != null && amount > max + 0.005) return nein("stake " + amount + " is above the book's maximum " + max + " for this combo");
      emit("Combo built and priced", { legs: gelegt.length, totalOdds: quote, netOdds: netto, amount, taxToPay: st.betrag, armed, ms: Math.round(jetztMs() - T0) });
      // Sicherheits-Halt: nur abgeben, wenn ausdruecklich scharf. Im Tab bleibt nichts stehen (es gibt keinen Schein in der Seite).
      if (!armed) return mit({ status: "staged", slipLeft: false, odds: quote, netOdds: netto, legs: gelegt, returns: auszahlung, tax: steuerInfo, note: "Combo checked and priced against the efbet odds feed — NOT placed (armed=false). Nothing is left in the tab." });
      // 4) Abgeben — EIN Auftrag an die Absende-Funktion des Buchs
      const z = { id: "k" + (++warteNr) + "-" + Date.now().toString(36), soll: { ids: sollIds, quote }, einsatz: amount, vorher, start: Date.now(), T0, ta: jetztMs(), ms, gelegt, spiele, steuer: steuerInfo, netto,
        antwort: null, urteil: null, ticket: null, fund: null, abgleiche: 0, lauf: null, env };
      try { if (typeof env.belegen === "function") env.belegen(spiele); } catch (_) {}
      gesendet = true;
      const sendung = env.sende(baueSchein(q.beine, amount));               // PUNKT OHNE WIEDERKEHR
      Promise.resolve(sendung).then((x) => { z.antwort = x || { art: "netzfehler", fehler: "empty answer of the bridge" }; }, (e) => { z.antwort = { art: "netzfehler", fehler: String((e && e.message) || e) }; });
      wartend.set(z.id, z);
      return nochOffen(z, NACH_MS);
    } catch (e) {
      const text = String((e && e.message) || e);
      if (gesendet) { try { if (typeof env.freigeben === "function") env.freigeben(spiele); } catch (_) {} return mit({ status: "uncertain", reason: BUCH + " combo: exception after the slip was sent (" + text + ") — POSSIBLY placed, check the bet history", legs: gelegt }); }
      return nein("exception: " + text);
    } finally { laeuft = false; }
  }

  const beschaeftigt = () => laeuft || [...wartend.values()].some((z) => Date.now() - z.start < WARTE_ALT_MS);
  self.EFKOMBI = { place, nachfragen, laeuft: () => laeuft, beschaeftigt, SIEGER, _gesamtQuote: gesamtQuote, _steuer: steuer, _staffel: staffel, _quotenAus: quotenAus, _sammelAnfrage: sammelAnfrage, _baueSchein: baueSchein, _klassifiziere: klassifiziere };
})();
