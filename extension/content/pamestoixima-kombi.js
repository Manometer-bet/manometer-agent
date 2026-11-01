// pamestoixima-kombi.js — KOMBIWETTE bei pamestoixima.gr (OPAP, Plattform OpenBet). 05.10.2026.
// Laeuft im Tab von www.pamestoixima.gr (im Manifest VOR pamestoixima-content.js geladen): gelesen und gesetzt wird aus der
// Seite heraus, wie die Einzelwette. Stellt PMKOMBI.place(msg, env) und PMKOMBI.nachfragen(warteId) bereit; die Befehls-
// Verdrahtung macht pamestoixima-content.js. Seit 18.10.2026 (Manometer Agent 1.2.76) liegt DIESE Datei byte-gleich auch in der Engine
// der External Bettors (engine/content/pamestoixima-kombi.js, Verdrahtung dort engine/content/pamestoixima-place.js).
//
// Betreiber (05.10.2026): „lasse uns Stück für Stück die anderen Bookies anbinden, sodass man auch bei denen die Parlays setzen
// kann … Zuerst bei den GR-Bookies bitte den GR-Chrome nutzen zum Testen.“
//
// GELERNT (05.10., GR-Chrome ohne Anmeldung am Code der Seite, an ihrer Schein-Auskunft und ihrem Steuer-Rechner; dazu der
// Mitschnitt vom 19.08. mit zwei echten Einzelwetten und einer verzoegerten — es wurde nichts abgegeben):
//   * Eine Kombi geht mit DEMSELBEN Abruf raus wie die Einzelwette: POST papi…/bet-service/api/v1/slips mit { legs, bets }.
//     legs = je Spiel ein Bein (LEG1 …: Auswahl-Nummer + Preis als Bruch numerator / denominator), bets = EINE Wette ueber alle
//     Beine: betTypeRef DBL (2) · TBL (3) · ACCUMULATOR<n> (ab 4), lines 1, legRefs alle Beine, stake, stakeType "SPL",
//     options { winPlaceOverride "WIN", priceChangeBehaviour "NONE" } — NONE = das Buch nimmt keine geaenderte Quote an
//     (die Seite kennt dazu HIGHER und ALL; hier geht immer NONE mit, wie bei der Einzelwette). Mehr Felder traegt ein
//     einfacher Schein nicht (Freiwette, Bet-Builder-Boost: gehen hier NIE mit). Die Anmeldung ist der Zugangs-Schluessel der
//     Sitzung (api…/web/access/session/check → access_token) als Authorization-Kopf; ohne ihn antwortet das Buch 401.
//   * FRISCHE SPIELE aller Beine in EINEM Abruf: GET capi…/q/getEventsNew?eventIds=<Nrn.>&marketGroupCodesIncluded=MATCH_RESULT
//     &includeMarkets=true&includeTeams=true (12 Spiele 33 kB in ~0,3 s). OHNE includeMarkets / includeTeams kommen weder Maerkte
//     noch Mannschaften (daran war der Vorspiel-Feed dieses Buchs still gestorben). Je Spiel: status / active, liveNow, started,
//     startTime, sortCode "MTCH", category.id "17" = Fussball, teams [{ name, side HOME | AWAY }] (ohne Nummern), genau EIN
//     Markt groupCode MATCH_RESULT (subType "MR") mit drei Auswahlen subType H / D / A; die Auswahl heisst wie ihre Mannschaft
//     („Draw“ beim Remis), Preis { numerator, denominator, decimal, priceType "LP" } — decimal ist genau 1 + Bruch.
//     FALLE: status "ACTIVE" steht auch an gesperrten Maerkten und Auswahlen — es gilt active (true / false).
//     FALLE: ein zweiter Sieger-Markt MATCH_RESULT_2 („0 %“, nur bei wenigen Spitzenspielen, bessere Quoten) ist eine ANDERE
//     Auswahl mit anderen Nummern; das Board fuehrt MATCH_RESULT, also setzt dieser Baustein nur dort.
//   * SCHEIN-AUSKUNFT POST papi…/slips/local/build { legs } prueft und bepreist den Schein, auch ohne Anmeldung (0,15–0,7 s):
//     HTTP 200 + status "BUILD" + bets = alle Wett-Arten, die aus den Beinen moeglich sind, je mit potentialPayout
//     [{ type "MULTIPLIER", value = Gesamtquote = genaues Produkt der Quoten }], minimumStake, maximumStake.
//     FALLEN, alle gemessen: ein Preis, der nicht (mehr) stimmt → 422 + BUILD_ERROR + errors BET_PRICE_CHANGED (auch wenn die
//     Quote GESTIEGEN ist), die Antwort nennt den neuen Preis — und fuehrt trotzdem alle Wett-Arten mit Quoten auf ·
//     angepfiffen / gesperrt → EVENT_STARTED · unbekannte Auswahl → 422 + BUILD_ERROR OHNE Fehlerliste · ohne Preis → 500 ·
//     zwei Auswahlen desselben Spiels oder eine doppelte: 200 + BUILD ohne Fehler, aber nonCombinableLegGroups nennt das Paar
//     und die volle Kombi fehlt in bets (eine doppelte Auswahl faellt aus legs still heraus).
//   * RECHNUNG: Auszahlung = Einsatz × Gesamtquote, auf Cent ABGESCHNITTEN (1 × 5,975721 → 5,97). 31 Faelle am Rechner des
//     Buchs nachgemessen, darunter 14 an der Gleitkomma-Kante (4,0115 × 20 → 80,23).
//   * GEWINNSTEUER (GR, je Wette auf Auszahlung minus Einsatz: bis 100 € frei, 2,5 % bis 200 €, 5 % bis 500 €, darueber 7,5 %;
//     auf Cent gerundet) zahlt hier der SPIELER — das Buch traegt nichts. Sein Rechner (POST taxation…/potential-payouts, geht
//     ohne Anmeldung, ~0,12 s) nennt winnings / tax / returns; die eigene Leiter traf ihn in 25 von 25 Faellen. Fuer die
//     Mindest-Gesamtquote zaehlt die Auszahlung NACH Steuer.
//   * KOMBI-BONUS („Acca Boost“): ab 3 Beinen, jede Quote ≥ 1,40, nur bestimmte Wettbewerbe und nie der 0-%-Markt; 5 % auf den
//     GEWINN bei 3 Beinen, je weiterem Bein 5 Punkte mehr (4 → 10 %, 5 → 15 %). Es zaehlt nur, wenn ALLE Beine teilnehmen. Die
//     Auskunft nennt ihn dann als zweiten Eintrag der Auszahlung (WINNINGS_PERCENTAGE_MULTIPLIER); anfordern muss ihn der
//     Schein nicht. Er wird hier nur GEMELDET (bonus), fuer die Mindest-Gesamtquote zaehlt er nicht.
//   * ANTWORT des Setzens (Mitschnitt der Einzelwetten): HTTP 201 { data: { id (Schein-Nr.), status "PLACED", legs, bets:[{ id,
//     betTypeRef, status "PLACED", stake, legRefs, potentialPrice, receipt }], potentialPayoutValues } } = gesetzt ·
//     HTTP 202 { data: { id, status "BIR_DELAY", poll, pollPeriod }, actions:[{ actionTypeRef "SLIP_RETRIEVE", method GET,
//     href …/slips/<Nr.> }] } = das Buch entscheidet noch; das Ergebnis steht dann unter GET …/slips/<Nr.>.
//     Weitere Status laut Code der Seite: REFERRAL_PENDING (bei den Haendlern), REFERRAL_PLACED, REFERRAL_PROCESSED (GEGENANGEBOT:
//     anderer Einsatz oder andere Quote — wird hier NIE angenommen, es verfaellt), PARTIALLY_PLACED, FAILED, DECLINED;
//     Fehler-Arten CHANGE_ERROR, BET_ERROR, ACCOUNT_ERROR, VALIDATION_ERROR, PAM_INTEGRATION_ERROR, READ_TIMEOUT, ACCESS_DENIED.
//     NICHT GEMESSEN: die Annahme einer KOMBI und deren Antwort, eine Absage, ein Gegenangebot (es wurde keine Kombi
//     abgegeben), die Einsatz-Grenzen eines echten Kontos.
// SICHERUNGEN (fail-closed): Auftrags-Nummer Pflicht (derselbe Auftrag laeuft nie zweimal); nur im Tab von www.pamestoixima.gr;
//   je Bein aus dem frischen Abruf: das Spiel ist da, Fussball-Spiel, Mannschaften des Buchs = die des Auftrags (gleiche
//   Reihenfolge), offen, nicht angepfiffen, GENAU ein Sieger-Markt mit genau H / D / A, die Auswahlen heissen wie die
//   Mannschaften, die Auswahl des Tipps ist offen und (wenn der Auftrag sie nennt) genau die genannte Nummer, Quote lesbar und
//   ≥ Mindestquote; die Auskunft des Buchs: ohne Fehler, dieselben Beine und Preise, nichts unvereinbar, die volle Kombi ist
//   da, ihre Gesamtquote = Produkt der Beine, Einsatz in den Grenzen des Buchs; Auszahlung nach Steuer OHNE Bonus ≥ Mindest-
//   Gesamtquote × Einsatz. armed:false endet hier („staged“) — nirgends bleibt etwas stehen (die Auskunft merkt sich nichts).
//   Scharf: nur angemeldet; derselbe Schein geht aus diesem Tab nicht zweimal binnen zehn Minuten raus; unmittelbar vor dem
//   Absenden prueft scheinFehler den fertigen Schein noch einmal Feld fuer Feld gegen den Auftrag. Abgeben: EIN Aufruf (sende),
//   nie ein zweiter.
// WARTEN OHNE ZEITGEBER IN DER SEITE: nach dem Absenden hoechstens ein Schritt je Aufruf; braucht es mehr (das Buch entscheidet
//   noch, unklare Antwort), kommt { status:"pending", warteId, nachMs } — der Aufrufer wartet und ruft nachfragen (liest den
//   Schein bzw. die offenen Wetten des Kontos, sendet nie einen Schein).
// Der Zugangs-Schluessel der Sitzung und der Name des Kontos stehen nie in einer Rueckgabe, einer Meldung oder einem Fehlertext.
(() => {
  "use strict";
  if (self.PMKOMBI && typeof self.PMKOMBI.beschaeftigt === "function" && self.PMKOMBI.beschaeftigt()) return;
  const BUCH = "pamestoixima", SEITE = "www.pamestoixima.gr";
  const SPIELE = "https://capi.pamestoixima.gr/content-service/api/v1/q/getEventsNew";      // lesen: Spiele mit Sieger-Markt
  const SITZUNG = "https://api.pamestoixima.gr/web/access/session/check";                  // lesen: Zugangs-Schluessel der Sitzung
  const PAPI = "https://papi.pamestoixima.gr/bet-service/api/v1";
  const BAU = PAPI + "/slips/local/build";                                                  // lesen: prueft und bepreist den Schein
  const RECHNER = "https://taxation.pamestoixima.gr/potential-payout-service/api/v1/potential-payouts";   // lesen: Auszahlung nach Steuer
  const SCHEIN = PAPI + "/slips/";                                                          // + Schein-Nr.: lesen (Ergebnis eines Scheins)
  const OFFENE = PAPI + "/bets?count=200&expand=cashout&settled=false";                     // lesen: offene Wetten des Kontos
  const SETZEN = PAPI + "/slips";                                                           // DER Punkt ohne Wiederkehr (nur in sende)
  const OB = { "x-ob-channel": "I", "x-accept-language": "en-GB" };                         // Namen auf Englisch — wie der Feed des Boards
  const KOPF = Object.assign({ "Content-Type": "application/json" }, OB);
  // Sieger-Markt je Sportart: Kategorie des Buchs, Markt (groupCode / subType) und Auswahl je Tipp (Reihenfolge des Buchs:
  // „1“ = HOME). Der Markt muss GENAU diese Auswahlen fuehren.
  const MARKT = { soccer: { kat: "17", gruppe: "MATCH_RESULT", art: "MR", sub: { "1": "H", "X": "D", "2": "A" } } };
  const MIN = 2, MAX = 12, MIN_EINSATZ = 0.1, MAX_EINSATZ = 1000;          // Sicherheitsgrenzen dieses Bausteins (EUR), nicht die des Buchs
  const STUFEN = [{ bis: 100, satz: 0 }, { bis: 200, satz: 0.025 }, { bis: 500, satz: 0.05 }, { bis: Infinity, satz: 0.075 }];   // Gewinnsteuer je Wette
  // Fehler-Arten, mit denen das Buch einen Schein ausdruecklich NICHT angenommen hat (alles andere bleibt offen).
  const ABSAGE_ARTEN = ["CHANGE_ERROR", "BET_ERROR", "ACCOUNT_ERROR", "VALIDATION_ERROR"];
  const WARTE_STATUS = ["BIR_DELAY", "REFERRAL_PENDING", "REFERRAL_PROCESSED"];
  const LESE_MS = 6000, SENDE_MS = 30000, DOPPEL_MS = 10 * 60000;
  const NACH_MS = 1500, NACH_ERST_MS = 1200, NACH_MAX = 10, VERZUG_MAX_MS = 10000;
  const WARTE_ALT_MS = 5 * 60000, MERKEN_MAX = 40;
  const wartend = new Map(), auftraege = new Map(), erledigt = new Map(), geschickt = new Map();
  const merke = (m, k, v) => { m.set(k, v); while (m.size > MERKEN_MAX) m.delete(m.keys().next().value); };
  let warteNr = 0, laeuft = false;
  const jetztMs = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  const text = (e) => String((e && e.message) || e);
  const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : null);
  const zahl = (x) => typeof x === "number" && isFinite(x);
  const cent = (x) => Math.round(x * 100) / 100;
  const sauber = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const num = (x) => (typeof x === "number" ? x : (typeof x === "string" && /^-?\d+(\.\d+)?$/.test(x.trim()) ? Number(x) : NaN));   // Zahl oder Ziffern-Text → Zahl
  const gleicheMenge = (a, b) => a.length === b.length && a.slice().sort().join("\n") === b.slice().sort().join("\n");
  const gleicheFolge = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const cfgVon = (sport) => { const k = String(sport == null || sport === "" ? "soccer" : sport); return Object.prototype.hasOwnProperty.call(MARKT, k) ? MARKT[k] : null; };
  const beinNr = (i) => "LEG" + (i + 1);
  // Zugangs-Schluessel der Sitzung (zugang): Text ohne Leer- und Steuerzeichen. „schluessel“ heisst hier — wie in den anderen
  // Kombi-Bausteinen — die Kennung eines Scheins fuer den Doppel-Schutz, nie der Zugang.
  const zugangOk = (x) => typeof x === "string" && /^[^\x00-\x20\x7f]{8,8000}$/.test(x);

  // ---- PURE: Rechnung wie das Buch --------------------------------------------------------------------------------------------
  // Wett-Art der vollen Kombi aus n Beinen
  function typVon(n) { return n === 2 ? "DBL" : n === 3 ? "TBL" : (Number.isInteger(n) && n >= 4 && n <= 30 ? "ACCUMULATOR" + n : null); }
  // Auszahlung eines gewonnenen Scheins: Einsatz × Gesamtquote, auf Cent abgeschnitten (gemessen; die kleine Zugabe faengt die
  // Gleitkomma-Kante: 4,0115 × 20 ist in der Maschine 80,2299…, das Buch zahlt 80,23).
  function auszahlung(quote, einsatz) { return Math.floor(einsatz * quote * 100 + 1e-7) / 100; }
  // Gewinnsteuer nach der Leiter, auf den Gewinn (Auszahlung minus Einsatz), auf Cent gerundet
  function steuerLeiter(gewinn) {
    if (!(gewinn > 0)) return 0;
    let s = 0, von = 0;
    for (const st of STUFEN) { if (gewinn > von) s += (Math.min(gewinn, st.bis) - von) * st.satz; von = st.bis; }
    return cent(s);
  }

  // ---- PURE: ein Bein aus dem frischen Abruf der Spiele ----------------------------------------------------------------------
  // e = das Spiel aus der Antwort des Buchs (undefined: nicht dabei). L = das Bein des Auftrags (Tipp in der Reihenfolge des
  // BUCHS, team1 = HOME). → { fehler, preis? } | { ref, n, d, preis, markt, namen }
  function beinAus(e, L, jetzt) {
    const M = cfgVon(L.sport);
    if (!M) return { fehler: "sport " + String(L.sport) + " is not connected for combos" };
    const sub = Object.prototype.hasOwnProperty.call(M.sub, String(L.tip)) ? M.sub[String(L.tip)] : null;
    if (!sub) return { fehler: "outcome " + String(L.tip) + " does not exist in the winner market" };
    if (!obj(e)) return { fehler: "the game is not offered (any more)" };
    if (String(e.id) !== String(L.eventId)) return { fehler: "the book names another game (" + String(e.id).slice(0, 16) + ")" };
    if (e.sortCode !== "MTCH" || !obj(e.category) || String(e.category.id) !== M.kat) return { fehler: "the game is not listed as a " + String(L.sport || "soccer") + " match at the book" };
    const T = Array.isArray(e.teams) ? e.teams.filter(obj) : [], H = T.filter((t) => t.side === "HOME"), A = T.filter((t) => t.side === "AWAY");
    if (T.length !== 2 || H.length !== 1 || A.length !== 1) return { fehler: "home and away team of the book not readable" };
    const heim = sauber(H[0].name), gast = sauber(A[0].name), namen = heim + " – " + gast;
    if (!heim || !gast || heim !== sauber(L.team1) || gast !== sauber(L.team2)) return { fehler: "teams at the book (" + namen.slice(0, 80) + ") differ from the order" };
    if (e.status !== "ACTIVE" || e.active !== true || e.displayed === false || e.settled === true || e.resulted === true) return { fehler: "the game is not open for betting" };
    if (e.liveNow === true || e.started === true) return { fehler: "the game is live — combos are pre-match only" };
    if (!(typeof e.startTime === "string" && Date.parse(e.startTime) > jetzt)) return { fehler: "the game has started or its kick-off is unknown" };
    const ms = (Array.isArray(e.markets) ? e.markets : []).filter((m) => obj(m) && m.groupCode === M.gruppe);
    if (ms.length !== 1) return { fehler: ms.length ? "the book lists the winner market more than once — unclear" : "the winner market is not offered" };
    const m = ms[0];
    if (m.subType !== M.art || String(m.eventId) !== String(e.id) || m.handicapValue != null || !/^\d{4,14}$/.test(String(m.id))) return { fehler: "the market of the book is not the plain match result" };
    if (m.status !== "ACTIVE" || m.active !== true || m.displayed === false) return { fehler: "the winner market is suspended" };
    // genau die Auswahlen des Sieger-Markts, jede einmal
    const os = Array.isArray(m.outcomes) ? m.outcomes.filter(obj) : [], subs = ["1", "X", "2"].filter((k) => Object.prototype.hasOwnProperty.call(M.sub, k)).map((k) => M.sub[k]);
    if (os.length !== subs.length || subs.some((s) => os.filter((o) => o.subType === s).length !== 1)) return { fehler: "the winner market of the book does not list exactly " + subs.join(" / ") };
    // Die Quote haengt an der richtigen Mannschaft: die Auswahlen H und A heissen wie HOME und AWAY.
    if (sauber(os.find((o) => o.subType === "H").name) !== heim || sauber(os.find((o) => o.subType === "A").name) !== gast) return { fehler: "the selections of the book do not carry the names of the teams — sides unclear" };
    const o = os.find((x) => x.subType === sub);
    if (String(o.marketId) !== String(m.id) || !/^\d{4,14}$/.test(String(o.id))) return { fehler: "selection number of the book not readable" };
    if (L.outcomeId != null && String(L.outcomeId) !== String(o.id)) return { fehler: "the selection number of the order is not the one the book lists for this outcome now" };
    if (o.status !== "ACTIVE" || o.active !== true || o.displayed === false) return { fehler: "outcome " + L.tip + " is suspended" };
    const ps = Array.isArray(o.prices) ? o.prices.filter(obj) : [];
    if (ps.length !== 1 || ps[0].priceType !== "LP") return { fehler: "odds of the book not readable (price type)" };
    const n = num(ps[0].numerator), d = num(ps[0].denominator), preis = num(ps[0].decimal);
    if (!(Number.isSafeInteger(n) && n > 0 && Number.isSafeInteger(d) && d > 0) || !(zahl(preis) && preis > 1) || Math.abs(1 + n / d - preis) > 0.0051) return { fehler: "odds not readable (" + String(ps[0].decimal).slice(0, 16) + ")" };
    if (!(preis >= Number(L.minOdds))) return { fehler: String(preis) + " is below the min odds " + Math.round(Number(L.minOdds) * 1e4) / 1e4, preis };
    return { ref: String(o.id), n, d, preis, markt: String(m.id), namen };
  }
  // PURE: alle Beine aus der Antwort des Abrufs. → { fehler, bein?, gelegt } | { beine, gelegt }
  function spieleAus(j, legs, jetzt) {
    if (!obj(j) || !obj(j.data) || !Array.isArray(j.data.events)) return { fehler: "games of the book not readable", gelegt: [] };
    if (Array.isArray(j.errors) && j.errors.length) return { fehler: "the book answered the game list with an error", gelegt: [] };
    const beine = [], gelegt = [];
    for (let i = 0; i < legs.length; i++) {
      const L = legs[i], treffer = j.data.events.filter((e) => obj(e) && String(e.id) === String(L.eventId));
      const x = treffer.length > 1 ? { fehler: "the book lists this game more than once — unclear" } : beinAus(treffer[0], L, jetzt);
      if (x.fehler) return { fehler: "leg " + (i + 1) + ": " + x.fehler, bein: i + 1, gelegt };
      beine.push(Object.assign({ eventId: String(L.eventId) }, x));
      gelegt.push({ eventId: String(L.eventId), tip: L.tip, outcomeId: x.ref, odds: x.preis, minOdds: Number(L.minOdds), teams: x.namen, sport: String(L.sport || "soccer") });
    }
    return { beine, gelegt };
  }
  // PURE: die Beine in der Form des Buchs (Auskunft und Schein tragen dieselben).
  function baueBeine(beine) {
    return beine.map((b, i) => ({ documentId: beinNr(i), options: { banker: false, inMultiples: true, handicaps: [{ outcomeRef: b.ref }], prices: [{ priceTypeRef: "LP", numerator: b.n, denominator: b.d, winPlaceRef: "WIN" }], winPlace: "WIN" }, outcomes: [{ outcomeRef: b.ref }] }));
  }
  // PURE: Fehlerliste des Buchs in Worten. → { text, bein (Nr. | null), art }
  function fehlerAus(j) {
    const errs = obj(j) && Array.isArray(j.errors) ? j.errors.filter(obj) : [];
    if (!errs.length) return { text: null, bein: null, art: null };
    const e = errs[0], m = /(?:^|\.)LEG(\d{1,2})(?:\.|$)/.exec(String(e.documentRef == null ? "" : e.documentRef)), id = typeof e.id === "string" ? e.id : "", art = typeof e.type === "string" ? e.type : "";
    const was = id === "BET_PRICE_CHANGED" ? "the odds changed" : id === "EVENT_STARTED" ? "the game has started or the selection is closed" : id === "OUTCOME_SUSPENDED" ? "the selection is suspended"
      : (id === "BET_LINE_CHANGED" || id === "BET_LINE_CHANGE") ? "the line changed" : id === "INSUFFICIENT_FUNDS" ? "not enough balance" : id === "OFFER_TIMED_OUT" ? "the counter-offer of the book expired"
      : art === "ACCESS_DENIED" ? "the login has expired" : sauber([id || art, typeof e.text === "string" ? e.text : ""].filter(Boolean).join(": ")).slice(0, 120) || "no reason given";
    return { text: was, bein: m ? Number(m[1]) : null, art };
  }
  // PURE: die Schein-Auskunft des Buchs. status = HTTP-Status, j = Antwort, beine = die gesendeten. → { fehler, bein?,
  // dauerhaft? } | { quote, doc, typ, grenzen, bonus, roh }
  function bauAus(status, j, beine, legs) {
    const n = beine.length, typ = typVon(n), d = obj(j) ? obj(j.data) : null;
    if (!obj(j)) return { fehler: "slip check of the book not readable (answer " + String(status).slice(0, 6) + ")" };
    const f = fehlerAus(j);
    if (f.text) {
      // Bei einer Preis-Aenderung nennt die Antwort den neuen Preis des Beins.
      let neu = "";
      if (f.bein && d && Array.isArray(d.legs)) { const l = d.legs.filter(obj).find((x) => x.documentId === beinNr(f.bein - 1)), p = l && obj(l.options) && Array.isArray(l.options.prices) ? obj(l.options.prices[0]) : null; if (p && num(p.decimal) > 1) neu = " (now " + num(p.decimal) + ")"; }
      return Object.assign({ fehler: (f.bein && f.bein <= n ? "leg " + f.bein + ": " : "") + f.text + neu + " — the slip check of the book refused" }, f.bein && f.bein <= n ? { bein: f.bein } : {});
    }
    if (status !== 200 || !d || d.status !== "BUILD") return { fehler: "the book refused the slip check" + (d && typeof d.status === "string" ? " (" + d.status.slice(0, 30) + ")" : " (answer " + String(status).slice(0, 6) + ")") + " — a selection is unknown or closed" };
    // dieselben Beine und Preise
    const dl = Array.isArray(d.legs) ? d.legs.filter(obj) : [];
    if (dl.length !== n) return { fehler: "the book dropped a selection from the slip (it cannot be combined with another one of the slip)" };
    for (let i = 0; i < n; i++) {
      const l = dl[i], o = obj(l.options), p = o && Array.isArray(o.prices) && o.prices.length === 1 ? obj(o.prices[0]) : null, os = Array.isArray(l.outcomes) ? l.outcomes.filter(obj) : [];
      if (l.documentId !== beinNr(i) || os.length !== 1 || String(os[0].outcomeRef) !== beine[i].ref || !p || num(p.numerator) !== beine[i].n || num(p.denominator) !== beine[i].d) return { fehler: "leg " + (i + 1) + ": the book answered with another selection or other odds", bein: i + 1 };
      if (obj(l.optionsAvailable) && l.optionsAvailable.inMultiples === false) return { fehler: "leg " + (i + 1) + ": this game takes single bets only", bein: i + 1, dauerhaft: true };
    }
    // nichts unvereinbar
    const ncl = Array.isArray(d.nonCombinableLegGroups) ? d.nonCombinableLegGroups.filter((g) => Array.isArray(g) && g.length) : [];
    if (ncl.length) {
      const nrn = ncl[0].map((x) => { const m = /^LEG(\d{1,2})$/.exec(String(x)); return m ? Number(m[1]) : null; }).filter((x) => x && x <= n).sort((a, b) => a - b);
      return Object.assign({ fehler: (nrn.length > 1 ? "legs " + nrn.join(" and ") : "two legs") + " cannot be combined at the book" }, nrn.length > 1 ? { bein: nrn[nrn.length - 1], dauerhaft: true } : {});
    }
    // die Auswahlen, wie das Buch sie fuehrt
    const outs = Array.isArray(d.outcomes) ? d.outcomes.filter(obj) : [];
    for (let i = 0; i < n; i++) {
      const M = cfgVon(legs[i].sport), o = outs.filter((x) => String(x.id) === beine[i].ref);
      if (o.length !== 1) return { fehler: "leg " + (i + 1) + ": the slip check of the book does not list the selection", bein: i + 1 };
      const x = o[0];
      if (String(x.eventRef) !== beine[i].eventId || String(x.marketRef) !== beine[i].markt || x.marketGroupCode !== M.gruppe || String(x.categoryRef) !== M.kat) return { fehler: "leg " + (i + 1) + ": the slip check of the book names another game or market", bein: i + 1 };
      if (x.isActive === false) return { fehler: "leg " + (i + 1) + ": the selection is suspended", bein: i + 1 };
      const mind = num(x.minAccumulator), hoechst = num(x.maxAccumulator);
      if (zahl(mind) && n < mind) return { fehler: "leg " + (i + 1) + ": this game needs a combo of at least " + mind + " legs", bein: i + 1, dauerhaft: true };
      if (zahl(hoechst) && n > hoechst) return { fehler: "leg " + (i + 1) + ": this game takes combos of at most " + hoechst + " legs", bein: i + 1 };
    }
    // die volle Kombi
    const bs = (Array.isArray(d.bets) ? d.bets.filter(obj) : []).filter((b) => b.betTypeRef === typ);
    if (!typ || bs.length !== 1) return { fehler: "the book does not offer the " + n + "-fold combo for these selections" };
    const b = bs[0], soll = beine.map((_, i) => beinNr(i));
    if (b.lines !== 1 || !Array.isArray(b.legRefs) || !gleicheMenge(b.legRefs.map(String), soll) || b.status !== "NOT_PLACED" || !/^BET\d{1,3}$/.test(String(b.documentId))) return { fehler: "the " + n + "-fold combo of the book is not a plain combo of exactly these legs" };
    const pp = Array.isArray(b.potentialPayout) ? b.potentialPayout.filter(obj) : [], mult = pp.filter((p) => p.type === "MULTIPLIER" && p.winPlaceOverrideRef === "WIN"), boni = pp.filter((p) => p.type === "WINNINGS_PERCENTAGE_MULTIPLIER");
    if (mult.length !== 1 || pp.length !== mult.length + boni.length || boni.length > 1) return { fehler: "payout of the combo not understood" };
    const quote = num(mult[0].value), eigen = beine.reduce((a, x) => a * x.preis, 1);
    if (!(zahl(quote) && quote > 1)) return { fehler: "total odds of the book not readable" };
    if (Math.abs(quote - eigen) > eigen * 1e-6) return { fehler: "total odds of the book (" + quote + ") are not the product of the legs (" + eigen.toFixed(4) + ") — not understood" };
    const lo = num(b.minimumStake), hi = num(b.maximumStake);
    const grenzen = zahl(lo) && zahl(hi) && lo >= 0 && hi >= lo ? { min: lo, max: hi } : null;
    // Kombi-Bonus des Buchs (nur gemeldet): Aufschlag auf den Gewinn, als Faktor auf den Einsatz
    const bf = boni.length ? num(boni[0].value) : NaN;
    const bonus = zahl(bf) && bf > 0 ? { faktor: bf, pct: Math.round(bf / (quote - 1) * 1000) / 10 } : null;
    return { quote, doc: String(b.documentId), typ, grenzen, bonus, roh: { maximumPayout: b.maximumPayout, minimumStake: b.minimumStake, maximumStake: b.maximumStake, wert: mult[0].value } };
  }
  // PURE: Anfrage an den Rechner des Buchs (Auszahlung nach Steuer) — nur die eine Kombi, ohne Bonus.
  function rechnerAnfrage(beine, bau, einsatz) {
    return { legs: beine.map((b, i) => ({ documentId: beinNr(i), outcomes: [{ outcomeRef: b.ref }] })), outcomes: beine.map((b) => ({ id: b.ref, marketRef: b.markt })),
      bets: [{ documentId: bau.doc, betTypeRef: bau.typ, lines: 1, legRefs: beine.map((_, i) => beinNr(i)), maximumPayout: bau.roh.maximumPayout, minimumStake: bau.roh.minimumStake, maximumStake: bau.roh.maximumStake,
        potentialPayout: [{ type: "MULTIPLIER", winPlaceOverrideRef: "WIN", value: bau.roh.wert }], stake: String(einsatz) }] };
  }
  // PURE: Antwort des Rechners. → { brutto, steuer, netto } | null (nicht verstanden)
  function rechnerAus(j, doc) {
    const bs = obj(j) && Array.isArray(j.bets) ? j.bets.filter((b) => obj(b) && b.documentId === doc) : [], p = bs.length === 1 ? obj(bs[0].potentialPayoutAmount) : null;
    if (!p) return null;
    const brutto = num(p.winnings), steuer = num(p.tax), netto = num(p.returns), bonus = p.bonus == null ? 0 : num(p.bonus);
    if (!(zahl(brutto) && brutto > 0 && zahl(steuer) && steuer >= 0 && zahl(netto) && netto > 0 && zahl(bonus)) || bonus !== 0 || Math.abs(brutto - steuer - netto) > 0.011) return null;
    return { brutto, steuer, netto };
  }
  // PURE: was der Schein auszahlt (ohne Bonus). srv = Zahlen des Rechners des Buchs (null: nicht erreichbar / nicht verstanden).
  // Nennt das Buch die Zahlen, gelten sie; weichen sie von der eigenen Rechnung ab, zaehlt die Rechnung mit der KLEINEREN
  // Auszahlung (ganz: Auszahlung, Steuer und netto aus EINER Quelle). → { brutto, steuer, netto, nettoQuote, geschaetzt, abweichung }
  function rechne(quote, einsatz, srv) {
    const eigenBrutto = auszahlung(quote, einsatz), eigenSteuer = steuerLeiter(eigenBrutto - einsatz), eigen = { brutto: eigenBrutto, steuer: eigenSteuer, netto: cent(eigenBrutto - eigenSteuer) };
    const abweichung = !!srv && (Math.abs(srv.netto - eigen.netto) > 0.011 || Math.abs(srv.brutto - eigen.brutto) > 0.011);
    const q = (!srv || (abweichung && eigen.netto < srv.netto)) ? eigen : srv;
    return { brutto: cent(q.brutto), steuer: cent(q.steuer), netto: cent(q.netto), nettoQuote: Math.round(cent(q.netto) / einsatz * 1e6) / 1e6, geschaetzt: !srv, abweichung };
  }
  // PURE: der Schein — die Beine der Auskunft und EINE Wette ueber alle (Form der mitgeschnittenen Einzelwetten).
  function baueSchein(beine, bau, einsatz) {
    return { legs: baueBeine(beine), bets: [{ documentId: bau.doc, betTypeRef: bau.typ, lines: 1, legRefs: beine.map((_, i) => beinNr(i)), options: { winPlaceOverride: "WIN", priceChangeBehaviour: "NONE" }, stake: einsatz, stakeType: "SPL" }] };
  }
  // PURE, ZWEITE PRUEFUNG unmittelbar vor dem Absenden: ist das GENAU die eine Kombi des Auftrags? null = ja, sonst der Grund.
  // soll: { einsatz, typ, doc, refs:[Auswahl-Nummern in der Reihenfolge der Beine], brueche:["n/d" …] }
  const SCHEIN_FELDER = ["legs", "bets"], BEIN_FELDER = ["documentId", "options", "outcomes"], OPT_FELDER = ["banker", "inMultiples", "handicaps", "prices", "winPlace"],
    PREIS_FELDER = ["priceTypeRef", "numerator", "denominator", "winPlaceRef"], WETTE_FELDER = ["documentId", "betTypeRef", "lines", "legRefs", "options", "stake", "stakeType"], WOPT_FELDER = ["winPlaceOverride", "priceChangeBehaviour"];
  function scheinFehler(k, soll) {
    if (!obj(k) || !soll || !Array.isArray(soll.refs) || !Array.isArray(soll.brueche)) return "no slip";
    if (!gleicheMenge(Object.keys(k), SCHEIN_FELDER)) return "the slip carries other fields than a plain combo";
    const n = soll.refs.length;
    if (!Array.isArray(k.legs) || k.legs.length < MIN || k.legs.length > MAX || k.legs.length !== n || soll.brueche.length !== n) return "the slip does not hold the ordered number of legs";
    const gesehen = new Set();
    for (let i = 0; i < n; i++) {
      const l = k.legs[i], o = obj(l) ? obj(l.options) : null;
      if (!obj(l) || !gleicheMenge(Object.keys(l), BEIN_FELDER) || l.documentId !== beinNr(i) || !o || !gleicheMenge(Object.keys(o), OPT_FELDER)) return "a leg of the slip is not a plain selection";
      if (o.banker !== false || o.inMultiples !== true || o.winPlace !== "WIN") return "a leg of the slip carries other options than a plain combo leg";
      const h = Array.isArray(o.handicaps) && o.handicaps.length === 1 ? obj(o.handicaps[0]) : null, p = Array.isArray(o.prices) && o.prices.length === 1 ? obj(o.prices[0]) : null, a = Array.isArray(l.outcomes) && l.outcomes.length === 1 ? obj(l.outcomes[0]) : null;
      if (!h || !p || !a || !gleicheMenge(Object.keys(h), ["outcomeRef"]) || !gleicheMenge(Object.keys(a), ["outcomeRef"]) || !gleicheMenge(Object.keys(p), PREIS_FELDER)) return "a leg of the slip is unreadable";
      const ref = a.outcomeRef;
      if (typeof ref !== "string" || !/^\d{4,14}$/.test(ref) || h.outcomeRef !== ref || ref !== soll.refs[i] || gesehen.has(ref)) return "the slip does not hold exactly the ordered selections";
      if (p.priceTypeRef !== "LP" || p.winPlaceRef !== "WIN" || !(Number.isSafeInteger(p.numerator) && p.numerator > 0 && Number.isSafeInteger(p.denominator) && p.denominator > 0) || p.numerator + "/" + p.denominator !== soll.brueche[i]) return "a leg of the slip carries other odds than the checked ones";
      gesehen.add(ref);
    }
    if (!Array.isArray(k.bets) || k.bets.length !== 1) return "the slip does not hold exactly one bet";
    const w = obj(k.bets[0]), wo = w ? obj(w.options) : null;
    if (!w || !gleicheMenge(Object.keys(w), WETTE_FELDER) || !wo || !gleicheMenge(Object.keys(wo), WOPT_FELDER)) return "the bet of the slip carries other fields than a plain combo (free bet, boost or offer)";
    if (w.betTypeRef !== typVon(n) || w.betTypeRef !== soll.typ || w.lines !== 1 || w.stakeType !== "SPL" || w.documentId !== soll.doc || !/^BET\d{1,3}$/.test(String(w.documentId))) return "the bet of the slip is not the plain " + n + "-fold combo";
    if (!Array.isArray(w.legRefs) || !gleicheFolge(w.legRefs, soll.refs.map((_, i) => beinNr(i)))) return "the bet of the slip does not cover exactly the legs";
    if (wo.winPlaceOverride !== "WIN" || wo.priceChangeBehaviour !== "NONE") return "the bet of the slip would accept changed odds";
    if (!(zahl(w.stake) && w.stake >= MIN_EINSATZ && w.stake <= MAX_EINSATZ) || Math.abs(w.stake - soll.einsatz) > 1e-9 || Math.abs(cent(w.stake) - w.stake) > 1e-9) return "the stake of the slip is not the ordered stake";
    return null;
  }
  // PURE: Wahrheitstabelle. Eingabe: die Rueckgabe von sende() bzw. des Schein-Abrufs (nachfrage; erwarteNr = die Nummer des
  // gelesenen Scheins) und was gesendet wurde (soll = { einsatz, quote, typ, refs }).
  // → status placed | failed | blocked | warten (ms, scheinNr) | unklar (endgueltig?)
  function klassifiziere(antwort, soll, nachfrage, erwarteNr) {
    const pruefen = " — POSSIBLY placed, check the bet history";
    if (!antwort || antwort.art === "gesperrt") return { status: "blocked", reason: BUCH + " combo: nothing sent — " + String((antwort && antwort.grund) || "the second check refused").slice(0, 160) };
    if (antwort.art === "netzfehler") return { status: "unklar", reason: BUCH + " combo: connection lost " + (nachfrage ? "while asking for the result" : "while sending") + " (" + String(antwort.fehler).slice(0, 80) + ")" + pruefen };
    if (antwort.art !== "antwort") return { status: "unklar", reason: BUCH + " combo: unknown answer" + pruefen };
    const s = Number(antwort.status) || 0, j = obj(antwort.json), f = fehlerAus(j), errs = j && Array.isArray(j.errors) ? j.errors.filter(obj) : [];
    // Nicht angemeldet / nicht durchgelassen: beim Absenden hat das Buch den Schein nicht verarbeitet; bei der Nachfrage sagt
    // es nichts ueber den Schein.
    if (s === 401 || s === 403 || errs.some((e) => e.type === "ACCESS_DENIED")) {
      if (nachfrage) return { status: "unklar", reason: BUCH + " combo: the result could not be read — the login has expired (answer " + s + ")" + pruefen };
      return { status: "failed", reason: "The book rejected the combo: " + (s === 403 && !j ? "the request was not let through (answer 403)" : "the login has expired — log in again at pamestoixima.gr") };
    }
    if (!j) return { status: "unklar", reason: BUCH + " combo: no readable answer of the book (answer " + s + ")" + pruefen };
    const d = obj(j.data), st = d && typeof d.status === "string" ? d.status : null, nr = d && /^\d{4,20}$/.test(String(d.id)) ? String(d.id) : null;
    // Nachfrage: die Antwort muss von DIESEM Schein handeln — ein anderer (oder keiner) sagt nichts ueber ihn.
    if (nachfrage && erwarteNr != null && d && nr !== String(erwarteNr)) return { status: "unklar", reason: BUCH + " combo: the book answered the question for slip " + String(erwarteNr).slice(0, 20) + " with another slip" + pruefen };
    if (st === "PLACED" || st === "REFERRAL_PLACED" || st === "PARTIALLY_PLACED") {
      const bs = Array.isArray(d.bets) ? d.bets.filter(obj) : [], b = bs.length === 1 ? bs[0] : null, pq = b && obj(b.potentialPrice) ? num(b.potentialPrice.decimal) : NaN;
      const kern = { ticket: nr, buchQuote: zahl(pq) && pq > 1 ? pq : null };
      if (!nr) return Object.assign({ status: "unklar", endgueltig: true, reason: "AUDIT: the book confirmed the combo without a slip number — check the bet history immediately" }, kern);
      // Die Auswahlen, die die Antwort nennt (NICHT GEMESSEN fuer eine Kombi: nennt sie keine, wird der Schein nachgelesen —
      // nennt sie ANDERE als gesendet, oder eine andere Wette, ist das ein Fall fuer sofortiges Nachsehen).
      const echo = Array.isArray(d.legs) && d.legs.length ? d.legs.filter(obj).map((l) => (Array.isArray(l.outcomes) && l.outcomes.length === 1 && obj(l.outcomes[0]) ? String(l.outcomes[0].outcomeRef) : "?")) : null;
      if (!b || b.betTypeRef !== soll.typ || (b.legRefs != null && (!Array.isArray(b.legRefs) || b.legRefs.length !== soll.refs.length)) || (echo && !gleicheMenge(echo, soll.refs)))
        return Object.assign({ status: "unklar", endgueltig: true, reason: "AUDIT: the answer of the book names another bet or other selections than the ones sent — check the bet history immediately" }, kern);
      if (!echo) return Object.assign({ status: "unklar", scheinNr: nr, reason: BUCH + " combo: the book confirmed the slip without listing the selections" + pruefen }, kern);
      // Der Schein gilt als angenommen, aber die Wette selbst steht (noch) nicht als gesetzt da: nachlesen.
      if (b.status !== "PLACED") return Object.assign({ status: "unklar", scheinNr: nr, reason: BUCH + " combo: the book reports the slip as " + st + " but the bet as " + String(b.status).slice(0, 24) + pruefen }, kern);
      const hinweise = [], einsatz = num(b.stake);
      if (st === "REFERRAL_PLACED") hinweise.push("accepted after a check by the traders of the book");
      if (st === "PARTIALLY_PLACED") hinweise.push("the book reports the slip as partially placed — the combo itself is placed");
      if (zahl(einsatz) && einsatz > 0 && Math.abs(einsatz - soll.einsatz) > 0.005) hinweise.push("the ticket names a stake of " + einsatz + " instead of " + soll.einsatz);
      const andereQuote = kern.buchQuote != null && Math.abs(kern.buchQuote - soll.quote) > Math.max(0.0101, soll.quote * 0.002);
      if (andereQuote) hinweise.push("the ticket names total odds of " + kern.buchQuote + " instead of " + (Math.round(soll.quote * 1e4) / 1e4));
      return Object.assign({ status: "placed" }, kern, zahl(einsatz) && einsatz > 0 ? { stake: einsatz } : {}, andereQuote ? { odds: kern.buchQuote } : {}, hinweise.length ? { note: hinweise.join("; ") } : {});
    }
    // Das Buch entscheidet noch (Verzug, Haendler) oder macht ein Gegenangebot: das Ergebnis steht spaeter am Schein.
    if (WARTE_STATUS.indexOf(st) >= 0) {
      if (!nr) return { status: "unklar", reason: BUCH + " combo: the book holds the slip (" + st + ") but gave no slip number" + pruefen };
      const pp = num(d.pollPeriod), ms = zahl(pp) && pp > 0 ? Math.min(pp * 1000, VERZUG_MAX_MS) + 200 : NACH_MS;
      const was = st === "REFERRAL_PROCESSED" ? "the book answered with a counter-offer (another stake or other odds) — it is NOT accepted from here and expires" : st === "REFERRAL_PENDING" ? "the book passed the slip to its traders" : "the book is still deciding";
      return { status: "warten", ms, scheinNr: nr, reason: BUCH + " combo: " + was + pruefen };
    }
    // Ausdrueckliche Absage: der Status des Buchs (FAILED, DECLINED, BUILD_ERROR) oder — NUR in der Antwort des Absendens — eine
    // Fehlerliste ohne Status; aber nur, wenn JEDER genannte Fehler von einer Art ist, die sicher vor der Annahme steht (eine
    // Stoerung zum Konto-System oder ein Zeitablauf dort sagt nicht, ob gebucht wurde: dann bleibt es offen). Bei einer
    // NACHFRAGE gilt eine Fehlerliste dem Lese-Abruf, nicht dem Schein („nicht gefunden“ heisst nicht „nicht gesetzt“).
    if (st === "FAILED" || st === "DECLINED" || st === "BUILD_ERROR" || (!st && errs.length && !nachfrage)) {
      const hart = errs.every((e) => ABSAGE_ARTEN.indexOf(e.type) >= 0 || e.id === "OFFER_TIMED_OUT");
      if (hart) return { status: "failed", reason: ("The book rejected the combo (" + (st || "answer " + s) + ")" + (f.text ? ": " + (f.bein ? "leg " + f.bein + " — " : "") + f.text : " without a reason")).slice(0, 260) };
      return Object.assign({ status: "unklar", reason: BUCH + " combo: the book reports " + (st || "an error") + (f.text ? " (" + f.text + ")" : "") + pruefen }, nr ? { scheinNr: nr } : {});
    }
    return { status: "unklar", reason: BUCH + " combo: no clear verdict of the book (answer " + s + (st ? ", " + st.slice(0, 30) : "") + ")" + pruefen };
  }
  // PURE: steht die Kombi unter den offenen Wetten des Kontos? j = Antwort der Liste, seit = Zeit des Absendens (ms).
  // → { gefunden:true, ticket } | { gefunden:false } | null (Liste nicht lesbar)
  function offeneAus(j, soll, seit) {
    if (!obj(j) || !Array.isArray(j.data)) return null;
    const passt = j.data.filter(obj).filter((b) => {
      if (b.betTypeRef !== soll.typ || b.status !== "PLACED" || !(Math.abs(num(b.stake) - soll.einsatz) <= 0.005)) return false;
      const t = typeof b.placedDate === "string" ? Date.parse(b.placedDate) : NaN;
      if (!(t >= seit - 120000)) return false;                                            // nur ein Schein von JETZT (kein aelterer gleicher)
      const refs = (Array.isArray(b.legs) ? b.legs.filter(obj) : []).map((l) => (Array.isArray(l.outcomes) && l.outcomes.length === 1 && obj(l.outcomes[0]) ? String(l.outcomes[0].outcomeRef) : "?"));
      return gleicheMenge(refs, soll.refs);
    });
    if (!passt.length) return { gefunden: false };
    return { gefunden: true, ticket: /^\d{4,20}$/.test(String(passt[0].id)) ? String(passt[0].id) : null, mehrere: passt.length > 1 };
  }

  // ---- Netz: genau ZWEI Abrufe im ganzen Baustein — frage (alles Lesende, feste Tabelle) und sende (der Schein) -------------
  // art → Verfahren, Adresse, Cookies. spiele: arg = Spiel-Nummern (Ziffern, Komma) · schein: arg = Schein-Nr. (Ziffern).
  const LESEN = {
    spiele: { m: "GET", cred: "include", kopf: OB, url: (a) => (/^\d{4,12}(,\d{4,12}){0,29}$/.test(String(a)) ? SPIELE + "?eventIds=" + a + "&marketGroupCodesIncluded=MATCH_RESULT&includeMarkets=true&includeTeams=true&limit=40" : null) },
    sitzung: { m: "GET", cred: "include", kopf: {}, url: () => SITZUNG },
    bau: { m: "POST", cred: "include", kopf: KOPF, url: () => BAU, mitZugang: true },
    rechner: { m: "POST", cred: "omit", kopf: KOPF, url: () => RECHNER },
    schein: { m: "GET", cred: "include", kopf: KOPF, url: (a) => (/^\d{4,20}$/.test(String(a)) ? SCHEIN + a : null), mitZugang: true },
    offene: { m: "GET", cred: "include", kopf: KOPF, url: () => OFFENE, mitZugang: true }
  };
  async function frage(art, arg, koerper, zugang) {
    const L = Object.prototype.hasOwnProperty.call(LESEN, art) ? LESEN[art] : null, url = L ? L.url(arg) : null;
    if (!L || !url || url === SETZEN) return { ok: false, grund: "address not allowed" };
    const kopf = Object.assign({}, L.kopf, L.mitZugang && zugangOk(zugang) ? { Authorization: "Bearer " + zugang } : {});
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), LESE_MS);
    try {
      const r = await fetch(url, Object.assign({ method: L.m, credentials: L.cred, cache: "no-store", headers: kopf, signal: ctl.signal }, L.m === "POST" ? { body: JSON.stringify(koerper) } : {}));
      let j = null; try { j = await r.json(); } catch (_) {}
      return { ok: r.ok, status: r.status, json: j, grund: r.ok ? null : "answer " + r.status };
    } catch (e) { return { ok: false, grund: text(e).slice(0, 80) }; }
    finally { clearTimeout(t); }
  }
  // Zugangs-Schluessel der Sitzung aus der Antwort von session/check (nicht angemeldet: HTTP 403 ohne Inhalt) → Text | null
  const zugangAus = (a) => (a && a.ok && obj(a.json) && zugangOk(a.json.access_token) ? a.json.access_token : null);
  // sende: DIE Absende-Funktion — der einzige Punkt ohne Wiederkehr. Davor die zweite Pruefung des fertigen Scheins.
  async function sende(schein, soll, zugang) {
    if (!zugangOk(zugang)) return { art: "gesperrt", grund: "no login" };
    const f = scheinFehler(schein, soll);
    if (f) return { art: "gesperrt", grund: f };
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), SENDE_MS);
    try {
      const r = await fetch(SETZEN, { method: "POST", credentials: "include", headers: Object.assign({}, KOPF, { Authorization: "Bearer " + zugang }), body: JSON.stringify(schein), signal: ctl.signal });
      let j = null; try { j = await r.json(); } catch (_) {}
      return { art: "antwort", status: r.status, json: j };
    } catch (e) { return { art: "netzfehler", fehler: text(e) }; }
    finally { clearTimeout(t); }
  }

  // ---- nach dem Absenden ---------------------------------------------------------------------------------------------------
  function fertig(z, o, env) {
    z.ms.gesamt = Math.round(jetztMs() - z.T0);
    const e = Object.assign(o, { legs: z.gelegt, ms: z.ms, tax: z.steuer, netOdds: z.netto, returns: z.auszahlung }, z.bonus ? { bonus: z.bonus } : {}, z.info ? { info: z.info } : {}, z.grenzen ? { limits: z.grenzen } : {});
    // Eine saubere Absage gibt denselben Schein fuer einen neuen Auftrag wieder frei; alles andere bleibt zehn Minuten gesperrt.
    if (e.status === "failed" || e.status === "blocked") geschickt.delete(z.schluessel);
    wartend.delete(z.id); merke(erledigt, z.id, e);
    try { if (env && env.emit) env.emit("Combo result", { status: e.status, odds: e.odds || null, ticket: e.ticket || null, reason: e.reason || null }); } catch (_) {}
    return e;
  }
  const quoteAus = (z) => Math.round(z.soll.quote * 1e6) / 1e6;
  const nochOffen = (z, ms) => ({ status: "pending", warteId: z.id, nachMs: ms, odds: quoteAus(z), ticket: z.ticket || undefined });
  // Urteil → Ergebnis oder „noch offen“. nachfrage: das Urteil stammt aus einem Abruf nach dem Absenden.
  function nachUrteil(z, u, env, nachfrage) {
    if (u.ticket) z.ticket = u.ticket;
    if (u.scheinNr) { z.scheinNr = u.scheinNr; if (!z.ticket) z.ticket = u.scheinNr; }
    if (u.reason) z.grund = u.reason;
    if (u.status === "blocked") return fertig(z, { status: "blocked", reason: u.reason }, env);
    if (u.status === "failed") return fertig(z, { status: "failed", reason: u.reason }, env);
    if (u.status === "placed") {
      const note = [u.note, nachfrage ? "confirmed by reading the slip back from the book" : null].filter(Boolean).join("; ");
      return fertig(z, Object.assign({ status: "placed", ticket: z.ticket, odds: u.odds || quoteAus(z), stake: u.stake || z.soll.einsatz }, u.buchQuote ? { bookOdds: u.buchQuote } : {}, nachfrage ? { verified: true } : {}, note ? { note } : {}), env);
    }
    if (u.endgueltig || z.nachfragen >= NACH_MAX) return fertig(z, { status: "uncertain", ticket: z.ticket || undefined, odds: quoteAus(z), reason: z.grund || (BUCH + " combo: no verdict of the book — POSSIBLY placed, check the bet history") }, env);
    return nochOffen(z, u.status === "warten" ? u.ms : (nachfrage ? NACH_MS : NACH_ERST_MS));
  }
  // EIN Schritt fuer einen abgegebenen Schein: erst das Urteil ueber die Antwort des Absendens (kein Abruf), danach je Aufruf
  // der Zugangs-Schluessel der Sitzung und EIN Lese-Abruf: der Schein selbst (Nummer bekannt) oder die offenen Wetten des Kontos.
  async function schritt(z, env) {
    const pruefen = " — POSSIBLY placed, check the bet history";
    if (!z.urteil) { z.urteil = klassifiziere(z.antwort, z.soll, false); return nachUrteil(z, z.urteil, env, false); }
    z.nachfragen++;
    const zugang = zugangAus(await frage("sitzung"));
    if (!zugang) return nachUrteil(z, { status: "unklar", reason: BUCH + " combo: the result could not be read — not logged in at pamestoixima.gr any more" + pruefen }, env, true);
    if (z.scheinNr) {
      const a = await frage("schein", z.scheinNr, null, zugang);
      return nachUrteil(z, klassifiziere(a.status ? { art: "antwort", status: a.status, json: a.json } : { art: "netzfehler", fehler: a.grund }, z.soll, true, z.scheinNr), env, true);
    }
    const a = await frage("offene", null, null, zugang), o = a.ok ? offeneAus(a.json, z.soll, z.start) : null;
    if (o && o.gefunden) return nachUrteil(z, { status: "placed", ticket: o.ticket || undefined, note: "found among the open bets of the account" + (o.ticket ? "" : " (without a readable number)") + (o.mehrere ? " — more than one matching bet, check the bet history" : "") }, env, true);
    return nachUrteil(z, { status: "unklar", reason: BUCH + " combo: " + (o ? "the answer of the book was unclear and the combo is not among the open bets of the account (check " + z.nachfragen + ")" : "the open bets of the account could not be read") + pruefen }, env, true);
  }
  // Laeuft fuer diesen Schein gerade ein Schritt (zweiter Empfaenger), gibt es dessen Ergebnis — kein zweiter Abruf.
  function nachfragen(warteId) {
    const id = String(warteId), z = wartend.get(id);
    if (!z) return Promise.resolve(erledigt.has(id) ? erledigt.get(id) : { status: "uncertain", reason: BUCH + " combo: the waiting slip is no longer known (page or extension reloaded?) — POSSIBLY placed, check the bet history" });
    if (z.lauf) return z.lauf;
    z.lauf = (async () => {
      try { return await schritt(z, z.env); }
      catch (e) { return fertig(z, { status: "uncertain", ticket: z.ticket || undefined, odds: quoteAus(z), reason: BUCH + " combo: " + text(e) + " — POSSIBLY placed, check the bet history" }, z.env); }
      finally { z.lauf = null; }
    })();
    return z.lauf;
  }

  // msg: { auftragId (Pflicht, 6–80 Zeichen — dieselbe Nummer wird nie zweimal ausgefuehrt), legs:[{ eventId, tip ("1"|"X"|"2" in
  //        der Reihenfolge des BUCHS), minOdds, team1, team2 (Mannschaften des Buchs: HOME, AWAY), outcomeId? (Auswahl-Nr. des
  //        Buchs aus dem Katalog — muss die sein, die das Buch jetzt fuer den Tipp fuehrt), sport? ("soccer") }], amount (€),
  //        minTotalOdds, armed (true = abgeben) }
  // env: { emit(text, daten) }
  // Antwort: { status: staged | pending | placed | failed | blocked | uncertain, odds (Gesamtquote des Buchs), netOdds (Auszahlung
  //            nach Steuer je € Einsatz), returns (Auszahlung vor Steuer), tax:{ total, back, toPay }, bonus?:{ legs, pct, extra,
  //            returns, claimed, auto }, limits?:{ min, max }, info?, legs:[…], ms, ticket?, bookOdds?, stake?, verified?, reason?,
  //            note?, bein?, dauerhaft?, warteId?, nachMs? }
  function place(msg, env) {
    const id = (msg && msg.auftragId != null) ? String(msg.auftragId) : "";
    if (!/^[A-Za-z0-9_.:-]{6,80}$/.test(id)) return Promise.resolve({ status: "blocked", reason: BUCH + " combo: order number missing — nothing sent", legs: [], ms: { gesamt: 0, lesen: null, bauen: null, abgeben: null } });
    if (auftraege.has(id)) return auftraege.get(id);
    const lauf = ausfuehren(msg, env || {});
    merke(auftraege, id, lauf);
    return lauf;
  }
  async function ausfuehren(msg, env) {
    const legs = msg && msg.legs, armed = !!(msg && msg.armed === true);
    const emit = (t, d) => { try { if (typeof env.emit === "function") env.emit(t, d); } catch (_) {} };
    const T0 = jetztMs(), ms = { gesamt: 0, lesen: null, bauen: null, abgeben: null };
    let gelegt = [];
    const mit = (o) => { ms.gesamt = Math.round(jetztMs() - T0); return Object.assign(o, { ms }); };
    const nein = (reason, mehr) => { emit("Combo aborted — nothing placed", { reason }); return mit(Object.assign({ status: "blocked", reason: BUCH + " combo: " + reason, legs: gelegt }, mehr || {})); };
    // Nur im Tab des Buchs: gelesen und gesetzt wird mit der Sitzung DIESER Seite.
    try { if (typeof location === "undefined" || !location || String(location.protocol) !== "https:" || String(location.hostname) !== SEITE) return nein("this tab is not " + SEITE); } catch (_) { return nein("this tab is not " + SEITE); }
    if (!Array.isArray(legs) || legs.length < MIN || legs.length > MAX) return nein("needs " + MIN + " to " + MAX + " legs");
    const spieleSet = new Set();
    for (const L of legs) {
      const M = L ? cfgVon(L.sport) : null;
      if (L && !M) return nein("sport " + String(L.sport) + " is not connected for combos");
      if (!L || !/^\d{4,12}$/.test(String(L.eventId)) || !Object.prototype.hasOwnProperty.call(M.sub, String(L.tip)) || !(Number(L.minOdds) > 1) || !sauber(L.team1) || !sauber(L.team2) || spieleSet.has(String(L.eventId))) return nein("invalid or duplicate leg");
      if (L.outcomeId != null && !/^\d{4,14}$/.test(String(L.outcomeId))) return nein("the selection number of a leg is unreadable");
      spieleSet.add(String(L.eventId));
    }
    const amount = cent(Number(msg.amount)), minTotal = Number(msg.minTotalOdds);
    if (!(amount >= MIN_EINSATZ) || amount > MAX_EINSATZ) return nein("stake " + String(msg.amount) + " outside " + MIN_EINSATZ + "–" + MAX_EINSATZ);
    if (!(minTotal > 1)) return nein("minimum total odds missing");
    if (laeuft) return nein("another combo is being built right now");
    // Verwaiste Warte-Eintraege (der Aufrufer fragt nicht mehr nach): der Ausgang bleibt „uncertain“.
    for (const [k, alt] of wartend) if (Date.now() - alt.start > WARTE_ALT_MS && !alt.lauf) { wartend.delete(k); merke(erledigt, k, { status: "uncertain", ticket: alt.ticket || undefined, odds: quoteAus(alt), legs: alt.gelegt, reason: BUCH + " combo: nobody asked for the result any more — POSSIBLY placed, check the bet history" }); }
    const schluessel = legs.map((L) => String(L.eventId) + ":" + String(L.tip)).sort().join("|");
    laeuft = true;
    let gesendet = false, z = null;
    try {
      // 1) nebeneinander: die frischen Spiele aller Beine und der Zugangs-Schluessel der Sitzung (ohne ihn nur ein Probe-Schein)
      const tl = jetztMs();
      const [a1, a0] = await Promise.all([frage("spiele", legs.map((L) => String(L.eventId)).join(",")), frage("sitzung")]);
      ms.lesen = Math.round(jetztMs() - tl);
      const zugang = zugangAus(a0);
      if (armed && !zugang) return nein("not logged in at pamestoixima.gr — log in in the pamestoixima tab");
      if (!a1.json) return nein("games of the book not readable (" + String(a1.grund || "no answer") + ")");
      const sp = spieleAus(a1.json, legs, Date.now());
      gelegt = sp.gelegt || [];
      if (sp.fehler) return nein(sp.fehler, sp.bein ? { bein: sp.bein } : {});
      // 2) die Schein-Auskunft des Buchs (mit der Sitzung, wenn es eine gibt)
      const tb = jetztMs();
      const a2 = await frage("bau", null, { legs: baueBeine(sp.beine) }, zugang);
      if (a2.status == null) { ms.bauen = Math.round(jetztMs() - tb); return nein("slip check of the book not reachable (" + String(a2.grund || "no answer") + ")"); }
      if ((a2.status === 401 || a2.status === 403) && !(obj(a2.json) && obj(a2.json.data))) { ms.bauen = Math.round(jetztMs() - tb); return nein(zugang ? "the login was not accepted by the slip check (answer " + a2.status + ") — log in again at pamestoixima.gr" : "the slip check of the book refused (answer " + a2.status + ")"); }
      const bau = bauAus(a2.status, a2.json, sp.beine, legs);
      if (bau.fehler) { ms.bauen = Math.round(jetztMs() - tb); return nein(bau.fehler, Object.assign({}, bau.bein ? { bein: bau.bein } : {}, bau.dauerhaft ? { dauerhaft: true } : {})); }
      // 3) Grenzen des Buchs fuer diese Kombi
      if (bau.grenzen && amount < bau.grenzen.min) { ms.bauen = Math.round(jetztMs() - tb); return nein("stake " + amount + " is below the book's minimum " + bau.grenzen.min + " for this slip", { limits: bau.grenzen }); }
      if (bau.grenzen && amount > bau.grenzen.max) { ms.bauen = Math.round(jetztMs() - tb); return nein("stake " + amount + " is above the book's maximum " + bau.grenzen.max + " for this slip", { limits: bau.grenzen }); }
      // 4) was der Schein auszahlt — nach Steuer, ohne Bonus: der Rechner des Buchs, sonst die eigene Leiter
      const a3 = await frage("rechner", null, rechnerAnfrage(sp.beine, bau, amount));
      ms.bauen = Math.round(jetztMs() - tb);
      const r = rechne(bau.quote, amount, a3.ok ? rechnerAus(a3.json, bau.doc) : null);
      const quote = Math.round(bau.quote * 1e6) / 1e6, netto = r.nettoQuote, steuerInfo = { total: r.steuer, back: 0, toPay: r.steuer };
      if (!(r.netto >= minTotal * amount - 1e-9)) return nein(r.steuer > 0 ? "after the winnings tax (" + r.steuer.toFixed(2) + " €" + (r.geschaetzt ? ", own calculation" : "") + ") the combo pays " + netto.toFixed(3) + " times the stake — below the min total odds " + minTotal.toFixed(2) : "total odds " + quote.toFixed(4) + " are below the min total odds " + minTotal.toFixed(2));
      let bonus = null;
      if (bau.bonus) { const extra = auszahlung(bau.bonus.faktor, amount); bonus = { legs: legs.length, pct: bau.bonus.pct, extra, returns: cent(r.brutto + extra), claimed: false, auto: true }; }
      const info = [armed ? null : (zugang ? "priced with the pamestoixima.gr login" : "priced WITHOUT a login (public figures)"),
        bau.grenzen ? "stake limits of the book for this slip " + bau.grenzen.min + "–" + bau.grenzen.max + " €" : null,
        r.steuer > 0 ? "winnings tax " + r.steuer.toFixed(2) + " € is deducted by the book → pays " + netto.toFixed(2) + "× the stake" + (r.geschaetzt ? " (own calculation — the tax calculator of the book did not answer)" : "") : null,
        bonus ? "acca boost +" + bonus.pct + " % on the winnings listed by the book (+" + bonus.extra.toFixed(2) + " € before tax) — not counted" : null,
        r.abweichung ? "the book's payout figures differ from the own calculation — the lower payout counts" : null].filter(Boolean).join(" · ") || null;
      emit("Combo built and priced", { legs: gelegt.length, totalOdds: quote, netOdds: netto, amount, taxToPay: r.steuer, bonusPct: bonus ? bonus.pct : null, armed, ms: Math.round(jetztMs() - T0) });
      // Sicherheits-Halt: nur abgeben, wenn ausdruecklich scharf. Es bleibt nirgends etwas stehen (die Auskunft merkt sich nichts).
      if (!armed) return mit(Object.assign({ status: "staged", slipLeft: false, odds: quote, netOdds: netto, legs: gelegt, returns: r.brutto, tax: steuerInfo, note: "Combo checked and priced by the pamestoixima slip check — NOT placed (armed=false). Nothing is left anywhere." }, bonus ? { bonus } : {}, bau.grenzen ? { limits: bau.grenzen } : {}, info ? { info } : {}));
      // 5) Doppel-Schutz: derselbe Schein ging aus diesem Tab eben schon raus
      const vor = geschickt.get(schluessel);
      if (vor != null && Date.now() - vor < DOPPEL_MS) return nein("the same slip was sent from this tab " + Math.round((Date.now() - vor) / 1000) + " s ago (double protection)");
      // 6) abgeben — EIN Auftrag an die Absende-Funktion
      const ta = jetztMs();
      const soll = { einsatz: amount, quote: bau.quote, typ: bau.typ, doc: bau.doc, refs: sp.beine.map((b) => b.ref), brueche: sp.beine.map((b) => b.n + "/" + b.d) };
      const schein = baueSchein(sp.beine, bau, amount);
      z = { id: "k" + (++warteNr) + "-" + Date.now().toString(36), soll, schluessel, start: Date.now(), T0, ms, gelegt, steuer: steuerInfo, netto, auszahlung: r.brutto, bonus, info, grenzen: bau.grenzen,
        antwort: null, urteil: null, ticket: null, scheinNr: null, grund: null, nachfragen: 0, lauf: null, env };
      merke(geschickt, schluessel, Date.now());
      gesendet = true;
      z.antwort = await sende(schein, soll, zugang);                        // PUNKT OHNE WIEDERKEHR
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
  self.PMKOMBI = { place, nachfragen, laeuft: () => laeuft, beschaeftigt, MARKT, _typVon: typVon, _auszahlung: auszahlung, _steuerLeiter: steuerLeiter, _beinAus: beinAus, _spieleAus: spieleAus, _baueBeine: baueBeine,
    _fehlerAus: fehlerAus, _bauAus: bauAus, _rechnerAnfrage: rechnerAnfrage, _rechnerAus: rechnerAus, _rechne: rechne, _baueSchein: baueSchein, _scheinFehler: scheinFehler, _klassifiziere: klassifiziere, _offeneAus: offeneAus };
})();
