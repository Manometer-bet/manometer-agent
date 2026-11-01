// content/foxtipp-place.js — Manometer Agent: Setz-Script im Tab von foxtipp.com. 31.10.2026.
//
//
// Portiert aus background.js des Operators: handleFoxPlace (Ablauf, Schein, Einsatzgrenzen), foxOutcome (Wahrheitstabelle), foxNetOdds
// (Gebuehr). Der Operator sendet aus dem Service Worker und erntet dafuer die Sitzung; hier laeuft derselbe Ablauf IN DER SEITE, damit
// die Sitzung den Tab nie verlaesst (kein Speicher, keine Nachricht, kein Protokoll): die Seite legt sie in localStorage["token"] und
// schickt sie als Kopfzeile sessionid (Seiten-Code HttpService). Mehr verlangt die Seite nicht: siteid, lang, sessionid.
//
// Nur Fussball, nur Sieger-Markt 997 („Tipp“, 1X2), nur vor dem Anpfiff (der Schein des Operators fuehrt Live:false / IsLive:false; ein
// laufendes Spiel beantwortet matchdetailnew mit 204, gemessen 31.10.2026), nur mit der GENAUEN Auswahl-Nummer des Operators (outcomeId
// = Odds[].Id des Buchs). Die Engine sucht nie selbst eine Auswahl und uebersetzt nie Heim/Gast.
//
// GEBUEHR: Foxtipp behaelt 5 % des Einsatzes ein (gesendet 5,00 → gestellt 4,75 → Auszahlung 4,75 × Quote). Wie beim Operator gilt:
//   an die Schnittstelle geht die BRUTTO-Quote (das erwartet der Server),
//   die Mindestquote minOdds gilt gegen die NETTO-Quote (brutto × (1 − (FeeRate − 1)), auf drei Stellen; Operator: foxNetOdds),
//   zurueck an die Engine geht netto (res.odds) und der GESENDETE Einsatz (res.stake, nicht TotalStake).
//
// Antworten: placed | failed (das Buch hat abgelehnt, sicher nicht gesetzt) | blocked (nichts gesendet) | uncertain (Schein war raus,
// Ergebnis unklar — im Konto pruefen). Vor dem Senden ist jeder Zweifel blocked, nach dem Senden gibt es nie mehr blocked. Es wird genau
// EINMAL gesendet: dieselbe Auftrags-Nummer laeuft in diesem Tab nie zweimal (Kit-Falle P24); frei wird sie nur, wenn nichts gesendet wurde.
(() => {
  "use strict";
  if (window.__engineFoxPlace) return;   // schon da: der Service Worker laedt den Tab neu, wenn die Version nicht passt
  window.__engineFoxPlace = true;
  let IS_TOP = false; try { IS_TOP = window.top === window; } catch (_) { IS_TOP = false; }
  const VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return "?"; } })();
  const WIRTE = { "foxtipp.com": true, "www.foxtipp.com": true };   // fox365.com aus BOOKMAKERS.foxtipp gibt es nicht mehr (DNS NXDOMAIN, 31.10.2026)
  const API = "https://foxtipp.com/backend/api";                    // CORS erlaubt jede Herkunft mit diesen Kopfzeilen (gemessen 31.10.2026)
  const KOPF = { "Content-Type": "application/json", "siteid": "16", "lang": "de" };
  const MARKT = 997, SPORT_FUSSBALL = 2;
  const TIP_VON = { 3: "1", 4: "X", 5: "2" };                       // OutcomeId in matchdetailnew; gemessen 31.10.2026: 14 Spiele, 42 Auswahlen, gleiche Id, Quote und Name wie im Katalog
  const SITZUNG_RE = /^[0-9a-f-]{20,}$/i;                           // Form wie _foxSetAuth des Operators
  const FRIST_MS = 15000;                                           // je Abruf, wie foxPost des Operators
  let _gebuehr = 1.05;                                              // wie _foxFee des Operators; jede Schein-Pruefung zieht sie nach (scheinAus)

  const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : null);
  const sauber = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const zahl = (x) => (typeof x === "number" ? x : (typeof x === "string" && x.trim() !== "" ? Number(x) : NaN));

  // PURE — Brutto → Netto, Rechnung und Rundung wie foxNetOdds des Operators.
  function netto(brutto, gebuehr) {
    const raw = Number(brutto);
    if (!(raw > 1)) return 0;
    return Math.round(raw * (1 - (gebuehr - 1)) * 1000) / 1000;
  }
  // Anstoss des Buchs: Md ohne Zeitzone ist UTC (gemessen 31.10.2026: Md 08:40, Spielminute 20 um 08:59 UTC).
  function anstoss(md) {
    const t = String(md == null ? "" : md);
    return Date.parse(/(?:Z|[+\-]\d\d:?\d\d)$/.test(t) ? t : t + "Z") || 0;
  }

  // PURE — frischer Abruf matchdetailnew + Auftrag → { auswahl } | { fehler (englisch) }. Die Regeln zum Markt wie foxParseMatch des
  // Operators (Heim und Gast offen, sonst steht das Spiel fuer ihn nicht im Brett); „nicht wettbar“ wie die Seite selbst: Active false,
  // Quote 1 oder 1,01, BetStatus false. sel ist die Sicht des Operators und wird nie uebersetzt — nur ein Remis ist in beiden Sichten
  // dasselbe, und das wird gegengeprueft.
  function waehleAuswahl(d, eventId, outcomeId, sel, jetztMs) {
    if (!obj(d) || !obj(d.Markets)) return { fehler: "the game of the book is not readable" };
    if (String(d.MatchId) !== String(eventId)) return { fehler: "the book answered with another game" };
    if (d.SportId !== SPORT_FUSSBALL) return { fehler: "this game is not football" };
    const heim = sauber(d.Home), gast = sauber(d.Away);
    if (!heim || !gast) return { fehler: "home and away team of the book not readable" };
    if (d.BetStatus !== true) return { fehler: "the game is not open for betting" };
    if (!(anstoss(d.Md) > jetztMs)) return { fehler: "the game has started — pre-match only" };
    const ms = [];
    for (const g of Object.keys(d.Markets)) for (const m of (Array.isArray(d.Markets[g]) ? d.Markets[g] : [])) if (obj(m) && m.Id === MARKT) ms.push(m);
    if (ms.length !== 1) return { fehler: ms.length ? "the book lists the winner market more than once — unclear" : "the winner market is not offered" };
    const zeilen = (Array.isArray(ms[0].Odds) ? ms[0].Odds : []).filter(obj);
    if ([3, 4, 5].some((oc) => zeilen.filter((o) => o.OutcomeId === oc).length > 1)) return { fehler: "the winner market lists an outcome more than once — unclear" };
    const offen = (o) => o.Active === true && zahl(o.OddsValue) > 1.01;
    if (![3, 5].every((oc) => zeilen.some((o) => o.OutcomeId === oc && offen(o)))) return { fehler: "the winner market of the book is not open on both sides" };
    const treffer = zeilen.filter((o) => String(o.Id) === String(outcomeId));
    if (treffer.length !== 1) return { fehler: treffer.length ? "the selection number is listed more than once — unclear" : "the selection number of the order is not in the winner market of this game" };
    const o = treffer[0], tip = TIP_VON[o.OutcomeId];
    if (!tip) return { fehler: "the selection is not 1, X or 2" };
    if (!offen(o)) return { fehler: "the selection is suspended" };
    if ((sel === "draw") !== (tip === "X")) return { fehler: "the order says " + String(sel) + " but the selection number is outcome " + tip + " — unclear" };
    return { auswahl: { eventId: String(d.MatchId), oddsId: o.Id, tip, brutto: zahl(o.OddsValue), team1: heim, team2: gast, startTime: String(d.Md),
      rid: d.RefId != null ? String(d.RefId) : null, league: [d.Category, d.Tournament].filter(Boolean).join(" / ") } };
  }

  // PURE — Antwort von /betslip/limits + Wunsch-Einsatz → { stake } | { fehler }. Unter dem Minimum: nie anheben. Ueber dem Maximum: auf das
  // Maximum kappen (beides wie handleFoxPlace). Strenger als der Operator, weil die Seite es so liest: MaxStake 0 heisst dort „Limit dieses
  // Spiels ausgeschoepft“ (der Operator wertete 0 als „keine Grenze“), Active 0 sperrt die Auswahl, und ohne lesbare Zahlen wird nicht gesetzt.
  function grenzenAus(j, einsatz) {
    if (!obj(j)) return { fehler: "stake limits of the book not readable" };
    if (j.Active === 0 || j.Active === false) return { fehler: "the book has closed this selection for new bets" };
    const minS = zahl(j.MinStake), maxS = zahl(j.MaxStake);
    if (!(minS >= 0) || !(maxS >= 0) || minS > maxS) return { fehler: "stake limits of the book not readable" };
    if (maxS === 0) return { fehler: "the stake limit of this game is used up" };
    if (einsatz < minS) return { fehler: "stake " + einsatz + " below the minimum " + minS + " of the book — not raised" };
    return einsatz > maxS ? { stake: maxS, gekappt: true } : { stake: einsatz, gekappt: false };
  }

  // PURE — der Schein-Eintrag, Feld fuer Feld wie „const leg“ in handleFoxPlace (Test: gegen den Quelltext des Operators).
  function bein(a) {
    return {
      Id: Number(a.eventId), Tournament: a.league || "", Iso: "   ",
      Teams: a.team1 + " - " + a.team2, Banko: false, HomeTeamName: a.team1, AwayTeamName: a.team2,
      Odds: [{ Id: a.oddsId, MatchId: Number(a.eventId), Market: "Tipp", MarketId: MARKT, Outcome: a.tip, OutcomeId: a.oddsId,
               Value: a.brutto, Active: true, IsSpecial: false, Live: false, HomeScore: 0, AwayScore: 0,
               RefMatchId: a.rid ? Number(a.rid) : 0, BetRefId: 0, OddRefId: 0 }],
      BulletinId: 0, StartDate: a.startTime, SportId: SPORT_FUSSBALL, TournamentId: 0, IsOutright: false,
    };
  }

  // PURE — Antwort von /betslip → { gebuehr } | { fehler }. Abweichende Quote = nicht setzen (Echo-Vergleich wie handleFoxPlace). FeeRate fehlt
  // oder ist 0: die letzte bekannte Gebuehr bleibt (Operator: if (slip.body.FeeRate) …; die Seite baut Scheine mit FeeRate 0), eine
  // unlesbare FeeRate ist ein Zweifel. Strenger als der Operator: ohne Echo der Auswahl wird nicht gesetzt.
  function scheinAus(j, a, gebuehrBisher) {
    if (!obj(j) || j.Success !== true) return { fehler: "the slip check of the book refused the bet" + (obj(j) && j.Message ? " (" + sauber(j.Message).slice(0, 160) + ")" : "") };
    if (j.OddsChanged === true) return { fehler: "the odds changed in the slip check of the book" };
    let gebuehr = gebuehrBisher;
    if (j.FeeRate != null && j.FeeRate !== 0) {
      gebuehr = zahl(j.FeeRate);
      if (!(gebuehr >= 1 && gebuehr < 1.5)) return { fehler: "the stake fee of the book is not readable" };
    }
    const M = Array.isArray(j.Matches) && j.Matches.length === 1 ? obj(j.Matches[0]) : null;
    const e = M && Array.isArray(M.Odds) && M.Odds.length === 1 ? obj(M.Odds[0]) : null;
    if (!e) return { fehler: "the slip check of the book does not name the selection" };
    if ((M.Id != null && String(M.Id) !== String(a.eventId)) || (e.Id != null && String(e.Id) !== String(a.oddsId))) return { fehler: "the slip check of the book names another selection" };
    if (M.BetStatus === false || e.Active === false) return { fehler: "the slip check of the book reports the selection as closed" };
    const v = zahl(e.Value);
    if (!(v > 1) || Math.abs(v - a.brutto) > 0.0011) return { fehler: "the odds in the slip differ (" + String(e.Value) + " instead of " + a.brutto + ")" };
    return { gebuehr };
  }

  // PURE — Wahrheitstabelle wie foxOutcome des Operators. NACH gesendetem Schein darf eine unbekannte Antwort NIE „blocked“ heissen: die Wette
  // koennte existieren. placed nur mit Success:true UND TicketId; failed nur, wenn das Buch OHNE Ticket benennt, dass es abgelehnt hat.
  function antwortAus(res) {
    if (!res) return { status: "uncertain", reason: "foxtipp: no answer to the ticket — check the bet history" };
    const b = res.body;
    if (b && b.Success === true && b.TicketId) {
      const rs = b.Result || {};
      return { status: "placed", ticket: String(b.TicketId), grossOdds: Number(rs.MaxOdds) || null, totalStake: Number(rs.TotalStake) || null, payout: Number(rs.PossiblePayout) || null, message: b.Message || null };
    }
    if (b && b.Success === false && !b.TicketId && (b.Message || b.ErrorNumber != null)) return { status: "failed", reason: "foxtipp: the book declined: " + sauber(b.Message || ("ErrorNumber " + b.ErrorNumber)).slice(0, 200) };
    return { status: "uncertain", reason: "foxtipp: unclear answer to the ticket (HTTP " + res.status + ") — check the bet history" };
  }

  // Wie foxPost des Operators; ohne sid ein reiner Lese-Abruf (Lesen braucht nur siteid).
  async function post(pfad, inhalt, sid) {
    const ctl = new AbortController(), frist = setTimeout(() => { try { ctl.abort(); } catch (_) {} }, FRIST_MS);
    try {
      const r = await fetch(API + pfad, { method: "POST", headers: sid ? Object.assign({}, KOPF, { "sessionid": sid }) : KOPF, body: JSON.stringify(inhalt), credentials: "omit", cache: "no-store", signal: ctl.signal });
      const txt = await r.text();
      let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (_) { j = null; }
      return { ok: r.ok, status: r.status, body: j };
    } finally { clearTimeout(frist); }
  }
  function sitzung() {
    try { const t = localStorage.getItem("token"); return SITZUNG_RE.test(String(t == null ? "" : t)) ? String(t) : null; } catch (_) { return null; }
  }
  // Waehrung des Kontos: der gespeicherte Stand der Seite (reduxPersist:profile → profile.Currency, Seiten-Code; die Seite selbst steht auf CHF
  // als Vorgabe). Der Einsatz kommt in Euro, dieser Weg rechnet nicht um: 5 im Schein waeren sonst 5 CHF. Der Operator kennt das nicht (sein Konto ist in Euro).
  function kontoWaehrung() {
    try { const j = JSON.parse(localStorage.getItem("reduxPersist:profile")), c = j && j.profile && j.profile.Currency; return /^[A-Za-z]{3}$/.test(String(c == null ? "" : c)) ? String(c).toUpperCase() : null; } catch (_) { return null; }
  }
  function ort() {
    try { if (String(location.protocol) !== "https:" || !WIRTE[String(location.hostname)]) return "this tab is not foxtipp.com"; } catch (_) { return "this tab is not foxtipp.com"; }
    return null;
  }

  async function einzel(msg) {
    const T0 = Date.now();
    const mit = (o) => Object.assign(o, { ms: Date.now() - T0 });
    const nein = (grund, mehr) => mit(Object.assign({ status: "blocked", reason: "foxtipp: " + grund + " — nothing sent" }, mehr || {}));
    let gesendet = false, netNow = null, stake = null;
    try {
      const o = ort(); if (o) return nein(o);
      const eventId = String(msg && msg.eventId != null ? msg.eventId : ""), outcomeId = String(msg && msg.outcomeId != null ? msg.outcomeId : "");
      if (!/^\d{4,12}$/.test(eventId)) return nein("event number missing");
      if (!/^\d{4,14}$/.test(outcomeId)) return nein("exact selection number of the operator missing");
      const einsatz = Math.round(Number(msg.amount) * 100) / 100, minOdds = Number(msg.minOdds);
      if (!(einsatz > 0)) return nein("stake missing");
      if (!(minOdds > 1)) return nein("minimum odds missing");
      // (1) Sitzung
      const sid = sitzung();
      if (!sid) return nein("not signed in at foxtipp.com");
      const cur = kontoWaehrung();
      if (!cur) return nein("the currency of the account is not readable in this tab");
      if (cur !== "EUR") return nein("the account runs in " + cur + ", stakes come in EUR and this path does not convert");
      // (2) FRISCHE Quote des Buchs, EIN Abruf nur fuer dieses Spiel (der Operator: ganzes Brett oder Turnier; hier gemessen dieselben Zahlen)
      const d = await post("/prematch/matchdetailnew", { MatchId: Number(eventId), IsNewMobile: true, Mobile: false });
      if (d.status === 204) return nein("the game is not offered before kick-off (any more)");
      if (!d.ok || !d.body) return nein("game not readable (HTTP " + d.status + ")");
      const w = waehleAuswahl(d.body, eventId, outcomeId, msg.sel, Date.now());
      if (w.fehler) return nein(w.fehler);
      const a = w.auswahl;
      const zuTief = (n) => "odds " + n.toFixed(3) + " net (" + a.brutto + " shown, stake fee " + _gebuehr + ") below min " + minOdds.toFixed(3);
      netNow = netto(a.brutto, _gebuehr);
      if (netNow < minOdds) return nein(zuTief(netNow), { odds: netNow });
      // (3) Einsatzgrenzen je Auswahl — reines Lesen
      const lim = await post("/betslip/limits", { OddsId: a.oddsId }, sid);
      if (lim.status === 401 || lim.status === 403) return nein("not signed in at foxtipp.com (the book answered " + lim.status + ")");
      if (!lim.ok || !lim.body) return nein("stake limits of the book not readable (HTTP " + lim.status + ")");
      const g = grenzenAus(lim.body, einsatz);
      if (g.fehler) return nein(g.fehler);
      stake = g.stake;
      // (4) Schein-Pruefung (nebenwirkungsfrei laut Operator: kein Einsatz im Abruf, offene Tickets 3 → 3)
      const leg = bein(a);
      const slip = await post("/betslip", { Ticket: [leg], Type: "R" }, sid);
      if (slip.status === 401 || slip.status === 403) return nein("not signed in at foxtipp.com (the book answered " + slip.status + ")");
      if (!slip.ok || !slip.body) return nein("the slip check of the book is not readable (HTTP " + slip.status + ")");
      const s = scheinAus(slip.body, a, _gebuehr);
      if (s.fehler) return nein(s.fehler);
      _gebuehr = s.gebuehr;
      // Die Gebuehr kann sich geaendert haben: Netto neu pruefen — die letzte Pruefung unmittelbar vor dem Senden.
      netNow = netto(a.brutto, _gebuehr);
      if (netNow < minOdds) return nein(zuTief(netNow), { odds: netNow });
      if (msg.armed !== true) return mit({ status: "staged", odds: netNow, brutto: a.brutto, stake, tip: a.tip, teams: a.team1 + " – " + a.team2 });
      // (5) PUNKT OHNE WIEDERKEHR — genau ein Abruf, keine Wiederholung. AccepptOddsChanges (Tippfehler ist deren Feldname) false: der Server
      // lehnt bei einer Quotenaenderung ab, statt unter dem Floor zu fuellen.
      gesendet = true;
      const res = await post("/ticket/placeticket", { Odds: [leg], Stake: stake, IsSystem: false, IsLive: false, AccepptOddsChanges: false, Systems: [] }, sid);
      const out = antwortAus(res);
      if (out.status === "placed") {
        const fill = out.grossOdds > 1 ? netto(out.grossOdds, _gebuehr) : netNow;
        return mit({ status: "placed", ticket: out.ticket, odds: fill, brutto: out.grossOdds || a.brutto, stake, totalStake: out.totalStake, payout: out.payout, tip: a.tip, teams: a.team1 + " – " + a.team2,
          gekappt: g.gekappt || undefined, note: fill < minOdds ? "filled net " + fill.toFixed(3) + ", below min " + minOdds.toFixed(3) + " — check" : undefined });
      }
      return mit({ status: out.status, reason: out.reason, odds: netNow, stake });
    } catch (e) {
      const fehler = String((e && e.message) || e).slice(0, 120);
      if (gesendet) return mit({ status: "uncertain", reason: "foxtipp: connection broke while sending the ticket (" + fehler + ") — check the bet history", odds: netNow, stake });
      return nein("connection to the book failed (" + fehler + ")");
    }
  }

  // Ein Setz-Auftrag laeuft in diesem Tab nur einmal; zwei Empfaenger oder doppelte Zustellung bekommen dasselbe Ergebnis. Die Nummer wird nur
  // frei, wenn NICHTS gesendet wurde — dann darf der Service Worker denselben Vorschlag spaeter noch einmal pruefen lassen.
  const _laeufe = (window.__engineFoxLaeufe && typeof window.__engineFoxLaeufe.get === "function") ? window.__engineFoxLaeufe : (window.__engineFoxLaeufe = new Map());
  function einmal(msg, lauf) {
    const nr = (msg && typeof msg.auftragId === "string" && /^[A-Za-z0-9_.:-]{6,80}$/.test(msg.auftragId)) ? msg.auftragId : null;
    if (!nr) return Promise.resolve({ status: "blocked", reason: "foxtipp: order number missing — nothing sent" });
    if (_laeufe.has(nr)) return _laeufe.get(nr);
    let p; try { p = Promise.resolve(lauf()); } catch (e) { p = Promise.reject(e); }
    _laeufe.set(nr, p);
    p.then((r) => { if (r && (r.status === "blocked" || r.status === "staged")) _laeufe.delete(nr); }, () => {});
    while (_laeufe.size > 200) _laeufe.delete(_laeufe.keys().next().value);
    return p;
  }

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _s, reply) => {
      if (!IS_TOP || !msg || !msg.cmd) return false;
      if (msg.cmd === "fxPing") { reply({ ok: true, bm: "foxtipp", version: VERSION, ort: ort() }); return false; }
      if (msg.cmd === "fxPlace") { einmal(msg, () => einzel(msg)).then(reply).catch((e) => reply({ status: "uncertain", reason: "foxtipp: " + String((e && e.message) || e).slice(0, 160) + " — check the bet history" })); return true; }
      return false;
    });
  }
  // fuer Tests im Rechner (vm): die reinen Funktionen
  try { window.__engineFoxTest = { netto, anstoss, waehleAuswahl, grenzenAus, bein, scheinAus, antwortAus, einzel, einmal }; } catch (_) {}
})();
