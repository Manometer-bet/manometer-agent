// elabet-content.js — Elabet (elabet.gr, Plattform Altenar WSDK 0.92.2): Platzierung ueber placeWidget aus dem eingeloggten Tab.
// Laeuft auf https://elabet.gr/*. Lesen/Aufloesen macht der Background (Katalog des Edge-Dienstes + frische Spiel-Details);
// dieses Script prueft Sitzung und frische Quote noch einmal selbst, baut den Schein und sendet ihn ueber die EINZIGE
// Absende-Funktion sende(). Mitgelesen an zwei echten Wetten des Betreibers (03.10.2026) und am
// Wett-Modul der Seite (chunks/src-HpPaIext.js: Po/Ta = Schein-Bau, placeBet = requestId/confirmedByClient/device,
// Di = Antwort {error} | {bets}).
//
// Abrufe aus einem Content-Script tragen die Herkunft der Seite — genau wie die Abrufe des Wett-Moduls. Die Anmeldung ist
// ein 15-Minuten-Schluessel (JWT, an die IP gebunden), der nur im Speicher der Seite liegt; der Service Worker liest ihn
// rein lesend aus den Abrufen der Seite mit (background.js, _elaAuth) und reicht ihn je Auftrag als kopf mit. Dieses Script
// speichert ihn nicht und gibt ihn nie aus.
// Dieselbe Datei liegt BYTE-GLEICH in der Manometer Agent der External Bettors (engine/content/elabet-place.js); dort liest
// books/elabet.js den Schluessel mit und reicht ihn je Auftrag mit. Aenderungen immer an beiden Stellen
// (ein Test prueft die Gleichheit).
//
// Aufbau :
//   sessionPruefen -> frischeQuote -> baueSchein [pure] -> sende [einziger Punkt ohne Wiederkehr]
//   -> klassifiziere [pure, Wahrheitstabelle] -> readBack -> betExists
//   wartet das Buch: -> wartendFragen (auf Zuruf des Service Workers) -> wartendLies [pure] -> schliesse
// Wahrheitstabelle: vor sende() nur "blocked"; danach placed (Wett-Nr. mit Status Open oder Read-back), failed
// (ausdrueckliche Ablehnung) oder uncertain — NIE blocked.
// Einen SCHEIN sendet nur sende(). Sonst wird gelesen: Spiel-Details (oeffentlich, GET), der Zaehler der offenen Wetten je
// Spiel (GET) und — nur wenn das Buch eine Wette warten laesst — der Stand DIESER Wette (wartendFragen; POST, weil das
// Wett-Modul so fragt, aendert aber nichts). Der einzige weitere schreibende Abruf ist gegenangebotAblehnen: er lehnt ein
// Gegenangebot des Buchs ab (action 1 = Cancel) und kann keine Wette ausloesen; angenommen (action 0) wird nie.
// Der Zaehler ist dreierlei: Sitzungs-Pruefung VOR dem Senden, Doppel-Schutz (schon eine offene Wette auf das Spiel ->
// nicht senden) und Read-back danach (Zaehler gestiegen = die Wette steht im Konto).
//
// Auswahl: der Background nennt die GENAUE Quote des Buchs (outcomeId = Altenar-oddId). Heim/Gast wird hier nie aus "home"/
// "away" abgeleitet — das Buch kann die Mannschaften gedreht fuehren (gemessen Superbet: 20 von 4821 Pruefungen).
// Gesetzt wird der SIEGER-Markt ueber das ganze Spiel: Fussball 1x2 und (seit 04.10.2026 abends, auswahl.sport "basketball",
// Betreiber: „Auto-Betting Pre-Match und Live Basketball") Basketball „Winner (incl. OT)" — 2-Weg inklusive Verlaengerung. Eine
// Sportart, die unten nicht in SIEGER steht, wird nie gesetzt.
// Vor dem Anpfiff UND live (seit 04.10.2026, Betreiber: „Wir müssen Elabet und Stoixi fit für Live-Wetten
// bekommen"), streng getrennt: ein Live-Auftrag (auswahl.live) setzt nur, wenn das Buch das Spiel als laufend fuehrt
// (liveTime); ein Vorspiel-Auftrag nur vor dem Anpfiff. Der Schein ist live derselbe (am Wett-Modul nachgelesen, Po/Ta —
// kein Live-Feld; an 6 laufenden Spielen gemessen: 1x2-Markt und Quoten tragen dieselben Felder wie vor dem Anpfiff).
// LIVE-ANNAHME (Wett-Modul, Klasse pendingInfo): placeWidget antwortet mit Wett-Status 3 Pending / 9 Init / 17
// WaitingForRegulator; das Modul fragt dann POST betHistory/WidgetReports/widgetPendingBets {betIds:[…]} — sofort, danach
// alle 10 s (Aufsicht: 0,5 / 1 / 3 / 5 / 10 s) — bis 0 Open (angenommen) oder 5/6/7 (abgelehnt). Status 10 Waiting ist ein
// GEGENANGEBOT (Einsatz gekuerzt oder Quote geaendert), das die Seite mit Confirm/Cancel beantworten laesst. Hier gilt:
// nie annehmen. Die Antwortformen sind aus dem Wett-Modul gelesen, NICHT an einer echten Live-Wette mitgelesen — jeder
// unbekannte Stand endet deshalb als uncertain mit Wett-Nr.
// Gewartet wird im Service Worker, nicht hier: Zeitgeber eines verdeckten Tabs drosselt Chrome. platziere() antwortet
// { status:"pending", warteId, nachMs }, jeder Befehl elabetNachfragen macht genau EINEN Abruf.
(() => {
  "use strict";
  if (window.__elabetPlace) return;                   // doppelte Injektion: ein Empfaenger reicht
  window.__elabetPlace = true;

  const BUCH = "elabet";
  const V = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return "?"; } })();
  // Adressen des Wett-Moduls (window.WSDKOrigins der Seite, mitgelesen 03.10.2026).
  const WEB = "https://sb2frontend-altenar2.biahosted.com/api/";
  const WETTEN = "https://sb2betgateway-altenar2.biahosted.com/api/";
  const HISTORIE = "https://sb2bethistory-gateway-altenar2.biahosted.com/api/";
  // Gemeinsame Felder jedes Abrufs (Query bei GET, Koerper bei POST). tz = new Date().getTimezoneOffset().
  const gemeinsam = (tz) => ({ culture: "en-GB", timezoneOffset: tz, integration: "elabet", deviceType: 1, numFormat: "en-GB", countryCode: "GR" });
  const abfrage = (tz) => { const g = gemeinsam(tz); return Object.keys(g).map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(g[k])).join("&"); };
  const DETAIL_URL = (eventId, tz) => WEB + "widget/GetEventDetails?" + abfrage(tz) + "&eventId=" + encodeURIComponent(eventId) + "&showNonBoosts=false";
  const ZAEHLER_URL = (tz) => HISTORIE + "WidgetReports/GetBetsCountWithEvents?" + abfrage(tz);
  const SETZ_URL = WETTEN + "widget/placeWidget";     // PONR
  const WARTEND_URL = HISTORIE + "WidgetReports/widgetPendingBets";          // Stand einer wartenden Wette (nur lesen)
  const ABLEHNEN_URL = WETTEN + "WidgetBetOperations/processPendingBet";     // Gegenangebot beantworten — hier nur: ablehnen
  // Aufzaehlungen des Wett-Moduls.
  const DB_HAUPT = 10;                                // dbId Sb2Main
  // Was gesetzt wird: der SIEGER-Markt je Sportart — sport.typeId (und sport.id) des Spiels, market.typeId, die Arten der
  // Auswahlen (odd.typeId: 1 Heim, 2 Remis, 3 Gast) in sortierter Form.
  //   Fussball:   sport.typeId 1, Markt 1 „1x2", Auswahlen 1 / 2 / 3.
  //   Basketball: sport.typeId 12 (sport.id 67), Markt 219 „Winner (incl. OT)", Auswahlen 1 / 3 — 2-Weg INKLUSIVE Verlaengerung,
  //               dieselbe Wette wie die Pinnacle-Moneyline (gemessen 04.10.2026 an einem laufenden und einem Vorspiel-Spiel:
  //               Markt 219 steht wie das 1x2 doppelt in der Antwort, Heim haengt an competitors[0], Gast an competitors[1]).
  //               Viertel- und Halbzeit-Maerkte (z. B. 235 „Third quarter - 1x2") haben andere Typen und eine Linie (sv).
  // Dieselbe Zuordnung fuehrt der Edge-Dienst (collectors/rabona.js SPORTS, main) — dessen Quote hat den EV ergeben.
  const SIEGER = {
    soccer: { sportTyp: 1, sportId: null, markt: 1, arten: "1,2,3", name: "1x2-Markt", seiten: "Heim/Remis/Gast", kein: "kein Fussball" },
    basketball: { sportTyp: 12, sportId: 67, markt: 219, arten: "1,3", name: "Sieger-Markt", seiten: "Heim/Gast", kein: "kein Basketball" },
    // 19.10.2026: weitere Sportarten (nur vor dem Anpfiff, eigenes Konto) — gemessen an je 2 Vorspiel-Spielen (GetEventDetails)
    tennis: { sportTyp: 4, sportId: 68, markt: 186, arten: "1,3", name: "Sieger-Markt", seiten: "Heim/Gast", kein: "kein Tennis" },
    icehockey: { sportTyp: 16, sportId: 70, markt: 406, arten: "1,3", name: "Sieger-Markt", seiten: "Heim/Gast", kein: "kein Eishockey" },
    volleyball: { sportTyp: 19, sportId: 69, markt: 186, arten: "1,3", name: "Sieger-Markt", seiten: "Heim/Gast", kein: "kein Volleyball" },
    amfootball: { sportTyp: 20, sportId: 75, markt: 219, arten: "1,3", name: "Sieger-Markt", seiten: "Heim/Gast", kein: "kein American Football" },
    baseball: { sportTyp: 13, sportId: 76, markt: 251, arten: "1,3", name: "Sieger-Markt", seiten: "Heim/Gast", kein: "kein Baseball" },
  };
  // Sportart des Auftrags: ohne Angabe Fussball (Auftraege von vor dem 04.10.2026). Unbekannt = null -> wird nicht gesetzt.
  function siegerVon(auswahl) {
    const k = auswahl && auswahl.sport != null && auswahl.sport !== "" ? String(auswahl.sport) : "soccer";
    return Object.prototype.hasOwnProperty.call(SIEGER, k) ? SIEGER[k] : null;
  }
  const WETTE_OFFEN = 0, WETTE_WARTET = [3, 9, 10, 17], WETTE_ABGELEHNT = [5, 6, 7];   // Open | Pending, Init, Waiting, WaitingForRegulator | Rejected*
  const WETTE_GEGENANGEBOT = 10, WETTE_AUFSICHT = 17;                        // Waiting = Gegenangebot | WaitingForRegulator
  const REST_WARTET = 4;                              // pendingInfo.reason RejectExtraStake: ein Teil ist angenommen, der Rest wartet
  const ABLEHNEN = 1;                                 // processPendingBet action: 0 = Confirm (annehmen) wird NIE gesendet, 1 = Cancel
  // Takt des Wett-Moduls beim Nachfragen: sofort, dann alle 10 s; wartet die Aufsicht: 0,5 / 1 / 3 / 5 / 10 s.
  const NACH_MS = 10000, NACH_AUFSICHT_MS = [500, 1000, 3000, 5000, 10000], NACH_ABLEHNEN_MS = 2000;
  const WARTE_MAX_MS = 60000;                         // laenger wird nicht gewartet -> uncertain mit Wett-Nr.
  const WARTE_ALT_MS = 5 * 60000;                     // verwaiste Warte-Eintraege (Service Worker weg) geben das Spiel wieder frei
  const QUOTE_OFFEN = 0;                              // odd.oddStatus
  const BEI_QUOTENAENDERUNG = 0;                      // oddsChangeAction AlwaysAsk: jede Aenderung lehnt das Buch ab, nie stillschweigend annehmen
  // Herkunfts-Angabe des Wett-Moduls zur Auswahl (Werte der beiden mitgelesenen Wetten).
  const WIDGET_INFO = { widget: 12, page: 3, tabIndex: 3, tipsterId: null, suggestionType: null };
  // Sicherheitsgrenzen dieses Scripts (EUR) — nicht die Limits des Buchs; die prueft das Buch selbst (bets.min_stake / bets.limits).
  const MIN_EINSATZ = 0.5, MAX_EINSATZ = 1000;
  const KOPF_REST_MS = 20000;                         // die Anmeldung muss noch mindestens so lange gelten
  const DOPPEL_SCHUTZ = true;                         // schon eine offene Wette auf das Spiel im Konto -> nicht senden
  const warte = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (e) => String((e && e.message) || e);
  const flach = (x) => (Array.isArray(x) ? x.flat(9).filter((v) => typeof v === "number" || typeof v === "string") : []);
  const _laeuft = new Set();                          // Spiele, fuer die in diesem Tab gerade ein Auftrag laeuft
  const _wartend = new Map();                         // warteId -> wartende Wette (ohne Anmeldung: die reicht der Service Worker je Nachfrage mit)
  let _warteNr = 0;

  // Abruf mit Frist. Ohne method = GET; nur sende() schreibt.
  async function hole(url, kopf, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms || 8000);
    try { return await fetch(url, { headers: kopf || {}, credentials: "omit", cache: "no-store", signal: ctl.signal }); }
    finally { clearTimeout(t); }
  }

  // Zaehler der offenen Wetten je Spiel (GET, mit Anmeldung): { ok, offen, jeSpiel } | { ok:false, grund }.
  async function kontoZaehler(kopf, tz) {
    try {
      const r = await hole(ZAEHLER_URL(tz), { Authorization: kopf.Authorization }, 8000);
      if (r.status === 401 || r.status === 403) return { ok: false, grund: "nicht angemeldet (Antwort " + r.status + ")" };
      if (!r.ok) return { ok: false, grund: "Konto nicht lesbar (Antwort " + r.status + ")" };
      const j = await r.json().catch(() => null);
      if (!j || typeof j !== "object" || j.error) return { ok: false, grund: "Konto nicht lesbar" };
      return { ok: true, offen: Number(j.open) || 0, jeSpiel: (j.events && typeof j.events === "object") ? j.events : {} };
    } catch (e) { return { ok: false, grund: "Konto nicht lesbar: " + text(e) }; }
  }

  // Sitzungs-Pruefung ohne Nebenwirkung: Laufzeit der Anmeldung + ein lesender Abruf, der sie wirklich benutzt.
  async function sessionPruefen(kopf, kopfExp, tz, jetzt) {
    if (!kopf || !kopf.Authorization) return { ok: false, grund: "keine Anmeldung uebergeben" };
    if (!(Number(kopfExp) - jetzt > KOPF_REST_MS)) return { ok: false, grund: "Anmeldung laeuft ab — elabet.gr-Tab nach vorn holen" };
    const z = await kontoZaehler(kopf, tz);
    return z.ok ? { ok: true, zaehler: z } : { ok: false, grund: z.grund };
  }

  // PURE: Spiel-Details -> die genannte Auswahl mit allem, was der Schein braucht; sonst { fehler } (fail-closed).
  // Zwei unabhaengige Merkmale muessen passen: die Quote gehoert zum Sieger-Markt DIESES Spiels (Fussball 1x2, Basketball
  // „Winner (incl. OT)"), und ihre Art (1 Heim, 2 Remis, 3 Gast) stimmt mit der Mannschaft ueberein, an der sie haengt (competitorId).
  function quoteAus(det, auswahl, jetzt) {
    const M = siegerVon(auswahl);
    if (!M) return { fehler: "Sportart nicht angebunden" };
    if (!det || typeof det !== "object") return { fehler: "keine Spieldaten" };
    if (String(det.id) !== String(auswahl.eventId)) return { fehler: "anderes Spiel in der Antwort" };
    if (!det.sport || Number(det.sport.typeId) !== M.sportTyp || (M.sportId != null && Number(det.sport.id) !== M.sportId)) return { fehler: M.kein };
    // Phase streng getrennt: live = das Buch fuehrt das Spiel als laufend (liveTime); Vorspiel = Anstoss liegt in der Zukunft.
    const anstoss = Date.parse(String(det.startDate || "")), laeuft = "liveTime" in det;
    if (auswahl.live === true) { if (!laeuft) return { fehler: "Spiel laeuft beim Buch nicht (kein Live-Spiel) — Live-Auftrag nur im laufenden Spiel" }; }
    else if (laeuft || !(anstoss > jetzt)) return { fehler: "Spiel laeuft schon oder Anstoss unbekannt — nur vor dem Anpfiff" };
    // Der Schein ist nur fuer die mitgelesene Form gebaut. Traegt das Spiel Zusatzangaben, die das Wett-Modul mitsenden
    // wuerde (extraEventInfo), wird nicht gesetzt (bei Fussball nie gesehen: 0 von 73 Live-Spielen, 0 vor dem Anpfiff).
    if (det.extraInfo != null) return { fehler: "Spiel traegt Zusatzangaben (extraInfo) — Schein-Form nicht mitgelesen" };
    // Die Antwort fuehrt viele Quoten doppelt (normal + Bet-Builder; gemessen 104 von 817, nie abweichend). Weicht ein
    // Doppel doch einmal in Preis, Status oder Art ab, ist unklar, welches gilt -> diese Quote nicht nehmen.
    const odds = new Map(), strittig = new Set();
    for (const o of det.odds || []) {
      if (!o || o.id == null) continue;
      const k = String(o.id), alt = odds.get(k);
      if (alt && (alt.price !== o.price || alt.oddStatus !== o.oddStatus || alt.typeId !== o.typeId || alt.competitorId !== o.competitorId)) strittig.add(k);
      odds.set(k, o);
    }
    if (strittig.has(String(auswahl.outcomeId))) return { fehler: "Quote steht widerspruechlich in der Antwort" };
    let markt = null;
    for (const m of det.markets || []) {
      // isAlt = Ersatzmarkt: die LISTE des Buchs haengt bei entschiedenem 1x2 "naechstes Tor" unter dieselbe typeId 1
      // (gemessen 04.10.: 3-7 von ~88 Live-Spielen). In den Details nie gesehen — hier trotzdem nie als 1x2 nehmen.
      if (!m || Number(m.typeId) !== M.markt || m.isAlt) continue;
      if (flach(m.desktopOddIds || m.oddIds || m.mobileOddIds).map(String).indexOf(String(auswahl.outcomeId)) >= 0) { markt = m; break; }
    }
    const o = markt ? odds.get(String(auswahl.outcomeId)) : null;
    if (!o) return { fehler: "Auswahl nicht (mehr) im " + M.name };
    // Ein echtes 1x2 hat genau die drei Ausgaenge Heim (1), Remis (2), Gast (3); "naechstes Tor" fuehrt 1 / 7 / 3.
    // Der Basketball-Sieger hat genau Heim (1) und Gast (3) — ein Markt mit Remis waere die regulaere Spielzeit.
    const arten = flach(markt.desktopOddIds || markt.oddIds || markt.mobileOddIds).map((i) => { const x = odds.get(String(i)); return x ? Number(x.typeId) : NaN; }).sort().join(",");
    if (arten !== M.arten) return { fehler: M.name + " hat nicht die Ausgaenge " + M.seiten + " (" + arten + ")" };
    // Linie (sv) oder Preis-Boost wuerde das Wett-Modul mitsenden (sPOV / priceType) — beim 1x2 nie gesehen, sonst nicht setzen.
    if (markt.sv || o.sv || "preBoostedPrice" in o) return { fehler: "Auswahl traegt Linie oder Preis-Boost — Schein-Form nicht mitgelesen" };
    const art = Number(o.typeId), ms = Array.isArray(det.competitors) ? det.competitors : [];
    if (M.arten.split(",").indexOf(String(art)) < 0) return { fehler: "unbekannte Auswahl-Art " + String(o.typeId) };
    if (ms.length !== 2 || ms[0].id == null || ms[1].id == null) return { fehler: "Mannschaften nicht lesbar" };
    const gehoertZu = art === 1 ? ms[0].id : art === 3 ? ms[1].id : null;
    if (art === 2 ? o.competitorId != null : o.competitorId !== gehoertZu) return { fehler: "Auswahl passt nicht zur Mannschaft" };
    if (o.oddStatus != null && Number(o.oddStatus) !== QUOTE_OFFEN) return { fehler: "Quote gesperrt" };
    if (!(Number(o.price) > 1)) return { fehler: "keine Quote" };
    return {
      preis: Number(o.price), auswahlId: String(o.id), buchSel: art === 1 ? "home" : art === 2 ? "draw" : "away",
      spiel: { id: det.id, name: det.name, rc: det.rc, dbId: det.dbId != null ? det.dbId : DB_HAUPT,
        sportName: det.sport.name, sportTypeId: det.sport.typeId, catName: det.category ? det.category.name : undefined, champName: det.champ ? det.champ.name : undefined },
      markt: { id: markt.id, name: markt.name, typeId: markt.typeId },
      odd: { id: o.id, price: o.price, isMB: o.isMB, typeId: o.typeId, name: o.name },
    };
  }

  // 17.10.2026 (Arb-Bot Stufe 2) — LINIEN: Handicap (Markt-Art 16, Auswahl 1714 Heim / 1715 Gast) und Total (Markt-Art 18, 12 Over /
  // 13 Under), nur Fussball vor dem Anpfiff, nur halbe Linien. Gelesen 17.10. im GR-Chrome am Wett-Modul der Seite (src-CR7_qxYl.js,
  // Schein-Bau Ta/cs): jede Auswahl im Schein traegt sPOV = Linie der Auswahl (odd.sv), sonst die des Markts — sonst dieselben Felder
  // wie beim 1x2; an echten Fussball-Spielen: die Linie steht als sv an Markt UND Auswahl (Heim-Linie, z. B. "-0.5"), Handicap nur ±0,5 / ±1,5.
  // auswahl = { eventId, outcomeId, markt "ah"|"tot", base (Linie in Buch-Sicht: AH = Linie der Heim-Mannschaft des Buchs), sel home|away|over|under }.
  const LINIE_ELA = { ah: { typ: 16, arten: { home: 1714, away: 1715 }, name: "Handicap" }, tot: { typ: 18, arten: { over: 12, under: 13 }, name: "Total" } };
  function quoteAusLinie(det, auswahl, jetzt) {
    const K = LINIE_ELA[auswahl.markt], M = siegerVon({ sport: "soccer" });
    if (!K || !M || (auswahl.sport != null && auswahl.sport !== "" && String(auswahl.sport) !== "soccer")) return { fehler: "Linien nur beim Fussball" };
    if (!det || typeof det !== "object" || String(det.id) !== String(auswahl.eventId)) return { fehler: "anderes Spiel in der Antwort" };
    if (!det.sport || Number(det.sport.typeId) !== M.sportTyp || (M.sportId != null && Number(det.sport.id) !== M.sportId)) return { fehler: M.kein };
    const anstoss = Date.parse(String(det.startDate || ""));
    if (auswahl.live === true || "liveTime" in det || !(anstoss > jetzt)) return { fehler: "Spiel laeuft schon oder Anstoss unbekannt — Linien nur vor dem Anpfiff" };
    if (det.extraInfo != null) return { fehler: "Spiel traegt Zusatzangaben (extraInfo) — Schein-Form nicht mitgelesen" };
    const L = Number(auswahl.base);
    if (!isFinite(L) || Math.abs(L * 2 - Math.round(L * 2)) > 1e-9 || Math.round(L * 2) % 2 === 0) return { fehler: "nur halbe Linien (x,5)" };
    const sollArt = K.arten[auswahl.sel];
    if (!sollArt) return { fehler: "Seite unbekannt" };
    const odds = new Map(), strittig = new Set();
    for (const o of det.odds || []) {
      if (!o || o.id == null) continue;
      const k = String(o.id), alt = odds.get(k);
      if (alt && (alt.price !== o.price || alt.oddStatus !== o.oddStatus || alt.typeId !== o.typeId || alt.competitorId !== o.competitorId || alt.sv !== o.sv)) strittig.add(k);
      odds.set(k, o);
    }
    if (strittig.has(String(auswahl.outcomeId))) return { fehler: "Quote steht widerspruechlich in der Antwort" };
    let markt = null;
    for (const m of det.markets || []) {
      if (!m || Number(m.typeId) !== K.typ || m.isAlt) continue;
      if (flach(m.desktopOddIds || m.oddIds || m.mobileOddIds).map(String).indexOf(String(auswahl.outcomeId)) >= 0) { markt = m; break; }
    }
    const o = markt ? odds.get(String(auswahl.outcomeId)) : null;
    if (!o) return { fehler: K.name + "-Auswahl nicht (mehr) im Angebot" };
    const arten = flach(markt.desktopOddIds || markt.oddIds || markt.mobileOddIds).map((i) => { const x = odds.get(String(i)); return x ? Number(x.typeId) : NaN; }).sort().join(",");
    if (arten !== Object.values(K.arten).sort().join(",")) return { fehler: K.name + "-Markt hat nicht genau die zwei Seiten (" + arten + ")" };
    if (Number(o.typeId) !== sollArt) return { fehler: "Auswahl sitzt nicht auf der erwarteten Seite (" + o.typeId + ")" };
    const sv = ("sv" in o && o.sv) ? o.sv : markt.sv;
    if (sv == null || !isFinite(Number(sv)) || Math.abs(Number(sv) - L) > 1e-9) return { fehler: K.name + "-Linie hat sich geaendert (" + String(sv) + " statt " + L + ")" };
    if ("preBoostedPrice" in o) return { fehler: "Auswahl traegt einen Preis-Boost — Schein-Form nicht mitgelesen" };
    const ms = Array.isArray(det.competitors) ? det.competitors : [];
    if (auswahl.markt === "ah") {
      if (ms.length !== 2 || ms[0].id == null || ms[1].id == null) return { fehler: "Mannschaften nicht lesbar" };
      if (o.competitorId !== (auswahl.sel === "home" ? ms[0].id : ms[1].id)) return { fehler: "Auswahl passt nicht zur Mannschaft" };
    }
    if (o.oddStatus != null && Number(o.oddStatus) !== QUOTE_OFFEN) return { fehler: "Quote gesperrt" };
    if (!(Number(o.price) > 1)) return { fehler: "keine Quote" };
    return {
      preis: Number(o.price), auswahlId: String(o.id), buchSel: auswahl.sel + " " + (auswahl.markt === "ah" && auswahl.sel === "away" ? -L : L),
      spiel: { id: det.id, name: det.name, rc: det.rc, dbId: det.dbId != null ? det.dbId : DB_HAUPT,
        sportName: det.sport.name, sportTypeId: det.sport.typeId, catName: det.category ? det.category.name : undefined, champName: det.champ ? det.champ.name : undefined },
      markt: { id: markt.id, name: markt.name, typeId: markt.typeId },
      odd: { id: o.id, price: o.price, isMB: o.isMB, typeId: o.typeId, name: o.name, sv: String(sv) },
    };
  }

  // Frische Quote unmittelbar vor dem Senden (PT08) — oeffentlicher Abruf, ohne Anmeldung, nie aus einem Zwischenspeicher.
  async function frischeQuote(auswahl, tz) {
    try {
      const r = await hole(DETAIL_URL(auswahl.eventId, tz), null, 8000);
      if (!r.ok) return { fehler: "Spiel nicht lesbar (Antwort " + r.status + ")" };
      if (auswahl.markt === "ah" || auswahl.markt === "tot") return quoteAusLinie(await r.json().catch(() => null), auswahl, Date.now());
      return quoteAus(await r.json().catch(() => null), auswahl, Date.now());
    } catch (e) { return { fehler: "Spiel nicht lesbar: " + text(e) }; }
  }

  // PURE: Schein aus frischer Quote, Einsatz und Anmeldung — Feld fuer Feld wie das Wett-Modul (Po/Ta/placeBet) und die
  // beiden mitgelesenen Wetten. Keine Netz-, DOM- oder Zeitzugriffe: tz und requestId kommen von aussen.
  function baueSchein(auswahl, quote, einsatz, kopf, extra) {
    const s = quote.spiel, m = quote.markt, o = quote.odd;
    return {
      url: SETZ_URL,
      method: "POST",
      headers: { Authorization: kopf.Authorization, "Content-Type": "application/json" },
      body: Object.assign(gemeinsam(extra.tz), {
        betType: 0, isAutoCharge: false, stakes: [Number(einsatz)], oddsChangeAction: BEI_QUOTENAENDERUNG,
        betMarkets: [{ id: s.id, isBanker: false, dbId: s.dbId, sportName: s.sportName, rC: s.rc, eventName: s.name, catName: s.catName, champName: s.champName, sportTypeId: s.sportTypeId,
          odds: [o.sv != null
            // Linie (17.10.2026): sPOV direkt nach id, wie das Wett-Modul den Schein baut (Ta/cs: { id, sPOV, marketId, … })
            ? { id: o.id, sPOV: o.sv, marketId: m.id, price: o.price, marketName: m.name, marketTypeId: m.typeId, mostBalanced: o.isMB, selectionTypeId: o.typeId, selectionName: o.name, widgetInfo: Object.assign({}, WIDGET_INFO) }
            : { id: o.id, marketId: m.id, price: o.price, marketName: m.name, marketTypeId: m.typeId, mostBalanced: o.isMB, selectionTypeId: o.typeId, selectionName: o.name,
            widgetInfo: Object.assign({}, WIDGET_INFO) }] }],
        eachWays: [false], requestId: extra.requestId, confirmedByClient: false, device: 0,
      }),
    };
  }

  // Auftragskennung wie das Wett-Modul (21 Zeichen aus A-Za-z0-9_-).
  function auftragsId() {
    const z = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
    const b = new Uint8Array(21);
    try { crypto.getRandomValues(b); } catch (_) { for (let i = 0; i < 21; i++) b[i] = Math.floor(Math.random() * 256); }
    let s = ""; for (let i = 0; i < 21; i++) s += z[b[i] & 63];
    return s;
  }

  // DIE Absende-Funktion: einziger Punkt ohne Wiederkehr dieses Buchs. Ab dem fetch kann Geld unterwegs sein.
  async function sende(schein) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 25000);
    try {
      const r = await fetch(schein.url, { method: schein.method, headers: schein.headers, body: JSON.stringify(schein.body), credentials: "omit", signal: ctl.signal });
      let roh = ""; try { roh = await r.text(); } catch (_) {}
      let json = null; try { json = JSON.parse(roh); } catch (_) {}
      return { art: "antwort", status: r.status, json, roh: roh.slice(0, 2000) };
    } catch (e) {
      // Die Anfrage kann schon raus sein, als die Verbindung abriss oder die Frist ablief -> uncertain, nie "nicht gesetzt".
      return { art: "netzfehler", fehler: text(e) };
    } finally { clearTimeout(t); }
  }

  // PURE: Wahrheitstabelle. Eingabe ist NUR die Rueckgabe von sende() und die gesendete Quote.
  // Die Texte nennen bewusst kein "HTTP 401/403": darauf fasst das Side Panel einmal nach (_placeRetryable).
  function klassifiziere(antwort, quote) {
    if (!antwort || antwort.art === "gesperrt") return { status: "blocked", reason: (antwort && antwort.grund) || BUCH + ": nichts gesendet" };
    if (antwort.art === "netzfehler") return { status: "uncertain", reason: BUCH + ": Verbindung beim Absenden abgerissen — im Konto pruefen (" + antwort.fehler + ")", odds: quote.preis };
    if (antwort.art !== "antwort") return { status: "uncertain", reason: BUCH + ": unbekannte Antwort — im Konto pruefen", odds: quote.preis };
    const s = Number(antwort.status) || 0, j = antwort.json;
    if (s === 0 || s >= 500) return { status: "uncertain", reason: BUCH + ": Serverfehler " + s + " nach dem Absenden — im Konto pruefen", odds: quote.preis };
    if (s === 401 || s === 403) return { status: "failed", reason: BUCH + ": Anmeldung abgelehnt (Antwort " + s + ") — auf elabet.gr neu anmelden", odds: quote.preis };
    const w = j && Array.isArray(j.bets) && j.bets.length ? j.bets[0] : null;
    if (w && w.id != null) {
      const st = Number(w.status), ticket = String(w.id);
      const fill = Number(w.totalOdds) > 1 ? Number(w.totalOdds) : quote.preis;
      const stake = Number(w.totalStake) > 0 ? Number(w.totalStake) : undefined;
      if (st === WETTE_OFFEN) return { status: "placed", ticket, odds: fill, stake };
      if (WETTE_ABGELEHNT.indexOf(st) >= 0) return { status: "failed", ticket, reason: BUCH + ": vom Buch abgelehnt (Wett-Status " + st + ")", odds: quote.preis };
      if (WETTE_WARTET.indexOf(st) >= 0) return { status: "uncertain", ticket, wartet: true, betId: w.id, stand: st, reason: BUCH + ": Wette wartet beim Buch (Wett-Status " + st + ") — im Konto pruefen", odds: fill, stake };
      return { status: "uncertain", ticket, reason: BUCH + ": unbekannter Wett-Status " + String(w.status) + " — im Konto pruefen", odds: fill, stake };
    }
    const e = j && j.error;
    if (e) {
      const code = String((typeof e === "object" ? (e.errorStringCode || e.message || e.errorCode) : e) || "ohne Angabe");
      return { status: "failed", reason: BUCH + ": abgelehnt — " + code.slice(0, 120), odds: quote.preis };
    }
    if (s >= 400) return { status: "failed", reason: BUCH + ": abgelehnt (Antwort " + s + ")", odds: quote.preis };
    return { status: "uncertain", reason: BUCH + ": kein eindeutiges Verdikt (Antwort " + s + ") — im Konto pruefen", odds: quote.preis };
  }

  // Read-back-Kern: stehen jetzt MEHR offene Wetten auf diesem Spiel im Konto als vor dem Senden? true/false, null = nicht lesbar.
  async function betExists(ziel) {
    const z = await kontoZaehler(ziel.kopf, ziel.tz);
    if (!z.ok) return null;
    return (Number(z.jeSpiel[String(ziel.eventId)]) || 0) > ziel.vorher;
  }
  // Read-back mit Wiederholung: die Wette erscheint oft erst verzoegert. Ruft betExists — NIE sich selbst
  // (Befund Z1: pamestoixima verifyBet rief verifyBet -> RangeError -> echte Wette als "blocked").
  async function readBack(ziel) {
    for (let i = 0; i < 3; i++) {
      if ((await betExists(ziel)) === true) return true;
      await warte(1200);
    }
    return (await betExists(ziel)) === true;
  }

  // ---- Wartende Wette (Live-Verzoegerung, Pruefung, Aufsicht) -----------------------------------------------------------
  // Stand EINER wartenden Wette beim Buch erfragen. POST, weil das Wett-Modul so fragt (Koerper: gemeinsame Felder +
  // betIds) — dem Wesen nach lesend: der Abruf aendert nichts am Konto und kann keine Wette ausloesen.
  async function wartendFragen(betId, kopf, tz) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(WARTEND_URL, { method: "POST", headers: { Authorization: kopf.Authorization, "Content-Type": "application/json" }, body: JSON.stringify(Object.assign(gemeinsam(tz), { betIds: [betId] })), credentials: "omit", cache: "no-store", signal: ctl.signal });
      let json = null; try { json = await r.json(); } catch (_) {}
      return { art: "antwort", status: r.status, json };
    } catch (e) { return { art: "netzfehler", fehler: text(e) }; }
    finally { clearTimeout(t); }
  }
  // Gegenangebot des Buchs ABLEHNEN (Wett-Modul: Knopf "Cancel" -> processPendingBet { id, action: 1 }). Der einzige
  // schreibende Abruf neben sende(). Er kann keine Wette ausloesen — die Gegenrichtung (action 0 = annehmen) gibt es hier
  // nicht. Die Antwort wertet auch das Wett-Modul nicht aus: massgeblich ist der naechste Stand der Wette.
  async function gegenangebotAblehnen(betId, kopf, tz) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(ABLEHNEN_URL, { method: "POST", headers: { Authorization: kopf.Authorization, "Content-Type": "application/json" }, body: JSON.stringify(Object.assign(gemeinsam(tz), { id: betId, action: ABLEHNEN })), credentials: "omit", cache: "no-store", signal: ctl.signal });
      return { art: "antwort", status: r.status };
    } catch (e) { return { art: "netzfehler", fehler: text(e) }; }
    finally { clearTimeout(t); }
  }
  // PURE: Antwort von wartendFragen -> Stand der Wette. "placed" nur bei ausdruecklichem Status Open DIESER Wett-Nr.,
  // "failed" nur bei ausdruecklicher Ablehnung; nicht lesbar oder noch wartend = weiter fragen; alles Unbekannte = uncertain.
  function wartendLies(antwort, betId) {
    if (!antwort || antwort.art !== "antwort") return { weiter: true, lesbar: false, grund: "nicht lesbar (" + String((antwort && antwort.fehler) || "keine Antwort").slice(0, 80) + ")" };
    const s = Number(antwort.status) || 0, j = antwort.json;
    if (s < 200 || s >= 300 || !j || !Array.isArray(j.bets)) return { weiter: true, lesbar: false, grund: "nicht lesbar (Antwort " + s + ")" };
    const w = j.bets.find((b) => b && String(b.id) === String(betId));
    if (!w) return { weiter: true, lesbar: false, grund: "Wette nicht in der Antwort" };
    const st = Number(w.status), pi = (w.pendingInfo && typeof w.pendingInfo === "object") ? w.pendingInfo : {};
    const info = { lesbar: true, stand: st, standRoh: String(w.status).slice(0, 24), felder: Object.keys(w).slice(0, 16).join(","), grundNr: pi.reason != null ? Number(pi.reason) : null,
      einsatz: Number(w.totalStake) > 0 ? Number(w.totalStake) : null, rest: Number(pi.rejectStake) > 0 ? Number(pi.rejectStake) : null,
      quote: Number(w.totalOdds) > 1 ? Number(w.totalOdds) : null,
      preise: Array.isArray(pi.priceChanges) ? pi.priceChanges.map((x) => Number(x && x.price)).filter((x) => x > 1) : [] };
    if (st === WETTE_OFFEN) return Object.assign({ ende: "placed" }, info);
    if (WETTE_ABGELEHNT.indexOf(st) >= 0) return Object.assign({ ende: "failed" }, info);
    if (st === WETTE_GEGENANGEBOT) return Object.assign({ weiter: true, gegenangebot: true }, info);
    if (WETTE_WARTET.indexOf(st) >= 0) return Object.assign({ weiter: true }, info);
    return Object.assign({ ende: "uncertain" }, info);
  }
  // PURE: was das Buch im Gegenangebot geaendert hat (pendingInfo.reason: 0 Einsatz, 1 Quote, 2 beides, 3 unbestimmt).
  function angebotText(l) {
    const teile = [];
    if ((l.grundNr === 0 || l.grundNr === 2) && l.einsatz) teile.push("Einsatz auf " + l.einsatz.toFixed(2) + " gekuerzt");
    if ((l.grundNr === 1 || l.grundNr === 2) && l.preise.length) teile.push("Quote auf " + l.preise.join(" / ") + " geaendert");
    return teile.length ? teile.join(", ") : "Wette geaendert";
  }
  // Wartezeit zu Ende: Eintrag loeschen, Spiel wieder frei, Ergebnis nach der Wahrheitstabelle.
  function schliesse(w, l) {
    _wartend.delete(w.id); _laeuft.delete(w.spiel);
    // Verlauf = die gelesenen Wett-Staende der Reihe nach ("?" = nicht lesbar) — zeigt im Protokoll, wie das Buch wirklich antwortet.
    const wie = " (nach " + Math.round((Date.now() - w.start) / 1000) + " s, " + w.fragen + " Nachfragen, Verlauf " + [w.erst].concat(w.verlauf).join(">") + ")";
    const kern = { ticket: w.ticket, buchSel: w.buchSel };
    if (l.ende === "placed") {
      // Nach einer Ablehnung des Gegenangebots darf die Wette nicht offen sein — sagt das Buch es doch, entscheidet das Konto.
      if (w.abgelehnt) return Object.assign({ status: "uncertain", odds: l.quote || w.preis, reason: BUCH + ": Gegenangebot abgelehnt (" + w.angebot + "), das Buch fuehrt die Wette trotzdem als offen — im Konto pruefen" + wie }, kern);
      const erg = Object.assign({ status: "placed", odds: l.quote || w.preis, stake: l.einsatz || w.einsatz, verified: true, note: "vom Buch nach Wartezeit angenommen" + wie }, kern);
      if (l.grundNr === REST_WARTET && l.rest) erg.note += " — das Buch hat " + l.rest.toFixed(2) + " vom Einsatz abgelehnt, Einsatz im Konto pruefen";
      return erg;
    }
    if (l.ende === "failed") return Object.assign({ status: "failed", odds: w.preis, reason: BUCH + ": " + (w.abgelehnt ? "Gegenangebot des Buchs nicht angenommen (" + w.angebot + ")" : "vom Buch nach Wartezeit abgelehnt (Wett-Status " + l.stand + ")") + wie }, kern);
    let warum;
    if (l.ende === "zeit") warum = w.abgelehnt ? "Gegenangebot abgelehnt (" + w.angebot + "), die Bestaetigung des Buchs steht aus"
      : (w.grundNr === REST_WARTET && w.rest) ? "ein Teil des Einsatzes ist angenommen, " + w.rest.toFixed(2) + " warten noch"
      : w.lesbar ? "Wette wartet noch beim Buch (Wett-Status " + w.stand + ")" : "Stand der Wette nicht lesbar (" + (w.grund || "keine Antwort") + ")";
    else warum = l.fehler ? String(l.fehler) : "unbekannter Wett-Status " + String(l.standRoh) + " (Felder: " + String(l.felder) + ")";
    return Object.assign({ status: "uncertain", odds: w.preis, stake: w.einsatz, reason: BUCH + ": " + warum + " — im Konto pruefen" + wie }, kern);
  }
  // EINE Nachfrage zu einer wartenden Wette (Befehl elabetNachfragen). Die Anmeldung reicht der Service Worker je Aufruf
  // mit (sie kann inzwischen erneuert sein); hier wird sie weder gespeichert noch ausgegeben.
  async function nachfragen(msg) {
    const w = _wartend.get(String(msg && msg.warteId));
    if (!w) return { status: "uncertain", reason: BUCH + ": Warte-Auftrag unbekannt (Tab neu geladen?) — im Konto pruefen" };
    if (w.fragt) return { status: "pending", warteId: w.id, nachMs: 1000, ticket: w.ticket, odds: w.preis, buchSel: w.buchSel };
    w.fragt = true;
    try {
      const kopf = msg.kopf, gueltig = !!(kopf && kopf.Authorization) && Number(msg.kopfExp) > Date.now();
      const l = gueltig ? wartendLies(await wartendFragen(w.betId, kopf, w.tz), w.betId) : { weiter: true, lesbar: false, grund: "keine gueltige Anmeldung" };
      w.fragen++; w.verlauf.push(l.lesbar ? (isFinite(l.stand) ? l.stand : l.standRoh) : "?");
      w.lesbar = !!l.lesbar; w.grund = l.grund || "";
      if (l.lesbar) { w.stand = l.stand; w.grundNr = l.grundNr; w.rest = l.rest; }
      if (l.ende) return schliesse(w, l);
      let nachMs = NACH_MS;
      if (l.gegenangebot) {
        // Gegenangebot: geaenderter Einsatz oder geaenderte Quote. Nie annehmen — ablehnen (hoechstens zwei Versuche) und
        // weiter fragen, bis das Buch die Wette als abgelehnt fuehrt.
        w.angebot = angebotText(l);
        if (w.abgelehnt < 2) { w.abgelehnt++; await gegenangebotAblehnen(w.betId, kopf, w.tz); }
        nachMs = NACH_ABLEHNEN_MS;
      } else if (l.stand === WETTE_AUFSICHT) nachMs = NACH_AUFSICHT_MS[Math.min(w.stufe++, NACH_AUFSICHT_MS.length - 1)];
      else if (w.abgelehnt) nachMs = NACH_ABLEHNEN_MS;
      if (Date.now() - w.start >= WARTE_MAX_MS) return schliesse(w, { ende: "zeit" });
      return { status: "pending", warteId: w.id, nachMs, ticket: w.ticket, odds: w.preis, buchSel: w.buchSel };
    } catch (e) {
      return schliesse(w, { ende: "uncertain", fehler: text(e) });
    } finally { w.fragt = false; }
  }

  async function platziere(msg) {
    const a = msg && msg.auswahl;
    const einsatz = Math.round(Number(msg && msg.einsatz) * 100) / 100, minOdds = Number(msg && msg.minOdds);
    if (!a || !a.eventId || !a.outcomeId) return { status: "blocked", reason: BUCH + ": unvollstaendige Auswahl (Spiel und Auswahl-Nummer noetig)" };
    if (!siegerVon(a)) return { status: "blocked", reason: BUCH + ": Sportart " + String(a.sport).slice(0, 24) + " ist bei diesem Buch nicht angebunden" };
    if (!(einsatz >= MIN_EINSATZ) || einsatz > MAX_EINSATZ) return { status: "blocked", reason: BUCH + ": Einsatz " + einsatz + " ausserhalb " + MIN_EINSATZ + "-" + MAX_EINSATZ };
    if (!(minOdds > 1)) return { status: "blocked", reason: BUCH + ": minOdds fehlt" };
    const spiel = String(a.eventId);
    for (const [k, alt] of _wartend) if (Date.now() - alt.start > WARTE_ALT_MS) { _wartend.delete(k); _laeuft.delete(alt.spiel); }   // verwaist (niemand fragt mehr)
    if (_laeuft.has(spiel)) return { status: "blocked", reason: BUCH + ": fuer dieses Spiel laeuft schon ein Auftrag" };
    _laeuft.add(spiel);
    let gesendet = false, wartet = false;
    try {
      const tz = new Date().getTimezoneOffset();
      const [sess, q] = await Promise.all([sessionPruefen(msg.kopf, msg.kopfExp, tz, Date.now()), frischeQuote(a, tz)]);
      if (!sess.ok) return { status: "blocked", reason: BUCH + ": " + sess.grund };
      if (!q || q.fehler) return { status: "blocked", reason: BUCH + ": " + ((q && q.fehler) || "keine frische Quote") };
      const vorher = Number(sess.zaehler.jeSpiel[spiel]) || 0;
      if (DOPPEL_SCHUTZ && vorher > 0) return { status: "blocked", reason: BUCH + ": im Konto steht schon eine offene Wette auf dieses Spiel (Doppel-Schutz)" };
      if (q.preis < minOdds) return { status: "blocked", reason: BUCH + ": " + q.preis + " unter Min " + minOdds, odds: q.preis };
      const schein = baueSchein(a, q, einsatz, msg.kopf, { tz, requestId: auftragsId() });
      gesendet = true;
      const antwort = await sende(schein);            // PUNKT OHNE WIEDERKEHR
      const erg = Object.assign(klassifiziere(antwort, q), { buchSel: q.buchSel });
      const ziel = { eventId: spiel, vorher, kopf: msg.kopf, tz };
      if (erg.status === "placed") {
        const rb = await readBack(ziel);
        return Object.assign(erg, { verified: rb === true }, rb === true ? {} : { note: "Wett-Nr. vergeben, per Read-back (noch) nicht bestaetigt" });
      }
      if (erg.wartet && erg.betId != null) {
        // Das Buch hat den Schein, entscheidet aber spaeter (Live-Verzoegerung, Pruefung, Aufsicht). Der Zaehler der offenen
        // Wetten taugt hier NICHT als Beleg (er kann eine wartende Wette mitzaehlen, die danach abgelehnt wird) — gefragt
        // wird nach genau dieser Wett-Nr., auf Zuruf des Service Workers. Das Spiel bleibt bis dahin gesperrt.
        const id = "w" + (++_warteNr) + "-" + erg.ticket;
        _wartend.set(id, { id, spiel, betId: erg.betId, ticket: erg.ticket, tz, preis: erg.odds || q.preis, einsatz, buchSel: q.buchSel, start: Date.now(),
          erst: erg.stand, stand: erg.stand, verlauf: [], grundNr: null, rest: null, lesbar: true, grund: "", stufe: 0, fragen: 0, abgelehnt: 0, angebot: "", fragt: false });
        wartet = true;
        return { status: "pending", warteId: id, nachMs: 0, ticket: erg.ticket, odds: erg.odds || q.preis, buchSel: q.buchSel };
      }
      if (erg.status === "uncertain") {
        if (a.live !== true) {
          if ((await readBack(ziel)) === true) return { status: "placed", ticket: erg.ticket || null, odds: erg.odds || q.preis, stake: erg.stake, verified: true, buchSel: q.buchSel, note: "per Read-back bestaetigt (Antwort des Buchs war unklar)" };
        } else if ((await betExists(ziel)) === true) {
          // Live: eine neue Wette im Zaehler kann noch warten und abgelehnt werden — kein Beleg fuer "gesetzt".
          erg.reason = String(erg.reason || "") + " Im Konto steht eine neue Wette auf dieses Spiel; ob sie angenommen ist, zeigt nur das Konto.";
        }
      }
      return erg;
    } catch (e) {
      // Ausnahme nach dem Senden = unbekannter Ausgang -> uncertain; davor ist nachweislich nichts gesendet.
      return gesendet ? { status: "uncertain", reason: BUCH + ": " + text(e) + " — im Konto pruefen" } : { status: "blocked", reason: BUCH + ": " + text(e) };
    } finally { if (!wartet) _laeuft.delete(spiel); }
  }

  // ---- Kombiwette (05.10.2026): Wege zum Buch fuer elabet-kombi.js -----------------------------------------------------------
  // Der Baustein (ELAKOMBI; in Erweiterung und Manometer Agent byte-gleich) bekommt genau die Funktionen dieses Scripts: die Pruefung
  // der Spiel-Details (quoteAus) und den Schein-Bau der Einzelwette (baueSchein — jedes Bein einer Kombi ist derselbe Eintrag wie
  // dort), den Zaehler des Kontos, das Nachfragen einer wartenden Wette — und zum Abgeben DIESELBE Absende-Funktion sende(),
  // davor eine zweite, unabhaengige Pruefung des Koerpers (kombiFehler). Die Setz-Adresse steht weiter nur im Schein aus
  // baueSchein: der Baustein nimmt dessen Huelle (Adresse, Kopfzeilen) und setzt nur den Kombi-Koerper ein; selbst liest er nur
  // ueber seine eigenen, festen Lese-Adressen.
  const kombiDa = () => (typeof ELAKOMBI !== "undefined" && !!ELAKOMBI && typeof ELAKOMBI.place === "function" && typeof ELAKOMBI.nachfragen === "function");
  // PURE: darf dieser Koerper als Kombi an das Buch? null = ja, sonst der Grund. Mitgelesen ist nur diese Form: Art Kombi (1),
  // 2 bis 12 verschiedene Spiele mit je EINER Quote, EIN Einsatz, keine Bonus-, Boost- oder Bestaetigungs-Felder.
  function kombiFehler(k) {
    if (!k || typeof k !== "object") return "kein Schein";
    if (k.betType !== 1) return "kein Kombi-Schein (betType " + String(k.betType) + ")";
    const m = Array.isArray(k.betMarkets) ? k.betMarkets : [];
    if (m.length < 2 || m.length > 12) return "eine Kombi braucht 2 bis 12 Spiele";
    const spiele = new Set(), quoten = new Set();
    for (const x of m) {
      const o = x && Array.isArray(x.odds) && x.odds.length === 1 ? x.odds[0] : null;
      if (!o || x.id == null || o.id == null || !(Number(o.price) > 1) || x.isBanker !== false) return "Spiel ohne genau eine Auswahl";
      if (spiele.has(String(x.id)) || quoten.has(String(o.id))) return "Spiel oder Auswahl doppelt";
      spiele.add(String(x.id)); quoten.add(String(o.id));
    }
    if (!Array.isArray(k.stakes) || k.stakes.length !== 1 || !(k.stakes[0] >= MIN_EINSATZ) || k.stakes[0] > MAX_EINSATZ) return "Einsatz ausserhalb " + MIN_EINSATZ + "-" + MAX_EINSATZ;
    if (!Array.isArray(k.eachWays) || k.eachWays.length !== 1 || k.eachWays[0] !== false) return "Schein-Form nicht mitgelesen (eachWays)";
    if (k.oddsChangeAction !== BEI_QUOTENAENDERUNG || k.confirmedByClient !== false || k.isAutoCharge !== false) return "Schein-Form nicht mitgelesen";
    for (const f of ["bonusStake", "bonusAccountId", "boostedAccountId", "betslipBoostGrantId", "confirmationChoice", "selectedTeaserPoints"]) if (f in k) return "Schein-Form nicht mitgelesen (" + f + ")";
    return null;
  }
  const KOMBI_ENV = {
    quoteAus, baueSchein, kontoZaehler, wartendFragen, wartendLies, gegenangebotAblehnen, gemeinsam, auftragsId,
    // Abgeben einer Kombi: geprueft, dann sende() — der einzige Punkt ohne Wiederkehr dieses Buchs, auch fuer die Kombi.
    sende: (schein) => {
      const f = (!schein || typeof schein !== "object") ? "kein Schein" : kombiFehler(schein.body);
      if (f || !schein.headers || !schein.headers.Authorization) return Promise.resolve({ art: "gesperrt", grund: BUCH + ": " + (f || "keine Anmeldung im Schein") + " — nichts gesendet" });
      return sende(schein);
    },
    // Spiele, auf denen in diesem Tab gerade ein Auftrag laeuft (eine Einzelwette und eine Kombi auf dasselbe Spiel nie zugleich).
    belegt: (spiele) => spiele.some((s) => _laeuft.has(String(s))),
    belegen: (spiele) => { for (const s of spiele) _laeuft.add(String(s)); },
    freigeben: (spiele) => { for (const s of spiele) _laeuft.delete(String(s)); },
    emit: (m, d) => { try { chrome.runtime.sendMessage({ cmd: "log", entry: { t: new Date().toISOString(), src: "place", msg: m, data: Object.assign({ bm: BUCH }, d || {}) } }).catch(() => {}); } catch (_) {} },
  };

  chrome.runtime.onMessage.addListener((msg, _sender, send) => {
    if (!msg || !msg.cmd) return;
    if (msg.cmd === "ping") { send({ ok: true, bm: BUCH, v: V, kombi: kombiDa() }); return; }
    // 05.10.2026 — KOMBIWETTE: der Ablauf steht in elabet-kombi.js (ELAKOMBI). Die Anmeldung reicht der Aufrufer je Auftrag und
    // je Nachfrage mit (msg.kopf); sie wird weder gespeichert noch ausgegeben.
    if (msg.cmd === "elabetPlaceCombo" || msg.cmd === "elabetKombiNachfragen") {
      if (!kombiDa()) { send({ status: "blocked", reason: BUCH + " combo: placement script not loaded (reload the elabet.gr tab)" }); return; }
      const lauf = msg.cmd === "elabetKombiNachfragen" ? ELAKOMBI.nachfragen(msg, KOMBI_ENV) : ELAKOMBI.place(msg, KOMBI_ENV);
      Promise.resolve(lauf).then(send).catch((e) => send({ status: "uncertain", reason: BUCH + " combo: " + text(e) + " — check the bet history" }));
      return true;
    }
    if (msg.cmd === "elabetPlace") {
      platziere(msg).then(send).catch((e) => send({ status: "uncertain", reason: BUCH + ": " + text(e) }));
      return true;
    }
    if (msg.cmd === "elabetNachfragen") {
      nachfragen(msg).then(send).catch((e) => send({ status: "uncertain", reason: BUCH + ": " + text(e) + " — im Konto pruefen" }));
      return true;
    }
  });
})();
