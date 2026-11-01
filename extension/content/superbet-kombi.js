// superbet-kombi.js — KOMBIWETTE bei Superbet (superbet.gr, eigene Plattform „betler“). 05.10.2026.
// Geteilt und BYTE-GLEICH: Erweiterung (superbet-kombi.js, vor superbet-content.js geladen) und Manometer Agent der External Bettors
// (engine/content/superbet-kombi.js, vor content/superbet-place.js eingespritzt). Stellt SBKOMBI.place(msg, env) und
// SBKOMBI.nachfragen(warteId) bereit; die Befehls-Verdrahtung macht das jeweilige Content-Script.
//
// Betreiber (05.10.2026): „lasse uns Stück für Stück die anderen Bookies anbinden, sodass man auch bei denen die Parlays setzen
// kann … Zuerst bei den GR-Bookies bitte den GR-Chrome nutzen zum Testen.“
//
// GELERNT (05.10., GR-Chrome ohne Anmeldung am Code der Seite und an ihrem Rechner; dazu die Mitschnitte der drei echten
// Einzelwetten vom 01.09. — es wurde nichts abgegeben):
//   * Eine Kombi geht mit DEMSELBEN Abruf raus wie die Einzelwette: POST …/legacy-web/betting/submitTicket mit items = je Spiel
//     EIN Eintrag, combs "" (nur ein System-Schein nennt dort Kombinationen), total = Einsatz, paymentBonusType 1 (= kein Bonus,
//     echtes Geld; 2 = Umsatz-Bonus, 3 = Freiwette). Jeder Eintrag traegt die Felder der mitgeschnittenen Einzelwetten (value
//     mit zwei Nachkommastellen, eventId, eventUuid, oddUuid, marketUuid, oddId = Ausgangs-Nr. …).
//     autoAcceptChanges geht hier NIE mit: die Seite sendet es nur, wenn der eingeschaltet hat.
//   * FRISCHE QUOTEN aller Beine in EINEM oeffentlichen Abruf: GET …offer…/v3/en-GR/events?events=<Nrn.>&startDate=…&endDate=…
//     (volle Stunden; Spiel-Nummern AUFSTEIGEND, hoechstens 16; MIT den Zeiten kommt je Spiel nur der Sieger-Markt — 12 Spiele 26 kB in ~130 ms,
//     ohne die Zeiten alle Maerkte, 2 MB je Spiel). Fussball: Markt 547 „Full Time“ mit 1 / X / 2, Basketball: 759 „Winner
//     (incl. overtime)“ mit 1 / 2. Jede Quote nennt in metadata.info ihre Mannschaft („<Heim> to win …“, „Draw result“).
//     Ein laufendes Spiel: status STARTED, offer_state_status { 1: 3, 2: 1 }; vor dem Anpfiff NOT_STARTED und { 1: 1 }.
//   * RECHNUNG des Scheins (Bibliothek der Seite, Big.js mit 20 Nachkommastellen, kaufmaennisch — jede Stufe wird wieder zur
//     JS-Zahl): Gesamtquote = Produkt der Quoten; Grundauszahlung = Produkt × Einsatz; Auszahlung auf DREI Stellen gerundet,
//     ausgewiesen auf zwei; angezeigte Gesamtquote auf zwei Stellen ABGESCHNITTEN. Hoechstgewinn je Schein 500 000 €.
//     Die Regeln stehen in der oeffentlichen Konfiguration der Seite (/static/js/fetchConfig/app) und werden hier gelesen.
//     Die Nachrechnung ist gegen den Rechner der Seite geprueft: 45 000 Zufalls-Scheine in neun Regel-Fassungen ohne
//     Abweichung, 15 absichtliche Schwaechungen fielen alle auf.
//   * GEWINNSTEUER (GR, je Schein auf Auszahlung minus Einsatz: bis 100 € frei, dann 2,5 % / 5 % / 7,5 % ab 500 €; je Stufe
//     auf Cent gerundet): Superbet TRAEGT SIE SELBST (Konfiguration taxGenerosity mit refundPercentage 100; oeffentlich:
//     superbet.gr/blog/tax-policy, Fassung 1.1 vom 30.06.2026 — „the player receiving the entire gross profit“). Die
//     Erstattung gilt fuer den Einsatz aus echtem Geld — genau den sendet dieser Baustein (paymentBonusType 1). Bleibt nach
//     den Regeln der Seite doch etwas zu zahlen, zaehlt fuer die Mindest-Gesamtquote die Auszahlung NACH Steuer.
//   * KOMBI-BONUS („Acca Boost“, im Code SuperBonus): ab 2 Beinen mit Quote ≥ 1,40 ein Aufschlag auf den GEWINN (2 → 2 %,
//     3 → 5 %, 4 → 8 %, 5 → 12 % … 23+ → 100 %); Beine darunter zaehlen nicht mit, schliessen ihn aber nicht aus. Die
//     Bedingungen (superbet.gr/lp/el-eng/acca-boost) behalten dem Buch vor, ihn zu streichen (Punkt 14) — er wird deshalb
//     ausgerechnet und GEMELDET (bonus), zaehlt aber NICHT fuer die Mindest-Gesamtquote.
//   * ANTWORT des Setzens (Mitschnitte): { code: 0, error: false, negotiationData: null, data: { ticketId, ticketData: {
//     ticketId, status: "approved", sumStake, sumCoefficient, winEstimated, sumBonus, system: "", events: [{ matchId (=
//     Spiel-Nr.), oddTypeId (= Ausgangs-Nr.), oddName, oddCoefficientEntry }] } } }. Die Seite wertet "approved" und "active"
//     als gesetzt. Absage: error true mit notice / errorCode. GEGENANGEBOT: negotiationData { userAmount, bookieAmount,
//     odds:[{ matchId, oddId, oldOdd, newOdd }] } + ticketData — wird NIE angenommen, sondern abgelehnt (handleAuthTicket mit
//     userAccepted 0). code "TICKETINPROGRESS": beim Buch laeuft noch ein Schein — die Seite sendet dann denselben Schein noch
//     einmal; dieser Baustein sendet NIE ein zweites Mal, er gleicht mit dem Konto ab.
//     NICHT GEMESSEN: die Annahme einer KOMBI, eine Absage und ein Gegenangebot (es wurde keine Kombi abgegeben).
//   * ABGLEICH wie die Seite selbst bei unklarem Ausgang: den juengsten Schein des Kontos lesen (…/user/<Nr.>/tickets mit der
//     Sitzungs-Kennung aus getPlayerDetails) und vergleichen — Einsatz gleich, GENAU die gesendeten Quoten-Kennungen, nach
//     dem Absenden eingegangen. Ein Schein mit bekannter Nummer ist oeffentlich lesbar (…/ticket/<Nr.>).
// SICHERUNGEN (fail-closed): Auftrags-Nummer Pflicht (derselbe Auftrag laeuft nie zweimal); je Bein aus dem frischen Abruf:
//   das Spiel ist da, Sportart, Mannschaften des Buchs = die des Auftrags (gleiche Reihenfolge), nicht angepfiffen, Angebot
//   offen, keine Sonder-Regeln, GENAU der Sieger-Markt mit genau dessen Ausgaengen, die Quote des Tipps offen, hoechstens
//   zwei Nachkommastellen, sie haengt laut Text des Buchs an der richtigen Mannschaft, Quote ≥ Mindestquote; Regeln des Buchs
//   verstanden (sonst nichts), Grenzen des Buchs; Auszahlung nach Steuer OHNE Bonus ≥ Mindest-Gesamtquote × Einsatz.
//   armed:false endet hier („staged“) — im Tab bleibt nichts stehen. Scharf: derselbe Schein geht aus diesem Tab nicht
//   zweimal binnen zehn Minuten raus; unmittelbar vor dem Absenden prueft scheinFehler den fertigen Schein noch einmal
//   Feld fuer Feld gegen den Auftrag. Abgeben: EIN Aufruf (sende), nie ein zweiter.
// WARTEN OHNE ZEITGEBER IN DER SEITE: nach dem Absenden hoechstens ein Schritt je Aufruf; braucht es mehr (Abgleich mit dem
//   Konto, Schein noch nicht bestaetigt), kommt { status:"pending", warteId, nachMs } — der Aufrufer wartet und ruft nachfragen.
(() => {
  "use strict";
  if (self.SBKOMBI && typeof self.SBKOMBI.beschaeftigt === "function" && self.SBKOMBI.beschaeftigt()) return;
  const BUCH = "superbet";
  const ANGEBOT = "https://production-superbet-offer-gr.freetls.fastly.net/v3/en-GR/events";             // GET, oeffentlich
  const REGELN = "https://superbet.gr/static/js/fetchConfig/app";                                         // GET, oeffentlich: var superbetServerConfig = {…}
  const API = "https://api.web.production.betler.superbet.gr";
  const SITZUNG = API + "/api/v1/checkLoginSession?clientSourceType=Desktop_new";                         // GET, Sitzung der Seite — nur Angabe beim Probe-Schein
  const KONTO = API + "/api/v1/getPlayerDetails?fields=hasMadeDeposit&clientSourceType=Desktop_new";      // GET, Sitzung der Seite — nur fuer den Abgleich (Konto-Nr., Sitzungs-Kennung)
  const SCHEINE = "https://prod-superbet-betting.freetls.fastly.net/tickets/presentation-api/v3/SB_GR";   // GET: /ticket/<Nr.> oeffentlich · /user/<Nr.>/tickets mit Sitzungs-Kennung
  const SETZEN = API + "/legacy-web/betting/submitTicket?clientSourceType=Desktop_new";                   // POST — DER Punkt ohne Wiederkehr (nur in sende)
  const ABLEHNEN = API + "/legacy-web/betting/handleAuthTicket?clientSourceType=Desktop_new";             // POST — nur das Nein zu einem Gegenangebot (nur in lehneAb)
  // Sieger-Markt je Sportart: Sportart-Nr. des Buchs, Markt-Nr. und -Name, erlaubte Tipps (Reihenfolge des Buchs), Name im Schein.
  const MARKT = { soccer: { sportId: 5, marktId: 547, marktName: "Full Time", tips: ["1", "X", "2"], sportName: "Football" },
    basketball: { sportId: 4, marktId: 759, marktName: "Winner (incl. overtime)", tips: ["1", "2"], sportName: "Basketball" } };
  const MIN = 2, MAX = 12, MIN_EINSATZ = 0.1, MAX_EINSATZ = 1000;         // Sicherheitsgrenzen dieses Bausteins (EUR), nicht die des Buchs
  const ECHTES_GELD = 1;                                                 // paymentBonusType: 1 = kein Bonus (2 Umsatz-Bonus, 3 Freiwette)
  const QUELLE_ART = 101, QUELLE_SEITE = 801;                            // sourceType „Regular“, sourceScreen wie die mitgeschnittenen Einzelwetten
  const REGELN_TTL_MS = 15 * 60000, FENSTER_VOR_MS = 3 * 3600000, FENSTER_NACH_MS = 30 * 86400000;
  const LESE_MS = 6000, SENDE_MS = 30000, DOPPEL_MS = 10 * 60000;
  const LESEN_MS = 1500, LESEN_MAX = 5, ABGLEICH_MS = 3000, ABGLEICH_MAX = 4, ABGLEICH_LAEUFT_MAX = 7, EINGANG_VOR_MS = 120000;
  const WARTE_ALT_MS = 5 * 60000, MERKEN_MAX = 40;
  const wartend = new Map(), auftraege = new Map(), erledigt = new Map(), geschickt = new Map();
  const merke = (m, k, v) => { m.set(k, v); while (m.size > MERKEN_MAX) m.delete(m.keys().next().value); };
  let warteNr = 0, laeuft = false, regelnStand = { at: 0, erg: null, lauf: null };
  const jetztMs = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  const text = (e) => String((e && e.message) || e);
  const gleicheMenge = (a, b) => a.length === b.length && a.slice().sort().join("\n") === b.slice().sort().join("\n");
  const cfgVon = (sport) => { const k = String(sport == null || sport === "" ? "soccer" : sport); return Object.prototype.hasOwnProperty.call(MARKT, k) ? MARKT[k] : null; };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const volleStunde = (ms) => { const d = new Date(ms); d.setUTCMinutes(0, 0, 0); return d.toISOString(); };   // das Angebot verlangt volle Stunden

  // ---- genaue Dezimalrechnung wie die Seite: Big.js (20 Nachkommastellen, kaufmaennisch), JEDE Stufe wieder als JS-Zahl -----
  const hoch = (k) => 10n ** BigInt(k);
  function dez(x) {
    let t = String(x), e = 0, neg = false;
    const i = t.search(/e/i);
    if (i > 0) { e = Number(t.slice(i + 1)); t = t.slice(0, i); }
    if (t[0] === "-") { neg = true; t = t.slice(1); }
    if (!/^\d+(\.\d+)?$/.test(t) || !Number.isInteger(e)) return null;
    const p = t.indexOf("."), nach = p < 0 ? "" : t.slice(p + 1);
    let zif = (p < 0 ? t : t.slice(0, p)) + nach, s = nach.length - e;
    if (s < 0) { zif += "0".repeat(-s); s = 0; }
    if (s > 400 || zif.length > 400) return null;
    const n = BigInt(zif);
    return { n: neg ? -n : n, s };
  }
  function zahl(d) {
    const neg = d.n < 0n, z = (neg ? -d.n : d.n).toString().padStart(d.s + 1, "0");
    return Number((neg ? "-" : "") + z.slice(0, z.length - d.s) + (d.s ? "." + z.slice(z.length - d.s) : ""));
  }
  const zwei = (a, b, f) => { const x = dez(a), y = dez(b); return x && y ? f(x, y) : NaN; };
  const plus = (a, b) => zwei(a, b, (x, y) => { const s = Math.max(x.s, y.s); return zahl({ n: x.n * hoch(s - x.s) + y.n * hoch(s - y.s), s }); });
  const minus = (a, b) => zwei(a, b, (x, y) => { const s = Math.max(x.s, y.s); return zahl({ n: x.n * hoch(s - x.s) - y.n * hoch(s - y.s), s }); });
  const mal = (a, b) => zwei(a, b, (x, y) => zahl({ n: x.n * y.n, s: x.s + y.s }));
  // Teilen auf 20 Nachkommastellen, kaufmaennisch (Big.DP 20, Big.RM 1)
  const durch = (a, b) => zwei(a, b, (x, y) => {
    if (y.n === 0n) return NaN;
    const neg = (x.n < 0n) !== (y.n < 0n), o = (x.n < 0n ? -x.n : x.n) * hoch(y.s + 21), u = (y.n < 0n ? -y.n : y.n) * hoch(x.s);
    let q = o / u; q = q / 10n + (q % 10n >= 5n ? 1n : 0n);
    return zahl({ n: neg ? -q : q, s: 20 });
  });
  // Runden wie Big.round(dp, rm): ab = true schneidet ab (rm 0), sonst kaufmaennisch (rm 1, ab ,5 von der Null weg)
  function runde(a, stellen, ab) {
    const x = dez(a);
    if (!x) return NaN;
    if (x.s <= stellen) return zahl(x);
    const t = hoch(x.s - stellen), neg = x.n < 0n, b = neg ? -x.n : x.n;
    let q = b / t;
    if (!ab && (b % t) * 2n >= t) q += 1n;
    return zahl({ n: neg ? -q : q, s: stellen });
  }

  // ---- PURE: Regeln aus der oeffentlichen Konfiguration der Seite (var superbetServerConfig = {…}) -------------------------
  function konfigAus(roh) {
    const t = String(roh == null ? "" : roh), a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (!/^\s*var\s+superbetServerConfig\s*=\s*\{/.test(t) || b <= a) return null;
    try { const j = JSON.parse(t.slice(a, b + 1)); return j && typeof j === "object" && !Array.isArray(j) ? j : null; } catch (_) { return null; }
  }
  // Steuerstufen aus "100|2.5|200|5|500|7.5" — wie die Seite: [{ satz, bis }, …, { satz }]
  function steuerStufen(roh) {
    if (!roh || roh === "0|1") return [{ satz: 0 }];
    if (typeof roh !== "string") return null;
    const teile = roh.split("|");
    if (!teile.every((x) => x !== "" && !isNaN(Number(x))) || teile.length % 2 !== 0) return null;
    let a = teile.map(parseFloat);
    a = a[0] ? [0].concat(a) : a.slice(1);
    if (a.length === 0 || a.length % 2 !== 1 || a[0] < 0 || (a.length > 1 && a[1] < 0)) return null;
    for (let t = 2; t < a.length; t++) if (a[t - 2] >= a[t]) return null;
    const out = [];
    for (let r = 0; r < a.length; r += 2) {
      const letzte = r + 1 >= a.length;
      if (!letzte && !(a[r + 1] > 0)) return null;
      out.push(letzte ? { satz: a[r] / 100 } : { satz: a[r] / 100, bis: a[r + 1] });
    }
    return out;
  }
  function bonusStufen(roh) {
    if (!roh) return [];
    if (typeof roh !== "string") return null;
    const out = [];
    for (const teil of roh.split("|")) {
      const p = teil.split("_");
      if (p.length < 2) return null;
      const n = Number(p[0]), r = Number(p[1]);
      if (Number.isNaN(n) || Number.isNaN(r) || !Number.isInteger(n) || n < 1 || r < 0) return null;
      out.push({ n, prozent: Math.round(100 * r) });
    }
    return out;
  }
  // Was dieser Baustein rechnen kann: keine Einsatzgebuehr, Steuer-Leiter auf Auszahlung minus Einsatz (winTaxMethod 2).
  // Alles andere wird nicht verstanden → der Aufrufer setzt nicht.
  function regelnAus(c) {
    const nein = (g) => ({ ok: false, grund: g });
    if (!c || typeof c !== "object" || Array.isArray(c)) return nein("rules of the book not readable");
    if (parseInt(c.taxOnline, 10) !== 0) return nein("rules of the book not understood (stake fee " + String(c.taxOnline).slice(0, 12) + ")");
    if (c.winTaxMethod !== 2) return nein("tax rule of the book not understood (method " + String(c.winTaxMethod).slice(0, 12) + ")");
    const stufen = steuerStufen(c.winTax);
    if (!stufen) return nein("tax brackets of the book unreadable");
    let erstattung = null;
    if (c.taxGenerosity === true) {
      const o = c.taxGenerosityOptions, p = o && typeof o === "object" ? o.refundPercentage : null;
      if (!(typeof p === "number" && isFinite(p) && p >= 0 && p <= 100)) return nein("tax refund of the book not understood");
      erstattung = { prozent: p };
    } else if (c.taxGenerosity != null && c.taxGenerosity !== false) return nein("tax refund of the book not understood");
    const maxGewinn = parseInt(c.maxWin, 10), minEinsatz = parseFloat(c.minSportStake), maxEinsatz = parseInt(c.maxSportStake, 10), maxBeine = c.sportMaxSelections ? parseInt(c.sportMaxSelections, 10) : 30;
    if (!(maxGewinn > 0) || !(minEinsatz > 0) || !(maxEinsatz > 0) || !(maxBeine >= 2)) return nein("limits of the book unreadable");
    // Kombi-Bonus („Acca Boost“). Unlesbar → bonus null (er zaehlt ohnehin nicht fuer die Mindest-Gesamtquote).
    let bonus = null;
    const bs = bonusStufen(c.superBonusBreakpoints), minQuote = c.superBonusMinCoef ? Number(c.superBonusMinCoef) : 0;
    if (bs && isFinite(minQuote) && minQuote >= 0) {
      const liste = (x, erlaubt) => { if (!x) return erlaubt.slice(); const l = String(x).split("|").map((y) => y.trim().toLowerCase()).filter((y) => erlaubt.indexOf(y) >= 0); return l.length ? l : erlaubt.slice(); };
      const basis = String(c.superBonusCalculationBase == null ? "" : c.superBonusCalculationBase).toLowerCase() === "profit" ? "Profit" : "Winning";
      bonus = { an: (c.superBonusEnabled === "true" || c.superBonusEnabled === true) && liste(c.superBonusValidBetTypes, ["simple", "system"]).indexOf("simple") >= 0 && liste(c.superBonusValidSelectionTypes, ["live", "prematch"]).indexOf("prematch") >= 0,
        stufen: bs, minQuote, basis, ignoriert: c.superBonusIgnoredOfferTypes ? String(c.superBonusIgnoredOfferTypes).split("|") : [],
        toleriert: c.superBonusSelectionsBelowMinOddTolerated !== undefined && (c.superBonusSelectionsBelowMinOddTolerated === "true" || c.superBonusSelectionsBelowMinOddTolerated === true) };
    }
    return { ok: true, R: { stufen, stufenStellen: c.roundTaxBracketsBeforeCalculatingTotal ? 2 : null, erstattung, maxGewinn, minEinsatz, maxEinsatz, maxBeine, bonus } };
  }
  // Zaehlt ein Bein fuer den Kombi-Bonus? Nicht, wenn seine Quote eine Sonder-Quote des Buchs ist (Kennzeichen der Quote).
  const bonusFaehig = (R, tags) => !(R.bonus ? R.bonus.ignoriert : []).some((t) => t && String(tags == null ? "" : tags).indexOf(t) >= 0);
  // Bonus-Satz in Prozent wie die Seite: die Stufe mit der groessten Bein-Zahl <= Zahl der zaehlenden Beine
  function bonusProzent(R, beine) {
    const B = R.bonus;
    if (!B || !B.an || !B.stufen.length) return 0;
    if (!B.toleriert && beine.some((b) => b.preis < B.minQuote)) return 0;
    const n = beine.filter((b) => b.bonusFaehig && b.preis >= B.minQuote).length;
    const idx = B.stufen.findIndex((s) => s.n > n), vor = idx === -1 ? B.stufen.length - 1 : idx - 1;
    return vor === -1 ? 0 : (B.stufen[vor].prozent || 0);
  }
  // Steuer wie die Seite: basis = Auszahlung − Einsatz. Die Anteile je Stufe rechnet die Seite mit gewoehnlichen JS-Zahlen
  // (100,6 − 100 = 0,5999999999999943 → 2,5 % davon sind 0,01 und nicht 0,02) — deshalb stehen sie hier genauso.
  function steuerAuf(R, basis) {
    if (!(basis >= 0)) return { gesamt: 0, abzug: 0, erstattung: 0 };
    let summe = 0;
    for (let i = 0; i < R.stufen.length; i++) {
      const s = R.stufen[i], von = (i !== 0 ? R.stufen[i - 1].bis : 0) || 0;
      let teil;
      if (s.bis === undefined) teil = basis > von ? basis - von : 0;
      else if (basis <= von) teil = 0;
      else { const breite = s.bis - von, ueber = basis - von; teil = ueber <= breite ? ueber : breite; }
      const betrag = minus(teil, minus(teil, mal(teil, s.satz)));
      summe = plus(summe, R.stufenStellen != null ? runde(betrag, R.stufenStellen) : betrag);
    }
    const gesamt = runde(summe, 3);
    let erst = 0, abzug = gesamt;
    // Erstattung: der Einsatz kommt ganz aus echtem Geld (paymentBonusType 1) — der Anteil ist 1
    if (R.erstattung) { erst = durch(mal(summe, mal(R.erstattung.prozent, 1)), 100); abzug = minus(summe, erst); }
    return { gesamt, abzug: runde(abzug, 3), erstattung: runde(erst, 3) };
  }
  // PURE: der Schein, wie ihn der Wettschein der Seite rechnet (eine Kombination). beine: [{ preis, bonusFaehig }].
  // mitBonus false rechnet OHNE Kombi-Bonus. → { ok, quote (Produkt), quoteAnzeige, einsatz, grund, bonus, bonusProzent,
  // bonusBeine, brutto (Auszahlung vor Steuer), steuer, erstattung, abzug (zu zahlen), netto, nettoQuote, begrenzt }
  function rechne(R, beine, einsatz, mitBonus) {
    const netto = runde(Math.round(Number(einsatz) * 100) / 100, 2);
    if (!(netto > 0)) return { ok: false, grund: "stake not computable" };
    let prod = 1;
    for (const b of beine) { if (!(typeof b.preis === "number" && b.preis > 1 && isFinite(b.preis))) return { ok: false, grund: "odds not computable" }; prod = mal(prod, b.preis); }
    const grund = mal(prod, netto);
    const prozent = mitBonus ? bonusProzent(R, beine) : 0;
    const gewinn = (R.bonus && R.bonus.basis === "Profit") ? grund - netto : grund;       // gewoehnliche JS-Zahl, wie die Seite
    const bonus = prozent ? runde(mal(gewinn, durch(prozent, 100)), 2) : 0;
    const summe = plus(grund, bonus), begrenzt = summe > R.maxGewinn;
    const brutto3 = runde(Math.min(summe, R.maxGewinn), 3);
    const st = steuerAuf(R, minus(brutto3, netto));
    const aus = runde(minus(brutto3, st.abzug), 2);
    if (![prod, grund, bonus, brutto3, st.gesamt, st.abzug, st.erstattung, aus].every((x) => typeof x === "number" && isFinite(x))) return { ok: false, grund: "slip not computable" };
    return { ok: true, quote: prod, quoteAnzeige: runde(prod, prod < 1.01 ? 3 : 2, true), einsatz: netto, grund: runde(grund, 2), bonus: runde(Math.min(bonus, R.maxGewinn), 2), bonusProzent: prozent,
      bonusBeine: R.bonus ? beine.filter((b) => b.bonusFaehig && b.preis >= R.bonus.minQuote).length : 0,
      brutto: runde(brutto3, 2), steuer: runde(st.gesamt, 2), erstattung: runde(st.erstattung, 2), abzug: runde(st.abzug, 2), netto: aus, nettoQuote: aus / netto, begrenzt };
  }

  // ---- PURE: ein Bein aus dem frischen Angebot ------------------------------------------------------------------------------
  // ev = das Spiel aus dem Angebots-Abruf, L = das Bein des Auftrags (Tipp und Mannschaften in der Reihenfolge des BUCHS).
  // → { fehler, preis? } | { preis, tags, eintrag (der Eintrag des Scheins), kennung (Quoten-Kennung), ausgang (Ausgangs-Nr.) }
  function beinAus(ev, L, jetzt) {
    const M = cfgVon(L.sport);
    if (!M) return { fehler: "sport " + String(L.sport) + " is not connected for combos" };
    if (!ev || typeof ev !== "object") return { fehler: "the game is not offered (any more)" };
    const fx = ev.fixture && typeof ev.fixture === "object" ? ev.fixture : {}, meta = ev.inplay_stats_metadata && typeof ev.inplay_stats_metadata === "object" ? ev.inplay_stats_metadata : {};
    if (String(ev.event_id) !== String(L.eventId)) return { fehler: "the offer names another game (" + String(ev.event_id).slice(0, 16) + ")" };
    if (Number(fx.sport_id) !== M.sportId) return { fehler: "the game is not listed as " + String(L.sport || "soccer") + " at the book" };
    const namen = String(fx.event_name == null ? "" : fx.event_name).split("·").map((x) => x.trim());
    if (namen.length !== 2 || !namen[0] || !namen[1] || namen[0] !== String(L.team1).trim() || namen[1] !== String(L.team2).trim()) return { fehler: "teams at the book (" + namen.join(" – ").slice(0, 80) + ") differ from the order" };
    const ko = Number(fx.unix_date_millis);
    if (String(meta.status).toUpperCase() !== "NOT_STARTED" || !(ko > jetzt)) return { fehler: "the game has started or its kick-off is unknown" };
    if (!(fx.offer_state_status && typeof fx.offer_state_status === "object" && fx.offer_state_status["1"] === 1)) return { fehler: "the pre-match offer of the game is not open" };
    if (fx.resolving_rules != null && !(Array.isArray(fx.resolving_rules) && fx.resolving_rules.length === 0)) return { fehler: "the game carries special settlement rules" };
    const maerkte = (Array.isArray(ev.markets) ? ev.markets : []).filter((m) => m && Number(m.id) === M.marktId && String(m.name) === M.marktName);
    if (maerkte.length !== 1) return { fehler: "winner market (" + M.marktName + ") not found" };
    const markt = maerkte[0], odds = Array.isArray(markt.odds) ? markt.odds : [];
    if (!gleicheMenge(odds.map((o) => String(o && o.metadata ? o.metadata.name : "")), M.tips)) return { fehler: "the winner market does not hold exactly the outcomes " + M.tips.join(" / ") };
    const o = odds.find((x) => String(x.metadata.name) === String(L.tip));
    if (!o) return { fehler: "outcome " + String(L.tip) + " does not exist in the winner market" };
    const md = o.metadata, preis = o.price;
    if (o.status !== 1 || o.display === false) return { fehler: "outcome " + L.tip + " is suspended" };
    if (!(typeof preis === "number" && isFinite(preis) && preis > 1) || Number(preis.toFixed(2)) !== preis) return { fehler: "odds not readable (" + String(preis).slice(0, 16) + ")" };
    // Die Quote haengt an der richtigen Mannschaft: der Text des Buchs nennt sie (1 = erste, 2 = zweite des Buchs); Remis nennt keine.
    const was = String(md.info == null ? "" : md.info);
    if ((L.tip === "1" && was.indexOf(namen[0] + " to win") !== 0) || (L.tip === "2" && was.indexOf(namen[1] + " to win") !== 0) || (L.tip === "X" && was !== "Draw result")) return { fehler: "the odds text of the book (" + was.slice(0, 60) + ") is not outcome " + L.tip + " of this game" };
    if (!UUID.test(String(o.uuid)) || !UUID.test(String(md.market_line_uuid)) || !UUID.test(String(fx.uuid)) || !Number.isInteger(md.outcome_id) || !Number.isInteger(ev.event_id)) return { fehler: "identifiers of the selection unreadable" };
    if (!(preis >= Number(L.minOdds))) return { fehler: String(preis) + " is below the min odds " + Number(L.minOdds), preis };
    const datum = String(fx.utc_date == null ? "" : fx.utc_date).replace("T", " ").slice(0, 19);
    // Der Eintrag des Scheins — Feld fuer Feld wie die mitgeschnittenen Einzelwetten (01.09.2026)
    const eintrag = { value: preis.toFixed(2), type: "sport", fix: false, betRadarId: String(fx.betradar_id || ""), eventId: ev.event_id, eventUuid: fx.uuid, oddUuid: o.uuid, sourceType: QUELLE_ART, sourceScreen: QUELLE_SEITE,
      betGroupId: markt.id, eventName: String(fx.event_name), eventCode: fx.event_code, live: false, marketId: markt.id, marketName: markt.name, marketUuid: md.market_line_uuid,
      matchDate: datum, matchDateUtc: datum, matchId: ev.event_id, matchName: String(fx.event_name), oddCode: String(md.code == null ? md.name : md.code), oddDescription: was, oddFullName: String(md.name), oddId: md.outcome_id, oddName: String(md.name), oddTypeId: md.outcome_id,
      rules: [], sbValue: "", selected: true, sportId: fx.sport_id, sportName: M.sportName, teamId1: String(fx.home_team_id || ""), teamId2: String(fx.away_team_id || ""),
      teamnameone: namen[0], teamnametwo: namen[1], tournamentId: fx.tournament_id, tournamentName: "", uuid: o.uuid };
    return { preis, tags: String(md.tags == null ? "" : md.tags), eintrag, kennung: String(o.uuid), ausgang: String(md.outcome_id) };
  }
  // PURE: der Schein. geraet = Geraete-Kennung der Seite, nr = Nummer DIESES Scheins (ticketUuid).
  function baueSchein(eintraege, einsatz, geraet, nr) {
    return { ticketOnline: "online", total: Number(einsatz), betType: "prematch", combs: "", items: eintraege.slice(), clientSourceType: "Desktop_new", paymentBonusType: ECHTES_GELD, locale: "en-GR",
      requestDetails: { deviceId: geraet }, geoLocation: "develop", deviceIdentifier: geraet, ticketUuid: nr };
  }
  // PURE, ZWEITE PRUEFUNG unmittelbar vor dem Absenden: ist das GENAU der eine Kombi-Schein des Auftrags? null = ja, sonst der Grund.
  // soll: { einsatz, kennungen:[Quoten-Kennungen], spiele:[Spiel-Nrn.] }
  const SCHEIN_FELDER = ["ticketOnline", "total", "betType", "combs", "items", "clientSourceType", "paymentBonusType", "locale", "requestDetails", "geoLocation", "deviceIdentifier", "ticketUuid"];
  function scheinFehler(k, soll) {
    if (!k || typeof k !== "object" || Array.isArray(k)) return "no slip";
    if (!gleicheMenge(Object.keys(k), SCHEIN_FELDER)) return "the slip carries other fields than a plain combo";
    if (k.ticketOnline !== "online" || k.betType !== "prematch" || k.combs !== "" || k.paymentBonusType !== ECHTES_GELD) return "the slip is not a plain pre-match combo paid with real money";
    if (!(typeof k.total === "number" && k.total >= MIN_EINSATZ && k.total <= MAX_EINSATZ) || Math.abs(k.total - soll.einsatz) > 1e-9 || Math.abs(Math.round(k.total * 100) / 100 - k.total) > 1e-9) return "the stake of the slip is not the ordered stake";
    if (!UUID.test(String(k.ticketUuid)) || !k.deviceIdentifier || !k.requestDetails || k.requestDetails.deviceId !== k.deviceIdentifier) return "slip number or device of the slip missing";
    if (!Array.isArray(k.items) || k.items.length < MIN || k.items.length > MAX || k.items.length !== soll.kennungen.length) return "the slip does not hold the ordered number of legs";
    const spiele = new Set(), kennungen = [];
    for (const e of k.items) {
      if (!e || typeof e !== "object" || e.type !== "sport" || e.fix !== false || e.live !== false || e.selected !== true || e.sbValue !== "" || !Array.isArray(e.rules) || e.rules.length) return "a leg of the slip is not a plain pre-match selection";
      if (!Number.isInteger(e.eventId) || e.matchId !== e.eventId || spiele.has(e.eventId) || !UUID.test(String(e.oddUuid)) || e.uuid !== e.oddUuid || !UUID.test(String(e.marketUuid)) || !UUID.test(String(e.eventUuid))) return "a leg of the slip is unreadable or doubled";
      if (!((e.sportId === 5 && e.marketId === 547) || (e.sportId === 4 && e.marketId === 759)) || e.betGroupId !== e.marketId) return "a leg of the slip is not in the winner market of its sport";
      if (typeof e.value !== "string" || !/^\d{1,4}\.\d{2}$/.test(e.value) || !(Number(e.value) > 1)) return "a leg of the slip carries unreadable odds";
      spiele.add(e.eventId); kennungen.push(String(e.oddUuid));
    }
    if (!gleicheMenge(kennungen, soll.kennungen) || !gleicheMenge([...spiele].map(String), soll.spiele)) return "the slip does not hold exactly the ordered selections";
    return null;
  }
  // PURE: Gegenangebot des Buchs in Worten (wird nie angenommen).
  function angebotText(n, soll) {
    const teile = [], nr = (x) => (typeof x === "number" && isFinite(x) ? x : (typeof x === "string" && x !== "" && isFinite(Number(x)) ? Number(x) : null));
    const a = nr(n.userAmount), b = nr(n.bookieAmount);
    if (b != null && (a == null || Math.abs(a - b) > 0.005)) teile.push("stake " + b.toFixed(2) + " instead of " + (a != null ? a : soll.einsatz).toFixed(2));
    for (const q of (Array.isArray(n.odds) ? n.odds : []).slice(0, 12)) {
      const alt = q ? nr(q.oldOdd) : null, neu = q ? nr(q.newOdd) : null, i = q ? soll.spiele.indexOf(String(q.matchId)) : -1;
      if (alt != null && neu != null && alt.toFixed(2) !== neu.toFixed(2)) teile.push((i >= 0 ? "leg " + (i + 1) : "a leg") + " now " + neu.toFixed(2) + " instead of " + alt.toFixed(2));
    }
    return teile.length ? teile.join("; ") : "changed terms";
  }
  // PURE: Absage des Buchs in Worten.
  function fehlerText(j) {
    const s = (x) => (typeof x === "string" && x.trim() ? x.trim() : null);
    const teile = [s(j.notice), s(j.errorCode), s(typeof j.code === "string" ? j.code : null), s(j.message)].filter(Boolean);
    return (teile.length ? [...new Set(teile)].join(" · ") : "no reason given").slice(0, 200);
  }
  // PURE: Wahrheitstabelle. Eingabe: die Rueckgabe von sende() und was gesendet wurde
  // (soll = { einsatz, quote, spiele:[Spiel-Nrn.], ausgaenge:{ Spiel-Nr.: Ausgangs-Nr. }, kennungen:[Quoten-Kennungen] }).
  function klassifiziere(antwort, soll) {
    const pruefen = " — POSSIBLY placed, check the bet history";
    if (!antwort || antwort.art === "gesperrt") return { status: "blocked", reason: BUCH + " combo: nothing sent — " + String((antwort && antwort.grund) || "the second check refused").slice(0, 160) };
    if (antwort.art === "netzfehler") return { status: "uncertain", reason: BUCH + " combo: connection lost while sending (" + String(antwort.fehler).slice(0, 80) + ")" + pruefen };
    if (antwort.art !== "antwort") return { status: "uncertain", reason: BUCH + " combo: unknown answer" + pruefen };
    const s = Number(antwort.status) || 0, j = antwort.json && typeof antwort.json === "object" && !Array.isArray(antwort.json) ? antwort.json : null;
    if (s === 401 || s === 403) return { status: "failed", reason: "The book rejected the combo: not logged in (answer " + s + ") — log in at superbet.gr" };
    if (s === 0 || s === 408 || s >= 500) return { status: "uncertain", reason: BUCH + " combo: server error " + s + " after sending" + pruefen };
    if (!j) return s >= 400 ? { status: "failed", reason: "The book rejected the combo (answer " + s + ")" } : { status: "uncertain", reason: BUCH + " combo: no readable answer of the book (answer " + s + ")" + pruefen };
    // Gegenangebot (anderer Einsatz / andere Quoten): nichts ist gesetzt, solange es niemand annimmt — und das tut hier niemand.
    if (j.negotiationData && typeof j.negotiationData === "object") return { status: "failed", gegenangebot: angebotText(j.negotiationData, soll), original: j.ticketData != null && j.ticketData !== "" ? j.ticketData : null };
    const d = j.data && typeof j.data === "object" ? j.data : null, td = d ? (d.ticketData && typeof d.ticketData === "object" ? d.ticketData : d) : null;
    const nrRoh = td && td.ticketId != null && td.ticketId !== "" ? td.ticketId : (d && d.ticketId != null && d.ticketId !== "" ? d.ticketId : null);
    const nr = nrRoh != null && /^[A-Za-z0-9-]{6,24}$/.test(String(nrRoh)) ? String(nrRoh) : null;
    if (j.error === false && j.code === 0 && nr) {
      const kern = { ticket: nr, buchQuote: Number(td.sumCoefficient) > 1 ? Number(td.sumCoefficient) : null, buchAuszahlung: Number(td.winEstimated) > 0 ? Number(td.winEstimated) : null, buchBonus: typeof td.sumBonus === "string" && td.sumBonus.indexOf("%=") > 0 ? td.sumBonus.slice(0, 24) : null };
      if (td.system != null && td.system !== "") return Object.assign({ status: "uncertain", reason: "AUDIT: the book booked a system ticket instead of a plain combo — check the bet history immediately" }, kern);
      const ev = Array.isArray(td.events) ? td.events : null, einsatz = Number(td.sumStake), stand = String(td.status == null ? "" : td.status).toLowerCase();
      // Ohne Liste der Spiele in der Antwort entscheidet der Schein selbst (oeffentlich lesbar unter seiner Nummer).
      if (!ev) return Object.assign({ status: "uncertain", lesen: true, reason: BUCH + " combo: the book answered with a ticket number but without its selections — check the bet history" }, kern);
      const passt = ev.length === soll.spiele.length && gleicheMenge(ev.map((e) => String(e && e.matchId)), soll.spiele) && ev.every((e) => String(e.oddTypeId) === String(soll.ausgaenge[String(e.matchId)]));
      if (!passt) return Object.assign({ status: "uncertain", reason: "AUDIT: the answer of the book names other selections than the ones sent — check the bet history immediately" }, kern);
      if (stand !== "approved" && stand !== "active") return Object.assign({ status: "uncertain", lesen: true, stand, reason: BUCH + " combo: the ticket is not confirmed yet (status " + stand.slice(0, 24) + ") — check the bet history" }, kern);
      const hinweise = [];
      if (isFinite(einsatz) && einsatz > 0 && Math.abs(einsatz - soll.einsatz) > 0.005) hinweise.push("the ticket names a stake of " + einsatz + " instead of " + soll.einsatz);
      // Die Gesamtquote des Scheins ist eine Anzeige (zwei Stellen); weicht sie mehr als eine Rundung von der eigenen ab, steht es dabei.
      const andereQuote = kern.buchQuote != null && Math.abs(kern.buchQuote - soll.quote) > Math.max(0.011, soll.quote * 0.0005);
      if (andereQuote) hinweise.push("the ticket names total odds of " + kern.buchQuote + " instead of " + soll.quote.toFixed(2));
      return Object.assign({ status: "placed" }, kern, isFinite(einsatz) && einsatz > 0 ? { stake: einsatz } : {}, andereQuote ? { odds: kern.buchQuote } : {}, hinweise.length ? { note: hinweise.join("; ") } : {});
    }
    if (j.error || (j.code != null && j.code !== 0)) {
      const kode = String(j.code == null ? "" : j.code) + " " + String(j.errorCode == null ? "" : j.errorCode);
      // „Schein in Arbeit“: beim Buch laeuft ein Schein — es kann DIESER sein. Nie noch einmal senden; das Konto entscheidet.
      if (/TICKETINPROGRESS/i.test(kode)) return { status: "uncertain", inArbeit: true, reason: BUCH + " combo: the book says a ticket is still being processed" + pruefen };
      if (/sessionNotValid|PlayerSessionCheckFailed/i.test(kode)) return { status: "failed", reason: "The book rejected the combo: the login has expired — log in again at superbet.gr" };
      return { status: "failed", reason: "The book rejected the combo: " + fehlerText(j) };
    }
    if (s >= 400) return { status: "failed", reason: "The book rejected the combo (answer " + s + ")" };
    return { status: "uncertain", reason: BUCH + " combo: no clear verdict of the book (answer " + s + ")" + pruefen };
  }
  // PURE: ist DAS der gesendete Schein? t = ein Schein, wie ihn der Schein-Dienst nennt. So prueft es auch die Seite selbst:
  // Einsatz gleich, GENAU die gesendeten Quoten-Kennungen — und (ab) nicht vor dem Absenden eingegangen.
  function passt(t, soll, ab) {
    if (!t || typeof t !== "object" || t.type !== "sports" || (t.system != null && t.system !== "")) return false;
    const p = t.payment && typeof t.payment === "object" ? t.payment : {}, ev = Array.isArray(t.events) ? t.events : [];
    if (!(Math.abs(Number(p.stake) - soll.einsatz) <= 0.01)) return false;
    if (!gleicheMenge(ev.map((e) => String(e && e.odd ? e.odd.oddUuid : "")), soll.kennungen)) return false;
    if (ab != null) { const an = Date.parse(String(t.dateReceived)); if (!(an >= ab - EINGANG_VOR_MS)) return false; }
    return true;
  }

  // ---- Netz: genau DREI Abrufe im ganzen Baustein — lies (nur GET), sende (der Schein), lehneAb (Nein zum Gegenangebot) -----
  // lies: nur die Lese-Adressen. Die Sitzung der Seite (Cookies) geht NUR an die zwei Konto-Adressen mit, sonst nie.
  async function lies(url, wie) {
    const konto = url === SITZUNG || url === KONTO;
    if (!(konto || url === REGELN || url.indexOf(ANGEBOT + "?") === 0 || url.indexOf(SCHEINE + "/") === 0)) return { ok: false, grund: "address not allowed" };
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), (wie && wie.ms) || LESE_MS);
    try {
      const r = await fetch(url, { credentials: konto ? "include" : "omit", cache: "no-store", headers: (wie && wie.kennung && !konto) ? { sessionId: wie.kennung } : {}, signal: ctl.signal });
      if (r.status === 401 || r.status === 403) return { ok: false, status: r.status, grund: "not logged in (answer " + r.status + ")" };
      if (!r.ok) return { ok: false, status: r.status, grund: "answer " + r.status };
      if (wie && wie.roh) return { ok: true, roh: await r.text() };
      let j = null; try { j = await r.json(); } catch (_) {}
      return { ok: true, json: j };
    } catch (e) { return { ok: false, grund: text(e).slice(0, 80) }; }
    finally { clearTimeout(t); }
  }
  // sende: DIE Absende-Funktion — der einzige Punkt ohne Wiederkehr. Davor die zweite Pruefung des fertigen Scheins.
  async function sende(schein, soll) {
    const f = scheinFehler(schein, soll);
    if (f) return { art: "gesperrt", grund: f };
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), SENDE_MS);
    try {
      const r = await fetch(SETZEN, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(schein), signal: ctl.signal });
      let j = null; try { j = await r.json(); } catch (_) {}
      return { art: "antwort", status: r.status, json: j };
    } catch (e) { return { art: "netzfehler", fehler: text(e) }; }
    finally { clearTimeout(t); }
  }
  // lehneAb: das Nein zu einem Gegenangebot (userAccepted steht fest auf 0 — ein Ja gibt es in diesem Baustein nicht).
  async function lehneAb(original) {
    if (original == null || original === "") return { ok: false, grund: "the counter offer carries nothing to answer" };
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), LESE_MS);
    try {
      const r = await fetch(ABLEHNEN, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ originalResponse: original, userAccepted: 0 }), signal: ctl.signal });
      return { ok: r.status < 500, status: r.status };
    } catch (e) { return { ok: false, grund: text(e).slice(0, 80) }; }
    finally { clearTimeout(t); }
  }

  // Regeln des Buchs (oeffentliche Konfiguration der Seite), 15 Minuten gemerkt; laeuft ein Abruf, warten alle auf denselben.
  function regelnLesen() {
    if (regelnStand.erg && Date.now() - regelnStand.at < REGELN_TTL_MS) return Promise.resolve(regelnStand.erg);
    if (regelnStand.lauf) return regelnStand.lauf;
    regelnStand.lauf = (async () => {
      try {
        const a = await lies(REGELN, { roh: true });
        if (!a.ok) return { ok: false, grund: "rules of the book not readable (" + a.grund + ")" };
        const r = regelnAus(konfigAus(a.roh));
        if (r.ok) regelnStand = { at: Date.now(), erg: r, lauf: null };
        return r;
      } finally { regelnStand.lauf = null; }
    })();
    return regelnStand.lauf;
  }
  // Frisches Angebot ALLER Beine in einem Abruf → Map Spiel-Nr. → Spiel | { fehler }. Das Angebot verlangt die Spiel-Nummern
  // AUFSTEIGEND (sonst Antwort 400 „events IDs must be in ascending order“) und hoechstens 16 je Abruf.
  async function angebotLesen(legs, jetzt) {
    const url = ANGEBOT + "?events=" + legs.map((L) => String(L.eventId)).sort((a, b) => Number(a) - Number(b)).map(encodeURIComponent).join(",") + "&startDate=" + encodeURIComponent(volleStunde(jetzt - FENSTER_VOR_MS)) + "&endDate=" + encodeURIComponent(volleStunde(jetzt + FENSTER_NACH_MS));
    const a = await lies(url, null);
    if (!a.ok) return { fehler: "offer of the book not readable (" + a.grund + ")" };
    if (!a.json || !Array.isArray(a.json.events)) return { fehler: "offer of the book not readable" };
    const m = new Map();
    for (const ev of a.json.events) if (ev && ev.event_id != null) { if (m.has(String(ev.event_id))) return { fehler: "the offer of the book names a game twice" }; m.set(String(ev.event_id), ev); }
    return { spiele: m };
  }
  // Ist die Seite angemeldet? true / false, null = nicht lesbar. Nur als Angabe beim Probe-Schein.
  async function sitzungLesen() {
    const a = await lies(SITZUNG, null);
    if (!a.ok) return (a.status === 401 || a.status === 403) ? false : null;
    const j = a.json;
    return !!(j && j.error === false && j.data && j.data.LogonSession && j.data.LogonSession.PlayerId);
  }
  // Geraete-Kennung wie die Seite (localStorage device_id); fehlt sie, eine frische (so setzt auch die Einzelwette seit 02.09.).
  function geraeteNr() {
    try { const v = String(localStorage.getItem("device_id") || ""); if (UUID.test(v)) return v; } catch (_) {}
    return scheinNr();
  }
  function scheinNr() {
    try { const u = crypto.randomUUID(); if (UUID.test(u)) return u; } catch (_) {}
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16); });
  }

  // ---- nach dem Absenden ---------------------------------------------------------------------------------------------------
  function fertig(z, o, env) {
    z.ms.gesamt = Math.round(jetztMs() - z.T0);
    const e = Object.assign(o, { legs: z.gelegt, ms: z.ms, tax: z.steuer, netOdds: z.netto, returns: z.auszahlung }, z.bonus ? { bonus: z.bonus } : {}, z.info ? { info: z.info } : {});
    if (z.buchAuszahlung != null && (e.status === "placed" || e.status === "uncertain")) e.bookReturns = z.buchAuszahlung;
    if (z.buchBonus && e.status === "placed") e.bookBonus = z.buchBonus;
    // Eine saubere Absage gibt denselben Schein fuer einen neuen Auftrag wieder frei; alles andere bleibt zehn Minuten gesperrt.
    if (e.status === "failed" || e.status === "blocked") geschickt.delete(z.schluessel);
    wartend.delete(z.id); merke(erledigt, z.id, e);
    try { if (env && env.emit) env.emit("Combo result", { status: e.status, odds: e.odds || null, ticket: e.ticket || null, bookReturns: e.bookReturns != null ? e.bookReturns : null, reason: e.reason || null }); } catch (_) {}
    return e;
  }
  const nochOffen = (z, ms) => ({ status: "pending", warteId: z.id, nachMs: ms, odds: z.soll.quote, ticket: z.ticket || undefined });
  const gesetzt = (z, env, mehr) => fertig(z, Object.assign({ status: "placed", ticket: z.ticket, odds: z.soll.quote, stake: z.soll.einsatz }, mehr || {}), env);
  // EIN Schritt fuer einen abgegebenen Schein — hoechstens zwei Abrufe je Aufruf (Konto-Kennung + Liste beim ersten Abgleich).
  async function schritt(z, env) {
    if (!z.urteil) {
      const u = z.urteil = klassifiziere(z.antwort, z.soll);
      if (u.ticket) { z.ticket = u.ticket; z.buchAuszahlung = u.buchAuszahlung; z.buchBonus = u.buchBonus; }
      if (u.status === "blocked") return fertig(z, { status: "blocked", reason: u.reason }, env);
      if (u.status === "placed") return gesetzt(z, env, Object.assign(u.stake ? { stake: u.stake } : {}, u.odds ? { odds: u.odds } : {}, u.note ? { note: u.note } : {}, u.buchQuote ? { bookOdds: u.buchQuote } : {}));
      if (u.gegenangebot) {
        const a = await lehneAb(u.original);
        return fertig(z, { status: "failed", reason: "Counter offer of the book (" + u.gegenangebot + ") — not accepted, nothing placed" + (a.ok ? "" : " (the decline was not confirmed: " + String(a.grund || "answer " + a.status) + ")") }, env);
      }
      if (u.status === "failed") return fertig(z, { status: "failed", reason: u.reason }, env);
      // unklar: der Schein braucht einen Augenblick, bis er im Schein-Dienst steht — erst beim Nachfragen lesen
      return nochOffen(z, u.lesen ? LESEN_MS : ABGLEICH_MS);
    }
    const u = z.urteil;
    if (u.lesen && z.ticket) {
      // Das Buch nannte eine Schein-Nummer, aber (noch) keine Bestaetigung: der Schein ist oeffentlich lesbar.
      z.lesungen++;
      const a = await lies(SCHEINE + "/ticket/" + encodeURIComponent(z.ticket) + "?locale=en-GR", null);
      const t = a.ok && a.json && typeof a.json === "object" && String(a.json.ticketId) === z.ticket ? a.json : null;
      if (t && passt(t, z.soll, null)) {
        const stand = String(t.status == null ? "" : t.status).toLowerCase();
        if (stand === "active") return gesetzt(z, env, { verified: true, note: "confirmed by reading the ticket" });
        if (stand === "canceled" || stand === "obsolete") return fertig(z, { status: "failed", ticket: z.ticket, reason: "The book did not keep the ticket (status " + stand + ")" }, env);
      } else if (t) return fertig(z, { status: "uncertain", ticket: z.ticket, odds: z.soll.quote, reason: "AUDIT: the ticket of the book holds other selections or another stake than the ones sent — check the bet history immediately" }, env);
      if (z.lesungen < LESEN_MAX) return nochOffen(z, LESEN_MS);
      return fertig(z, { status: "uncertain", ticket: z.ticket, odds: z.soll.quote, reason: u.reason }, env);
    }
    // Abgleich mit dem Konto, wie die Seite selbst bei unklarem Ausgang: die juengsten Scheine lesen und vergleichen.
    z.abgleiche++;
    if (!z.konto) {
      const k = await lies(KONTO, null), d = k.ok && k.json && k.json.data && typeof k.json.data === "object" ? k.json.data : null;
      if (d && /^\d{4,12}$/.test(String(d.userId)) && typeof d.sessionId === "string" && /^[\x21-\x7e]{20,120}$/.test(d.sessionId)) z.konto = { nr: String(d.userId), kennung: d.sessionId };
    }
    if (z.konto) {
      const a = await lies(SCHEINE + "/user/" + z.konto.nr + "/tickets?locale=en-GR&count=10", { kennung: z.konto.kennung });
      const liste = a.ok ? (Array.isArray(a.json) ? a.json : (a.json && Array.isArray(a.json.tickets) ? a.json.tickets : [])) : [];
      const treffer = liste.find((t) => passt(t, z.soll, z.start) && String(t.status).toLowerCase() === "active" && /^[A-Za-z0-9-]{6,24}$/.test(String(t.ticketId)));
      if (treffer) { z.ticket = String(treffer.ticketId); return gesetzt(z, env, { verified: true, note: "confirmed by reading the account (the answer of the book was unclear)" }); }
    }
    if (z.abgleiche < (u.inArbeit ? ABGLEICH_LAEUFT_MAX : ABGLEICH_MAX)) return nochOffen(z, ABGLEICH_MS);
    return fertig(z, { status: "uncertain", ticket: z.ticket || undefined, odds: z.soll.quote, reason: u.reason + (z.konto ? "" : " (the account was not readable)") }, env);
  }
  // Laeuft fuer diesen Schein gerade ein Schritt (zweiter Empfaenger im selben Tab), gibt es dessen Ergebnis — kein zweiter Abruf.
  function nachfragen(warteId) {
    const id = String(warteId), z = wartend.get(id);
    if (!z) return Promise.resolve(erledigt.has(id) ? erledigt.get(id) : { status: "uncertain", reason: BUCH + " combo: the waiting slip is no longer known (page reloaded?) — POSSIBLY placed, check the bet history" });
    if (z.lauf) return z.lauf;
    z.lauf = (async () => {
      try { return await schritt(z, z.env); }
      catch (e) { return fertig(z, { status: "uncertain", ticket: z.ticket || undefined, odds: z.soll.quote, reason: BUCH + " combo: " + text(e) + " — POSSIBLY placed, check the bet history" }, z.env); }
      finally { z.lauf = null; }
    })();
    return z.lauf;
  }

  // msg: { auftragId (Pflicht, 6–80 Zeichen — dieselbe Nummer wird nie zweimal ausgefuehrt), legs:[{ eventId, tip ("1"|"X"|"2" in
  //        der Reihenfolge des BUCHS), minOdds, team1, team2 (Mannschaften des Buchs), sport? ("soccer" ohne Angabe ·
  //        "basketball": 1|2) }], amount (€), minTotalOdds, armed (true = abgeben) }
  // env: { emit(text, daten) }
  // Antwort: { status: staged | pending | placed | failed | blocked | uncertain, odds (Gesamtquote = Produkt), netOdds (Auszahlung
  //            nach Steuer je € Einsatz, OHNE Kombi-Bonus), returns, tax:{ total, back, toPay }, bonus?:{ legs, pct, extra, returns,
  //            netOdds }, info?, legs:[…], ms, ticket?, bookReturns?, bookBonus?, bookOdds?, reason?, note?, bein?, warteId?, nachMs? }
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
    if (!Array.isArray(legs) || legs.length < MIN || legs.length > MAX) return nein("needs " + MIN + " to " + MAX + " legs");
    const spieleSet = new Set();
    for (const L of legs) {
      const M = L ? cfgVon(L.sport) : null;
      if (L && !M) return nein("sport " + String(L.sport) + " is not connected for combos");
      if (!L || !/^\d{4,12}$/.test(String(L.eventId)) || M.tips.indexOf(L.tip) < 0 || !(Number(L.minOdds) > 1) || !L.team1 || !L.team2 || spieleSet.has(String(L.eventId))) return nein("invalid or duplicate leg");
      spieleSet.add(String(L.eventId));
    }
    const amount = Math.round(Number(msg.amount) * 100) / 100, minTotal = Number(msg.minTotalOdds);
    if (!(amount >= MIN_EINSATZ) || amount > MAX_EINSATZ) return nein("stake " + String(msg.amount) + " outside " + MIN_EINSATZ + "–" + MAX_EINSATZ);
    if (!(minTotal > 1)) return nein("minimum total odds missing");
    if (laeuft) return nein("another combo is being built right now");
    // Verwaiste Warte-Eintraege (der Aufrufer fragt nicht mehr nach): der Ausgang bleibt „uncertain“.
    for (const [k, alt] of wartend) if (Date.now() - alt.start > WARTE_ALT_MS && !alt.lauf) { wartend.delete(k); merke(erledigt, k, { status: "uncertain", ticket: alt.ticket || undefined, odds: alt.soll.quote, legs: alt.gelegt, reason: BUCH + " combo: nobody asked for the result any more — POSSIBLY placed, check the bet history" }); }
    const spiele = [...spieleSet], schluessel = legs.map((L) => String(L.eventId) + ":" + String(L.tip)).sort().join("|");
    laeuft = true;
    let gesendet = false, z = null;
    try {
      const jetzt = Date.now(), tl = jetztMs();
      // 1) nebeneinander: Regeln des Buchs (gemerkt), frisches Angebot ALLER Beine (ein Abruf); beim Probe-Schein dazu die Anmeldung
      const [regeln, angebot, angemeldet] = await Promise.all([regelnLesen(), angebotLesen(legs, jetzt), armed ? null : sitzungLesen()]);
      ms.lesen = Math.round(jetztMs() - tl);
      if (!regeln.ok) return nein(regeln.grund);
      if (angebot.fehler) return nein(angebot.fehler);
      const R = regeln.R, beine = [], eintraege = [], kennungen = [], ausgaenge = {};
      for (let i = 0; i < legs.length; i++) {
        const L = legs[i], nr = i + 1, x = beinAus(angebot.spiele.get(String(L.eventId)), L, Date.now());
        if (x.fehler) return nein("leg " + nr + ": " + x.fehler, { bein: nr });
        beine.push({ preis: x.preis, bonusFaehig: bonusFaehig(R, x.tags) });
        eintraege.push(x.eintrag); kennungen.push(x.kennung); ausgaenge[String(L.eventId)] = x.ausgang;
        gelegt.push({ eventId: String(L.eventId), tip: L.tip, outcomeId: x.kennung, odds: x.preis, minOdds: Number(L.minOdds), teams: String(L.team1) + " – " + String(L.team2), sport: String(L.sport || "soccer") });
      }
      // 2) Grenzen des Buchs
      if (legs.length > R.maxBeine) return nein("the book allows at most " + R.maxBeine + " selections in a combo");
      if (amount < R.minEinsatz) return nein("stake " + amount + " is below the book's minimum " + R.minEinsatz);
      if (amount > R.maxEinsatz) return nein("stake " + amount + " is above the book's maximum " + R.maxEinsatz);
      // 3) der Schein, wie ihn das Buch rechnet — fuer die Mindest-Gesamtquote OHNE Kombi-Bonus, nach Steuer
      const ohne = rechne(R, beine, amount, false);
      if (!ohne.ok) return nein(ohne.grund);
      if (ohne.begrenzt) return nein("the payout would exceed the book's maximum win per ticket (" + R.maxGewinn + ")");
      const quote = ohne.quote, netto = ohne.nettoQuote, steuerInfo = { total: ohne.steuer, back: ohne.erstattung, toPay: ohne.abzug };
      if (!(ohne.netto >= minTotal * ohne.einsatz - 1e-9)) return nein(ohne.abzug > 0 ? "after the winnings tax (" + ohne.abzug.toFixed(2) + " €) the combo pays " + netto.toFixed(2) + " times the stake — below the min total odds " + minTotal.toFixed(2) : "total odds " + quote.toFixed(2) + " are below the min total odds " + minTotal.toFixed(2));
      // Kombi-Bonus des Buchs: nur als Angabe (siehe Kopf der Datei)
      let bonus = null;
      const m2 = R.bonus ? rechne(R, beine, amount, true) : null;
      if (m2 && m2.ok && m2.bonus > 0) bonus = { legs: m2.bonusBeine, pct: m2.bonusProzent, extra: m2.bonus, returns: m2.brutto, netOdds: m2.nettoQuote };
      const info = [armed ? null : (angemeldet === true ? "logged in at superbet.gr" : angemeldet === false ? "NOT logged in at superbet.gr" : "login at superbet.gr not readable"),
        ohne.steuer > 0 ? (ohne.abzug > 0 ? "winnings tax " + ohne.abzug.toFixed(2) + " € → pays " + netto.toFixed(2) + "× the stake" : "winnings tax " + ohne.steuer.toFixed(2) + " € carried by Superbet") : null,
        bonus ? "Acca Boost +" + bonus.pct + " % for " + bonus.legs + " legs (+" + bonus.extra.toFixed(2) + " € if the book credits it — not counted)" : (R.bonus ? null : "combo bonus of the book not readable")].filter(Boolean).join(" · ") || null;
      emit("Combo built and priced", { legs: gelegt.length, totalOdds: quote, netOdds: netto, amount, taxToPay: ohne.abzug, bonusPct: bonus ? bonus.pct : null, armed, ms: Math.round(jetztMs() - T0) });
      // Sicherheits-Halt: nur abgeben, wenn ausdruecklich scharf. Im Tab bleibt nichts stehen (es gibt keinen Schein in der Seite).
      if (!armed) return mit(Object.assign({ status: "staged", slipLeft: false, odds: quote, netOdds: netto, legs: gelegt, returns: ohne.brutto, tax: steuerInfo, note: "Combo checked and priced against the Superbet odds feed — NOT placed (armed=false). Nothing is left in the tab." }, bonus ? { bonus } : {}, info ? { info } : {}));
      // 4) Doppel-Schutz: derselbe Schein ging aus diesem Tab eben schon raus
      const vor = geschickt.get(schluessel);
      if (vor != null && Date.now() - vor < DOPPEL_MS) return nein("the same slip was sent from this tab " + Math.round((Date.now() - vor) / 1000) + " s ago (double protection)");
      // 5) Abgeben — EIN Auftrag an die Absende-Funktion
      const soll = { einsatz: amount, quote, spiele, ausgaenge, kennungen };
      const schein = baueSchein(eintraege, amount, geraeteNr(), scheinNr());
      z = { id: "k" + (++warteNr) + "-" + Date.now().toString(36), soll, schluessel, start: Date.now(), T0, ms, gelegt, steuer: steuerInfo, netto, auszahlung: ohne.brutto, bonus, info,
        antwort: null, urteil: null, ticket: null, buchAuszahlung: null, buchBonus: null, konto: null, lesungen: 0, abgleiche: 0, lauf: null, env };
      merke(geschickt, schluessel, Date.now());
      const ta = jetztMs();
      gesendet = true;
      z.antwort = await sende(schein, soll);                                // PUNKT OHNE WIEDERKEHR
      ms.abgeben = Math.round(jetztMs() - ta);
      wartend.set(z.id, z);
      z.lauf = schritt(z, env);
      try { return await z.lauf; }
      catch (e) { return fertig(z, { status: "uncertain", ticket: z.ticket || undefined, odds: quote, reason: BUCH + " combo: " + text(e) + " — POSSIBLY placed, check the bet history" }, env); }
      finally { z.lauf = null; }
    } catch (e) {
      if (gesendet) {
        // Nach dem Absenden ist der Ausgang offen — nie „nicht gesetzt“. Kein haengender Warte-Eintrag.
        if (z) wartend.delete(z.id);
        return mit({ status: "uncertain", ticket: (z && z.ticket) || undefined, reason: BUCH + " combo: exception after the slip was sent (" + text(e) + ") — POSSIBLY placed, check the bet history", legs: gelegt });
      }
      return nein("exception: " + text(e));
    } finally { laeuft = false; }
  }

  const beschaeftigt = () => laeuft || [...wartend.values()].some((z) => Date.now() - z.start < WARTE_ALT_MS);
  self.SBKOMBI = { place, nachfragen, laeuft: () => laeuft, beschaeftigt, MARKT, _dez: dez, _zahl: zahl, _plus: plus, _minus: minus, _mal: mal, _durch: durch, _runde: runde, _konfigAus: konfigAus, _steuerStufen: steuerStufen,
    _bonusStufen: bonusStufen, _regelnAus: regelnAus, _bonusFaehig: bonusFaehig, _bonusProzent: bonusProzent, _steuerAuf: steuerAuf, _rechne: rechne, _beinAus: beinAus, _baueSchein: baueSchein, _scheinFehler: scheinFehler,
    _angebotText: angebotText, _fehlerText: fehlerText, _klassifiziere: klassifiziere, _passt: passt };
})();
