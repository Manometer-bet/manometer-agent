// fonbet-kombi.js — KOMBIWETTE („Express“) bei Fonbet (fonbet001.com und fonbet.gr — dieselbe Plattform). 05.10.2026.
// Geteilt und BYTE-GLEICH: Erweiterung (fonbet-kombi.js — im Tab von fonbet001.com vor fonbet-content.js geladen UND im Service
// Worker eingebunden, wo der Auftrag fuer fonbet.gr laeuft — jeweils dort, wo auch die Einzelwette dieses Orts rausgeht) und Bet
// Engine der External Bettors (engine/content/fonbet-kombi.js, von books/fonbet.js eingebunden: die Engine setzt bei Fonbet aus
// ihrem Service Worker). Stellt FBKOMBI.place(msg, env) und FBKOMBI.nachfragen(warteId) bereit.
//
// Betreiber (05.10.2026): „lasse uns Stück für Stück die anderen Bookies anbinden, sodass man auch bei denen die Parlays setzen
// kann … Zuerst bei den GR-Bookies bitte den GR-Chrome nutzen zum Testen.“
//
// GELERNT (05.10., GR-Chrome ohne Anmeldung am Code der Seite fonbet.gr 2.10.99 und an der Schein-Auskunft beider Orte; dazu die
// Mitschnitte echter Einzelwetten vom Juli — es wurde nichts abgegeben):
//   * Ein Express ist DERSELBE Schein wie die Einzelwette, nur mit mehreren Wetten: coupon { amount, flexBet, flexParam, mirror,
//     bets:[{ num, event, factor, value, zone }] } (Seite: couponToPlace; „system“ traegt nur ein System-Schein, eine Aktion nur,
//     wer sie anfordert — beides geht hier NIE mit). Ablauf wie die Einzelwette: coupon/betRequestId (Nummer) → coupon/bet →
//     bei Verzug coupon/betResult mit derselben Nummer. Die Anmeldung steht im Koerper (fsid, clientId, deviceId), nicht in Cookies.
//   * SCHEIN-AUSKUNFT coupon/betSlipInfo prueft und bepreist den GANZEN Schein in EINEM Abruf (0,1–0,2 s, auch ohne Anmeldung):
//     je Wette das Ereignis (id, rootId, kind 1 = Spiel, sportId 1 Fussball / 3 Basketball, team1Id / team2Id, team1 / team2,
//     startTime, place "line" | "live" | "none") und der Faktor (id, v = Quote, blocked), dazu K = Gesamtquote. Angemeldet kommen
//     sums { min, max, maxWinForAmount } und bei fonbet.gr taxes { tax, refund, maxWinAfterTaxes } dazu.
//     FALLEN, alle gemessen: zwei Auswahlen desselben Spiels oder eine doppelte laesst das Buch STILL weg (die Antwort nennt je
//     Wette ihre Stelle im Auftrag: oldIndex) · ein unbekanntes Spiel kommt mit place "none", ein unbekannter Faktor mit v 0 — K
//     ist dann das Produkt der UEBRIGEN · ein gesperrter Faktor kommt mit blocked true und der Quote von VOR der Sperre (K rechnet
//     damit) · ein laufendes Spiel mit place "live".
//   * RECHNUNG (Bibliothek der Seite): Gesamtquote = Produkt der Quoten, auf zwei Stellen gerundet (genau ,5 zur geraden Ziffer);
//     Auszahlung = Einsatz × Gesamtquote auf Cent. 1,5 × 2,8 × 5,1 = 21,42 an beiden Orten nachgemessen.
//   * GEWINNSTEUER (nur fonbet.gr, je Schein auf den Gewinn: bis 100 € frei, 2,5 % bis 200 €, 5 % bis 500 €, darueber 7,5 %):
//     Fonbet traegt sie bis 200 € Gewinn selbst (fonbet.gr/pages/profit_taxation, Stand 26.06.2026: „covers the 100% of the
//     taxation for winnings up to 200€“ — nach eigenem Ermessen). Was ein Schein wirklich auszahlt, nennt das Buch angemeldet
//     selbst (taxes.maxWinAfterTaxes) — DAMIT wird gerechnet. Ohne diese Angabe (nicht angemeldet) rechnet der Baustein die
//     Leiter OHNE jede Erstattung (untere Grenze der Auszahlung) und sagt das dazu.
//     NICHT GEMESSEN: wie viel Fonbet ueber 200 € Gewinn noch traegt (kein Schein mit so hohem Gewinn mitgeschnitten).
//   * EXPRESS-BONUS (nur fonbet.gr, „progressive accumulator“): die Auskunft nennt ihn ab drei Wetten (promos: ProgK 1,05 →
//     K × 1,05). Er gilt nur, wenn der Schein ihn anfordert (bookmakerPromoId) — das tut dieser Baustein NICHT: der Schein hat
//     genau die Form der mitgeschnittenen Einzelwetten. Der Bonus wird nur GEMELDET (bonus, claimed false).
//   * ANTWORT des Setzens (Mitschnitte der Einzelwetten): { result:"couponResult", coupon:{ resultCode 0, regId, originalK,
//     amount, amountMin, amountMax, bets:[{ event, factor, value }] } } = gesetzt · resultCode ≠ 0 mit errorMessage(Eng) = Absage
//     (2 „Odds changed“, 100 „too frequent“) · { result:"betDelay", betDelay } = das Ergebnis kommt ueber coupon/betResult ·
//     { result:"error", errorCode 200 } = noch kein Ergebnis, 201 = dauerhaft unbekannt, 17 = Sitzung ungueltig.
//     NICHT GEMESSEN: die Annahme eines EXPRESS und dessen Antwort (es wurde keiner abgegeben).
// SICHERUNGEN (fail-closed): Auftrags-Nummer Pflicht (derselbe Auftrag laeuft nie zweimal); Ort und Adresse der Schnittstelle
//   stehen in einer festen Tabelle; je Bein aus der frischen Auskunft: das Buch hat es nicht weggelassen, dasselbe Spiel
//   (Mannschafts-Nummern des Buchs, sonst genau die Namen — gleiche Reihenfolge), ein Spiel (kein Kind-Ereignis) der richtigen
//   Sportart, vor dem Anpfiff, nicht gesperrt, genau der Faktor des Tipps, ohne Linie, Quote ≥ Mindestquote; Basketball: eine
//   Gegenprobe belegt, dass das Spiel KEIN Remis fuehrt (sonst waere 921 / 923 die regulaere Spielzeit = eine andere Wette);
//   der Schein als Ganzes: keine Einschraenkung, Gesamtquote des Buchs = Produkt der Beine, Einsatz in den Grenzen des Kontos;
//   Auszahlung nach Steuer ≥ Mindest-Gesamtquote × Einsatz. armed:false endet hier („staged“) — nirgends bleibt etwas stehen.
//   Scharf: nur mit Sitzung; derselbe Schein geht von hier nicht zweimal binnen zehn Minuten raus; unmittelbar vor dem Absenden
//   prueft scheinFehler den fertigen Auftrag noch einmal Feld fuer Feld. Abgeben: EIN Aufruf (sende), nie ein zweiter.
// WARTEN OHNE ZEITGEBER HIER: nach dem Absenden hoechstens ein Abruf je Aufruf; braucht es mehr (Verzug, unklare Antwort),
//   kommt { status:"pending", warteId, nachMs } — der Aufrufer wartet und ruft nachfragen (liest das Ergebnis zur Nummer DIESES
//   Scheins, sendet nie einen Schein).
// Die Sitzungswerte (fsid, clientId, deviceId) stehen nie in einer Rueckgabe, einer Meldung oder einem Fehlertext.
(() => {
  "use strict";
  if (self.FBKOMBI && typeof self.FBKOMBI.beschaeftigt === "function" && self.FBKOMBI.beschaeftigt()) return;
  const BUCH = "fonbet";
  // Die zwei Orte derselben Plattform. api = erlaubte Adressen der Konto-Schnittstelle (Spiegel-Nummer frei, Domain fest);
  // lang / scope wie die Seite des Orts; mitBetrag = die Auskunft nennt den Einsatz (nur wo es eine Gewinnsteuer gibt).
  const ORT = {
    com: { name: "fonbet001.com", seite: "https://fonbet001.com", api: /^https:\/\/clientsapi\d{2}\.fm41d5-resources\.com$/, lang: "de", scope: "3100", mitBetrag: false, steuer: false },
    gr: { name: "fonbet.gr", seite: "https://fonbet.gr", api: /^https:\/\/clientsapi\d{2}\.gr-resource\.com$/, lang: "en", scope: "1900", mitBetrag: true, steuer: true }
  };
  const AUSKUNFT = "/coupon/betSlipInfo";       // lesen: prueft und bepreist den ganzen Schein
  const NUMMER = "/coupon/betRequestId";        // Nummer fuer EINEN Schein (setzt nichts)
  const ERGEBNIS = "/coupon/betResult";         // lesen: Ergebnis zu einer Nummer
  const SETZEN = "/coupon/bet";                 // DER Punkt ohne Wiederkehr (nur in sende)
  const KOPF = { "Content-Type": "text/plain;charset=UTF-8" };
  const SYS = 21, ZONE = "es", ANNAHME = "up";  // sysId der Web-Seite · Zone und Quoten-Annahme wie die Einzelwette (hoehere Quote ja, niedrigere nein)
  // Sieger-Markt je Sportart: Sportart-Nr. des Buchs (Wurzel), Faktor je Tipp (Reihenfolge des Buchs: „1“ = team1), ohne = der
  // Faktor, den das Spiel NICHT fuehren darf (Basketball: 922 = Remis → 3-Weg regulaere Spielzeit, eine andere Wette).
  const MARKT = { soccer: { sportNr: 1, faktor: { "1": 921, "X": 922, "2": 923 }, ohne: null },
    basketball: { sportNr: 3, faktor: { "1": 921, "2": 923 }, ohne: 922 } };
  const FAKTOREN = [921, 922, 923];
  const MIN = 2, MAX = 12, MIN_EINSATZ = 0.1, MAX_EINSATZ = 1000;         // Sicherheitsgrenzen dieses Bausteins (EUR), nicht die des Buchs
  // Gewinnsteuer fonbet.gr: Stufen auf den Gewinn je Schein (bis, Satz)
  const GR_STUFEN = [{ bis: 100, satz: 0 }, { bis: 200, satz: 0.025 }, { bis: 500, satz: 0.05 }, { bis: Infinity, satz: 0.075 }];
  // Fehler-Nummern der Schnittstelle, die VOR der Annahme stehen (Sitzung, Captcha, Takt, Bestaetigungs-Code, Sperre, Rechenaufgabe):
  // mit ihnen hat das Buch den Schein nicht verarbeitet.
  const VOR_DER_ANNAHME = [17, 18, 19, 24, 26, 31, 36, 37];
  const LESE_MS = 6000, SENDE_MS = 30000, DOPPEL_MS = 10 * 60000;
  const NACH_MS = 1000, NACH_ERST_MS = 1200, NACH_MAX = 8, VERZUG_MAX_MS = 20000;
  const WARTE_ALT_MS = 5 * 60000, MERKEN_MAX = 40;
  const wartend = new Map(), auftraege = new Map(), erledigt = new Map(), geschickt = new Map();
  const merke = (m, k, v) => { m.set(k, v); while (m.size > MERKEN_MAX) m.delete(m.keys().next().value); };
  let warteNr = 0, laeuft = false;
  const jetztMs = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  const text = (e) => String((e && e.message) || e);
  const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : null);
  const zahl = (x) => typeof x === "number" && isFinite(x);
  const cent = (x) => Math.round(x * 100) / 100;
  const gleicheMenge = (a, b) => a.length === b.length && a.slice().sort().join("\n") === b.slice().sort().join("\n");
  const cfgVon = (sport) => { const k = String(sport == null || sport === "" ? "soccer" : sport); return Object.prototype.hasOwnProperty.call(MARKT, k) ? MARKT[k] : null; };
  const ortVon = (sitz) => { const k = sitz ? String(sitz.ort) : ""; return Object.prototype.hasOwnProperty.call(ORT, k) ? ORT[k] : null; };
  // Mannschafts-Nummer des Buchs aus dem Auftrag (Zahl oder Ziffern-Text) → Zahl | null
  const tnr = (x) => { const n = typeof x === "string" && /^\d{1,12}$/.test(x) ? Number(x) : x; return Number.isSafeInteger(n) && n > 0 ? n : null; };

  // ---- PURE: Rechnung wie die Seite -------------------------------------------------------------------------------------------
  // Runden wie die Seite (bankersRound): zur naechsten ganzen Zahl, genau ,5 zur GERADEN.
  function gerade(x) { const t = Math.round(x); return Math.abs(x) % 1 !== 0.5 || t % 2 === 0 ? t : t - 1; }
  // Gesamtquote (Seite: aggregateV) — Produkt der Quoten auf zwei Stellen
  function gesamtQuote(preise) { let n = 1; for (const p of preise) n *= p; return gerade(100 * n + 1e-6) / 100; }
  // Auszahlung eines gewonnenen Scheins (Seite: calcPossibleWin, Waehrung mit zwei Nachkommastellen) — Einsatz × Gesamtquote auf Cent
  function auszahlung(quote, einsatz) { return gerade(einsatz * quote / 0.01 + 0.001) / 100; }
  // Gewinnsteuer fonbet.gr nach der veroeffentlichten Leiter, auf den Gewinn je Schein (ohne Erstattung)
  function steuerLeiter(gewinn) {
    if (!(gewinn > 0)) return 0;
    let s = 0, von = 0;
    for (const st of GR_STUFEN) { if (gewinn > von) s += (Math.min(gewinn, st.bis) - von) * st.satz; von = st.bis; }
    return cent(s);
  }

  // ---- PURE: ein Bein aus der Schein-Auskunft -----------------------------------------------------------------------------------
  // b = die Wette aus der Antwort des Buchs, die an der Stelle dieses Beins steht (oldIndex) — undefined, wenn das Buch sie
  // weggelassen hat. L = das Bein des Auftrags (Tipp in der Reihenfolge des BUCHS; t1Id / t2Id = Mannschafts-Nummern des Buchs,
  // sonst zaehlen genau die Namen team1 / team2). → { fehler, preis? } | { preis, faktor, wette, namen }
  function beinAus(b, L, jetzt) {
    const M = cfgVon(L.sport);
    if (!M) return { fehler: "sport " + String(L.sport) + " is not connected for combos" };
    const faktor = Object.prototype.hasOwnProperty.call(M.faktor, String(L.tip)) ? M.faktor[String(L.tip)] : null;
    if (!faktor) return { fehler: "outcome " + String(L.tip) + " does not exist in the winner market" };
    if (b == null) return { fehler: "the book dropped this selection from the slip (it cannot be combined with another one of the slip)" };
    const ev = obj(b.event), f = obj(b.factor);
    if (!ev || !f) return { fehler: "the answer of the book is unreadable" };
    if (ev.place === "none") return { fehler: "the game is not offered (any more)" };
    if (String(ev.id) !== String(L.eventId)) return { fehler: "the book names another game (" + String(ev.id).slice(0, 16) + ")" };
    if (ev.kind !== 1 || String(ev.rootId) !== String(ev.id)) return { fehler: "this is not a match at the book (a part of a game or a special)" };
    if (Number(ev.sportId) !== M.sportNr) return { fehler: "the game is not listed as " + String(L.sport || "soccer") + " at the book" };
    const namen = String(ev.team1 == null ? "" : ev.team1).trim() + " – " + String(ev.team2 == null ? "" : ev.team2).trim();
    // Dasselbe Spiel in derselben Reihenfolge: die Mannschafts-Nummern des Buchs (gleich an beiden Orten, unabhaengig von der
    // Sprache), sonst genau die Namen.
    const n1 = tnr(L.t1Id), n2 = tnr(L.t2Id);
    if ((n1 && n2) ? (ev.team1Id !== n1 || ev.team2Id !== n2) : (String(ev.team1 == null ? "" : ev.team1).trim() !== String(L.team1).trim() || String(ev.team2 == null ? "" : ev.team2).trim() !== String(L.team2).trim()))
      return { fehler: "teams at the book (" + namen.slice(0, 80) + ") differ from the order" };
    if (ev.place !== "line") return { fehler: ev.place === "live" ? "the game is live — combos are pre-match only" : "the game is not offered pre-match" };
    if (!(Number(ev.startTime) * 1000 > jetzt)) return { fehler: "the game has started or its kick-off is unknown" };
    if (ev.betIncompatible === true) return { fehler: "this selection cannot be combined with another one of the slip" };
    if (Number(f.id) !== faktor) return { fehler: "the book answered with another selection (" + String(f.id).slice(0, 12) + ")" };
    if (f.blocked === true) return { fehler: "outcome " + L.tip + " is suspended" };
    const preis = f.v;
    if (preis === 0) return { fehler: "outcome " + L.tip + " is not offered" };
    if (!(zahl(preis) && preis > 1)) return { fehler: "odds not readable (" + String(preis).slice(0, 16) + ")" };
    if (f.p != null || f.pt != null) return { fehler: "the selection carries a line — not the winner market" };
    if (!(preis >= Number(L.minOdds))) return { fehler: String(preis) + " is below the min odds " + Number(L.minOdds), preis };
    return { preis, faktor, wette: { event: Number(ev.id), factor: faktor, value: preis }, namen };
  }
  // PURE: Absage / Fehler der Schnittstelle in Worten.
  function fehlerText(j) {
    const s = (x) => (typeof x === "string" && x.trim() ? x.replace(/\s+/g, " ").trim() : null);
    const teile = [j && j.errorCode != null ? "code " + String(j.errorCode).slice(0, 8) : null, s(j && j.errorMessageEng) || s(j && j.errorMessage) || s(j && j.errorDisplayMessage)].filter(Boolean);
    return (teile.length ? teile.join(": ") : "no reason given").slice(0, 200);
  }
  // PURE: die ganze Schein-Auskunft. → { fehler, bein?, dauerhaft? } | { K, preise, wetten, gelegt, grenzen, buchAuszahlung,
  // steuer, aktion }
  function auskunftAus(j, legs, jetzt) {
    if (!obj(j) || j.result !== "betSlipInfo" || !Array.isArray(j.bets)) {
      if (obj(j) && j.result === "error") return { fehler: Number(j.errorCode) === 17 ? "the Fonbet login has expired — log in again" : "the book refused the slip check (" + fehlerText(j) + ")" };
      return { fehler: "slip check of the book not readable" };
    }
    // Stelle im Auftrag → Wette der Antwort. Eine Stelle doppelt oder ausserhalb des Auftrags: nicht verstanden.
    const nachStelle = new Map();
    for (const b of j.bets) {
      const i = obj(b) ? b.oldIndex : null;
      if (!Number.isInteger(i) || i < 0 || i >= legs.length || nachStelle.has(i)) return { fehler: "slip check of the book not readable (positions of the selections)" };
      nachStelle.set(i, b);
    }
    const preise = [], wetten = [], gelegt = [];
    for (let i = 0; i < legs.length; i++) {
      const L = legs[i], x = beinAus(nachStelle.get(i), L, jetzt);
      if (x.fehler) return { fehler: "leg " + (i + 1) + ": " + x.fehler, bein: i + 1, gelegt };
      preise.push(x.preis); wetten.push(x.wette);
      gelegt.push({ eventId: String(L.eventId), tip: L.tip, outcomeId: String(x.faktor), odds: x.preis, minOdds: Number(L.minOdds), teams: x.namen, sport: String(L.sport || "soccer") });
    }
    // Der Schein als Ganzes
    if (j.restricted) {
      const i = Number.isInteger(j.restrictedBetIndex) && j.restrictedBetIndex >= 0 && j.restrictedBetIndex < legs.length ? j.restrictedBetIndex : null, was = typeof j.restrictionMessage === "string" ? j.restrictionMessage.replace(/\s+/g, " ").trim().slice(0, 160) : "";
      return Object.assign({ fehler: (i != null ? "leg " + (i + 1) + ": " : "") + "the book restricts this slip" + (was ? " (" + was + ")" : ""), gelegt }, i != null ? { bein: i + 1, dauerhaft: true } : {});
    }
    if (j.cantBet) return { fehler: "the book does not take this slip" + (typeof j.cantBetMessage === "string" && j.cantBetMessage.trim() ? " (" + j.cantBetMessage.replace(/\s+/g, " ").trim().slice(0, 160) + ")" : ""), gelegt };
    if (j.systemNumber != null) return { fehler: "the book answered with a system slip — not a plain combo", gelegt };
    const K = j.K, eigen = gesamtQuote(preise);
    if (!(zahl(K) && K > 1)) return { fehler: "total odds of the book not readable", gelegt };
    if (Math.abs(K - eigen) > 0.0101) return { fehler: "total odds of the book (" + K + ") are not the product of the legs (" + eigen.toFixed(2) + ") — not understood", gelegt };
    const s = obj(j.sums), t = obj(j.taxes);
    const grenzen = s && zahl(s.min) && zahl(s.max) && s.min >= 0 && s.max >= s.min ? { min: s.min, max: s.max } : null;
    const buchAuszahlung = s && zahl(s.maxWinForAmount) && s.maxWinForAmount > 0 ? s.maxWinForAmount : null;
    const steuer = t && zahl(t.tax) && zahl(t.refund) && zahl(t.maxWinAfterTaxes) && t.tax >= 0 && t.refund >= 0 ? { steuer: t.tax, erstattung: t.refund, netto: t.maxWinAfterTaxes } : null;
    // Express-Bonus des Buchs (nur gemeldet): die Aktion mit ProgK
    let aktion = null;
    for (const p of (Array.isArray(j.promos) ? j.promos : [])) {
      if (!obj(p) || !zahl(p.ProgK) || !(p.ProgK > 1) || !zahl(p.K) || !(p.K > K)) continue;
      const pt = obj(p.taxes);
      aktion = { faktor: p.ProgK, quote: p.K, netto: pt && zahl(pt.maxWinAfterTaxes) && pt.maxWinAfterTaxes > 0 ? pt.maxWinAfterTaxes : null };
      break;
    }
    return { K, preise, wetten, gelegt, grenzen, buchAuszahlung, steuer, aktion };
  }
  // PURE: Gegenprobe fuer Beine, deren Spiel einen Faktor NICHT fuehren darf (Basketball: 922). j = Auskunft zu genau diesen
  // Faktoren, probe = [{ nr (Bein-Nr.), eventId, ohne }]. Fuehrt das Spiel ihn nicht, nennt das Buch ihn mit Quote 0.
  function gegenprobeAus(j, probe) {
    if (!obj(j) || j.result !== "betSlipInfo" || !Array.isArray(j.bets)) return { fehler: "the market type of the book could not be checked" };
    for (let i = 0; i < probe.length; i++) {
      const P = probe[i], b = j.bets.find((x) => obj(x) && x.oldIndex === i), ev = b ? obj(b.event) : null, f = b ? obj(b.factor) : null;
      if (!ev || !f || String(ev.id) !== String(P.eventId) || Number(f.id) !== P.ohne || !zahl(f.v)) return { fehler: "leg " + P.nr + ": the market type of the book could not be checked", bein: P.nr };
      if (f.v !== 0) return { fehler: "leg " + P.nr + ": the winner market lists a draw (3-way, regular time) — a different bet", bein: P.nr, dauerhaft: true };
    }
    return {};
  }
  // PURE: was der Schein auszahlt. O = Ort, a = Ergebnis von auskunftAus. Wo das Buch die Zahlen selbst nennt, gelten sie.
  // → { ok, grund } | { ok, brutto, steuer, erstattung, abzug, netto, nettoQuote, geschaetzt, abweichung }
  function rechne(O, a, einsatz) {
    const eigen = auszahlung(a.K, einsatz), brutto = a.buchAuszahlung != null ? a.buchAuszahlung : eigen;
    if (!(zahl(brutto) && brutto > 0)) return { ok: false, grund: "slip not computable" };
    let steuer = 0, erstattung = 0, netto = brutto, geschaetzt = false;
    if (O.steuer) {
      if (a.steuer) {
        steuer = a.steuer.steuer; erstattung = a.steuer.erstattung; netto = a.steuer.netto;
        if (!(netto > 0) || netto > brutto + 0.011) return { ok: false, grund: "tax figures of the book not understood" };
      } else { steuer = steuerLeiter(brutto - einsatz); netto = cent(brutto - steuer); geschaetzt = true; }
    }
    return { ok: true, brutto: cent(brutto), steuer: cent(steuer), erstattung: cent(erstattung), abzug: cent(brutto - netto), netto: cent(netto), nettoQuote: Math.round(netto / einsatz * 1e6) / 1e6, geschaetzt, abweichung: Math.abs(brutto - eigen) > 0.011 };
  }
  // PURE: der Schein (Form der mitgeschnittenen Einzelwetten, je Spiel eine Wette) und der Auftrag an das Buch.
  function baueSchein(wetten, einsatz, O) {
    return { amount: einsatz, flexBet: ANNAHME, flexParam: false, mirror: O.seite, bets: wetten.map((w, i) => ({ num: i + 1, event: w.event, factor: w.factor, value: w.value, zone: ZONE })) };
  }
  function baueAuftrag(nummer, schein, O, sitz) { return { requestId: nummer, lang: O.lang, coupon: schein, fsid: sitz.fsid, sysId: SYS, clientId: sitz.clientId }; }
  // PURE, ZWEITE PRUEFUNG unmittelbar vor dem Absenden: ist das GENAU der eine Express des Auftrags? null = ja, sonst der Grund.
  // soll: { einsatz, ort, paare:["<Spiel>:<Faktor>"] }
  const AUFTRAG_FELDER = ["requestId", "lang", "coupon", "fsid", "sysId", "clientId"], SCHEIN_FELDER = ["amount", "flexBet", "flexParam", "mirror", "bets"], WETTE_FELDER = ["num", "event", "factor", "value", "zone"];
  function scheinFehler(k, soll) {
    if (!obj(k)) return "no slip";
    const O = soll ? ortVon({ ort: soll.ort }) : null;
    if (!O) return "place of the slip unknown";
    if (!gleicheMenge(Object.keys(k), AUFTRAG_FELDER)) return "the order carries other fields than a plain combo";
    if (!((Number.isSafeInteger(k.requestId) && k.requestId > 0) || (typeof k.requestId === "string" && /^\d{1,20}$/.test(k.requestId)))) return "number of the slip missing";
    if (k.lang !== O.lang || k.sysId !== SYS || typeof k.fsid !== "string" || !k.fsid || !(Number.isSafeInteger(k.clientId) && k.clientId > 0)) return "session fields of the order incomplete";
    const c = obj(k.coupon);
    if (!c || !gleicheMenge(Object.keys(c), SCHEIN_FELDER)) return "the slip carries other fields than a plain combo (system, bonus or promotion)";
    if (c.flexBet !== ANNAHME || c.flexParam !== false || c.mirror !== O.seite) return "the slip is not a plain combo of " + O.name;
    if (!(zahl(c.amount) && c.amount >= MIN_EINSATZ && c.amount <= MAX_EINSATZ) || Math.abs(c.amount - soll.einsatz) > 1e-9 || Math.abs(cent(c.amount) - c.amount) > 1e-9) return "the stake of the slip is not the ordered stake";
    if (!Array.isArray(c.bets) || c.bets.length < MIN || c.bets.length > MAX || c.bets.length !== soll.paare.length) return "the slip does not hold the ordered number of legs";
    const spiele = new Set(), paare = [];
    for (let i = 0; i < c.bets.length; i++) {
      const w = c.bets[i];
      if (!obj(w) || !gleicheMenge(Object.keys(w), WETTE_FELDER) || w.num !== i + 1 || w.zone !== ZONE) return "a leg of the slip is not a plain pre-match selection";
      if (!(Number.isSafeInteger(w.event) && w.event > 0) || spiele.has(w.event) || FAKTOREN.indexOf(w.factor) < 0) return "a leg of the slip is unreadable, doubled or not in the winner market";
      if (!(zahl(w.value) && w.value > 1)) return "a leg of the slip carries unreadable odds";
      spiele.add(w.event); paare.push(w.event + ":" + w.factor);
    }
    if (!gleicheMenge(paare, soll.paare)) return "the slip does not hold exactly the ordered selections";
    return null;
  }
  // PURE: Wahrheitstabelle. Eingabe: die Rueckgabe von sende() bzw. der Ergebnis-Abfrage (nachfrage) und was gesendet wurde
  // (soll = { einsatz, quote, ort, paare }). → status placed | failed | blocked | warten (ms) | unklar (endgueltig?)
  function klassifiziere(antwort, soll, nachfrage) {
    const pruefen = " — POSSIBLY placed, check the bet history";
    if (!antwort || antwort.art === "gesperrt") return { status: "blocked", reason: BUCH + " combo: nothing sent — " + String((antwort && antwort.grund) || "the second check refused").slice(0, 160) };
    if (antwort.art === "netzfehler") return { status: "unklar", reason: BUCH + " combo: connection lost " + (nachfrage ? "while asking for the result" : "while sending") + " (" + String(antwort.fehler).slice(0, 80) + ")" + pruefen };
    if (antwort.art !== "antwort") return { status: "unklar", reason: BUCH + " combo: unknown answer" + pruefen };
    const s = Number(antwort.status) || 0, j = obj(antwort.json);
    if (!j) return { status: "unklar", reason: BUCH + " combo: no readable answer of the book (answer " + s + ")" + pruefen };
    const c = j.result === "couponResult" ? obj(j.coupon) : null;
    if (c) {
      if (c.resultCode === 0) {
        const nr = c.regId != null && /^\d{4,20}$/.test(String(c.regId)) ? String(c.regId) : null;
        const kern = { ticket: nr, buchQuote: zahl(c.originalK) && c.originalK > 1 ? c.originalK : null };
        if (!nr) return Object.assign({ status: "unklar", endgueltig: true, reason: "AUDIT: the book confirmed the combo without a ticket number — check the bet history immediately" }, kern);
        const echo = Array.isArray(c.bets) ? c.bets : null;
        if (echo && !gleicheMenge(echo.map((w) => String(w && w.event) + ":" + String(w && w.factor)), soll.paare)) return Object.assign({ status: "unklar", endgueltig: true, reason: "AUDIT: the answer of the book names other selections than the ones sent — check the bet history immediately" }, kern);
        const hinweise = [], einsatz = Number(c.amount);
        if (!echo) hinweise.push("the book confirmed without listing the selections");
        if (isFinite(einsatz) && einsatz > 0 && Math.abs(einsatz - soll.einsatz) > 0.005) hinweise.push("the ticket names a stake of " + einsatz + " instead of " + soll.einsatz);
        const andereQuote = kern.buchQuote != null && Math.abs(kern.buchQuote - soll.quote) > 0.0101;
        if (andereQuote) hinweise.push("the ticket names total odds of " + kern.buchQuote + " instead of " + soll.quote.toFixed(2));
        return Object.assign({ status: "placed" }, kern, isFinite(einsatz) && einsatz > 0 ? { stake: einsatz } : {}, andereQuote ? { odds: kern.buchQuote } : {}, hinweise.length ? { note: hinweise.join("; ") } : {});
      }
      // Ausdrueckliche Absage (resultCode ≠ 0): sicher nicht gesetzt.
      if (zahl(c.resultCode)) {
        const s2 = (x) => (typeof x === "string" && x.trim() ? x.replace(/\s+/g, " ").trim() : null), was = s2(c.errorMessageEng) || s2(c.errorMessage) || s2(c.resultText);
        const grenzen = zahl(c.amountMin) && zahl(c.amountMax) && c.amountMin > 0 && c.amountMax > 0 ? " (stake limits of the book for this slip: " + c.amountMin + "–" + c.amountMax + ")" : "";
        return { status: "failed", reason: ("The book rejected the combo (code " + c.resultCode + ")" + (was ? ": " + was : " without a reason") + grenzen).slice(0, 260) };
      }
      return { status: "unklar", reason: BUCH + " combo: the answer of the book carries no result" + pruefen };
    }
    // Verzug: das Ergebnis kommt ueber die Ergebnis-Abfrage mit derselben Nummer
    if (j.result === "betDelay" && zahl(j.betDelay) && j.betDelay > 0) return { status: "warten", ms: Math.min(j.betDelay, VERZUG_MAX_MS) + 200, reason: BUCH + " combo: the book is still deciding" + pruefen };
    if (j.result === "error") {
      const nr = Number(j.errorCode);
      if (nr === 200) return { status: "warten", ms: NACH_MS, reason: BUCH + " combo: the book is still deciding" + pruefen };
      if (nr === 201) return { status: "unklar", endgueltig: true, reason: BUCH + " combo: the book does not know the result of this slip (code 201)" + pruefen };
      // Fehler vor der Annahme: beim Absenden eine klare Absage; bei der Ergebnis-Abfrage sagt er nichts ueber den Schein.
      if (!nachfrage && VOR_DER_ANNAHME.indexOf(nr) >= 0) return { status: "failed", reason: "The book rejected the combo: " + (nr === 17 ? "the login has expired — log in again" : fehlerText(j)) };
      return { status: "unklar", endgueltig: nachfrage && nr === 17, reason: BUCH + " combo: the book answered with an error (" + fehlerText(j) + ")" + pruefen };
    }
    return { status: "unklar", reason: BUCH + " combo: no clear verdict of the book (answer " + s + ")" + pruefen };
  }

  // ---- Netz: genau ZWEI Abrufe im ganzen Baustein — frage (Auskunft, Nummer, Ergebnis) und sende (der Schein) ----------------
  // Beide gehen an die Konto-Schnittstelle des Orts (Adresse in ausfuehren geprueft), ohne Cookies: die Anmeldung steht im Koerper.
  async function frage(sitz, pfad, koerper) {
    const O = ortVon(sitz);
    if (!O || !O.api.test(String(sitz.host)) || !(pfad === AUSKUNFT || pfad === NUMMER || pfad === ERGEBNIS)) return { ok: false, grund: "address not allowed" };
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), LESE_MS);
    try {
      const r = await fetch(sitz.host + pfad, { method: "POST", credentials: "omit", headers: KOPF, body: JSON.stringify(koerper), signal: ctl.signal });
      let j = null; try { j = await r.json(); } catch (_) {}
      return { ok: r.ok, status: r.status, json: j, grund: r.ok ? null : "answer " + r.status };
    } catch (e) { return { ok: false, grund: text(e).slice(0, 80) }; }
    finally { clearTimeout(t); }
  }
  // sende: DIE Absende-Funktion — der einzige Punkt ohne Wiederkehr. Davor die zweite Pruefung des fertigen Auftrags.
  async function sende(sitz, auftrag, soll) {
    const O = ortVon(sitz);
    if (!O || !O.api.test(String(sitz.host)) || !soll || soll.ort !== sitz.ort) return { art: "gesperrt", grund: "address of the Fonbet interface not allowed" };
    const f = scheinFehler(auftrag, soll);
    if (f) return { art: "gesperrt", grund: f };
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), SENDE_MS);
    try {
      const r = await fetch(sitz.host + SETZEN, { method: "POST", credentials: "omit", headers: KOPF, body: JSON.stringify(auftrag), signal: ctl.signal });
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
  const nochOffen = (z, ms) => ({ status: "pending", warteId: z.id, nachMs: ms, odds: z.soll.quote, ticket: z.ticket || undefined });
  // Urteil → Ergebnis oder „noch offen“. nachfrage: das Urteil stammt aus der Ergebnis-Abfrage.
  function nachUrteil(z, u, env, nachfrage) {
    if (u.ticket) z.ticket = u.ticket;
    if (u.reason) z.grund = u.reason;
    if (u.status === "blocked") return fertig(z, { status: "blocked", reason: u.reason }, env);
    if (u.status === "failed") return fertig(z, { status: "failed", reason: u.reason }, env);
    if (u.status === "placed") {
      const note = [u.note, nachfrage ? "confirmed by asking the book for the result of this slip" : null].filter(Boolean).join("; ");
      return fertig(z, Object.assign({ status: "placed", ticket: z.ticket, odds: u.odds || z.soll.quote, stake: u.stake || z.soll.einsatz }, u.buchQuote ? { bookOdds: u.buchQuote } : {}, nachfrage ? { verified: true } : {}, note ? { note } : {}), env);
    }
    if (u.endgueltig || z.nachfragen >= NACH_MAX) return fertig(z, { status: "uncertain", ticket: z.ticket || undefined, odds: z.soll.quote, reason: z.grund || (BUCH + " combo: no verdict of the book — POSSIBLY placed, check the bet history") }, env);
    return nochOffen(z, u.status === "warten" ? u.ms : (nachfrage ? NACH_MS : NACH_ERST_MS));
  }
  // EIN Schritt fuer einen abgegebenen Schein: erst das Urteil ueber die Antwort des Absendens (kein Abruf), danach je Aufruf
  // EINE Ergebnis-Abfrage zur Nummer dieses Scheins.
  async function schritt(z, env) {
    if (!z.urteil) { z.urteil = klassifiziere(z.antwort, z.soll, false); return nachUrteil(z, z.urteil, env, false); }
    z.nachfragen++;
    const S = z.sitz, a = await frage(S, ERGEBNIS, { lang: z.O.lang, requestId: z.nummer, fsid: S.fsid, sysId: SYS, clientId: S.clientId, CDI: S.clientId % 1001, deviceId: S.deviceId });
    return nachUrteil(z, klassifiziere(a.status ? { art: "antwort", status: a.status, json: a.json } : { art: "netzfehler", fehler: a.grund }, z.soll, true), env, true);
  }
  // Laeuft fuer diesen Schein gerade ein Schritt (zweiter Empfaenger), gibt es dessen Ergebnis — kein zweiter Abruf.
  function nachfragen(warteId) {
    const id = String(warteId), z = wartend.get(id);
    if (!z) return Promise.resolve(erledigt.has(id) ? erledigt.get(id) : { status: "uncertain", reason: BUCH + " combo: the waiting slip is no longer known (page or extension reloaded?) — POSSIBLY placed, check the bet history" });
    if (z.lauf) return z.lauf;
    z.lauf = (async () => {
      try { return await schritt(z, z.env); }
      catch (e) { return fertig(z, { status: "uncertain", ticket: z.ticket || undefined, odds: z.soll.quote, reason: BUCH + " combo: " + text(e) + " — POSSIBLY placed, check the bet history" }, z.env); }
      finally { z.lauf = null; }
    })();
    return z.lauf;
  }

  // msg: { auftragId (Pflicht, 6–80 Zeichen — dieselbe Nummer wird nie zweimal ausgefuehrt), legs:[{ eventId, tip ("1"|"X"|"2" in
  //        der Reihenfolge des BUCHS), minOdds, team1, team2 (Mannschaften des Buchs), t1Id?, t2Id? (deren Nummern beim Buch),
  //        sport? ("soccer" ohne Angabe · "basketball": 1|2) }], amount (€), minTotalOdds, armed (true = abgeben),
  //        sitz: { ort ("com" | "gr"), host (Konto-Schnittstelle des Orts), fsid?, clientId?, deviceId? } — ohne Sitzung nur ein
  //        Probe-Schein mit den oeffentlichen Zahlen }
  // env: { emit(text, daten) }
  // Antwort: { status: staged | pending | placed | failed | blocked | uncertain, odds (Gesamtquote des Buchs), netOdds (Auszahlung
  //            nach Steuer je € Einsatz), returns, tax:{ total, back, toPay }, bonus?:{ legs, pct, odds, extra, returns, claimed },
  //            limits?:{ min, max }, info?, legs:[…], ms, ticket?, bookOdds?, reason?, note?, bein?, dauerhaft?, warteId?, nachMs? }
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
    const T0 = jetztMs(), ms = { gesamt: 0, lesen: null, abgeben: null };
    let gelegt = [];
    const mit = (o) => { ms.gesamt = Math.round(jetztMs() - T0); return Object.assign(o, { ms }); };
    const nein = (reason, mehr) => { emit("Combo aborted — nothing placed", { reason }); return mit(Object.assign({ status: "blocked", reason: BUCH + " combo: " + reason, legs: gelegt }, mehr || {})); };
    const roh = obj(msg && msg.sitz), O = ortVon(roh);
    if (!O || typeof roh.host !== "string" || !O.api.test(roh.host)) return nein("place or address of the Fonbet interface unknown");
    // Im Tab eines Buchs laeuft nur der Auftrag DIESES Orts (der Service Worker hat keine Seite — dort gilt die Tabelle allein).
    try { if (typeof location !== "undefined" && location && /^https?:$/.test(String(location.protocol)) && String(location.hostname) !== O.name) return nein("this tab is not " + O.name); } catch (_) {}
    const wert = (x) => typeof x === "string" && /^[^\x00-\x20\x7f]{4,400}$/.test(x);                // Sitzungswert: Text ohne Leer- und Steuerzeichen
    const mitSitzung = wert(roh.fsid) && Number.isSafeInteger(roh.clientId) && roh.clientId > 0;
    const sitz = { ort: String(roh.ort), host: roh.host, fsid: mitSitzung ? roh.fsid : null, clientId: mitSitzung ? roh.clientId : null, deviceId: mitSitzung && wert(roh.deviceId) ? roh.deviceId : null };
    if (!Array.isArray(legs) || legs.length < MIN || legs.length > MAX) return nein("needs " + MIN + " to " + MAX + " legs");
    const spieleSet = new Set();
    for (const L of legs) {
      const M = L ? cfgVon(L.sport) : null;
      if (L && !M) return nein("sport " + String(L.sport) + " is not connected for combos");
      if (!L || !/^\d{4,12}$/.test(String(L.eventId)) || !Object.prototype.hasOwnProperty.call(M.faktor, String(L.tip)) || !(Number(L.minOdds) > 1) || !L.team1 || !L.team2 || spieleSet.has(String(L.eventId))) return nein("invalid or duplicate leg");
      // Nennt der Auftrag den Faktor des Buchs (outcomeId), muss es der des Tipps sein.
      if (L.outcomeId != null && String(L.outcomeId) !== String(M.faktor[String(L.tip)])) return nein("the selection number of a leg is not the one of its outcome");
      spieleSet.add(String(L.eventId));
    }
    const amount = cent(Number(msg.amount)), minTotal = Number(msg.minTotalOdds);
    if (!(amount >= MIN_EINSATZ) || amount > MAX_EINSATZ) return nein("stake " + String(msg.amount) + " outside " + MIN_EINSATZ + "–" + MAX_EINSATZ);
    if (!(minTotal > 1)) return nein("minimum total odds missing");
    if (armed && !(mitSitzung && sitz.deviceId)) return nein(mitSitzung ? "device number of the Fonbet session not seen yet — open a betslip at " + O.name + " once" : "no Fonbet session — log in at " + O.name);
    if (laeuft) return nein("another combo is being built right now");
    // Verwaiste Warte-Eintraege (der Aufrufer fragt nicht mehr nach): der Ausgang bleibt „uncertain“.
    for (const [k, alt] of wartend) if (Date.now() - alt.start > WARTE_ALT_MS && !alt.lauf) { wartend.delete(k); merke(erledigt, k, { status: "uncertain", ticket: alt.ticket || undefined, odds: alt.soll.quote, legs: alt.gelegt, reason: BUCH + " combo: nobody asked for the result any more — POSSIBLY placed, check the bet history" }); }
    const schluessel = sitz.ort + "|" + legs.map((L) => String(L.eventId) + ":" + String(L.tip)).sort().join("|");
    laeuft = true;
    let gesendet = false, z = null;
    try {
      const tl = jetztMs();
      // 1) nebeneinander: die Auskunft zum ganzen Schein (mit der Sitzung, wenn es eine gibt — dann nennt das Buch die Grenzen
      //    des Kontos und die Steuer) und, fuer Basketball-Beine, die Gegenprobe auf ein Remis (ohne Sitzung).
      const frageSchein = Object.assign({ lang: O.lang, bets: legs.map((L) => ({ eventId: Number(L.eventId), factorId: cfgVon(L.sport).faktor[String(L.tip)] })) }, O.mitBetrag ? { amount } : {}, { sysId: SYS, scopeMarketId: O.scope }, mitSitzung ? { fsid: sitz.fsid, clientId: sitz.clientId } : {});
      const probe = legs.map((L, i) => ({ nr: i + 1, eventId: String(L.eventId), ohne: cfgVon(L.sport).ohne })).filter((p) => p.ohne != null);
      const [a1, a2] = await Promise.all([frage(sitz, AUSKUNFT, frageSchein), probe.length ? frage(sitz, AUSKUNFT, { lang: O.lang, bets: probe.map((p) => ({ eventId: Number(p.eventId), factorId: p.ohne })), sysId: SYS, scopeMarketId: O.scope }) : null]);
      ms.lesen = Math.round(jetztMs() - tl);
      if (!a1.json) return nein("slip check of the book not readable (" + String(a1.grund || "no answer") + ")");
      const a = auskunftAus(a1.json, legs, Date.now());
      if (a.gelegt) gelegt = a.gelegt;
      if (a.fehler) return nein(a.fehler, Object.assign({}, a.bein ? { bein: a.bein } : {}, a.dauerhaft ? { dauerhaft: true } : {}));
      if (probe.length) {
        const g = a2 && a2.json ? gegenprobeAus(a2.json, probe) : { fehler: "the market type of the book could not be checked (" + String((a2 && a2.grund) || "no answer") + ")" };
        if (g.fehler) return nein(g.fehler, Object.assign({}, g.bein ? { bein: g.bein } : {}, g.dauerhaft ? { dauerhaft: true } : {}));
      }
      // 2) Grenzen des Kontos fuer diesen Schein (nur mit Sitzung bekannt)
      if (a.grenzen && amount < a.grenzen.min) return nein("stake " + amount + " is below the book's minimum " + a.grenzen.min + " for this slip", { limits: a.grenzen });
      if (a.grenzen && amount > a.grenzen.max) return nein("stake " + amount + " is above the book's maximum " + a.grenzen.max + " for this slip", { limits: a.grenzen });
      // 3) was der Schein auszahlt — nach Steuer, ohne Express-Bonus
      const r = rechne(O, a, amount);
      if (!r.ok) return nein(r.grund);
      const quote = a.K, netto = r.nettoQuote, steuerInfo = { total: r.steuer, back: r.erstattung, toPay: r.abzug };
      if (!(r.netto >= minTotal * amount - 1e-9)) return nein(r.abzug > 0 ? "after the winnings tax (" + r.abzug.toFixed(2) + " €" + (r.geschaetzt ? ", estimated without any refund" : "") + ") the combo pays " + netto.toFixed(2) + " times the stake — below the min total odds " + minTotal.toFixed(2) : "total odds " + quote.toFixed(2) + " are below the min total odds " + minTotal.toFixed(2));
      let bonus = null;
      if (a.aktion) { const mitBonus = auszahlung(a.aktion.quote, amount); bonus = { legs: legs.length, pct: Math.round((a.aktion.faktor - 1) * 1000) / 10, odds: a.aktion.quote, extra: cent(mitBonus - r.brutto), returns: mitBonus, claimed: false }; }
      const info = [armed ? null : (mitSitzung ? "priced with the " + O.name + " session" : "priced WITHOUT a Fonbet session (public figures)"),
        a.grenzen ? "stake limits of the book for this slip " + a.grenzen.min + "–" + a.grenzen.max + " €" : null,
        O.steuer ? (r.geschaetzt ? (r.steuer > 0 ? "winnings tax estimated " + r.steuer.toFixed(2) + " € (no refund assumed — the book names the real figure only when logged in)" : null) : (r.steuer > 0 ? (r.abzug > 0 ? "winnings tax " + r.steuer.toFixed(2) + " €, Fonbet carries " + r.erstattung.toFixed(2) + " € → pays " + netto.toFixed(2) + "× the stake" : "winnings tax " + r.steuer.toFixed(2) + " € carried by Fonbet") : null)) : null,
        bonus ? "express bonus +" + bonus.pct + " % available at the book (+" + bonus.extra.toFixed(2) + " €) — not claimed" : null,
        r.abweichung ? "the book's payout figure differs from stake × total odds" : null].filter(Boolean).join(" · ") || null;
      emit("Combo built and priced", { legs: gelegt.length, totalOdds: quote, netOdds: netto, amount, taxToPay: r.abzug, bonusPct: bonus ? bonus.pct : null, armed, ms: Math.round(jetztMs() - T0) });
      // Sicherheits-Halt: nur abgeben, wenn ausdruecklich scharf. Es bleibt nirgends etwas stehen (kein Schein in einer Seite).
      if (!armed) return mit(Object.assign({ status: "staged", slipLeft: false, odds: quote, netOdds: netto, legs: gelegt, returns: r.brutto, tax: steuerInfo, note: "Combo checked and priced by the Fonbet slip check — NOT placed (armed=false). Nothing is left anywhere." }, bonus ? { bonus } : {}, a.grenzen ? { limits: a.grenzen } : {}, info ? { info } : {}));
      // 4) Doppel-Schutz: derselbe Schein ging von hier eben schon raus
      const vor = geschickt.get(schluessel);
      if (vor != null && Date.now() - vor < DOPPEL_MS) return nein("the same slip was sent from here " + Math.round((Date.now() - vor) / 1000) + " s ago (double protection)");
      // 5) Nummer fuer diesen einen Schein (setzt nichts), dann abgeben — EIN Auftrag an die Absende-Funktion
      const ta = jetztMs();
      const n = await frage(sitz, NUMMER, { lang: O.lang, fsid: sitz.fsid, sysId: SYS, clientId: sitz.clientId, CDI: sitz.clientId % 1001, deviceId: sitz.deviceId });
      const nummer = n.json && n.json.requestId != null && ((Number.isSafeInteger(n.json.requestId) && n.json.requestId > 0) || (typeof n.json.requestId === "string" && /^\d{1,20}$/.test(n.json.requestId))) ? n.json.requestId : null;
      if (nummer == null) return nein(obj(n.json) && n.json.result === "error" ? (Number(n.json.errorCode) === 17 ? "the Fonbet login has expired — log in again at " + O.name : "the book gave no slip number (" + fehlerText(n.json) + ")") : "the book gave no slip number (" + String(n.grund || "unreadable answer") + ")");
      const soll = { einsatz: amount, quote, ort: sitz.ort, paare: a.wetten.map((w) => w.event + ":" + w.factor) };
      const auftrag = baueAuftrag(nummer, baueSchein(a.wetten, amount, O), O, sitz);
      z = { id: "k" + (++warteNr) + "-" + Date.now().toString(36), soll, schluessel, start: Date.now(), T0, ms, gelegt, steuer: steuerInfo, netto, auszahlung: r.brutto, bonus, info, grenzen: a.grenzen,
        sitz, O, nummer, antwort: null, urteil: null, ticket: null, grund: null, nachfragen: 0, lauf: null, env };
      merke(geschickt, schluessel, Date.now());
      gesendet = true;
      z.antwort = await sende(sitz, auftrag, soll);                         // PUNKT OHNE WIEDERKEHR
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
  self.FBKOMBI = { place, nachfragen, laeuft: () => laeuft, beschaeftigt, MARKT, ORTE: Object.keys(ORT), _gerade: gerade, _gesamtQuote: gesamtQuote, _auszahlung: auszahlung, _steuerLeiter: steuerLeiter, _beinAus: beinAus,
    _fehlerText: fehlerText, _auskunftAus: auskunftAus, _gegenprobeAus: gegenprobeAus, _rechne: rechne, _baueSchein: baueSchein, _baueAuftrag: baueAuftrag, _scheinFehler: scheinFehler, _klassifiziere: klassifiziere };
})();
