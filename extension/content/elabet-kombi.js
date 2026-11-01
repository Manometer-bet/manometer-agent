// elabet-kombi.js — KOMBIWETTE bei Elabet (elabet.gr, Plattform Altenar WSDK). 05.10.2026.
// Geteilt und BYTE-GLEICH: Erweiterung (elabet-kombi.js, vor elabet-content.js geladen) und Manometer Agent der External Bettors
// (engine/content/elabet-kombi.js, vor content/elabet-place.js eingespritzt). Stellt ELAKOMBI.place(msg, env) und
// ELAKOMBI.nachfragen(msg, env) bereit. Den Weg zum Buch gibt das Setz-Script (elabet-content.js) als env mit:
//   env.quoteAus(details, auswahl, jetzt)   dieselbe Pruefung der Spiel-Details wie bei der Einzelwette → Quote oder { fehler }
//   env.baueSchein(…)                       der Schein der Einzelwette — aus ihm stammen die Huelle (Adresse, Kopfzeilen) und jedes Bein
//   env.sende(schein)                       DIE Absende-Funktion des Buchs (einziger Punkt ohne Wiederkehr), davor geprueft
//   env.kontoZaehler(kopf, tz)              offene Wetten je Spiel (Anmelde-Probe, Doppel-Schutz, Abgleich)
//   env.wartendFragen / env.wartendLies / env.gegenangebotAblehnen   eine wartende Wette nachfragen; Gegenangebot ablehnen
//   env.gemeinsam(tz) / env.auftragsId()    gemeinsame Felder jedes Abrufs · Auftragskennung des Scheins
//   env.belegt / env.belegen / env.freigeben   Spiele, auf denen im selben Tab gerade ein Auftrag laeuft
//   env.emit(text, daten)                   Protokoll
// Die ANMELDUNG (15-Minuten-Schluessel der Seite) reicht der Aufrufer je Auftrag und je Nachfrage als msg.kopf mit — sie wird
// hier weder gespeichert noch ausgegeben.
//
// Betreiber (05.10.2026): „lasse uns Stück für Stück die anderen Bookies anbinden, sodass man auch bei denen die Parlays setzen
// kann … Zuerst bei den GR-Bookies bitte den GR-Chrome nutzen zum Testen.“
//
// GELERNT am Wett-Modul der Seite (05.10., GR-Chrome ohne Anmeldung — es wurde nichts abgegeben):
//   * Eine Kombi geht mit DEMSELBEN Abruf raus wie die Einzelwette (chunks/src-HpPaIext.js, fetch → placeBet): placeWidget mit
//     betType 1 (Single 0 · Multiple 1 · System 2 · Teaser 3), betMarkets = je Spiel EIN Eintrag mit einer Quote (getBetMarkets:
//     Po/Ta — dieselben Felder wie bei den beiden mitgelesenen Einzelwetten), stakes [Einsatz], eachWays [false].
//   * RECHNUNG des Scheins (calc.worker der Seite, exakte Dezimalrechnung): Quote je Bein auf oddsDecimals Stellen, Gesamtquote =
//     Produkt, auf multipleOddsDecimals Stellen (Elabet: 6, kaufmaennisch), Auszahlung = Gesamtquote × Einsatz, auf Cent
//     ABGESCHNITTEN (winningsPayout 0; an der mitgelesenen Einzelwette belegt: 5 × 1,4445 = 7,2225 → totalWin 7,22). Die
//     Rundungsarten gehen unveraendert an Big.round (0 = abschneiden, 1 = kaufmaennisch). Die Nachrechnung hier ist gegen den
//     Rechner der Seite geprueft: 40000 Zufalls-Scheine (auch mit Steuer und Bonus) ohne Abweichung.
//   * GEWINNSTEUER: steht in den Regeln des KONTOS (GetSystemParams, Feld taxes: Art 2 = auf die Auszahlung, 3 = auf den Gewinn,
//     fest oder als Leiter { bound, value }; ohne Anmeldung fuehrt GetDefaultSystemParams keine). Elabet nennt sie oeffentlich
//     (elabet.gr/en/winning-tax): je Schein auf den GEWINN — bis 100 € frei, dann 2,5 % / 5 % / 7,5 % ab 500 €. Sie wird hier
//     beim Bau des Scheins frisch gelesen; fuer die Mindest-Gesamtquote zaehlt die Auszahlung NACH Steuer.
//   * KOMBI-BONUS („Combo Megaboost“, WidgetBonus/GetMultipleBonuses): ab 3 Beinen mit Quote ≥ 1,5 ein Aufschlag auf den Gewinn
//     (3 → 3 %, 4 → 5 %, 5 → 8 % … 21+ → 100 %). Die Bedingungen der Aktion nennen dazu eine Liste von Ligen, die die Regeln der
//     Schnittstelle NICHT abbilden — ob das Buch ihn fuer ein Spiel wirklich gutschreibt, ist deshalb nicht sicher. Er wird
//     ausgerechnet und GEMELDET (bonus), zaehlt aber NICHT fuer die Mindest-Gesamtquote.
//   * Antwort des Setzens wie bei der Einzelwette: { bets:[{ id, type, status, totalStake, totalWin, totalOdds, createdDate,
//     selections:[{ id (= Quoten-Nr.), eventId, price … }] }] } oder { error:{ errorStringCode, changedOdds?, selectionIds?,
//     limit?, stakesFormatted? … } }. NICHT GEMESSEN: die Annahme einer Kombi (es wurde keine abgegeben). Ausgewertet wird
//     streng: GENAU EINE Wette, Art Kombi, mit GENAU den gesendeten Quoten-Nummern — sonst „uncertain“.
// SICHERUNGEN (fail-closed): Auftrags-Nummer Pflicht (derselbe Auftrag laeuft nie zweimal); scharf nur mit gueltiger Anmeldung und
//   lesbarem Konto, und nie, wenn auf JEDEM Spiel des Scheins schon eine offene Wette steht (derselbe Schein koennte schon liegen);
//   je Bein die frischen Spiel-Details durch dieselbe Pruefung wie bei der Einzelwette (Sportart, vor dem Anpfiff, echter
//   Sieger-Markt mit genau dessen Ausgaengen, die Quoten-Nr. haengt an der richtigen Mannschaft, offen), die Seite der Quote =
//   der Tipp des Auftrags, Quote ≥ Mindestquote; Grenzen des Buchs (Zahl der Beine, Mindesteinsatz, Mindestquoten); Auszahlung
//   nach Steuer ≥ Mindest-Gesamtquote × Einsatz. armed:false endet hier („staged“) — im Tab bleibt nichts stehen.
// WARTEN OHNE ZEITGEBER IN DER SEITE: nach dem Absenden hoechstens EIN Abgleich je Aufruf; braucht es mehr (Abgleich mit dem
//   Konto, wartende Wette), kommt { status:"pending", warteId, nachMs } — der Aufrufer (Service Worker) wartet und ruft nachfragen.
(() => {
  "use strict";
  if (self.ELAKOMBI && typeof self.ELAKOMBI.beschaeftigt === "function" && self.ELAKOMBI.beschaeftigt()) return;
  const BUCH = "elabet";
  // LESENDE Adressen des Wett-Moduls (window.WSDKOrigins der Seite, gelesen 05.10.2026). Die Setz-Adresse steht hier bewusst
  // NICHT: einen Schein sendet nur env.sende (elabet-content.js).
  const WEB = "https://sb2frontend-altenar2.biahosted.com/api/";
  const ANMELDUNG = "https://sb2auth-altenar2.biahosted.com/api/";
  const BONUS = "https://sb2bonus-gateway-p002.biahosted.com/api/";
  const HISTORIE = "https://sb2bethistory-gateway-altenar2.biahosted.com/api/";
  const A_DETAILS = WEB + "widget/GetEventDetails";                          // GET, oeffentlich
  const A_REGELN = ANMELDUNG + "WidgetAuth/GetSystemParams";                 // GET, Regeln des Kontos (Steuer, Rundung, Grenzen)
  const A_REGELN_OFFEN = ANMELDUNG + "WidgetAuth/GetDefaultSystemParams";    // GET, oeffentlich (ohne Steuer)
  const A_BONUS = BONUS + "WidgetBonus/GetMultipleBonuses";                  // POST, aendert nichts (die Seite fragt so)
  const A_WETTE = HISTORIE + "WidgetReports/WidgetGetBetDetails";            // POST, liest EINE Wette des Kontos
  const LESBAR = [A_DETAILS, A_REGELN, A_REGELN_OFFEN, A_BONUS, A_WETTE];
  // Tipp in der Reihenfolge des BUCHS → Seite der Quote, wie sie die Pruefung der Spiel-Details nennt (buchSel).
  const SEITEN = { soccer: { "1": "home", X: "draw", "2": "away" }, basketball: { "1": "home", "2": "away" } };
  const KOMBIWETTE = 1;                                                      // betType Multiple
  const WETTE_OFFEN = 0, WETTE_WARTET = [3, 9, 10, 17], WETTE_ABGELEHNT = [5, 6, 7], WETTE_AUFSICHT = 17;
  const MIN = 2, MAX = 12, MIN_EINSATZ = 0.5, MAX_EINSATZ = 1000;            // Sicherheitsgrenzen dieses Bausteins (EUR), nicht die des Buchs
  const KOPF_REST_MS = 20000;                                                // die Anmeldung muss noch mindestens so lange gelten
  const NACH_MS = 10000, NACH_AUFSICHT_MS = [500, 1000, 3000, 5000, 10000], NACH_ABLEHNEN_MS = 2000;   // Takt des Wett-Moduls beim Nachfragen
  const ABGLEICH_MS = 1200, ABGLEICH_MAX = 3, WARTE_MAX_MS = 60000, WARTE_ALT_MS = 5 * 60000, MERKEN_MAX = 40;
  const wartend = new Map(), auftraege = new Map(), erledigt = new Map();
  const merke = (m, k, v) => { m.set(k, v); while (m.size > MERKEN_MAX) m.delete(m.keys().next().value); };
  let warteNr = 0, laeuft = false;
  const jetztMs = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  const text = (e) => String((e && e.message) || e);
  const gleicheMenge = (a, b) => a.length === b.length && a.slice().sort().join(",") === b.slice().sort().join(",");
  const abfrage = (g) => Object.keys(g).map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(g[k])).join("&");
  const seitenVon = (sport) => { const k = String(sport == null || sport === "" ? "soccer" : sport); return Object.prototype.hasOwnProperty.call(SEITEN, k) ? SEITEN[k] : null; };

  // ---- exakte Dezimalzahlen wie Big.js des Rechners der Seite: { m: BigInt, s: Nachkommastellen } = m / 10^s -----------------
  function dez(x) {
    const t = typeof x === "number" ? (isFinite(x) ? String(x) : "") : String(x == null ? "" : x).trim();
    const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(t);
    if (!m) return null;
    let ziffern = m[2] + (m[3] || ""), s = (m[3] || "").length - (m[4] ? Number(m[4]) : 0);
    if (s < 0) { ziffern += "0".repeat(-s); s = 0; }
    if (s > 60 || ziffern.length > 120) return null;
    return { m: BigInt((m[1] || "") + ziffern), s };
  }
  const zehn = (n) => 10n ** BigInt(n);
  const gleich = (a, b) => { const s = Math.max(a.s, b.s); return [a.m * zehn(s - a.s), b.m * zehn(s - b.s), s]; };
  const plus = (a, b) => { const [x, y, s] = gleich(a, b); return { m: x + y, s }; };
  const minus = (a, b) => { const [x, y, s] = gleich(a, b); return { m: x - y, s }; };
  const mal = (a, b) => ({ m: a.m * b.m, s: a.s + b.s });
  const vergleich = (a, b) => { const [x, y] = gleich(a, b); return x < y ? -1 : x > y ? 1 : 0; };
  const durch100 = (a) => ({ m: a.m, s: a.s + 2 });
  // Runden wie Big.round(dp, rm): rm 0 = abschneiden (zur Null hin), rm 1 = kaufmaennisch (ab ,5 von der Null weg).
  function runde(a, dp, rm) {
    if (a.s <= dp) return a;
    const t = zehn(a.s - dp), neg = a.m < 0n, b = neg ? -a.m : a.m;
    let q = b / t;
    if (rm === 1 && (b % t) * 2n >= t) q += 1n;
    return { m: neg ? -q : q, s: dp };
  }
  function zahl(a) {
    const neg = a.m < 0n, z = (neg ? -a.m : a.m).toString().padStart(a.s + 1, "0");
    return Number((neg ? "-" : "") + z.slice(0, z.length - a.s) + (a.s ? "." + z.slice(z.length - a.s) : ""));
  }
  const NULL = { m: 0n, s: 0 }, EINS = { m: 1n, s: 0 };
  const ganz = (x, von, bis) => (Number.isInteger(x) && x >= von && x <= bis ? x : null);

  // ---- PURE: Regeln des Buchs ----------------------------------------------------------------------------------------------
  // Rechenregeln aus GetSystemParams / GetDefaultSystemParams. Vorgaben wie das Wett-Modul (onResponse): fehlende Stellen = 6.
  // Steuern: nur die fuer echte Spiele (isVirtual false). Eine Steuer auf den EINSATZ oder eine unbekannte Art wird nicht
  // verstanden → der Aufrufer setzt nicht.
  function regelnAus(j) {
    if (!j || typeof j !== "object" || Array.isArray(j)) return { ok: false, grund: "rules of the book not readable" };
    const qs = j.oddsDecimals == null ? 6 : ganz(j.oddsDecimals, 0, 8), ks = j.multipleOddsDecimals == null ? 6 : ganz(j.multipleOddsDecimals, 0, 8), gs = ganz(j.allowDecimals, 0, 4);
    const qa = ganz(j.oddsRounding, 0, 1), ka = ganz(j.multipleOddsRounding, 0, 1), ga = ganz(j.winningsPayout, 0, 1);
    if (qs == null || ks == null || gs == null || qa == null || ka == null || ga == null) return { ok: false, grund: "rounding rules of the book not understood" };
    const roh = j.taxes == null ? [] : (Array.isArray(j.taxes) ? j.taxes : null);
    if (roh === null) return { ok: false, grund: "tax rules of the book unreadable" };
    const steuern = [];
    for (const t of roh) {
      if (!t || typeof t !== "object") return { ok: false, grund: "tax rules of the book unreadable" };
      if (t.isVirtual === true) continue;                                    // gilt nur fuer virtuelle Spiele — die setzen wir nie
      if (t.isVirtual !== false) return { ok: false, grund: "tax rules of the book unreadable" };
      const typ = ganz(t.type, 0, 3);
      if (typ == null) return { ok: false, grund: "tax rule of the book not understood (type " + String(t.type) + ")" };
      if (typ === 0) continue;
      if (typ === 1) return { ok: false, grund: "tax rule of the book not understood (tax on the stake)" };
      const art = t.method == null ? 0 : ganz(t.method, 0, 1);
      if (art == null) return { ok: false, grund: "tax rule of the book not understood (rounding " + String(t.method) + ")" };
      let leiter = null;
      if (t.ladder) {
        if (!Array.isArray(t.ladder)) return { ok: false, grund: "tax brackets of the book unreadable" };
        leiter = [];
        for (const s of t.ladder) {
          const b = s && typeof s.bound === "number" && isFinite(s.bound) ? s.bound : null, w = s && typeof s.value === "number" && isFinite(s.value) ? s.value : null;
          if (b == null || w == null || w < 0 || w > 100 || (b < 0 && b !== -1)) return { ok: false, grund: "tax brackets of the book unreadable" };
          leiter.push({ bound: b, value: w });
        }
      } else if (!(typeof t.value === "number" && isFinite(t.value) && t.value >= 0 && t.value <= 100)) return { ok: false, grund: "tax rule of the book not understood (rate " + String(t.value) + ")" };
      if (steuern.some((x) => x.typ === typ)) return { ok: false, grund: "tax rules of the book ambiguous" };
      steuern.push({ typ, wert: typeof t.value === "number" ? t.value : 0, art, leiter });
    }
    return { ok: true, R: { quoteStellen: qs, quoteArt: qa, kombiStellen: ks, kombiArt: ka, geldStellen: gs, geldArt: ga, steuern } };
  }
  // Grenzen des Buchs fuer einen Kombi-Schein (dieselbe Antwort). Was fehlt oder unlesbar ist, bleibt null — dann entscheidet das Buch.
  function grenzenAus(j) {
    const pos = (x) => (typeof x === "number" && isFinite(x) && x > 0 ? x : null);
    const o = j && typeof j === "object" ? j : {};
    return { maxBeine: pos(o.maxSelectionCount), minBeine: pos(o.minSelectionsCount), minEinsatz: pos(o.minTotalStake), minQuoteBein: pos(o.minOddPerSelection), minGesamtQuote: pos(o.minTotalOddsPerBet) };
  }
  // PURE: Kombi-Bonus des Buchs (Antwort GetMultipleBonuses) → B oder null = keiner. Feld fuer Feld wie getMultipleBonusesForCalc.
  function bonusAus(j) {
    if (j == null) return { ok: true, B: null };
    if (typeof j !== "object" || Array.isArray(j)) return { ok: false, grund: "combo bonus of the book not readable" };
    const liste = (x) => (x == null ? [] : (Array.isArray(x) && x.every((v) => typeof v === "number" && isFinite(v)) ? x.slice() : null));
    const maerkte = liste(j.excludedMarketIds), sportTyp = liste(j.excludedSportIds), sportId = liste(j.excludedSports), ligen = liste(j.excludedChampIds);
    if (!maerkte || !sportTyp || !sportId || !ligen) return { ok: false, grund: "combo bonus of the book not readable" };
    const roh = j.bonuses == null ? [] : (Array.isArray(j.bonuses) ? j.bonuses : null);
    if (roh === null) return { ok: false, grund: "combo bonus of the book not readable" };
    const stufen = [];
    for (const s of roh) {
      const w = s ? Number(s.value) : NaN, von = s ? Number(s.lowBound) : NaN, bis = s ? Number(s.topBound) : NaN;
      if (!(w >= 1 && w <= 10) || !(von >= 0) || !(isFinite(bis) || s.topBound == null)) return { ok: false, grund: "combo bonus of the book not readable" };
      stufen.push({ wert: w, von, bis: bis || 255 });
    }
    const minPreis = j.minPrice ? Number(j.minPrice) : 0, maxExtra = j.maxExtraWinnings ? Number(j.maxExtraWinnings) : 0;
    if (!isFinite(minPreis) || !isFinite(maxExtra) || minPreis < 0 || maxExtra < 0) return { ok: false, grund: "combo bonus of the book not readable" };
    if (!stufen.length) return { ok: true, B: null };
    return { ok: true, B: { netto: !!j.netWins, minPreis, stufen, maerkte, sportTyp, sportId, ligen, maxExtra } };
  }
  // Steuer auf einen gewonnenen Schein wie calculateWinningTaxes des Rechners (ohne Einsatz-Steuer, ohne Bonus-Konto).
  function steuerAuf(R, auszahlung, einsatz) {
    const aufAlles = R.steuern.find((x) => x.typ === 2) || null, aufGewinn = R.steuern.find((x) => x.typ === 3) || null, a = aufAlles || aufGewinn;
    if (!a) return { betrag: NULL, satz: null, auf: null };
    const basis = aufGewinn ? minus(auszahlung, einsatz) : auszahlung;
    let roh;
    if (a.leiter) {
      roh = NULL;
      const stufen = a.leiter.filter((x) => x.bound !== -1).sort((x, y) => x.bound - y.bound), rest = a.leiter.find((x) => x.bound === -1);
      const alle = stufen.concat([{ value: rest ? rest.value : 0, bound: Number.MAX_SAFE_INTEGER }]);
      for (let i = 0; i < alle.length; i++) {
        const grenze = dez(alle[i].bound), satz = dez(alle[i].value), davor = i ? dez(alle[i - 1].bound) : NULL;
        if (!grenze || !satz || !davor) return null;
        if (vergleich(basis, grenze) < 0) { roh = plus(roh, durch100(mal(minus(basis, davor), satz))); break; }
        roh = plus(roh, durch100(mal(minus(grenze, davor), satz)));
      }
    } else {
      const satz = dez(a.wert / 100);                                       // wie der Rechner: erst als Gleitkommazahl geteilt
      if (!satz) return null;
      roh = mal(basis, satz);
    }
    return { betrag: runde(roh, 2, a.art === 1 ? 0 : 1), satz: a.wert, auf: aufGewinn ? "profit" : "return" };
  }
  // PURE: der Schein, wie ihn das Buch rechnet. beine: [{ preis, sportMarktId, sportTyp, sportId, ligaId }], einsatz in EUR.
  // B = null rechnet OHNE Kombi-Bonus. → { ok, quote (Gesamtquote des Buchs), auszahlungOhne, auszahlung, bonus, bonusFaktor,
  // bonusBeine, steuer, steuerAuf, netto (Auszahlung nach Steuer), einsatz, nettoQuote } | { ok:false, grund }
  function rechne(R, B, beine, einsatz) {
    const c = dez(einsatz);
    if (!c || c.m <= 0n) return { ok: false, grund: "stake not computable" };
    let produkt = EINS, zaehlen = 0;
    for (const b of beine) {
      const roh = dez(b.preis);
      if (!roh) return { ok: false, grund: "odds not computable" };
      const p = runde(roh, R.quoteStellen, R.quoteArt), pz = zahl(p);
      if (!(pz > 1)) return { ok: false, grund: "odds not computable" };
      produkt = mal(produkt, p);
      if (B && pz >= B.minPreis && B.maerkte.indexOf(Number(b.sportMarktId)) < 0 && B.sportTyp.indexOf(Number(b.sportTyp)) < 0 && B.ligen.indexOf(Number(b.ligaId)) < 0 && B.sportId.indexOf(Number(b.sportId)) < 0) zaehlen++;
    }
    const T = runde(produkt, R.kombiStellen, R.kombiArt);
    const ohne = runde(mal(T, c), R.geldStellen, R.geldArt);
    let faktor = 0;
    if (B) for (const s of B.stufen) if (zaehlen >= s.von && zaehlen <= s.bis) { faktor = s.wert; break; }
    let mit = ohne;
    if (faktor) {
      const f = dez(faktor);
      if (!f) return { ok: false, grund: "combo bonus not computable" };
      let x = mal(T, f);
      if (B.netto) x = minus(x, minus(f, EINS));
      mit = runde(mal(x, c), R.geldStellen, R.geldArt);
      if (B.maxExtra) { const deckel = dez(B.maxExtra); if (!deckel) return { ok: false, grund: "combo bonus not computable" }; if (vergleich(minus(mit, ohne), deckel) > 0) mit = plus(ohne, deckel); }
    }
    const D = runde(c, R.geldStellen || 2, 0);
    const st = steuerAuf(R, mit, D);
    if (!st) return { ok: false, grund: "tax not computable" };
    const netto = minus(mit, st.betrag), nz = zahl(netto), ez = zahl(D);
    return { ok: true, quote: zahl(T), produkt: zahl(produkt), auszahlungOhne: zahl(ohne), auszahlung: zahl(mit), bonus: zahl(minus(mit, ohne)), bonusFaktor: faktor, bonusBeine: zaehlen,
      steuer: zahl(st.betrag), steuerSatz: st.satz, steuerAuf: st.auf, netto: nz, einsatz: ez, nettoQuote: ez > 0 ? nz / ez : 0 };
  }

  // PURE: der Kombi-Schein aus den Einzel-Scheinen der Beine (env.baueSchein — Feld fuer Feld wie die mitgelesenen Einzelwetten):
  // Huelle (Adresse, Kopfzeilen) und gemeinsame Felder des ersten, Art Kombi, je Spiel dessen EIN Eintrag, EIN Einsatz.
  function baueSchein(einzel, einsatz) {
    return Object.assign({}, einzel[0], { body: Object.assign({}, einzel[0].body, { betType: KOMBIWETTE, stakes: [Number(einsatz)], betMarkets: einzel.map((s) => s.body.betMarkets[0]), eachWays: [false] }) });
  }
  // PURE: Absage des Buchs in Worten. e = error der Antwort; soll.ids = gesendete Quoten-Nummern (Reihenfolge der Beine).
  function fehlerText(e, soll) {
    if (!e || typeof e !== "object") return String(e == null ? "no reason given" : e).slice(0, 120);
    const code = String(e.errorStringCode || e.message || e.errorCode || "no reason given").slice(0, 80), teile = [];
    const bein = (id) => { const i = soll.ids.indexOf(String(id)); return i >= 0 ? i + 1 : null; };
    const nr = (x) => (typeof x === "number" && isFinite(x) ? x : null);
    for (const c of (Array.isArray(e.changedOdds) ? e.changedOdds : []).slice(0, 12)) { const b = c ? bein(c.selectionId) : null; if (b && nr(c.price) != null) teile.push("leg " + b + " now " + c.price); }
    const beine = (Array.isArray(e.selectionIds) ? e.selectionIds : []).map(bein).filter((b) => b != null);
    if (beine.length) teile.push("leg " + beine.slice(0, 12).join(", "));
    if (nr(e.limit) != null) teile.push("limit " + e.limit);
    const st = (Array.isArray(e.stakesFormatted) ? e.stakesFormatted : []).map((x) => (x && typeof x === "object" ? nr(x.value) : nr(x))).filter((x) => x != null);
    if (st.length) teile.push("the book would take a stake of " + st.slice(0, 3).join(" / "));
    if (nr(e.totalPotWin) != null) teile.push("payout capped at " + e.totalPotWin);
    return code + (teile.length ? " (" + teile.join("; ") + ")" : "");
  }
  // PURE: Wahrheitstabelle. Eingabe: die Rueckgabe von env.sende() und was gesendet wurde (soll = { ids:[Quoten-Nrn.], quote }).
  function klassifiziere(antwort, soll) {
    const pruefen = " — POSSIBLY placed, check the bet history";
    if (!antwort || antwort.art === "gesperrt") return { status: "blocked", reason: BUCH + " combo: nothing sent — " + String((antwort && antwort.grund) || "the placement script refused").slice(0, 160) };
    if (antwort.art === "netzfehler") return { status: "uncertain", reason: BUCH + " combo: connection lost while sending (" + String(antwort.fehler).slice(0, 80) + ")" + pruefen };
    if (antwort.art !== "antwort") return { status: "uncertain", reason: BUCH + " combo: unknown answer" + pruefen };
    const s = Number(antwort.status) || 0, j = antwort.json;
    if (s === 0 || s >= 500) return { status: "uncertain", reason: BUCH + " combo: server error " + s + " after sending" + pruefen };
    if (s === 401 || s === 403) return { status: "failed", reason: "The book rejected the combo: login not accepted (answer " + s + ") — log in again at elabet.gr" };
    const liste = j && Array.isArray(j.bets) ? j.bets : [];
    if (liste.length) {
      // Angenommen oder wartend: GENAU EINE Wette, Art Kombi, mit GENAU den gesendeten Quoten-Nummern. Alles andere ist kein sauberes Urteil.
      const w = liste.length === 1 ? liste[0] : null;
      if (!w || w.id == null) return { status: "uncertain", reason: liste.length > 1 ? "AUDIT: the book answers with " + liste.length + " bets for one combo — check the bet history immediately" : BUCH + " combo: answer without a readable bet number" + pruefen };
      const kern = { ticket: String(w.id), betId: w.id, odds: Number(w.totalOdds) > 1 ? Number(w.totalOdds) : soll.quote, stake: Number(w.totalStake) > 0 ? Number(w.totalStake) : undefined,
        erstellt: typeof w.createdDate === "string" ? w.createdDate : null, buchAuszahlung: Number(w.totalWin) > 0 ? Number(w.totalWin) : null };
      if (Number(w.type) !== KOMBIWETTE) return Object.assign({ status: "uncertain", reason: "AUDIT: the book booked bet type " + String(w.type) + " instead of a combo — check the bet history immediately" }, kern);
      if (!gleicheMenge((Array.isArray(w.selections) ? w.selections : []).map((x) => String(x && x.id)), soll.ids)) return Object.assign({ status: "uncertain", reason: "AUDIT: the answer of the book names other selections than the ones sent — check the bet history immediately" }, kern);
      const st = Number(w.status);
      if (st === WETTE_OFFEN) return Object.assign({ status: "placed" }, kern);
      if (WETTE_ABGELEHNT.indexOf(st) >= 0) return Object.assign({ status: "failed", reason: "The book rejected the combo (bet status " + st + ")" }, kern);
      if (WETTE_WARTET.indexOf(st) >= 0) return Object.assign({ status: "uncertain", wartet: true, stand: st, reason: BUCH + " combo: the bet is waiting at the book (bet status " + st + ") — check the bet history" }, kern);
      return Object.assign({ status: "uncertain", reason: BUCH + " combo: unknown bet status " + String(w.status).slice(0, 24) + " — check the bet history" }, kern);
    }
    if (j && j.error) return { status: "failed", reason: "The book rejected the combo: " + fehlerText(j.error, soll) };
    if (s >= 400) return { status: "failed", reason: "The book rejected the combo (answer " + s + ")" };
    return { status: "uncertain", reason: BUCH + " combo: no clear verdict of the book (answer " + s + ")" + pruefen };
  }

  // ---- Lesen (nur die Adressen aus LESBAR; ohne Cookies) -----------------------------------------------------------------
  async function lies(url, kopf, koerper, ms) {
    if (!LESBAR.some((a) => url === a || url.indexOf(a + "?") === 0)) return { ok: false, grund: "address not allowed" };
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms || 6000);
    try {
      const kopfzeilen = {};
      if (kopf && kopf.Authorization) kopfzeilen.Authorization = kopf.Authorization;
      if (koerper) kopfzeilen["Content-Type"] = "application/json";
      const r = await fetch(url, { method: koerper ? "POST" : "GET", headers: kopfzeilen, body: koerper ? JSON.stringify(koerper) : undefined, credentials: "omit", cache: "no-store", signal: ctl.signal });
      if (r.status === 401 || r.status === 403) return { ok: false, status: r.status, grund: "not logged in (answer " + r.status + ")" };
      if (!r.ok) return { ok: false, status: r.status, grund: "answer " + r.status };
      let j = null; try { j = await r.json(); } catch (_) {}
      return { ok: true, json: j };
    } catch (e) { return { ok: false, grund: text(e).slice(0, 80) }; }
    finally { clearTimeout(t); }
  }
  // Regeln des Buchs: mit Anmeldung die des Kontos (dort steht die Steuer), sonst die oeffentlichen.
  async function regelnLesen(env, kopf, tz) {
    const a = await lies((kopf ? A_REGELN : A_REGELN_OFFEN) + "?" + abfrage(env.gemeinsam(tz)), kopf, null, 6000);
    if (!a.ok) return { ok: false, grund: "rules of the book not readable (" + a.grund + ")" };
    if (!a.json || typeof a.json !== "object" || a.json.error) return { ok: false, grund: "rules of the book not readable" };
    const r = regelnAus(a.json);
    return r.ok ? { ok: true, R: r.R, G: grenzenAus(a.json) } : r;
  }
  // Kombi-Bonus des Buchs. Nicht lesbar ist kein Hindernis — er zaehlt ohnehin nicht fuer die Mindest-Gesamtquote.
  async function bonusLesen(env, kopf, tz) {
    const a = await lies(A_BONUS, kopf, env.gemeinsam(tz), 6000);
    if (!a.ok) return { ok: false, grund: a.grund };
    return bonusAus(a.json);
  }
  // Frische Spiel-Details EINES Beins (oeffentlich) durch die Pruefung der Einzelwette.
  async function beinLesen(env, L, tz) {
    const a = await lies(A_DETAILS + "?" + abfrage(env.gemeinsam(tz)) + "&eventId=" + encodeURIComponent(L.eventId) + "&showNonBoosts=false", null, null, 8000);
    if (!a.ok) return { fehler: "game not readable (" + a.grund + ")" };
    const det = a.json, auswahl = { eventId: String(L.eventId), outcomeId: String(L.outcomeId), sport: String(L.sport == null || L.sport === "" ? "soccer" : L.sport), live: false };
    let q; try { q = env.quoteAus(det, auswahl, Date.now()); } catch (e) { q = { fehler: text(e) }; }
    if (!q || q.fehler) return { fehler: String((q && q.fehler) || "no fresh odds") };
    // Kennungen fuer den Kombi-Bonus (Sportart, Liga, Markt-Sorte) aus denselben Details
    const markt = (Array.isArray(det.markets) ? det.markets : []).find((m) => m && String(m.id) === String(q.markt.id)) || {};
    return { q, auswahl, kennung: { sportMarktId: markt.sportMarketId, sportTyp: det.sport ? det.sport.typeId : null, sportId: det.sport ? det.sport.id : null, ligaId: det.champ ? det.champ.id : null } };
  }
  // Steht dieser Schein im Konto? true / false, null = nicht lesbar. Erst die Wette selbst (Wett-Nr.), sonst der Zaehler: auf
  // JEDEM Spiel des Scheins stehen jetzt mehr offene Wetten als vor dem Senden.
  async function imKonto(z, env, kopf) {
    if (z.betId != null) {
      const a = await lies(A_WETTE, kopf, Object.assign(env.gemeinsam(z.tz), { id: z.betId }, z.erstellt ? { createdDate: z.erstellt } : {}), 8000);
      const w = a.ok && a.json && a.json.bet && typeof a.json.bet === "object" ? a.json.bet : null;
      if (w && String(w.id) === String(z.ticket) && gleicheMenge((Array.isArray(w.selections) ? w.selections : []).map((x) => String(x && x.id)), z.soll.ids) && Number(w.status) === WETTE_OFFEN) return true;
    }
    let k; try { k = await env.kontoZaehler(kopf, z.tz); } catch (_) { return null; }
    if (!k || !k.ok) return null;
    return z.spiele.every((s) => (Number(k.jeSpiel[s]) || 0) > (z.vorher[s] || 0));
  }

  // ---- nach dem Absenden ---------------------------------------------------------------------------------------------------
  function fertig(z, o, env) {
    z.ms.gesamt = Math.round(jetztMs() - z.T0);
    const e = Object.assign(o, { legs: z.gelegt, ms: z.ms, tax: z.steuer, netOdds: z.netto, returns: z.auszahlung }, z.bonus ? { bonus: z.bonus } : {}, z.info ? { info: z.info } : {});
    if (z.buchAuszahlung != null && (e.status === "placed" || e.status === "uncertain")) e.bookReturns = z.buchAuszahlung;
    wartend.delete(z.id); merke(erledigt, z.id, e);
    try { if (env && env.freigeben) env.freigeben(z.spiele); } catch (_) {}
    try { if (env && env.emit) env.emit("Combo result", { status: e.status, odds: e.odds || null, ticket: e.ticket || null, bookReturns: e.bookReturns != null ? e.bookReturns : null, reason: e.reason || null }); } catch (_) {}
    return e;
  }
  const nochOffen = (z, ms) => ({ status: "pending", warteId: z.id, nachMs: ms, odds: z.soll.quote, ticket: z.ticket || undefined });
  const kopfAus = (msg) => (msg && msg.kopf && msg.kopf.Authorization && Number(msg.kopfExp) > Date.now() ? { Authorization: msg.kopf.Authorization } : null);
  // EIN Schritt fuer einen abgegebenen Schein — hoechstens ein Abruf an das Buch je Aufruf (zwei, wenn ein Gegenangebot abzulehnen ist).
  async function schritt(z, env, kopf) {
    if (!z.urteil) {
      z.urteil = klassifiziere(z.antwort, z.soll);
      const u0 = z.urteil;
      if (u0.ticket != null) { z.ticket = u0.ticket; z.betId = u0.betId; z.erstellt = u0.erstellt; z.buchAuszahlung = u0.buchAuszahlung; }
      if (u0.status === "blocked" || u0.status === "failed") return fertig(z, { status: u0.status, reason: u0.reason, ticket: u0.ticket }, env);
      if (u0.wartet) { z.wartet = true; z.erst = u0.stand; return nochOffen(z, 250); }
    }
    const u = z.urteil;
    if (z.wartet) {
      // Das Buch laesst die Wette warten (Pruefung, Aufsicht): gefragt wird nach genau dieser Wett-Nr.
      let l;
      if (kopf) { try { l = env.wartendLies(await env.wartendFragen(z.betId, kopf, z.tz), z.betId); } catch (e) { l = { weiter: true, lesbar: false, grund: text(e) }; } }
      else l = { weiter: true, lesbar: false, grund: "no valid login" };
      z.fragen++; z.verlauf.push(l.lesbar ? (isFinite(l.stand) ? l.stand : l.standRoh) : "?");
      const wie = " (after " + Math.round((Date.now() - z.start) / 1000) + " s, " + z.fragen + " follow-ups, bet status " + [z.erst].concat(z.verlauf).join(">") + ")";
      if (l.ende === "placed") {
        // Nach einer Ablehnung des Gegenangebots darf die Wette nicht offen sein — sagt das Buch es doch, entscheidet das Konto.
        if (z.abgelehnt) return fertig(z, { status: "uncertain", ticket: z.ticket, odds: l.quote || z.soll.quote, reason: BUCH + " combo: counter-offer declined (" + z.angebot + "), yet the book lists the bet as open — check the bet history" + wie }, env);
        return fertig(z, { status: "placed", ticket: z.ticket, odds: l.quote || u.odds, stake: l.einsatz || u.stake || z.einsatz, verified: true, note: "accepted by the book after waiting" + wie }, env);
      }
      if (l.ende === "failed") return fertig(z, { status: "failed", ticket: z.ticket, reason: (z.abgelehnt ? "Counter-offer of the book not accepted (" + z.angebot + ")" : "The book rejected the combo after waiting (bet status " + l.stand + ")") + wie }, env);
      if (l.ende) return fertig(z, { status: "uncertain", ticket: z.ticket, odds: z.soll.quote, stake: z.einsatz, reason: BUCH + " combo: unknown bet status " + String(l.standRoh) + " — check the bet history" + wie }, env);
      let nachMs = NACH_MS;
      if (l.gegenangebot) {
        // Gegenangebot (Einsatz gekuerzt / Quote geaendert): nie annehmen — ablehnen (hoechstens zweimal) und weiter fragen.
        z.angebot = (l.einsatz ? "stake cut to " + Number(l.einsatz).toFixed(2) : "bet changed") + (l.preise && l.preise.length ? ", odds " + l.preise.join(" / ") : "");
        if (z.abgelehnt < 2 && kopf) { z.abgelehnt++; try { await env.gegenangebotAblehnen(z.betId, kopf, z.tz); } catch (_) {} }
        nachMs = NACH_ABLEHNEN_MS;
      } else if (l.lesbar && l.stand === WETTE_AUFSICHT) nachMs = NACH_AUFSICHT_MS[Math.min(z.stufe++, NACH_AUFSICHT_MS.length - 1)];
      else if (z.abgelehnt) nachMs = NACH_ABLEHNEN_MS;
      if (Date.now() - z.start >= WARTE_MAX_MS) return fertig(z, { status: "uncertain", ticket: z.ticket, odds: z.soll.quote, stake: z.einsatz, reason: BUCH + " combo: " + (z.abgelehnt ? "counter-offer declined (" + z.angebot + "), the confirmation of the book is missing" : l.lesbar ? "the bet is still waiting at the book" : "state of the bet not readable (" + String(l.grund || "no answer").slice(0, 60) + ")") + " — check the bet history" + wie }, env);
      return nochOffen(z, nachMs);
    }
    // Abgleich mit dem Konto
    z.abgleiche++;
    let da = null;
    if (kopf) { try { da = await imKonto(z, env, kopf); } catch (_) { da = null; } }
    if (u.status === "placed") {
      if (da === true || z.abgleiche >= ABGLEICH_MAX) return fertig(z, Object.assign({ status: "placed", ticket: u.ticket, odds: u.odds, stake: u.stake != null ? u.stake : z.einsatz, verified: da === true }, da === true ? {} : { note: "bet number given by the book, not (yet) confirmed by reading the account" }), env);
      return nochOffen(z, ABGLEICH_MS);
    }
    // uncertain: steht der Schein im Konto, ist er gesetzt — sonst bleibt der Ausgang offen.
    if (da === true) return fertig(z, { status: "placed", ticket: z.ticket || null, odds: u.odds || z.soll.quote, stake: u.stake || z.einsatz, verified: true, note: "confirmed by reading the account (the answer of the book was unclear)" }, env);
    if (z.abgleiche < ABGLEICH_MAX) return nochOffen(z, ABGLEICH_MS);
    return fertig(z, { status: "uncertain", ticket: z.ticket || undefined, odds: u.odds || z.soll.quote, reason: u.reason }, env);
  }
  // msg: { warteId, kopf, kopfExp }. Laeuft fuer diesen Schein gerade ein Schritt, gibt es dessen Ergebnis — kein zweiter Abruf.
  function nachfragen(msg, env) {
    const id = String(msg && msg.warteId), z = wartend.get(id);
    if (!z) return Promise.resolve(erledigt.has(id) ? erledigt.get(id) : { status: "uncertain", reason: BUCH + " combo: the waiting slip is no longer known (page reloaded?) — POSSIBLY placed, check the bet history" });
    if (z.lauf) return z.lauf;
    z.lauf = (async () => {
      try { return await schritt(z, env || z.env, kopfAus(msg)); }
      catch (e) { return fertig(z, { status: "uncertain", ticket: z.ticket || undefined, odds: z.soll.quote, reason: BUCH + " combo: " + text(e) + " — POSSIBLY placed, check the bet history" }, env || z.env); }
      finally { z.lauf = null; }
    })();
    return z.lauf;
  }

  // msg: { auftragId (Pflicht, 6–80 Zeichen — dieselbe Nummer wird nie zweimal ausgefuehrt), legs:[{ eventId, outcomeId (Quoten-Nr.
  //        des Buchs), tip ("1"|"X"|"2" in der Reihenfolge des BUCHS), minOdds, sport? ("soccer" ohne Angabe · "basketball": 1|2) }],
  //        amount (€), minTotalOdds, armed (true = abgeben), kopf { Authorization }, kopfExp (ms) }
  // Antwort: { status: staged | pending | placed | failed | blocked | uncertain, odds (Gesamtquote), netOdds (Auszahlung nach
  //            Steuer je € Einsatz, OHNE Kombi-Bonus), returns, tax:{ total, back, toPay }, bonus?:{ legs, pct, extra, returns, tax,
  //            netOdds }, info?, legs:[…], ms, ticket?, bookReturns?, reason?, note?, bein?, warteId?, nachMs? }
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
    for (const f of ["quoteAus", "baueSchein", "sende", "kontoZaehler", "wartendFragen", "wartendLies", "gegenangebotAblehnen", "gemeinsam", "auftragsId"]) if (typeof env[f] !== "function") return nein("placement script incomplete");
    if (!Array.isArray(legs) || legs.length < MIN || legs.length > MAX) return nein("needs " + MIN + " to " + MAX + " legs");
    const spieleSet = new Set(), nummern = new Set();
    for (const L of legs) {
      const S = L ? seitenVon(L.sport) : null;
      if (L && !S) return nein("sport " + String(L.sport) + " is not connected for combos");
      if (!L || !/^\d{1,15}$/.test(String(L.eventId)) || !/^\d{1,15}$/.test(String(L.outcomeId)) || !Object.prototype.hasOwnProperty.call(S, String(L.tip)) || !(Number(L.minOdds) > 1) || spieleSet.has(String(L.eventId)) || nummern.has(String(L.outcomeId))) return nein("invalid or duplicate leg");
      spieleSet.add(String(L.eventId)); nummern.add(String(L.outcomeId));
    }
    const amount = Math.round(Number(msg.amount) * 100) / 100, minTotal = Number(msg.minTotalOdds);
    if (!(amount >= MIN_EINSATZ) || amount > MAX_EINSATZ) return nein("stake " + String(msg.amount) + " outside " + MIN_EINSATZ + "–" + MAX_EINSATZ);
    if (!(minTotal > 1)) return nein("minimum total odds missing");
    const kopf = kopfAus(msg);
    if (armed && !(msg.kopf && msg.kopf.Authorization)) return nein("no login handed over — log in at elabet.gr and keep the sport page open");
    if (armed && !(kopf && Number(msg.kopfExp) - Date.now() > KOPF_REST_MS)) return nein("login expiring — bring the elabet.gr tab to the front");
    if (laeuft) return nein("another combo is being built right now");
    // Verwaiste Warte-Eintraege (der Aufrufer fragt nicht mehr nach): ihre Spiele wieder freigeben; der Ausgang bleibt „uncertain“.
    for (const [k, alt] of wartend) if (Date.now() - alt.start > WARTE_ALT_MS && !alt.lauf) { wartend.delete(k); merke(erledigt, k, { status: "uncertain", ticket: alt.ticket || undefined, odds: alt.soll.quote, legs: alt.gelegt, reason: BUCH + " combo: nobody asked for the result any more — POSSIBLY placed, check the bet history" }); try { if (typeof env.freigeben === "function") env.freigeben(alt.spiele); } catch (_) {} }
    const spiele = [...spieleSet], sollIds = legs.map((L) => String(L.outcomeId));
    try { if (typeof env.belegt === "function" && env.belegt(spiele)) return nein("a bet on one of these games is being placed in this tab right now"); } catch (_) {}
    laeuft = true;
    let gesendet = false, z = null;
    try {
      const tz = new Date().getTimezoneOffset(), tl = jetztMs();
      // 1) nebeneinander: Konto (nur scharf: Anmelde-Probe + Zaehler), Regeln des Buchs, Kombi-Bonus, frische Details JEDES Beins
      const [konto, regelnErst, bonusRoh, gelesen] = await Promise.all([
        armed ? env.kontoZaehler(kopf, tz) : null, regelnLesen(env, kopf, tz), bonusLesen(env, kopf, tz), Promise.all(legs.map((L) => beinLesen(env, L, tz)))]);
      // Probe-Schein ohne lesbare Konto-Regeln: mit den oeffentlichen rechnen (und es dazusagen). Scharf nie — dort fehlte die Steuer.
      let regeln = regelnErst, vomKonto = !!kopf;
      if (!regeln.ok && !armed && kopf) { regeln = await regelnLesen(env, null, tz); vomKonto = false; }
      ms.lesen = Math.round(jetztMs() - tl);
      if (armed && !(konto && konto.ok)) return nein(String((konto && konto.grund) || "account not readable") + " — nothing sent");
      if (!regeln.ok) return nein(regeln.grund);
      const R = regeln.R, G = regeln.G, beine = [], einzel = [];
      for (let i = 0; i < legs.length; i++) {
        const L = legs[i], x = gelesen[i], nr = i + 1;
        if (!x || x.fehler) return nein("leg " + nr + ": " + String((x && x.fehler) || "no fresh odds"), { bein: nr });
        if (x.q.buchSel !== seitenVon(L.sport)[String(L.tip)]) return nein("leg " + nr + ": the selection number does not (any longer) sit on outcome " + L.tip + " of this game", { bein: nr });
        if (!(x.q.preis >= Number(L.minOdds))) return nein("leg " + nr + ": " + String(x.q.preis) + " is below the min odds " + Number(L.minOdds), { bein: nr });
        if (G.minQuoteBein != null && x.q.preis <= G.minQuoteBein) return nein("leg " + nr + ": " + String(x.q.preis) + " is not above the book's minimum odds per selection (" + G.minQuoteBein + ")", { bein: nr });
        beine.push(Object.assign({ preis: x.q.preis }, x.kennung));
        gelegt.push({ eventId: String(L.eventId), tip: L.tip, outcomeId: String(x.q.auswahlId), odds: x.q.preis, minOdds: Number(L.minOdds), sport: x.auswahl.sport });
        einzel.push({ auswahl: x.auswahl, q: x.q });
      }
      // 2) Grenzen des Buchs
      if (G.maxBeine != null && legs.length > G.maxBeine) return nein("the book allows at most " + G.maxBeine + " selections in a combo");
      if (G.minBeine != null && legs.length < G.minBeine) return nein("the book needs at least " + G.minBeine + " selections in a combo");
      if (G.minEinsatz != null && amount < G.minEinsatz) return nein("stake " + amount + " is below the book's minimum " + G.minEinsatz);
      // 3) der Schein, wie ihn das Buch rechnet — fuer die Mindest-Gesamtquote OHNE Kombi-Bonus, nach Steuer
      const ohne = rechne(R, null, beine, amount);
      if (!ohne.ok) return nein(ohne.grund);
      const quote = ohne.quote, netto = ohne.nettoQuote, steuerInfo = { total: ohne.steuer, back: 0, toPay: ohne.steuer };
      if (G.minGesamtQuote != null && quote < G.minGesamtQuote) return nein("total odds " + quote.toFixed(2) + " are below the book's minimum for a bet (" + G.minGesamtQuote + ")");
      if (!(ohne.netto >= minTotal * ohne.einsatz - 1e-9)) return nein(ohne.steuer > 0 ? "after the winnings tax (" + ohne.steuer.toFixed(2) + " €) the combo pays " + netto.toFixed(2) + " times the stake — below the min total odds " + minTotal.toFixed(2) : "total odds " + quote.toFixed(2) + " are below the min total odds " + minTotal.toFixed(2));
      // Kombi-Bonus des Buchs: nur als Angabe (siehe Kopf der Datei)
      let bonus = null;
      const B = bonusRoh && bonusRoh.ok ? bonusRoh.B : null;
      if (B) { const m2 = rechne(R, B, beine, amount); if (m2.ok && m2.bonus > 0) bonus = { legs: m2.bonusBeine, pct: Math.round((m2.bonusFaktor - 1) * 10000) / 100, extra: m2.bonus, returns: m2.auszahlung, tax: m2.steuer, netOdds: m2.nettoQuote }; }
      const info = [vomKonto ? null : "rules of the logged-out page (the tax of the account is not visible here)",
        ohne.steuer > 0 ? "winnings tax " + ohne.steuer.toFixed(2) + " € → pays " + netto.toFixed(2) + "× the stake" : null,
        bonus ? "Combo Megaboost +" + bonus.pct + " % for " + bonus.legs + " legs (+" + bonus.extra.toFixed(2) + " € if the book credits it — not counted)" : (bonusRoh && !bonusRoh.ok ? "combo bonus of the book not readable" : null)].filter(Boolean).join(" · ") || null;
      emit("Combo built and priced", { legs: gelegt.length, totalOdds: quote, netOdds: netto, amount, taxToPay: ohne.steuer, bonusPct: bonus ? bonus.pct : null, armed, ms: Math.round(jetztMs() - T0) });
      // Sicherheits-Halt: nur abgeben, wenn ausdruecklich scharf. Im Tab bleibt nichts stehen (es gibt keinen Schein in der Seite).
      if (!armed) return mit(Object.assign({ status: "staged", slipLeft: false, odds: quote, netOdds: netto, legs: gelegt, returns: ohne.auszahlung, tax: steuerInfo, note: "Combo checked and priced against the Elabet odds feed — NOT placed (armed=false). Nothing is left in the tab." }, bonus ? { bonus } : {}, info ? { info } : {}));
      // 4) Doppel-Schutz: steht auf JEDEM Spiel des Scheins schon eine offene Wette, koennte genau dieser Schein schon im Konto liegen
      const vorher = {};
      for (const s of spiele) vorher[s] = Number(konto.jeSpiel[s]) || 0;
      if (spiele.every((s) => vorher[s] > 0)) return nein("the account already holds an open bet on every game of this combo — the same slip may already be placed (double protection)");
      // 5) Abgeben — EIN Auftrag an die Absende-Funktion des Buchs
      const requestId = env.auftragsId();
      const schein = baueSchein(einzel.map((e) => env.baueSchein(e.auswahl, e.q, amount, kopf, { tz, requestId })), amount);
      z = { id: "k" + (++warteNr) + "-" + Date.now().toString(36), soll: { ids: sollIds, quote }, einsatz: amount, vorher, spiele, tz, start: Date.now(), T0, ms, gelegt, steuer: steuerInfo, netto, auszahlung: ohne.auszahlung, bonus, info,
        antwort: null, urteil: null, ticket: null, betId: null, erstellt: null, buchAuszahlung: null, wartet: false, erst: null, verlauf: [], fragen: 0, stufe: 0, abgelehnt: 0, angebot: "", abgleiche: 0, lauf: null, env };
      try { if (typeof env.belegen === "function") env.belegen(spiele); } catch (_) {}
      const ta = jetztMs();
      gesendet = true;
      z.antwort = await env.sende(schein);                                  // PUNKT OHNE WIEDERKEHR
      ms.abgeben = Math.round(jetztMs() - ta);
      wartend.set(z.id, z);
      z.lauf = schritt(z, env, kopfAus(msg));
      try { return await z.lauf; }
      catch (e) { return fertig(z, { status: "uncertain", ticket: z.ticket || undefined, odds: quote, reason: BUCH + " combo: " + text(e) + " — POSSIBLY placed, check the bet history" }, env); }
      finally { z.lauf = null; }
    } catch (e) {
      if (gesendet) {
        // Nach dem Absenden ist der Ausgang offen — nie „nicht gesetzt“. Aufraeumen: Spiele frei, kein haengender Warte-Eintrag.
        if (z) wartend.delete(z.id);
        try { if (typeof env.freigeben === "function") env.freigeben(spiele); } catch (_) {}
        return mit({ status: "uncertain", ticket: (z && z.ticket) || undefined, reason: BUCH + " combo: exception after the slip was sent (" + text(e) + ") — POSSIBLY placed, check the bet history", legs: gelegt });
      }
      return nein("exception: " + text(e));
    } finally { laeuft = false; }
  }

  const beschaeftigt = () => laeuft || [...wartend.values()].some((z) => Date.now() - z.start < WARTE_ALT_MS);
  self.ELAKOMBI = { place, nachfragen, laeuft: () => laeuft, beschaeftigt, SEITEN, LESBAR, _dez: dez, _runde: runde, _zahl: zahl, _regelnAus: regelnAus, _grenzenAus: grenzenAus, _bonusAus: bonusAus, _steuerAuf: steuerAuf, _rechne: rechne,
    _baueSchein: baueSchein, _fehlerText: fehlerText, _klassifiziere: klassifiziere };
})();
