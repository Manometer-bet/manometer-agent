// content/betonline-place.js — Manometer Agent: Setz-Script im Tab von www.betonline.ag. 31.10.2026.
//
//
// Uebernommen von betonline-content.js und background.js handleBoPlace des Operators. Wird nur per executeScript geladen (books/betonline.js),
// steht nicht im Manifest. Ablauf eines Auftrags (boPlace), je Schritt nur weiter, wenn alles stimmt:
//   1) Anmeldung: GET /get-token (gleiche Herkunft, Cookie der Seite) → JWT, 300 s gueltig. Wird NIE zwischengespeichert: die Antwort kann ein
//      fast abgelaufenes Token sein (Mitschnitt: Rest 108 s), und nach dem Senden gibt es keinen zweiten Versuch.
//   2) Frisches Angebot der Liga (api-offering, wie boOfferGames; ohne Cookie, wie die Seite selbst): das Spiel ueber GameId, die Rotation muss
//      in DIESEM Spiel genau die Seite sel sein, die drei Preise des Sieger-Markts muessen stehen, Preis ≥ Mindestquote.
//   3) POST /betslip/add-line: Schein-Zustand beim Buch, setzt nichts. Das Buch nennt die Mannschaft der Auswahl; sie muss die erwartete sein.
//   4) POST /betslip/place-bets — der Punkt ohne Wiederkehr. Genau EINMAL. Auch bei 401 / 403 kein zweiter Versuch (das tut nur der Operator).
// Antworten: placed | blocked (nichts gesendet, oder das Buch hat ausdruecklich abgelehnt) | uncertain (Schein war raus, Ergebnis unklar).
//
// PREIS: Auf dem Draht steht die amerikanische Quote; add-line und place-bets tragen nur sie. DecimalLine ist auf zwei Stellen GERUNDET und liegt
// bei 7 von 89 Preisen UEBER der echten Quote (−637: 1,16 statt 1,156986). Der Operator vergleicht nur DecimalLine — so fiel Ticket 990883257
// mit 1,909091 unter die Mindestquote 1,91 (−110, DecimalLine 1,91). Hier gilt deshalb der kleinere der beiden Werte. Das Buch selbst rechnet genau
// (place-bets: −111 → decimal 1.900901).
//
// lineChangeOption: bleibt 1 wie beim Operator (und wie die Voreinstellung der Seite). Die Bedeutung steht im Code der Seite (pty-betslip, Juni und
// September gleich): NO_CHANGE 0, FAVORABLE_CHANGE 1, ANY_CHANGE 2 — 1 heisst NUR BESSERE Quoten annehmen, nicht „Aenderungen akzeptieren“ wie
// in betonline-content.js steht. Bewegt sich die Linie gegen uns, lehnt das Buch ab (errors, code 157 „Odds change from … to …“ → blocked).
// Protokolle Operator 07.08.–28.10.: 55 verschiedene Verschlechterungen so abgelehnt, keine Verbesserung; es gibt Fuellungen ueber der gelesenen
// Quote (2,66 statt 2,58). Eine Ausnahme bleibt: Ticket 986021946, gelesen 2,00, gefuellt 1,970874. Darum wird die gefuellte Quote gelesen und eine
// Fuellung unter der Mindestquote als note gemeldet (wie handleBoPlace) — verhindern kann das nach dem Senden nichts mehr.
//
// Nur der OBERSTE Rahmen antwortet. Ein Auftrag laeuft in diesem Tab nur einmal (Auftrags-Nummer, Kit-Falle P24); die Liste haengt am Fenster, damit
// zwei Fassungen sie teilen. Hat er gesendet, bleibt die Nummer fuer immer belegt — jede Wiederholung bekommt dasselbe Ergebnis. Hat er nachweislich
// nichts gesendet, wird sie wieder frei, damit die Engine es spaeter noch einmal versuchen kann.
// Das Token und die Daten des Kontos stehen nie in einer Rueckgabe oder Meldung.
(() => {
  "use strict";
  const VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return "?"; } })();
  if (window.__engineBoPlace === VERSION) return;   // schon da (zweites Einspritzen); nach dem Neuladen der Erweiterung meldet sich die neue Fassung an
  window.__engineBoPlace = VERSION;
  let IS_TOP = false; try { IS_TOP = window.top === window; } catch (_) { IS_TOP = false; }

  const SLIP = "https://api-betslip.betonline.ag";
  const OFFER = "https://api-offering.betonline.ag";
  const GSETTING = "bolnasite";                     // statischer Site-Tag, wie BO_GSETTING des Operators
  const LINE_CHANGE = 1;                            // FAVORABLE_CHANGE, siehe Kopf
  const CUR = "USD";                                // nicht vom Buch gemeldet, siehe books/betonline.js
  const TOKEN_REST_S = 20;                          // so lange muss das Token noch gelten (wie der Operator); sonst nicht anfangen
  const TOKEN_REST_SENDEN_S = 5;                    // … und unmittelbar vor dem Senden
  const PREIS_TOLERANZ = 0.011;                     // DecimalLine gegen die amerikanische Quote: gemessen hoechstens 0,0053 (Rundung)
  const FRIST_MS = 12000, SENDE_FRIST_MS = 30000;   // nach SENDE_FRIST wird abgebrochen: uncertain, nie „nicht gesetzt“

  const sauber = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const gleich = (a, b) => { const x = sauber(a).toLowerCase(); return x !== "" && x === sauber(b).toLowerCase(); };
  const runde6 = (x) => Math.round(x * 1e6) / 1e6;
  const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : null);

  // PURE — amerikanische Quote → Dezimalquote, exakt. Nur ganze Zahlen mit Betrag ≥ 100 sind Quoten (Line 0 = kein Preis). Sonst null.
  function dezimalAus(am) {
    if (typeof am !== "number" || !Number.isInteger(am) || (am > -100 && am < 100)) return null;
    return am > 0 ? 1 + am / 100 : 1 + 100 / -am;
  }
  // PURE — ein MoneyLine-Objekt des Angebots → { american, dec, genau, preis } | null. preis = der kleinere Wert (siehe Kopf). Passen Line und DecimalLine
  // nicht zusammen, ist unklar, welcher Preis gilt.
  function preisAus(m) {
    const q = obj(m); if (!q) return null;
    const genau = dezimalAus(q.Line), dec = Number(q.DecimalLine);
    if (genau == null || !(dec > 1) || Math.abs(dec - genau) > PREIS_TOLERANZ) return null;
    return { american: q.Line, dec, genau, preis: Math.min(dec, genau) };
  }
  const offen = (m) => !!(obj(m) && Number(m.DecimalLine) > 1 && dezimalAus(m.Line) != null);

  // PURE — frisches Angebot + Auftrag → { auswahl } | { fehler (englisch), odds? }. Regeln wie boReadOdds / handleBoPlace des Operators; dazu: genau ein Spiel
  // mit dieser Nummer, kein verknuepftes Unter-Spiel, Rotation passt zur Seite, alle drei Preise da (Fussball ohne Remis-Preis waere „Draw No Bet“).
  // WagerCutOff bleibt bewusst aussen vor: die Zeit des Angebots liegt je nach Abruf daneben (zeitzonen-nicht-umstellen); den Anpfiff prueft
  // die Engine (startsTs), ein begonnenes Spiel lehnt das Buch ab (code 154).
  function pruefeAuswahl(j, a) {
    const gd = obj(j) && obj(j.GameOffering) && j.GameOffering.GamesDescription;
    if (!Array.isArray(gd)) return { fehler: "offering unreadable" };
    const spiele = gd.map((r) => r && r.Game).filter((g) => g && String(g.GameId) === String(a.eventId));
    if (!spiele.length) return { fehler: "game no longer offered" };
    if (spiele.length > 1) return { fehler: "game listed twice in the offering" };
    const g = spiele[0];
    if (g.ParentLinkEvent != null) return { fehler: "game number belongs to a linked sub-event" };
    const home = sauber(g.HomeTeam), away = sauber(g.AwayTeam);
    if (!home || !away) return { fehler: "team names missing in the offering" };
    const seiten = [["home", g.HomeRotation], ["away", g.AwayRotation], ["draw", g.DrawRotaion]].filter(([, r]) => String(r == null ? "" : r) === String(a.rotation));   // DrawRotaion: so heisst das Feld beim Buch
    if (seiten.length !== 1) return { fehler: "rotation " + a.rotation + " does not belong to this game" };
    const seite = seiten[0][0];
    if (seite !== a.sel) return { fehler: "wrong side: rotation " + a.rotation + " is " + seite + " in this game, the order says " + a.sel };
    if (!offen(g.HomeLine && g.HomeLine.MoneyLine) || !offen(g.AwayLine && g.AwayLine.MoneyLine) || !offen(g.DrawLine && g.DrawLine.MoneyLine)) return { fehler: "1X2 market incomplete (a moneyline without a draw price would be another bet)" };
    const zeile = seite === "home" ? g.HomeLine : seite === "away" ? g.AwayLine : g.DrawLine, p = preisAus(zeile && zeile.MoneyLine);
    if (!p) return { fehler: "price of the outcome unreadable (american and decimal disagree)" };
    if (p.preis < a.minOdds) return { fehler: "odds " + p.preis.toFixed(3) + " below min " + a.minOdds.toFixed(2), odds: runde6(p.preis) };
    return { auswahl: { eventId: Number(g.GameId), selectionId: Number(a.rotation), seite, home, away, american: p.american, dec: p.dec, genau: p.genau, preis: p.preis } };
  }

  // PURE — Zeile und Schein, Feld fuer Feld wie der echte Schein (Mitschnitt 27.06., Ticket 975269142) und betonline-content.js place.
  function zeileAus(w) {
    return { eventId: w.eventId, marketId: 1, selectionId: w.selectionId, periodId: 0, wagerType: 2, overUnder: 0, marketType: 0, source: 3, marketName: "0_" + w.eventId + "_2_" + w.selectionId, auxAltTag: null };
  }
  function addLineAus(w) {
    return { newPick: { line: zeileAus(w), odds: w.american, points: 0 }, lines: [], parlay: { picks: [] }, ifbet: { picks: [], ifBetOptionSelected: 0 }, teaser: { picks: [] } };
  }
  function scheinAus(w, toRisk) {
    return { state: { lines: [zeileAus(w)], straight: { picks: [{ lineIndex: 0, odds: w.american, points: 0, initialOdds: w.american, initialPoints: 0, toRisk, pitcherOption: -1, useFreePlay: false }] },
      parlay: { picks: [] }, robin: { picks: [], robinOptions: [] }, teaser: { picks: [] }, ifbet: { picks: [], ifBetOptionSelected: 0 }, reverse: { picks: [] }, sportcast: { picks: [] }, sportCastParlay: { picks: [] } },
      isConfirmedBet: true, lineChangeOption: LINE_CHANGE, device: 3 };
  }

  // PURE — Antwort auf add-line + Auswahl → null | Fehler. Das Buch nennt hier selbst, was im Schein liegt. Mitschnitt: eine Moneyline-Auswahl, Gast (teamSelected = Mannschaft,
  // subtitle „Money Line“, Namen gleich dem Angebot); Heim gilt dasselbe. Remis: nicht mitgeschnitten, deshalb nur „keine der beiden Mannschaften, kein anderer Markt“. Der Operator liest
  // diese Antwort gar nicht: passt sie einmal nicht, ist das hier eine Absage ohne Wette, und der Grund steht im Protokoll. Anderer Preis = die Linie hat sich gerade bewegt.
  function pruefeZeile(j, w) {
    const pd = obj(j) && obj(j.pickDetails), st = obj(j) && obj(j.straight);
    if (!pd || !st) return "answer to add-line unreadable";
    if (st.added !== true) return "the book did not add the selection to the slip";
    if (!gleich(pd.teamHome, w.home) || !gleich(pd.teamAway, w.away)) return "the book names another game on the slip";
    if (w.seite === "draw") {
      if (gleich(pd.teamSelected, w.home) || gleich(pd.teamSelected, w.away)) return "wrong side: the book puts a team on the slip, the order says draw";
      if (/spread|total/i.test(sauber(pd.subtitle))) return "the book names another market on the slip";
    } else {
      if (!gleich(pd.teamSelected, w.seite === "home" ? w.home : w.away)) return "wrong side: the book puts another team on the slip";
      if (!/^money\s*line$/i.test(sauber(pd.subtitle))) return "the book names another market on the slip";
    }
    const am = obj(pd.oddsFormats) ? pd.oddsFormats.american : undefined;
    if (am != null && Number(am) !== w.american) return "the price moved while adding to the slip";
    return null;
  }

  // PURE — Antwort auf place-bets → Ergebnis. Der Schein war raus: nur eine lesbare Absage OHNE Ticket ist „blocked“, alles Unklare „uncertain“ (Kit P45, P20).
  function fehlerText(f) {
    if (!obj(f)) return null;
    const t = [f.description, f.message, f.Message].find((x) => typeof x === "string" && x.trim());
    if (t) return (f.code != null ? "code " + f.code + " · " : "") + sauber(t).slice(0, 200);
    return f.code != null ? "code " + f.code : null;
  }
  function antwortAus(j, w, a) {
    const gefragt = runde6(w.genau);
    if (!obj(j)) return { status: "uncertain", reason: "betonline: answer to place-bets unreadable — check the bet history", odds: gefragt };
    const nummern = Array.isArray(j.ticketNumbers) ? j.ticketNumbers.filter((x) => (typeof x === "number" && x > 0) || (typeof x === "string" && x.trim())) : [];
    const fehler = Array.isArray(j.errors) ? j.errors : [];
    if (nummern.length) {
      const ticket = String(nummern[0]);
      if (fehler.length) return { status: "uncertain", ticket, reason: "betonline: ticket " + ticket + " together with an error (" + (fehlerText(fehler[0]) || "unreadable") + ") — check the bet history", odds: gefragt };
      let fill = null, fillAm = null;
      try { const f = j.newBetslipValues.betPayouts.straightBetPayoutFactor[0].odds; fill = Number(f.decimal) > 1 ? Number(f.decimal) : null; fillAm = Number.isInteger(f.american) ? f.american : null; } catch (_) {}
      const risk = Number(j.totalRisk), stake = risk >= 0.01 ? risk : a.toRisk;
      const notiz = [stake + " risked in the account currency (" + CUR + " assumed) — the EUR figure was not converted"];
      if (fill != null && fill < a.minOdds - 1e-9) notiz.push("filled @ " + fill + " — BELOW min " + a.minOdds + ", check the bet");
      else if (fillAm != null && fillAm !== w.american) notiz.push("filled at " + fillAm + ", read " + w.american);
      if (risk >= 0.01 && risk !== a.toRisk) notiz.push("book risked " + risk + " instead of " + a.toRisk);
      if (nummern.length > 1 || j.isPartial === true) notiz.push("answer shows " + nummern.length + " ticket(s)" + (j.isPartial === true ? ", partial" : "") + " — check the bet history");
      return { status: "placed", odds: fill != null ? fill : gefragt, ticket, stake, cur: CUR, note: notiz.join(" · ") };
    }
    if (fehler.length && j.isPartial !== true) {
      const t = fehlerText(fehler[0]);
      if (t) return { status: "blocked", reason: "betonline: " + t, odds: gefragt };
    }
    return { status: "uncertain", reason: "betonline: no ticket and no readable refusal in the answer — check the bet history", odds: gefragt };
  }

  async function abruf(url, opt, frist) {
    const ctl = new AbortController(), t = setTimeout(() => { try { ctl.abort(); } catch (_) {} }, frist);
    try { return await fetch(url, Object.assign({}, opt, { signal: ctl.signal })); }
    finally { clearTimeout(t); }
  }
  const kopf = (token) => Object.assign({ "Content-Type": "application/json", gsetting: GSETTING }, token ? { Authorization: "Bearer " + token } : {});

  // AUTH (betonline-content.js, Mitschnitt): api-betslip kennt kein Cookie (kein allow-credentials → credentials "include" scheitert schon an der
  // Vorabfrage), autorisiert wird per Bearer. Wirft mit einem Text OHNE das Token. Ablauf: epoch der Antwort (Mitschnitt: gleich exp), sonst exp im Token.
  function ablaufImToken(t) {
    try { const b = String(t).split(".")[1].replace(/-/g, "+").replace(/_/g, "/"); return Number(JSON.parse(atob(b + "===".slice((b.length + 3) % 4))).exp) || 0; }
    catch (_) { return 0; }
  }
  async function zugang() {
    let res;
    try { res = await abruf("/get-token", { credentials: "same-origin", cache: "no-store" }, FRIST_MS); }
    catch (_) { throw new Error("not logged in at betonline.ag (get-token not reachable)"); }
    if (!res.ok) throw new Error("not logged in at betonline.ag (get-token " + res.status + ")");
    let j = null; try { j = await res.json(); } catch (_) {}
    const token = j && typeof j.token === "string" ? j.token : "";
    if (!token) throw new Error("not logged in at betonline.ag (no token)");
    const zeiten = [Number(j.epoch), ablaufImToken(token)].filter((x) => x > 0);
    if (!zeiten.length) throw new Error("sign-in token without an expiry — not used");
    const exp = Math.min.apply(null, zeiten), rest = exp - Math.floor(Date.now() / 1000);
    return { token, exp, rest };
  }

  async function angebot(a) {
    const s = a.slug, pfad = s.scheduleText ? "/api/offering/Sports/offering-by-scheduletext" : "/api/offering/Sports/offering-by-league";
    const res = await abruf(OFFER + pfad, { method: "POST", headers: kopf(null), body: JSON.stringify({ Sport: s.sport, League: s.league, ScheduleText: s.scheduleText || null, filterTime: 0 }), credentials: "omit" }, FRIST_MS);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  }

  function auftragAus(msg) {
    const s = obj(msg.slug), a = { eventId: String(msg.eventId == null ? "" : msg.eventId), rotation: String(msg.rotation == null ? "" : msg.rotation), sel: msg.sel, toRisk: msg.toRisk, minOdds: Number(msg.minOdds), slug: s };
    if (!/^\d{4,12}$/.test(a.eventId) || !/^\d{1,12}$/.test(a.rotation)) return null;
    if (a.sel !== "home" && a.sel !== "draw" && a.sel !== "away") return null;
    if (!Number.isInteger(a.toRisk) || a.toRisk < 1 || !(a.minOdds > 1)) return null;
    if (!s || s.sport !== "soccer" || typeof s.league !== "string" || !s.league) return null;
    return a;
  }

  // z.gesendet wird UNMITTELBAR vor dem Abruf gesetzt: ab da gibt es fuer diesen Auftrag keinen zweiten Lauf mehr.
  async function einzel(msg, z) {
    const nein = (grund, odds) => ({ status: "blocked", reason: "betonline: " + grund + " — nothing sent", odds });
    if (msg.armed !== true) return nein("order not armed");
    if (abfrage()) return nein("Cloudflare check open in the tab, confirm it once");
    const a = auftragAus(msg);
    if (!a) return nein("order incomplete");
    let zu;
    try { zu = await zugang(); } catch (e) { return nein(String((e && e.message) || e)); }
    if (zu.rest < TOKEN_REST_S) return nein("sign-in token expires in " + zu.rest + " s");
    let j;
    try { j = await angebot(a); } catch (e) { return nein("offering fetch failed: " + String((e && e.message) || e).slice(0, 120)); }
    const w = pruefeAuswahl(j, a);
    if (w.fehler) return nein(w.fehler, w.odds);
    const au = w.auswahl;
    let zr, zj = null;
    try { zr = await abruf(SLIP + "/betslip/add-line", { method: "POST", headers: kopf(zu.token), body: JSON.stringify(addLineAus(au)), credentials: "omit" }, FRIST_MS); }
    catch (e) { return nein("add-line: network/CORS: " + String((e && e.message) || e).slice(0, 120)); }
    if (!zr.ok) return nein("add-line: HTTP " + zr.status);
    try { zj = await zr.json(); } catch (_) {}
    const zf = pruefeZeile(zj, au);
    if (zf) return nein(zf);
    if (zu.exp - Math.floor(Date.now() / 1000) < TOKEN_REST_SENDEN_S) return nein("sign-in token expired during the checks");

    // ---- AB HIER ist der Auftrag draussen: eine unklare Antwort heisst „vielleicht gesetzt“, nie „nicht gesetzt“. Kein zweiter Versuch, aus keinem Grund. ----
    const gefragt = runde6(au.genau);
    z.gesendet = true;
    let res;
    try { res = await abruf(SLIP + "/betslip/place-bets", { method: "POST", headers: kopf(zu.token), body: JSON.stringify(scheinAus(au, a.toRisk)), credentials: "omit" }, SENDE_FRIST_MS); }
    catch (e) { return { status: "uncertain", reason: "betonline: place-bets: connection lost after sending (" + String((e && e.message) || e).slice(0, 120) + ") — check the bet history", odds: gefragt }; }
    if (!res.ok) return { status: "uncertain", reason: "betonline: place-bets answered HTTP " + res.status + " — check the bet history", odds: gefragt };
    let antwort = null;
    try { antwort = await res.json(); } catch (_) { return { status: "uncertain", reason: "betonline: answer to place-bets is not JSON — check the bet history", odds: gefragt }; }
    return antwortAus(antwort, au, a);
  }

  // Ein Auftrag laeuft in diesem Tab nur einmal (Kopf). Die Liste haengt am Fenster: beide Fassungen sehen dieselben Auftraege.
  const _laeufe = (window.__engineBoLaeufe && typeof window.__engineBoLaeufe.get === "function") ? window.__engineBoLaeufe : (window.__engineBoLaeufe = new Map());
  function einmal(nr, lauf) {
    const da = _laeufe.get(nr);
    if (da) return da.p;
    const z = { p: null, gesendet: false };
    z.p = Promise.resolve().then(() => lauf(z)).catch((e) => ({ status: z.gesendet ? "uncertain" : "blocked", reason: "betonline: " + String((e && e.message) || e).slice(0, 120) + (z.gesendet ? " — check the bet history" : " — nothing sent") }));
    _laeufe.set(nr, z);
    z.p.then(() => { if (!z.gesendet && _laeufe.get(nr) === z) _laeufe.delete(nr); });
    while (_laeufe.size > 200) _laeufe.delete(_laeufe.keys().next().value);
    return z.p;
  }

  function abfrage() {
    try { return /just a moment|nur einen moment|un instant|attention required/i.test(document.title || "") || !!document.querySelector("#challenge-form, .cf-turnstile, #challenge-stage"); }
    catch (_) { return false; }
  }

  // Login-Probe und Kontostand fuer den Heartbeat (boAuth des Operators, ohne Token-Laenge). Zurueck gehen nur Zahlen. /wallet/customer/update-balance:
  // die Seite fragt sie selbst alle 6 s, ohne Inhalt, mit gsetting; die Antwort traegt auch Name und Kundennummer — die bleiben hier.
  async function kontoStand() {
    const zu = await zugang();
    const aus = { ok: true, loggedIn: true, expiresInSec: Math.max(0, zu.rest), saldo: null, bonus: null, hold: null };
    try {
      const r = await abruf("/wallet/customer/update-balance", { method: "POST", credentials: "same-origin", cache: "no-store", headers: kopf(null) }, FRIST_MS);
      const P = r.ok ? obj((await r.json()).Profile) : null;
      const zahl = (x) => (typeof x === "number" && isFinite(x) ? x : null);
      if (P) { aus.saldo = zahl(P.AvailableBalance); aus.bonus = zahl(P.FreePlayBalance); aus.hold = zahl(P.PendingWagerBalance); }
    } catch (_) {}
    return aus;
  }

  chrome.runtime.onMessage.addListener((msg, _abs, antwort) => {
    if (!IS_TOP || !msg || !msg.cmd) return false;
    if (msg.cmd === "boPing") { antwort({ ok: true, bm: "betonline", version: VERSION, abfrage: abfrage() }); return false; }
    if (msg.cmd === "boAuth") { kontoStand().then(antwort, (e) => antwort({ ok: false, loggedIn: false, fehler: String((e && e.message) || e).slice(0, 120) })); return true; }
    if (msg.cmd !== "boPlace") return false;
    if (!/^[A-Za-z0-9_.:-]{6,80}$/.test(String(msg.auftragId == null ? "" : msg.auftragId))) { antwort({ status: "blocked", reason: "betonline: order number missing — nothing sent" }); return false; }
    einmal(String(msg.auftragId), (z) => einzel(msg, z)).then(antwort);
    return true;
  });

  try { window.__engineBoTest = { dezimalAus, preisAus, pruefeAuswahl, pruefeZeile, antwortAus, zeileAus, addLineAus, scheinAus, einmal }; } catch (_) {}
})();
