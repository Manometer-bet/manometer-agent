// efbet-content.js — efbet.gr (Plattform BetConstruct „Swarm"): Platzierung ueber den Swarm-Socket der eingeloggten Seite.
// Laeuft auf https://www.efbet.gr/* (isolierte Welt). Lesen/Aufloesen macht der Background (Katalog + Auswahl-Nummern des
// Edge-Dienstes); dieses Script prueft Sitzung und frische Quote noch einmal selbst, baut den Schein und sendet ihn ueber die
// EINZIGE Absende-Funktion sende(). Mitgelesen an zwei echten Wetten des Betreibers (04.10.2026, eine vor dem Anpfiff, eine live;
// interne Notizen und am Wettschein-Code der Seite (assets/js/Swarm.*.js, BetslipProvider.*.js, useUserData.*.js:
// create_bets, Antwort { StatusCode, Data }, Ablehnung { Key, ErrorData }).
//
// efbet setzt NICHT per HTTP-Abruf: der Schein geht als Befehl create_bets ueber den WebSocket der Seite, an dessen Sitzung
// die Anmeldung haengt. Den Socket erreicht nur die Seiten-Welt — dort sitzt efbet-inject.js und nimmt Auftraege per
// window.postMessage an (feste Befehlsliste, Antworten ohne Kontodaten). Dieses Script kennt weder Token noch Cookie und
// meldet nie an; ist die Seite nicht angemeldet, antwortet das Buch mit Code 12 und es wird nicht gesetzt.
// Dieselbe Datei liegt BYTE-GLEICH in der Manometer Agent der External Bettors (engine/content/efbet-place.js). Aenderungen immer
// an beiden Stellen (ein Test prueft die Gleichheit).
//
// Aufbau :
//   sessionPruefen -> frischeQuote -> baueSchein [pure] -> sende [einziger Punkt ohne Wiederkehr]
//   -> klassifiziere [pure, Wahrheitstabelle] -> readBack -> betExists
// Wahrheitstabelle: vor sende() nur "blocked"; danach placed (Wett-Nr. in der Antwort oder Read-back), failed (ausdrueckliche
// Ablehnung) oder uncertain — blocked nur noch, wenn die Seiten-Bruecke den Schein nachweislich NICHT gesendet hat.
// Einen SCHEIN sendet nur sende(). Alles andere liest: Spiel + 1x2-Markt (oeffentlich), offene Wetten des Kontos (Sitzungs-
// Pruefung, Doppel-Schutz, Read-back), Hoechsteinsatz der Auswahl, Stand einer Wett-Nr., Kontostand (nur Zahlen).
//
// Auswahl: der Background nennt die GENAUE Auswahl des Buchs (outcomeId = event.id = SelectionId im Schein) und ihre Seite
// im Markt (art W1 / X / W2). Heim/Gast wird hier nie aus "home"/"away" abgeleitet — das Buch kann die Mannschaften anders
// fuehren als die Quelle des Signals. Gesetzt wird der SIEGER-Markt ueber das ganze Spiel: Fussball 1x2 und (seit 04.10.2026,
// auswahl.sport "basketball") Basketball „Match Winner" — 2-Weg inklusive Verlaengerung. Vor dem Anpfiff UND live, streng
// getrennt: ein Live-Auftrag (auswahl.live) setzt nur, wenn das Buch das Spiel als laufend fuehrt; ein Vorspiel-Auftrag nur
// vor dem Anpfiff. Eine Sportart, die hier nicht steht, wird nie gesetzt.
// LIVE-ANNAHME: das Buch haelt die Antwort auf create_bets zurueck, bis es entschieden hat (mitgelesen: 13,4 s; vor dem
// Anpfiff 1,0 s) — EINE Antwort, kein Zwischenstand. Gewartet wird im Service Worker, nicht hier (Zeitgeber eines verdeckten
// Tabs drosselt Chrome): platziere() antwortet nach kurzer Zeit { status:"pending", warteId, nachMs }, jeder Befehl
// efbetNachfragen sieht nur nach, ob die Antwort inzwischen da ist.
(() => {
  "use strict";
  if (window.__efbetPlace) return;                    // doppelte Injektion: ein Empfaenger reicht
  window.__efbetPlace = true;

  const BUCH = "efbet";
  const V = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return "?"; } })();
  const AN_SEITE = "efbet-place", VON_SEITE = "efbet-inject";   // Kennungen der Bruecke (efbet-inject.js)
  // Was gesetzt wird: der SIEGER-Markt je Sportart — Swarm-Sportart (alias), Markt-Typ, market_type und die Auswahl-Arten.
  //   Fussball:   „Match Result" (P1XP2 / MatchResult), W1 / X / W2.
  //   Basketball: „Match Winner" (P1P2 / MatchWinner2), W1 / W2 — 2-Weg INKLUSIVE Verlaengerung, dieselbe Wette wie die
  //               Pinnacle-Moneyline. „Match Result (Regular Time)" (P1XP2 / MatchWinner3, 3-Weg) ist eine ANDERE Wette und
  //               hat einen anderen Typ — er kommt in der Antwort auf die Anfrage unten gar nicht vor (gemessen 04.10.2026 an
  //               einem Vorspiel- und einem laufenden Spiel: genau ein Markt P1P2 / MatchWinner2, Auswahlen W1 und W2).
  // Dieselbe Zuordnung fuehrt der Edge-Dienst (lib/betconstruct.js SPORT) — dessen Quote hat den EV ergeben.
  const SIEGER = {
    soccer: { alias: "Soccer", typ: "P1XP2", art: "MatchResult", arten: { W1: "home", X: "draw", W2: "away" }, markt: "1x2-Markt", maerkte: "1x2-Maerkte", kein: "kein Fussball" },
    basketball: { alias: "Basketball", typ: "P1P2", art: "MatchWinner2", arten: { W1: "home", W2: "away" }, markt: "Sieger-Markt", maerkte: "Sieger-Maerkte", kein: "kein Basketball" },
    // 19.10.2026: weitere Sportarten (nur vor dem Anpfiff, eigenes Konto) — Swarm-Sportart, Markt-Typ und market_type wie der Edge-Dienst
    tennis: { alias: "Tennis", typ: "P1P2", art: "MatchResult", arten: { W1: "home", W2: "away" }, markt: "Sieger-Markt", maerkte: "Sieger-Maerkte", kein: "kein Tennis" },
    icehockey: { alias: "IceHockey", typ: "P1P2", art: "MatchWinner2", arten: { W1: "home", W2: "away" }, markt: "Sieger-Markt", maerkte: "Sieger-Maerkte", kein: "kein Eishockey" },
    volleyball: { alias: "Volleyball", typ: "P1P2", art: "MatchWinner2", arten: { W1: "home", W2: "away" }, markt: "Sieger-Markt", maerkte: "Sieger-Maerkte", kein: "kein Volleyball" },
    amfootball: { alias: "AmericanFootball", typ: "P1P2", art: "MatchWinner", arten: { W1: "home", W2: "away" }, markt: "Sieger-Markt", maerkte: "Sieger-Maerkte", kein: "kein American Football" },
    baseball: { alias: "Baseball", typ: "P1P2", art: "MatchResult", arten: { W1: "home", W2: "away" }, markt: "Sieger-Markt", maerkte: "Sieger-Maerkte", kein: "kein Baseball" },
  };
  // Sportart des Auftrags: ohne Angabe Fussball (Auftraege von vor dem 04.10.2026). Unbekannt = null -> wird nicht gesetzt.
  function siegerVon(auswahl) {
    const k = auswahl && auswahl.sport != null && auswahl.sport !== "" ? String(auswahl.sport) : "soccer";
    return Object.prototype.hasOwnProperty.call(SIEGER, k) ? SIEGER[k] : null;
  }
  // Schein-Felder der beiden mitgelesenen Wetten: Source 42 = Desktop, Type 1 = Einzelwette, OddType 0 = Dezimal,
  // AcceptTypeId 0 = „Always ask" (das Buch nimmt KEINE Quotenaenderung an), Tags 216 = Marke der Spiel-Ansicht.
  const HERKUNFT = 42, EINZELWETTE = 1, NIE_ANNEHMEN = 0, DEZIMAL = 0, MARKE = 216;
  // Sicherheitsgrenzen dieses Scripts (EUR) — nicht die Limits des Buchs (Mindesteinsatz des Partners 0,10; das Maximum je
  // Auswahl sagt get_max_bet, darueber lehnt das Buch mit ClientBetStakeLimitError ab).
  const MIN_EINSATZ = 0.1, MAX_EINSATZ = 1000;
  const LESE_FRIST_MS = 8000, SETZ_FRIST_MS = 120000;
  const SOFORT_MS = 2500;                             // so lange wartet platziere() selbst auf die Antwort (vor dem Anpfiff ~1 s)
  const NACH_MS = 1500;                               // Abstand der Nachfragen des Service Workers
  const WARTE_MAX_MS = 75000;                         // laenger wird auf die Antwort nicht gewartet -> Read-back, sonst uncertain
  const WARTE_ALT_MS = 5 * 60000;                     // verwaiste Warte-Eintraege (Service Worker weg) geben das Spiel wieder frei
  const WETTEN_TAGE = 7;                              // so weit zurueck werden offene Wetten gelesen (Katalog: 7 Tage Vorlauf)
  const DOPPEL_SCHUTZ = true;                         // schon eine offene Wette auf das Spiel im Konto -> nicht senden
  // Swarm-Codes (Swarm.js der Seite + Sonden 04.10.2026). Nur diese gelten als ausdrueckliche Ablehnung — jeder andere
  // Code nach dem Absenden ist „ungewiss" (3/4/23 heissen z. B. Dienst nicht erreichbar / Zeitueberschreitung).
  const CODE_OK = 0, CODE_ABGEMELDET = 12;
  const CODES_ABGELEHNT = { 2: "Befehl vom Buch nicht angenommen", 5: "Sitzung der Seite verloren", 12: "nicht angemeldet — auf efbet.gr einloggen", 27: "das Buch verlangt ein Captcha", 32: "das Buch verlangt ein Captcha",
    33: "das Buch verlangt ein Captcha", 34: "das Buch verlangt ein Captcha", 41: "das Buch verlangt eine Sicherheitspruefung", 558: "Sitzung der Seite schon aktiv" };
  // Wett-Staende von check_bet_status (useCheckBetStatus.js der Seite): 1 Accepted, 3 Lost, 4 Won, 5 CashOut, 6 LostReturn =
  // die Wette wurde angenommen. 0 NotFound, 2 Returned (zurueckgegeben) sind kein Beleg.
  const STAND_ANGENOMMEN = { 1: 1, 3: 1, 4: 1, 5: 1, 6: 1 };
  const warte = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (e) => String((e && e.message) || e);
  const rund2 = (x) => Math.round(Number(x) * 100) / 100;
  const _laeuft = new Set();                          // Spiele, fuer die in diesem Tab gerade ein Auftrag laeuft
  const _wartend = new Map();                         // warteId -> gesendeter Schein, dessen Antwort noch aussteht
  let _warteNr = 0;

  // ---- Bruecke zur Seiten-Welt (efbet-inject.js) -------------------------------------------------------------------------
  const _offen = new Map();                           // Auftrags-Nr. -> { fertig, gesendet, t }
  let _bNr = 0;
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== VON_SEITE || typeof d.id !== "string") return;
    const w = _offen.get(d.id);
    if (!w) return;
    if (d.kind === "gesendet") { w.gesendet = true; return; }   // Quittung der Bruecke: der Schein ist auf dem Socket
    if (d.kind !== "antwort") return;
    _offen.delete(d.id); clearTimeout(w.t);
    w.fertig(d);
  });
  // art: lesen | konto | stand | setzen. Antwort der Bruecke: { ok, antwort:{code,msg,data} } | { ok:false, gesendet, fehler }.
  // gesendet false = nachweislich nichts gesendet; true = gesendet, aber keine Antwort; null = die Bruecke schweigt ganz.
  function bruecke(art, command, params, fristMs) {
    return new Promise((fertig) => {
      const id = "f" + (++_bNr) + "-" + Math.random().toString(36).slice(2, 10);
      const w = { fertig, gesendet: false, t: null };
      // Die Frist haelt die Bruecke selbst; dieser Zeitgeber faengt nur den Fall, dass sie gar nicht antwortet.
      w.t = setTimeout(() => { if (_offen.delete(id)) fertig({ ok: false, gesendet: w.gesendet ? true : null, fehler: "Bruecke zur Seite antwortet nicht" }); }, fristMs + 2000);
      _offen.set(id, w);
      try { window.postMessage({ source: AN_SEITE, kind: "frage", id, art, command, params, fristMs }, location.origin); }
      catch (e) { _offen.delete(id); clearTimeout(w.t); fertig({ ok: false, gesendet: false, fehler: "Bruecke nicht erreichbar: " + text(e) }); }
    });
  }
  // Lesender Befehl ueber den Socket der Seite: { code, msg, data } | { fehler }.
  async function lies(command, params, fristMs) {
    const r = await bruecke("lesen", command, params, fristMs || LESE_FRIST_MS);
    if (!r || !r.ok || !r.antwort) return { fehler: String((r && r.fehler) || "keine Antwort").slice(0, 120) };
    return r.antwort;
  }

  // Offene Wetten des Kontos (nur lesen): { ok, wetten:[{id, zeit, quote, einsatz, auswahl:[{id, spiel}]}] } | { ok:false, grund }.
  // Dreierlei: Sitzungs-Pruefung (nur angemeldet lesbar — sonst Code 12), Doppel-Schutz und Read-back ohne Wett-Nr.
  async function offeneWetten(jetzt) {
    const bis = Math.floor(jetzt / 1000) + 300, von = bis - WETTEN_TAGE * 86400;
    const a = await lies("bet_history", { where: { outcome: 0, from_date: von, to_date: bis, all_bet_types: true } });
    if (a.fehler) return { ok: false, grund: "Konto nicht lesbar (" + a.fehler + ")" };
    if (a.code === CODE_ABGEMELDET) return { ok: false, grund: "nicht angemeldet — auf efbet.gr einloggen" };
    if (a.code !== CODE_OK) return { ok: false, grund: "Konto nicht lesbar (Swarm-Code " + String(a.code) + ")" };
    const b = a.data && a.data.bets;
    if (!Array.isArray(b)) return { ok: false, grund: "Konto nicht lesbar (unerwartete Antwort)" };
    return { ok: true, wetten: b };
  }
  // Sitzungs-Pruefung ohne Nebenwirkung: ein lesender Befehl, den nur eine angemeldete Sitzung beantwortet.
  async function sessionPruefen(jetzt) {
    const o = await offeneWetten(jetzt);
    return o.ok ? { ok: true, wetten: o.wetten } : { ok: false, grund: o.grund };
  }

  // PURE: Antwort auf die Spiel-Anfrage -> die genannte Auswahl mit allem, was der Schein braucht; sonst { fehler } (fail-closed).
  // Drei unabhaengige Merkmale muessen passen: das Spiel hat die Sportart des Auftrags und steht in der verlangten Phase, es
  // traegt GENAU EINEN Sieger-Markt dieser Sportart mit genau dessen Auswahlen (Fussball W1 / X / W2, Basketball W1 / W2), und
  // die genannte Nummer sitzt auf der genannten Seite dieses Markts.
  function quoteAus(a, auswahl, jetzt) {
    const M = siegerVon(auswahl);
    if (!M) return { fehler: "Sportart nicht angebunden" };
    if (!a || a.fehler) return { fehler: "Spiel nicht lesbar (" + String((a && a.fehler) || "keine Antwort") + ")" };
    if (a.code !== CODE_OK) return { fehler: "Spiel nicht lesbar (Swarm-Code " + String(a.code) + ")" };
    const S = a.data && a.data.data && a.data.data.sport;
    const sids = S && typeof S === "object" ? Object.keys(S) : [];
    // Ein Spiel ohne offenen Sieger-Markt liefert der Swarm bei diesem Filter gar nicht (50-fallen.md S58).
    if (!sids.length) return { fehler: "Spiel oder " + M.markt + " nicht (mehr) im Angebot" };
    if (sids.length !== 1 || !S[sids[0]]) return { fehler: "mehrere Sportarten in der Antwort" };
    if (S[sids[0]].alias !== M.alias) return { fehler: M.kein };
    const G = S[sids[0]].game && typeof S[sids[0]].game === "object" ? S[sids[0]].game : {}, gids = Object.keys(G);
    const g = gids.length === 1 ? G[gids[0]] : null;
    if (!g || String(g.id) !== String(auswahl.eventId) || String(gids[0]) !== String(auswahl.eventId)) return { fehler: "anderes Spiel in der Antwort" };
    // Phase streng getrennt. „laeuft" wie im Board-Satz des Dienstes: Live-Liste UND gestartet (efbet fuehrt Spiele schon
    // ~30 min vor dem Anpfiff als „Not Started" in der Live-Liste — das ist ein Vorspiel-Angebot).
    const info = g.info && typeof g.info === "object" ? g.info : {}, zustand = String(info.current_game_state == null ? "" : info.current_game_state);
    const laeuft = Number(g.type) === 1 && Number(g.is_started) !== 0 && zustand !== "notstarted";
    const anstoss = Number(g.start_ts) > 0 ? Number(g.start_ts) * 1000 : 0;
    if (auswahl.live === true) { if (!laeuft) return { fehler: "Spiel laeuft beim Buch nicht (kein Live-Spiel) — Live-Auftrag nur im laufenden Spiel" }; }
    else if (laeuft || !(anstoss > jetzt)) return { fehler: "Spiel laeuft schon oder Anstoss unbekannt — nur vor dem Anpfiff" };
    if (Number(g.is_blocked) === 1) return { fehler: "Spiel gesperrt" };
    const MK = g.market && typeof g.market === "object" ? g.market : {};
    let markt = null, nM = 0;
    for (const mid of Object.keys(MK)) { const m = MK[mid]; if (!m || m.type !== M.typ || m.market_type !== M.art) continue; nM++; markt = m; }
    if (nM !== 1) return { fehler: nM ? "mehrere " + M.maerkte : M.markt + " nicht (mehr) offen" };
    const E = markt.event && typeof markt.event === "object" ? markt.event : {}, je = {};
    const seiten = Object.keys(M.arten), ungenau = M.markt + " hat nicht genau die Auswahlen " + seiten.join(" / ");
    let nE = 0;
    for (const eid of Object.keys(E)) {
      const e = E[eid]; if (!e) continue;
      nE++;
      const art = String(e.type_1 == null ? "" : e.type_1);
      if (!Object.prototype.hasOwnProperty.call(M.arten, art) || je[art]) return { fehler: ungenau };
      je[art] = e;
    }
    if (nE !== seiten.length || seiten.some((x) => !je[x])) return { fehler: ungenau };
    const e = Object.prototype.hasOwnProperty.call(M.arten, String(auswahl.art)) ? je[auswahl.art] : null;
    if (!e || String(e.id) !== String(auswahl.outcomeId)) return { fehler: "Auswahl-Nummer gehoert nicht (mehr) zu dieser Seite des " + M.markt + "s" };
    if (!/^\d{1,15}$/.test(String(e.id))) return { fehler: "Auswahl-Nummer unlesbar" };
    const preis = Number(e.price);
    if (!(preis > 1) || !isFinite(preis)) return { fehler: "keine Quote" };
    return { preis, auswahlId: String(e.id), buchSel: M.arten[auswahl.art], spielId: String(g.id), marktId: String(markt.id), live: laeuft };
  }
  // PURE: die Anfrage dazu — EIN Spiel, nur der Markt-Typ des Sieger-Markts der Sportart (typ), nie als Abo.
  function quoteAnfrage(eventId, typ) {
    return { source: "betting",
      what: { sport: ["id", "alias"], game: ["id", "team1_name", "team2_name", "start_ts", "type", "is_blocked", "is_started", "info"], market: ["id", "type", "market_type", "sequence"], event: ["id", "type_1", "price"] },
      where: { game: { id: Number(eventId) }, market: { type: String(typ) } }, subscribe: false };
  }
  // 17.10.2026 (Arb-Bot Stufe 2) — LINIEN-Maerkte (nur Fussball, ganzes Spiel): Asiatisches Handicap und Tore Over/Under. Die Auswahl
  // kommt aus dem Swarm-Stand des Edge-Dienstes (/auswahl … &markt=ah|tot, lib/betconstruct.js linienAuswahl) und traegt Markt-Nummer,
  // Markt-Typ, Auswahl-Art (type_1 wie im Swarm) und die Linie DIESER Auswahl (base). Vor dem Senden wird GENAU dieser Markt frisch
  // ueber den Socket der Seite gelesen; es muessen passen: Spiel, Phase, Markt-Nummer und -Typ, genau zwei Auswahlen, die genannte
  // Nummer mit der genannten Art und Linie, beim Handicap die Gegenseite auf −Linie, bei Over/Under beide auf derselben Linie.
  const LINIE = {
    ah: { typen: { AsianHandicap: 1 }, arten: { Home: "home", Away: "away", W1: "home", W2: "away", P1: "home", P2: "away", Team1: "home", Team2: "away" }, name: "Handicap" },
    tot: { typen: { OverUnder: 1 }, arten: { Over: "over", Under: "under" }, name: "Over/Under" }
  };
  const istLinie = (a) => !!(a && (a.markt === "ah" || a.markt === "tot"));
  function quoteAnfrageLinie(eventId, marktId) {
    return { source: "betting",
      what: { sport: ["id", "alias"], game: ["id", "team1_name", "team2_name", "start_ts", "type", "is_blocked", "is_started", "info"], market: ["id", "type", "market_type", "sequence", "base"], event: ["id", "type", "type_1", "price", "base"] },
      where: { game: { id: Number(eventId) }, market: { id: Number(marktId) } }, subscribe: false };
  }
  function quoteAusLinie(a, auswahl, jetzt) {
    const K = LINIE[auswahl.markt];
    if (!K || String(auswahl.sport == null || auswahl.sport === "" ? "soccer" : auswahl.sport) !== "soccer") return { fehler: "Linien-Maerkte nur beim Fussball" };
    if (!a || a.fehler) return { fehler: "Spiel nicht lesbar (" + String((a && a.fehler) || "keine Antwort") + ")" };
    if (a.code !== CODE_OK) return { fehler: "Spiel nicht lesbar (Swarm-Code " + String(a.code) + ")" };
    const S = a.data && a.data.data && a.data.data.sport, sids = S && typeof S === "object" ? Object.keys(S) : [];
    if (!sids.length) return { fehler: "Spiel oder " + K.name + "-Markt nicht (mehr) im Angebot" };
    if (sids.length !== 1 || !S[sids[0]] || S[sids[0]].alias !== "Soccer") return { fehler: "kein Fussball" };
    const G = S[sids[0]].game && typeof S[sids[0]].game === "object" ? S[sids[0]].game : {}, gids = Object.keys(G);
    const g = gids.length === 1 ? G[gids[0]] : null;
    if (!g || String(g.id) !== String(auswahl.eventId) || String(gids[0]) !== String(auswahl.eventId)) return { fehler: "anderes Spiel in der Antwort" };
    const info = g.info && typeof g.info === "object" ? g.info : {}, zustand = String(info.current_game_state == null ? "" : info.current_game_state);
    const laeuft = Number(g.type) === 1 && Number(g.is_started) !== 0 && zustand !== "notstarted";
    const anstoss = Number(g.start_ts) > 0 ? Number(g.start_ts) * 1000 : 0;
    if (laeuft || !(anstoss > jetzt)) return { fehler: "Spiel laeuft schon oder Anstoss unbekannt — Linien nur vor dem Anpfiff" };
    if (Number(g.is_blocked) === 1) return { fehler: "Spiel gesperrt" };
    const MK = g.market && typeof g.market === "object" ? g.market : {}, mids = Object.keys(MK);
    if (mids.length !== 1 || !MK[mids[0]] || String(MK[mids[0]].id) !== String(auswahl.marktId)) return { fehler: K.name + "-Markt nicht (mehr) offen" };
    const m = MK[mids[0]];
    if (!K.typen[String(m.type)] || String(m.type) !== String(auswahl.typ)) return { fehler: "anderer Markt-Typ (" + String(m.type) + ")" };
    if (auswahl.marktArt != null && String(m.market_type) !== String(auswahl.marktArt)) return { fehler: "anderer Markt (" + String(m.market_type) + ")" };
    const E = m.event && typeof m.event === "object" ? m.event : {}, liste = Object.keys(E).map((k) => E[k]).filter(Boolean);
    if (liste.length !== 2) return { fehler: K.name + "-Markt hat nicht genau zwei Auswahlen" };
    const artVon = (e) => String(e.type_1 == null || e.type_1 === "" ? (e.type == null ? "" : e.type) : e.type_1).trim();
    const e = liste.find((x) => String(x.id) === String(auswahl.outcomeId)), anders = liste.find((x) => x !== e);
    if (!e || !anders) return { fehler: "Auswahl-Nummer gehoert nicht (mehr) zu diesem Markt" };
    if (artVon(e) !== String(auswahl.art) || !K.arten[artVon(e)] || !K.arten[artVon(anders)] || K.arten[artVon(e)] === K.arten[artVon(anders)]) return { fehler: "Auswahl sitzt nicht auf der erwarteten Seite (" + artVon(e) + ")" };
    const zahl = (x) => (x === null || x === undefined || x === "" || !isFinite(Number(x))) ? null : Number(x);
    const soll = Number(auswahl.base);
    if (auswahl.markt === "ah") {
      const b1 = zahl(e.base), b2 = zahl(anders.base);
      if (b1 == null || b2 == null || Math.abs(b1 - soll) > 1e-9 || Math.abs(b1 + b2) > 1e-9) return { fehler: "Handicap-Linie hat sich geaendert (" + b1 + " statt " + soll + ")" };
    } else {
      const b1 = zahl(e.base) != null ? zahl(e.base) : zahl(m.base), b2 = zahl(anders.base) != null ? zahl(anders.base) : zahl(m.base);
      if (b1 == null || Math.abs(b1 - soll) > 1e-9 || (b2 != null && Math.abs(b2 - soll) > 1e-9)) return { fehler: "Tor-Linie hat sich geaendert (" + b1 + " statt " + soll + ")" };
    }
    if (!/^\d{1,15}$/.test(String(e.id))) return { fehler: "Auswahl-Nummer unlesbar" };
    const preis = Number(e.price);
    if (!(preis > 1) || !isFinite(preis)) return { fehler: "keine Quote" };
    const seite = K.arten[artVon(e)];
    return { preis, auswahlId: String(e.id), buchSel: seite + " " + (auswahl.markt === "ah" && soll > 0 ? "+" : "") + soll, spielId: String(g.id), marktId: String(m.id), live: laeuft };
  }

  // Frische Quote unmittelbar vor dem Senden (PT08) — ueber den Socket der Seite, nie aus einem Zwischenspeicher.
  async function frischeQuote(auswahl) {
    if (istLinie(auswahl)) {
      try { return quoteAusLinie(await lies("get", quoteAnfrageLinie(auswahl.eventId, auswahl.marktId)), auswahl, Date.now()); }
      catch (e) { return { fehler: "Spiel nicht lesbar: " + text(e) }; }
    }
    const M = siegerVon(auswahl);
    if (!M) return { fehler: "Sportart nicht angebunden" };
    try { return quoteAus(await lies("get", quoteAnfrage(auswahl.eventId, M.typ)), auswahl, Date.now()); }
    catch (e) { return { fehler: "Spiel nicht lesbar: " + text(e) }; }
  }
  // Hoechsteinsatz des Buchs fuer diese Auswahl (nur lesen; die Seite fragt denselben Befehl fuer ihren MAX-Knopf).
  // Zahl oder null (nicht lesbar — dann entscheidet das Buch beim Absenden selbst).
  async function maxEinsatz(auswahlId) {
    try {
      const a = await lies("get_max_bet", { events: [{ event_id: Number(auswahlId) }], type: EINZELWETTE });
      const m = a && a.code === CODE_OK && a.data && Number(a.data.result) === 0 && a.data.details ? Number(a.data.details.amount) : NaN;
      return isFinite(m) && m >= 0 ? m : null;
    } catch (_) { return null; }
  }

  // PURE: Schein aus frischer Quote und Einsatz — Feld fuer Feld wie die beiden mitgelesenen Wetten (Reihenfolge inklusive).
  // Keine Netz-, DOM- oder Zeitzugriffe. Die Anmeldung steckt nicht im Schein: sie haengt an der Sitzung des Sockets.
  function baueSchein(auswahl, quote, einsatz) {
    return { command: "create_bets", params: { bets: [{ Source: HERKUNFT, Type: EINZELWETTE, AcceptTypeId: NIE_ANNEHMEN, OddType: DEZIMAL, EachWay: false,
      Events: [{ Coeficient: quote.preis, SelectionId: Number(quote.auswahlId) }], IsSuperBet: false, Amount: Number(einsatz), Tags: MARKE }] } };
  }

  // DIE Absende-Funktion: einziger Punkt ohne Wiederkehr dieses Buchs. Ab dem Auftrag an die Seiten-Bruecke kann Geld
  // unterwegs sein. art "gesperrt" nur, wenn die Bruecke ausdruecklich meldet, dass sie NICHT gesendet hat.
  async function sende(schein) {
    const r = await bruecke("setzen", schein.command, schein.params, SETZ_FRIST_MS);
    if (r && r.ok && r.antwort) return { art: "antwort", json: r.antwort };
    if (r && r.gesendet === false) return { art: "gesperrt", grund: BUCH + ": nichts gesendet — " + String(r.fehler || "die Seiten-Bruecke hat abgelehnt").slice(0, 160) };
    if (r && r.fehler === "zeit") return { art: "zeit" };
    return { art: "netzfehler", fehler: String((r && r.fehler) || "keine Antwort").slice(0, 160) };
  }

  // PURE: Wahrheitstabelle. Eingabe ist NUR die Rueckgabe von sende() und die gesendete Quote.
  // Die Texte nennen bewusst kein "HTTP 401/403": darauf fasst das Side Panel einmal nach (_placeRetryable).
  function klassifiziere(antwort, quote) {
    if (!antwort || antwort.art === "gesperrt") return { status: "blocked", reason: (antwort && antwort.grund) || BUCH + ": nichts gesendet" };
    if (antwort.art === "netzfehler") return { status: "uncertain", reason: BUCH + ": Verbindung der Seite beim Absenden abgerissen — im Konto pruefen (" + antwort.fehler + ")", odds: quote.preis };
    if (antwort.art === "zeit") return { status: "uncertain", reason: BUCH + ": keine Antwort des Buchs in der Frist — im Konto pruefen", odds: quote.preis };
    if (antwort.art !== "antwort" || !antwort.json) return { status: "uncertain", reason: BUCH + ": unbekannte Antwort — im Konto pruefen", odds: quote.preis };
    const j = antwort.json, code = Number(j.code);
    if (code !== CODE_OK) {
      const zusatz = j.msg ? " — " + String(j.msg).slice(0, 80) : "";
      if (CODES_ABGELEHNT[code]) return { status: "failed", reason: BUCH + ": abgelehnt — " + CODES_ABGELEHNT[code] + " (Swarm-Code " + code + zusatz + ")", odds: quote.preis };
      return { status: "uncertain", reason: BUCH + ": unklare Antwort des Buchs (Swarm-Code " + String(j.code) + zusatz + ") — im Konto pruefen", odds: quote.preis };
    }
    const d = j.data;
    if (!d || typeof d !== "object") return { status: "uncertain", reason: BUCH + ": leere Antwort des Buchs — im Konto pruefen", odds: quote.preis };
    if (String(d.StatusCode) === "0") {
      // Angenommen: Data = Liste der Wetten (hier genau eine) mit Wett-Nr., Quote, Einsatz und der Auswahl.
      const w = Array.isArray(d.Data) && d.Data.length === 1 ? d.Data[0] : null;
      const ev = w && Array.isArray(w.events) && w.events.length === 1 ? w.events[0] : null;
      if (!w || w.bet_id == null || !ev) return { status: "uncertain", reason: BUCH + ": Annahme ohne lesbare Wett-Nr. — im Konto pruefen", odds: quote.preis };
      const ticket = String(w.bet_id), fill = Number(w.k) > 1 ? Number(w.k) : quote.preis, stake = Number(w.amount) > 0 ? Number(w.amount) : undefined;
      if (String(ev.selection_id) !== String(quote.auswahlId)) return { status: "uncertain", ticket, reason: BUCH + ": die Antwort nennt eine andere Auswahl als die gesendete — im Konto pruefen", odds: fill, stake };
      if (w.is_superbet === true) return { status: "uncertain", ticket, reason: BUCH + ": Wette liegt beim Buch zur Pruefung (Superbet) — im Konto pruefen", odds: fill, stake };
      return { status: "placed", ticket, odds: fill, stake };
    }
    // Ausdrueckliche Ablehnung des Wett-Systems: StatusCode ungleich "0", Data = Text oder { Key, ErrorData }.
    const sc = d.StatusCode != null ? String(d.StatusCode) : "";
    const key = typeof d.Data === "string" ? d.Data : (d.Data && typeof d.Data === "object" && d.Data.Key != null ? String(d.Data.Key) : "");
    if (!sc && !key) return { status: "uncertain", reason: BUCH + ": kein eindeutiges Verdikt des Buchs — im Konto pruefen", odds: quote.preis };
    let was = key || "Status " + sc;
    const ed = d.Data && typeof d.Data === "object" && d.Data.ErrorData && typeof d.Data.ErrorData === "object" ? d.Data.ErrorData : null;
    if (ed) {
      // BetSelectionChanged nennt die neue Quote (ActualPrice), ClientBetStakeLimitError die Grenze — beides gehoert in den Vermerk.
      const teile = Object.keys(ed).filter((k) => typeof ed[k] === "number" || typeof ed[k] === "string").slice(0, 6).map((k) => k + " " + String(ed[k]).slice(0, 24));
      if (teile.length) was += " (" + teile.join(", ") + ")";
    }
    return { status: "failed", reason: BUCH + ": abgelehnt — " + was.slice(0, 200), odds: quote.preis };
  }

  // Read-back-Kern: true/false, null = nicht lesbar. Ein Treffer steht in ziel.fund { id, quote, einsatz }.
  // Mit Wett-Nr. (ziel.betId): der Stand GENAU dieser Wette samt ihrer Auswahl. Ohne: steht seit dem Absenden eine NEUE
  // offene Einzelwette auf genau diese Auswahl im Konto (Wett-Nr. vorher unbekannt)?
  async function betExists(ziel) {
    if (ziel.betId != null) {
      const a = await lies("check_bet_status", { bet_id: Number(ziel.betId) });
      if (!a || a.fehler || a.code !== CODE_OK || !a.data) return null;
      const d = a.data.details;
      if (!d) return /BetNotFound/i.test(String(a.data.result_text || "")) ? false : null;
      if (String(d.Id) !== String(ziel.betId) || d.IsSuperBet === true) return null;
      const s = Array.isArray(d.SelectionList) && d.SelectionList.length === 1 ? d.SelectionList[0] : null;
      if (!s || String(s.SelectionId) !== String(ziel.auswahlId)) return null;
      if (!STAND_ANGENOMMEN[Number(d.StateId)]) return null;      // z. B. Returned: das Konto entscheidet
      ziel.fund = { id: String(d.Id), quote: Number(d.Price) > 1 ? Number(d.Price) : null, einsatz: Number(d.Amount) > 0 ? Number(d.Amount) : null };
      return true;
    }
    const o = await offeneWetten(Date.now());
    if (!o.ok) return null;
    for (const w of o.wetten) {
      if (!w || w.id == null || ziel.vorher[String(w.id)]) continue;
      if (!Array.isArray(w.auswahl) || w.auswahl.length !== 1 || String(w.auswahl[0].id) !== String(ziel.auswahlId)) continue;
      if (Number(w.zeit) > 0 && Number(w.zeit) * 1000 < ziel.start - 120000) continue;       // aelter als der Auftrag: nicht unsere
      ziel.fund = { id: String(w.id), quote: Number(w.quote) > 1 ? Number(w.quote) : null, einsatz: Number(w.einsatz) > 0 ? Number(w.einsatz) : null };
      return true;
    }
    return false;
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

  // Ergebnis eines gesendeten Scheins: Wahrheitstabelle, dann Read-back. w = { quote, einsatz, wunsch, vorher, start }.
  async function abschluss(w, antwort) {
    const erg = Object.assign(klassifiziere(antwort, w.quote), { buchSel: w.quote.buchSel });
    if (erg.status === "blocked" || erg.status === "failed") return erg;
    const ziel = { auswahlId: w.quote.auswahlId, vorher: w.vorher, start: w.start, betId: erg.ticket != null ? erg.ticket : null, fund: null };
    const gekappt = w.wunsch > w.einsatz ? { wantStake: w.wunsch, partial: true } : {};
    if (erg.status === "placed") {
      if (erg.stake == null) erg.stake = w.einsatz;
      const rb = await readBack(ziel);
      return Object.assign(erg, gekappt, { verified: rb === true }, rb === true ? {} : { note: "Wett-Nr. vergeben, per Read-back (noch) nicht bestaetigt" });
    }
    // uncertain: findet der Read-back die Wette im Konto, ist sie gesetzt — sonst bleibt der Ausgang offen.
    if ((await readBack(ziel)) === true) {
      return Object.assign({ status: "placed", ticket: ziel.fund.id, odds: ziel.fund.quote || erg.odds || w.quote.preis, stake: ziel.fund.einsatz || w.einsatz, verified: true, buchSel: w.quote.buchSel,
        note: "per Read-back bestaetigt (Antwort des Buchs war unklar)" }, gekappt);
    }
    // Ausgang offen: steht die Wette doch im Konto, lautet sie auf den gesendeten (ggf. gekappten) Betrag.
    return Object.assign(erg, erg.stake == null ? { stake: w.einsatz } : {}, gekappt);
  }
  // Wartezeit zu Ende (Antwort da oder Frist um): Eintrag loeschen, Spiel wieder frei, Ergebnis nach der Wahrheitstabelle.
  async function schliesse(w, antwort) {
    try {
      const erg = await abschluss(w, antwort);
      const wie = " (nach " + Math.round((Date.now() - w.start) / 1000) + " s, " + w.fragen + " Nachfragen)";
      if (erg.status === "placed") erg.note = (erg.note ? erg.note + " — " : "") + "vom Buch nach Wartezeit angenommen" + wie;
      else if (erg.reason) erg.reason = String(erg.reason) + wie;
      return erg;
    } finally { _wartend.delete(w.id); _laeuft.delete(w.spiel); }
  }
  // EINE Nachfrage zu einem gesendeten Schein (Befehl efbetNachfragen): ist die Antwort des Buchs inzwischen da?
  async function nachfragen(msg) {
    const w = _wartend.get(String(msg && msg.warteId));
    if (!w) return { status: "uncertain", reason: BUCH + ": Warte-Auftrag unbekannt (Tab neu geladen?) — im Konto pruefen" };
    const noch = { status: "pending", warteId: w.id, nachMs: NACH_MS, odds: w.quote.preis, buchSel: w.quote.buchSel };
    if (w.fragt) return noch;
    w.fragt = true;
    try {
      w.fragen++;
      if (w.antwort) return await schliesse(w, w.antwort);
      if (Date.now() - w.start >= WARTE_MAX_MS) return await schliesse(w, { art: "zeit" });
      return noch;
    } catch (e) {
      _wartend.delete(w.id); _laeuft.delete(w.spiel);
      return { status: "uncertain", odds: w.quote.preis, buchSel: w.quote.buchSel, reason: BUCH + ": " + text(e) + " — im Konto pruefen" };
    } finally { w.fragt = false; }
  }

  async function platziere(msg) {
    const a = msg && msg.auswahl;
    const wunsch = rund2(msg && msg.einsatz), minOdds = Number(msg && msg.minOdds);
    const M = siegerVon(a);
    if (a && !M) return { status: "blocked", reason: BUCH + ": Sportart " + String(a.sport).slice(0, 24) + " ist bei diesem Buch nicht angebunden" };
    if (istLinie(a)) {
      // Linie (AH / Over-Under): Markt-Nummer, Typ, Art und Linie muessen mitkommen; geprueft wird gegen den frisch gelesenen Markt
      if (!a.eventId || !a.outcomeId || !/^\d{1,15}$/.test(String(a.marktId || "")) || !LINIE[a.markt].typen[String(a.typ)] || !LINIE[a.markt].arten[String(a.art)] || !isFinite(Number(a.base)) || a.live === true)
        return { status: "blocked", reason: BUCH + ": unvollstaendige Linien-Auswahl (Spiel, Auswahl-, Markt-Nummer, Typ, Art und Linie noetig; nur vor dem Anpfiff)" };
    }
    else if (!a || !a.eventId || !a.outcomeId || !Object.prototype.hasOwnProperty.call(M.arten, String(a.art))) return { status: "blocked", reason: BUCH + ": unvollstaendige Auswahl (Spiel, Auswahl-Nummer und Art " + (M ? Object.keys(M.arten).join("/") : "W1/X/W2") + " noetig)" };
    if (!/^\d{1,15}$/.test(String(a.eventId)) || !/^\d{1,15}$/.test(String(a.outcomeId))) return { status: "blocked", reason: BUCH + ": Spiel- oder Auswahl-Nummer unlesbar" };
    if (!(wunsch >= MIN_EINSATZ) || wunsch > MAX_EINSATZ) return { status: "blocked", reason: BUCH + ": Einsatz " + wunsch + " ausserhalb " + MIN_EINSATZ + "-" + MAX_EINSATZ };
    if (!(minOdds > 1)) return { status: "blocked", reason: BUCH + ": minOdds fehlt" };
    const spiel = String(a.eventId);
    for (const [k, alt] of _wartend) if (Date.now() - alt.start > WARTE_ALT_MS) { _wartend.delete(k); _laeuft.delete(alt.spiel); }   // verwaist (niemand fragt mehr)
    if (_laeuft.has(spiel)) return { status: "blocked", reason: BUCH + ": fuer dieses Spiel laeuft schon ein Auftrag" };
    _laeuft.add(spiel);
    let gesendet = false, wartet = false;
    try {
      // Konto zuerst (Sitzung, Doppel-Schutz, Hoechsteinsatz), die Quote zuletzt: sie ist beim Senden nur einen Abruf alt.
      const [sess, max] = await Promise.all([sessionPruefen(Date.now()), maxEinsatz(a.outcomeId)]);
      if (!sess.ok) return { status: "blocked", reason: BUCH + ": " + sess.grund };
      const vorher = {};
      let schonDa = false;
      for (const w of sess.wetten) { if (!w || w.id == null) continue; vorher[String(w.id)] = 1; if (Array.isArray(w.auswahl) && w.auswahl.some((x) => x && String(x.spiel) === spiel)) schonDa = true; }
      if (DOPPEL_SCHUTZ && schonDa) return { status: "blocked", reason: BUCH + ": im Konto steht schon eine offene Wette auf dieses Spiel (Doppel-Schutz)" };
      // Einsatz ueber dem Hoechsteinsatz des Buchs: auf das Maximum kappen (wie Foxtipp), nie anheben.
      let einsatz = wunsch;
      if (max != null && einsatz > max) einsatz = Math.floor(max * 100 + 1e-6) / 100;
      if (!(einsatz >= MIN_EINSATZ)) return { status: "blocked", reason: BUCH + ": Hoechsteinsatz des Buchs " + String(max) + " unter dem Mindesteinsatz " + MIN_EINSATZ };
      const q = await frischeQuote(a);
      if (!q || q.fehler) return { status: "blocked", reason: BUCH + ": " + ((q && q.fehler) || "keine frische Quote") };
      if (q.preis < minOdds) return { status: "blocked", reason: BUCH + ": " + q.preis + " unter Min " + minOdds, odds: q.preis };
      const schein = baueSchein(a, q, einsatz);
      const w = { id: "w" + (++_warteNr) + "-" + spiel, spiel, quote: q, einsatz, wunsch, vorher, start: Date.now(), antwort: null, fragen: 0, fragt: false };
      gesendet = true;
      const lauf = sende(schein);                      // PUNKT OHNE WIEDERKEHR
      const erst = await Promise.race([lauf, warte(SOFORT_MS).then(() => null)]);
      if (erst) return await abschluss(w, erst);
      // Noch keine Antwort (live haelt das Buch sie zurueck): der Schein ist beim Buch, das Spiel bleibt gesperrt, und der
      // Service Worker fragt nach. Die Antwort wird gemerkt, sobald sie eintrifft.
      lauf.then((x) => { w.antwort = x || { art: "netzfehler", fehler: "leere Antwort der Bruecke" }; }, (e) => { w.antwort = { art: "netzfehler", fehler: text(e) }; });
      _wartend.set(w.id, w);
      wartet = true;
      return { status: "pending", warteId: w.id, nachMs: NACH_MS, odds: q.preis, buchSel: q.buchSel };
    } catch (e) {
      // Ausnahme nach dem Senden = unbekannter Ausgang -> uncertain; davor ist nachweislich nichts gesendet.
      return gesendet ? { status: "uncertain", reason: BUCH + ": " + text(e) + " — im Konto pruefen" } : { status: "blocked", reason: BUCH + ": " + text(e) };
    } finally { if (!wartet) _laeuft.delete(spiel); }
  }

  // Zustand fuer Keepalive und Bettor-Status (nur lesen): Bruecke da? Socket offen? Angemeldet? Kontostand (nur Zahlen).
  async function stand() {
    const aus = { ok: true, bm: BUCH, v: V, bruecke: false, socket: null, angemeldet: null, konto: null, grund: "" };
    const b = await bruecke("stand", "", null, 2000);
    if (!b || !b.ok || !b.stand) { aus.grund = "Seiten-Bruecke fehlt — efbet-Tab neu laden"; return aus; }
    aus.bruecke = true; aus.socket = b.stand.socket;
    if (b.stand.socket !== 1) { aus.grund = b.stand.socket == null ? "Socket der Seite noch nicht erfasst — efbet-Tab einmal neu laden" : "Socket der Seite nicht offen"; return aus; }
    const k = await bruecke("konto", "", null, LESE_FRIST_MS);
    if (!k || !k.ok || !k.antwort) { aus.grund = "Konto nicht lesbar (" + String((k && k.fehler) || "keine Antwort").slice(0, 80) + ")"; return aus; }
    if (k.antwort.code === CODE_ABGEMELDET) { aus.angemeldet = false; aus.grund = "nicht angemeldet — auf efbet.gr einloggen"; return aus; }
    if (k.antwort.code !== CODE_OK) { aus.grund = "Konto nicht lesbar (Swarm-Code " + String(k.antwort.code) + ")"; return aus; }
    aus.angemeldet = true;
    aus.konto = (k.antwort.data && k.antwort.data.konto) || null;
    return aus;
  }

  // ---- Kombiwette (05.10.2026): Wege zum Buch fuer efbet-kombi.js ------------------------------------------------------------
  // Der Baustein bekommt genau die Funktionen dieses Scripts: lies (lesender Befehl ueber die Seiten-Bruecke), die Regeln des
  // Partners (Art „vorgaben“ der Bruecke: Steuer, Kombi-Quote — oeffentlich), sende (DIE Absende-Funktion) und die Liste der
  // Spiele, auf denen in diesem Tab gerade ein Auftrag laeuft (eine Einzelwette und eine Kombi auf dasselbe Spiel nie zugleich).
  const kombiDa = () => (typeof EFKOMBI !== "undefined" && !!EFKOMBI && typeof EFKOMBI.place === "function" && typeof EFKOMBI.nachfragen === "function");
  const KOMBI_ENV = {
    lies, sende,
    vorgaben: () => bruecke("vorgaben", "", null, LESE_FRIST_MS),
    belegt: (spiele) => spiele.some((s) => _laeuft.has(String(s))),
    belegen: (spiele) => { for (const s of spiele) _laeuft.add(String(s)); },
    freigeben: (spiele) => { for (const s of spiele) _laeuft.delete(String(s)); },
    emit: (m, d) => { try { chrome.runtime.sendMessage({ cmd: "log", entry: { t: new Date().toISOString(), src: "place", msg: m, data: Object.assign({ bm: BUCH }, d || {}) } }).catch(() => {}); } catch (_) {} },
  };

  chrome.runtime.onMessage.addListener((msg, _sender, send) => {
    if (!msg || !msg.cmd) return;
    if (msg.cmd === "ping") { send({ ok: true, bm: BUCH, v: V, kombi: kombiDa() }); return; }
    // 05.10.2026 — KOMBIWETTE: der Ablauf steht in efbet-kombi.js (EFKOMBI; in Erweiterung und Manometer Agent byte-gleich). Er liest
    // und sendet ueber DIESELBEN Wege wie die Einzelwette: lies() fuer alles Lesende, sende() als einzigen Punkt ohne Wiederkehr.
    if (msg.cmd === "efbetPlaceCombo" || msg.cmd === "efKombiNachfragen") {
      if (!kombiDa()) { send({ status: "blocked", reason: BUCH + " combo: placement script not loaded (reload the efbet tab)" }); return; }
      const lauf = msg.cmd === "efKombiNachfragen" ? EFKOMBI.nachfragen(msg.warteId, KOMBI_ENV) : EFKOMBI.place(msg, KOMBI_ENV);
      Promise.resolve(lauf).then(send).catch((e) => send({ status: "uncertain", reason: BUCH + " combo: " + text(e) + " — check the bet history" }));
      return true;
    }
    if (msg.cmd === "efbetStand") {
      stand().then(send).catch((e) => send({ ok: true, bm: BUCH, v: V, bruecke: false, socket: null, angemeldet: null, konto: null, grund: text(e) }));
      return true;
    }
    if (msg.cmd === "efbetPlace") {
      platziere(msg).then(send).catch((e) => send({ status: "uncertain", reason: BUCH + ": " + text(e) }));
      return true;
    }
    if (msg.cmd === "efbetNachfragen") {
      nachfragen(msg).then(send).catch((e) => send({ status: "uncertain", reason: BUCH + ": " + text(e) + " — im Konto pruefen" }));
      return true;
    }
  });
})();
