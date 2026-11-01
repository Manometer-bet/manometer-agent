// content/pamestoixima-place.js — Manometer Agent: Setz-Script im Tab von www.pamestoixima.gr (OPAP / OpenBet). 1.2.76, 18.10.2026.
//
//
// Lesen, Pruefen und Setzen laufen AUS DER SEITE: Cloudflare laesst die Abrufe nur aus dem Seitenkontext zu (aus dem Service
// Worker 403), die Sitzung ist das httpOnly-Cookie der Seite plus der Zugangs-Schluessel aus session/check (Authorization am
// Schein). Pame sperrt auslaendische Adressen (Umleitung auf media.pamestoixima.gr/uc/foreign-ips-blocking/) — der Rechner des
// Bettors braucht eine griechische Adresse.
//
// EINZELWETTE (pmePlace): nur Fussball, nur der Sieger-Markt MATCH_RESULT (nicht der 0-%-Markt MATCH_RESULT_2), nur vor dem
// Anpfiff, nur mit der GENAUEN Auswahl-Nummer des Operators (outcomeId; die Engine sucht nie selbst eine Auswahl und uebersetzt
// nie Heim/Gast). Frisch beim Buch geprueft: Spiel offen und nicht angepfiffen, GENAU ein Sieger-Markt mit genau H / D / A, die
// Auswahlen heissen wie die Mannschaften, die genannte Auswahl liegt in DIESEM Markt, ist offen und hat einen lesbaren
// Festpreis ≥ Mindestquote. Der Schein ist der der Einzelwette des Operators (pamestoixima-content.js place, am 03.09. echt
// gelaufen): SGL, priceChangeBehaviour NONE (das Buch nimmt keine geaenderte Quote an). Danach Gegenlesen in den Wetten des
// Kontos. Antworten: placed | failed (sicher nicht gesetzt) | blocked (nichts gesendet) | uncertain (Schein war raus, Ergebnis
// unklar — im Konto pruefen) | pending (Buch entscheidet noch → der Service Worker fragt mit pmeNachfragen nach). Die Antwort
// des Buchs liest dieselbe Wahrheitstabelle wie der Kombi-Baustein (antwortAus): im Zweifel uncertain, nie „failed“.
// KOMBI (pmeKombi / pmeKombiNachfragen): der Baustein content/pamestoixima-kombi.js (byte-gleich mit dem des Operators, PMKOMBI).
// Nur der OBERSTE Rahmen antwortet. Ein Setz-Auftrag laeuft in diesem Tab nur einmal (Auftrags-Nummer, Kit-Falle P24).
// Der Zugangs-Schluessel und der Name des Kontos stehen nie in einer Rueckgabe oder Meldung.
(() => {
  "use strict";
  if (window.__enginePamePlace) return;   // schon da: der Service Worker laedt den Tab neu, wenn die Version nicht passt
  window.__enginePamePlace = true;
  let IS_TOP = false; try { IS_TOP = window.top === window; } catch (_) { IS_TOP = false; }
  const VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return "?"; } })();
  const SEITE = "www.pamestoixima.gr";
  const SPIELE = "https://capi.pamestoixima.gr/content-service/api/v1/q/getEventsNew";
  const SITZUNG = "https://api.pamestoixima.gr/web/access/session/check";
  const PAPI = "https://papi.pamestoixima.gr/bet-service/api/v1";
  const OB = { "Content-Type": "application/json", "x-ob-channel": "I", "x-accept-language": "en-GB" };
  const MARKT = "MATCH_RESULT", SEITE_SUB = { "1": "H", "X": "D", "2": "A" };

  const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : null);
  const sauber = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const num = (x) => (typeof x === "number" ? x : (typeof x === "string" && /^-?\d+(\.\d+)?$/.test(x.trim()) ? Number(x) : NaN));

  // PURE — frischer Abruf (getEventsNew, nur Sieger-Markt) + Auftrag → { auswahl } | { fehler (englisch) }. Regeln wie
  // background.js pameSiegerMarkt des Operators; dazu: nicht angepfiffen, und die Auswahl-Nummer des Operators liegt in DIESEM Markt.
  function pruefeAuswahl(j, eventId, outcomeId, minOdds, jetztMs) {
    if (!obj(j) || !obj(j.data) || !Array.isArray(j.data.events)) return { fehler: "games of the book not readable" };
    if (Array.isArray(j.errors) && j.errors.length) return { fehler: "the book answered the game list with an error" };
    const evs = j.data.events.filter((e) => obj(e) && String(e.id) === String(eventId));
    if (evs.length !== 1) return { fehler: evs.length ? "the book lists this game more than once — unclear" : "the game is not offered (any more)" };
    const e = evs[0];
    const T = Array.isArray(e.teams) ? e.teams.filter(obj) : [], H = T.filter((t) => t.side === "HOME"), A = T.filter((t) => t.side === "AWAY");
    const heim = H.length === 1 ? sauber(H[0].name) : "", gast = A.length === 1 ? sauber(A[0].name) : "";
    if (T.length !== 2 || !heim || !gast) return { fehler: "home and away team of the book not readable" };
    if (e.status !== "ACTIVE" || e.active !== true || e.displayed === false || e.settled === true || e.resulted === true) return { fehler: "the game is not open for betting" };
    const start = Date.parse(String(e.startTime || ""));
    if (e.started === true || e.liveNow === true || !(start > jetztMs)) return { fehler: "the game has started — pre-match only" };
    const ms = (Array.isArray(e.markets) ? e.markets : []).filter((m) => obj(m) && m.groupCode === MARKT);
    if (ms.length !== 1) return { fehler: ms.length ? "the book lists the winner market more than once — unclear" : "the winner market is not offered" };
    const m = ms[0];
    if (m.subType !== "MR" || String(m.eventId) !== String(e.id) || m.handicapValue != null) return { fehler: "the market of the book is not the plain match result" };
    if (m.status !== "ACTIVE" || m.active !== true || m.displayed === false) return { fehler: "the winner market is suspended" };
    const os = Array.isArray(m.outcomes) ? m.outcomes.filter(obj) : [], subs = ["H", "D", "A"];
    if (os.length !== 3 || subs.some((s) => os.filter((o) => o.subType === s).length !== 1)) return { fehler: "the winner market of the book does not list exactly H / D / A" };
    if (sauber(os.find((o) => o.subType === "H").name) !== heim || sauber(os.find((o) => o.subType === "A").name) !== gast) return { fehler: "the selections of the book do not carry the names of the teams — sides unclear" };
    const o = os.find((x) => String(x.id) === String(outcomeId));
    if (!o) return { fehler: "the selection number of the order is not in the winner market of this game" };
    if (String(o.marketId) !== String(m.id)) return { fehler: "the selection does not belong to the winner market" };
    if (o.status !== "ACTIVE" || o.active !== true || o.displayed === false) return { fehler: "the selection is suspended" };
    const ps = Array.isArray(o.prices) ? o.prices.filter(obj) : [], px = ps.length === 1 && ps[0].priceType === "LP" ? ps[0] : null;
    const n = px ? num(px.numerator) : NaN, d = px ? num(px.denominator) : NaN, preis = px ? num(px.decimal) : NaN;
    if (!(Number.isSafeInteger(n) && n > 0 && Number.isSafeInteger(d) && d > 0) || !(isFinite(preis) && preis > 1) || Math.abs(1 + n / d - preis) > 0.0051) return { fehler: "the selection has no readable odds" };
    if (Number(minOdds) > 1 && preis < Number(minOdds) - 1e-9) return { fehler: "odds " + preis.toFixed(2) + " below min " + Number(minOdds).toFixed(2), unterMin: true, preis };
    const tip = Object.keys(SEITE_SUB).find((k) => SEITE_SUB[k] === o.subType);
    return { auswahl: { eventId: String(e.id), outcomeId: String(o.id), tip, name: sauber(o.name), numerator: n, denominator: d, preis, teams: heim + " – " + gast } };
  }

  // PURE — der Schein der Einzelwette (wie pamestoixima-content.js place des Operators)
  function scheinEinzel(a, stake) {
    return {
      legs: [{ documentId: "LEG1", options: { banker: false, inMultiples: true, handicaps: [{ outcomeRef: String(a.outcomeId) }], prices: [{ priceTypeRef: "LP", numerator: a.numerator, denominator: a.denominator, winPlaceRef: "WIN" }], winPlace: "WIN" }, outcomes: [{ outcomeRef: String(a.outcomeId) }] }],
      bets: [{ documentId: "BET1", betTypeRef: "SGL", lines: 1, legRefs: ["LEG1"], options: { winPlaceOverride: "WIN", priceChangeBehaviour: "NONE" }, stake, stakeType: "SPL" }],
    };
  }

  // PURE — Antwort des Buchs auf den Schein → Ergebnis. Dieselbe Wahrheitstabelle wie der Kombi-Baustein (klassifiziere; gebaut
  // aus den mitgeschnittenen Einzelwetten vom 19.08.), fuer GENAU EINE Einzelwette: placed nur bei PLACED / REFERRAL_PLACED /
  // PARTIALLY_PLACED mit Schein-Nr., GENAU einer Wette SGL und — wo die Antwort sie nennt — GENAU der gesendeten Auswahl; steht die
  // Wette selbst noch nicht auf PLACED, wird der Schein nachgelesen. BIR_DELAY / REFERRAL_PENDING / REFERRAL_PROCESSED = das Buch
  // entscheidet noch (ein Gegenangebot wird NIE angenommen, es verfaellt). failed (sicher nicht gesetzt) NUR bei FAILED / DECLINED /
  // BUILD_ERROR oder einer Fehlerliste beim Absenden, wenn JEDER Fehler von einer Art ist, die sicher vor der Annahme steht; sonst
  // uncertain. soll = { outcomeId, nr? }; nachfrage = Antwort auf das Nachlesen des Scheins (dort sagt eine Fehlerliste nichts).
  const ABSAGE_ARTEN = ["CHANGE_ERROR", "BET_ERROR", "ACCOUNT_ERROR", "VALIDATION_ERROR"], WARTE_STATUS = ["BIR_DELAY", "REFERRAL_PENDING", "REFERRAL_PROCESSED"];
  function fehlerText(errs) {
    const e = errs[0]; if (!e) return "";
    const id = typeof e.id === "string" ? e.id : "", art = typeof e.type === "string" ? e.type : "";
    return id === "BET_PRICE_CHANGED" ? "the odds changed" : id === "EVENT_STARTED" ? "the game has started or the selection is closed" : id === "OUTCOME_SUSPENDED" ? "the selection is suspended"
      : id === "INSUFFICIENT_FUNDS" ? "not enough balance" : id === "OFFER_TIMED_OUT" ? "the counter-offer of the book expired" : art === "ACCESS_DENIED" ? "the login has expired"
      : sauber([id || art, typeof e.text === "string" ? e.text : ""].filter(Boolean).join(": ")).slice(0, 120);
  }
  function antwortAus(httpStatus, j, soll, nachfrage) {
    const s = Number(httpStatus) || 0, jo = obj(j), errs = jo && Array.isArray(jo.errors) ? jo.errors.filter(obj) : [], f = fehlerText(errs);
    soll = obj(soll) || {};
    if (s === 401 || s === 403 || errs.some((e) => e.type === "ACCESS_DENIED")) return nachfrage ? { art: "uncertain", grund: "the result could not be read — the login has expired (answer " + s + ") — check the bet history" } : { art: "failed", grund: "the book refused the slip — the login has expired (answer " + s + ")" };
    if (!jo) return { art: "uncertain", grund: "no readable answer of the book (answer " + s + ") — check the bet history" };
    const d = obj(jo.data), st = d && typeof d.status === "string" ? d.status : null, nr = d && /^\d{4,20}$/.test(String(d.id)) ? String(d.id) : null;
    if (nachfrage && soll.nr != null && d && nr !== String(soll.nr)) return { art: "uncertain", grund: "the book answered the question for slip " + String(soll.nr).slice(0, 20) + " with another slip — check the bet history" };
    if (st === "PLACED" || st === "REFERRAL_PLACED" || st === "PARTIALLY_PLACED") {
      if (!nr) return { art: "uncertain", grund: "AUDIT: the book confirmed the bet without a slip number — check the bet history immediately" };
      const bs = Array.isArray(d.bets) ? d.bets.filter(obj) : [], b = bs.length === 1 ? bs[0] : null;
      const echo = Array.isArray(d.legs) && d.legs.length ? d.legs.filter(obj).map((l) => (Array.isArray(l.outcomes) && l.outcomes.length === 1 && obj(l.outcomes[0]) ? String(l.outcomes[0].outcomeRef) : "?")) : null;
      if (!b || b.betTypeRef !== "SGL" || (echo && soll.outcomeId != null && !(echo.length === 1 && echo[0] === String(soll.outcomeId))))
        return { art: "uncertain", ticket: nr, grund: "AUDIT: the answer of the book names another bet or another selection than the one sent — check the bet history immediately" };
      if (b.status !== "PLACED") return { art: "pending", ticket: nr };   // Schein angenommen, Wette (noch) nicht: nachlesen
      let preis = obj(b.potentialPrice) ? num(b.potentialPrice.decimal) : NaN;
      if (!(preis > 1)) { try { const p0 = d.legs[0].options.prices; preis = num(p0[p0.length - 1].decimal); } catch (_) { preis = NaN; } }
      return { art: "placed", ticket: nr, preis: preis > 1 ? preis : null, hinweis: st === "PLACED" ? null : (st === "REFERRAL_PLACED" ? "accepted after a check by the traders of the book" : "the book reports the slip as partially placed") };
    }
    if (WARTE_STATUS.indexOf(st) >= 0) return nr ? { art: "pending", ticket: nr } : { art: "uncertain", grund: "the book holds the slip (" + st + ") but gave no slip number — check the bet history" };
    if (st === "FAILED" || st === "DECLINED" || st === "BUILD_ERROR" || (!st && errs.length && !nachfrage)) {
      if (errs.every((e) => ABSAGE_ARTEN.indexOf(e.type) >= 0 || e.id === "OFFER_TIMED_OUT")) return { art: "failed", grund: "the book declined the bet (" + (st || "answer " + s) + ")" + (f ? ": " + f : "") };
      return { art: "uncertain", ticket: nr, grund: "the book reports " + (st || "an error") + (f ? " (" + f + ")" : "") + " — check the bet history" };
    }
    return { art: "uncertain", ticket: nr, grund: "no clear verdict of the book (answer " + s + (st ? ", " + st.slice(0, 30) : "") + ") — check the bet history" };
  }

  async function holeJson(url, kopf) {
    const r = await fetch(url, { credentials: "include", cache: "no-store", headers: kopf || OB });
    let j = null; try { j = await r.json(); } catch (_) { j = null; }
    return { status: r.status, ok: r.ok, j };
  }
  async function zugang() {
    try {
      const r = await fetch(SITZUNG, { credentials: "include", cache: "no-store" });
      if (!r.ok) return { ok: false, status: r.status };
      const j = await r.json().catch(() => null);
      return { ok: !!(j && j.access_token), token: j && j.access_token ? String(j.access_token) : null };
    } catch (e) { return { ok: false, fehler: String((e && e.message) || e) }; }
  }
  function ort() {
    try {
      if (String(location.hostname) !== SEITE || String(location.protocol) !== "https:") return /foreign-ips-blocking/i.test(String(location.href)) ? "pamestoixima blocks this connection (no Greek IP address)" : "this tab is not " + SEITE;
    } catch (_) { return "this tab is not " + SEITE; }
    return null;
  }
  // Gegenlesen: die Wette in den offenen Wetten des Kontos (bis dreimal — sie erscheint dort mit kurzer Verzoegerung)
  async function inWetten(ticket, token) {
    const kopf = { "x-ob-channel": "I" }; if (token) kopf.Authorization = "Bearer " + token;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await holeJson(PAPI + "/bets?count=200&settled=false", kopf);
        if (r.ok) {
          const arr = (r.j && (r.j.data || r.j.bets || r.j.content)) || r.j || [];
          const flach = Array.isArray(arr) ? arr : (arr && Array.isArray(arr.bets) ? arr.bets : []);
          if (flach.some((b) => b && (String(b.id) === String(ticket) || String(b.slipId) === String(ticket) || (Array.isArray(b.bets) && b.bets.some((x) => String(x.id) === String(ticket)))))) return true;
        }
      } catch (_) {}
      await new Promise((rs) => setTimeout(rs, 1200));
    }
    return false;
  }

  async function einzel(msg) {
    const T0 = Date.now();
    const mit = (o) => Object.assign(o, { ms: Date.now() - T0 });
    const nein = (grund) => mit({ status: "blocked", reason: "pamestoixima: " + grund + " — nothing sent" });
    const o = ort(); if (o) return nein(o);
    const eventId = String(msg && msg.eventId != null ? msg.eventId : ""), outcomeId = String(msg && msg.outcomeId != null ? msg.outcomeId : "");
    if (!/^\d{4,12}$/.test(eventId)) return nein("event number missing");
    if (!/^\d{4,14}$/.test(outcomeId)) return nein("exact selection number of the operator missing");
    const einsatz = Math.round(Number(msg.amount) * 100) / 100;
    if (!(einsatz >= 0.1)) return nein("stake below 0.10 €");
    const z = await zugang();
    if (!z.ok || !z.token) return nein("not signed in at " + SEITE + (z.status ? " (session " + z.status + ")" : ""));
    let r;
    try { r = await holeJson(SPIELE + "?eventIds=" + eventId + "&marketGroupCodesIncluded=" + MARKT + "&includeMarkets=true&includeTeams=true&limit=5"); }
    catch (e) { return nein("game list not reachable (" + String((e && e.message) || e).slice(0, 80) + ")"); }
    if (!r.ok) return nein("game list HTTP " + r.status);
    const w = pruefeAuswahl(r.j, eventId, outcomeId, Number(msg.minOdds), Date.now());
    if (w.fehler) return mit({ status: "blocked", reason: "pamestoixima: " + w.fehler + " — nothing sent", odds: w.preis || undefined });
    const a = w.auswahl;
    if (msg.armed !== true) return mit({ status: "staged", odds: a.preis, tip: a.tip, name: a.name, teams: a.teams });
    const kopf = Object.assign({}, OB, { Authorization: "Bearer " + z.token });
    let s;
    try { s = await fetch(PAPI + "/slips", { method: "POST", headers: kopf, body: JSON.stringify(scheinEinzel(a, einsatz)), credentials: "include" }); }
    catch (e) { return mit({ status: "uncertain", reason: "pamestoixima: connection broke while sending the slip (" + String((e && e.message) || e).slice(0, 80) + ") — check the bet history", odds: a.preis }); }
    if (s.status === 401 || s.status === 403) return mit({ status: "failed", reason: "pamestoixima: the book refused the slip (HTTP " + s.status + " — session expired?)" });
    let j = null; try { j = await s.json(); } catch (_) { j = null; }
    const x = antwortAus(s.status, j, { outcomeId: a.outcomeId }, false);
    if (x.art === "failed") return mit({ status: "failed", reason: "pamestoixima: " + x.grund, odds: a.preis });
    if (x.art === "pending") { merkeOffen(x.ticket, a.outcomeId); return mit({ status: "pending", warteId: x.ticket, nachMs: 2000, odds: a.preis }); }
    if (x.art === "placed") {
      const ok = await inWetten(x.ticket, z.token);
      const notiz = [x.hinweis, ok ? null : "read-back did not confirm yet — check the bet history"].filter(Boolean).join("; ");
      return mit({ status: "placed", ticket: x.ticket, odds: x.preis > 1 ? x.preis : a.preis, verified: ok, note: notiz || undefined });
    }
    return mit({ status: "uncertain", reason: "pamestoixima: " + x.grund, ticket: x.ticket || undefined, odds: a.preis });
  }
  // Offene Scheine dieses Tabs (Nummer → gesendete Auswahl), damit das Nachlesen die Auswahl gegenpruefen kann
  const _offen = new Map();
  function merkeOffen(nr, outcomeId) { _offen.set(String(nr), { outcomeId: String(outcomeId), nr: String(nr) }); while (_offen.size > 40) _offen.delete(_offen.keys().next().value); }
  // Nachfragen (das Buch entschied noch): GENAU EIN Abruf des Scheins, sendet nie einen Schein
  async function nachfragen(warteId) {
    if (!/^[0-9A-Za-z_-]{1,40}$/.test(String(warteId || ""))) return { status: "uncertain", reason: "pamestoixima: no slip number to follow up — check the bet history" };
    const z = await zugang();
    const kopf = { "x-ob-channel": "I" }; if (z.token) kopf.Authorization = "Bearer " + z.token;
    let r; try { r = await holeJson(PAPI + "/slips/" + encodeURIComponent(warteId), kopf); } catch (_) { return { status: "pending", warteId, nachMs: 2000 }; }
    const x = antwortAus(r.status, r.j, _offen.get(String(warteId)) || { nr: String(warteId) }, true);
    if (x.art === "pending") return { status: "pending", warteId, nachMs: 2000 };
    if (x.art === "placed") { const ok = await inWetten(x.ticket, z.token); return { status: "placed", ticket: x.ticket, odds: x.preis || undefined, verified: ok, note: x.hinweis || undefined }; }
    if (x.art === "failed") return { status: "failed", reason: "pamestoixima: " + x.grund };
    return { status: "uncertain", reason: "pamestoixima: " + x.grund, ticket: x.ticket || undefined };
  }

  // Ein Setz-Auftrag laeuft in diesem Tab nur einmal (Auftrags-Nummer; zwei Fassungen / doppelte Zustellung bekommen dasselbe Ergebnis)
  const _laeufe = (window.__enginePameLaeufe && typeof window.__enginePameLaeufe.get === "function") ? window.__enginePameLaeufe : (window.__enginePameLaeufe = new Map());
  function einmal(msg, lauf) {
    const nr = (msg && msg.auftragId != null && /^[A-Za-z0-9_.:-]{6,80}$/.test(String(msg.auftragId))) ? String(msg.auftragId) : null;
    if (!nr) return Promise.resolve({ status: "blocked", reason: "pamestoixima: order number missing — nothing sent" });
    if (_laeufe.has(nr)) return _laeufe.get(nr);
    let p; try { p = Promise.resolve(lauf()); } catch (e) { p = Promise.reject(e); }
    _laeufe.set(nr, p);
    while (_laeufe.size > 40) _laeufe.delete(_laeufe.keys().next().value);
    return p;
  }
  const kombiDa = () => (typeof PMKOMBI !== "undefined" && !!PMKOMBI && typeof PMKOMBI.place === "function" && typeof PMKOMBI.nachfragen === "function");
  const KOMBI_ENV = { emit: () => {} };

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _s, reply) => {
      if (!IS_TOP || !msg || !msg.cmd) return false;
      if (msg.cmd === "pmePing") { reply({ ok: true, version: VERSION, kombi: kombiDa(), ort: ort() }); return false; }
      if (msg.cmd === "pmePlace") { einmal(msg, () => einzel(msg)).then(reply).catch((e) => reply({ status: "uncertain", reason: "pamestoixima: " + String((e && e.message) || e) + " — check the bet history" })); return true; }
      if (msg.cmd === "pmeNachfragen") { nachfragen(msg.warteId).then(reply).catch((e) => reply({ status: "uncertain", reason: "pamestoixima: " + String((e && e.message) || e) })); return true; }
      if (msg.cmd === "pmeKombi" || msg.cmd === "pmeKombiNachfragen") {
        if (!kombiDa()) { reply({ status: "blocked", reason: "pamestoixima combo: placement script not loaded — nothing sent" }); return false; }
        const lauf = msg.cmd === "pmeKombiNachfragen" ? PMKOMBI.nachfragen(msg.warteId) : PMKOMBI.place(msg, KOMBI_ENV);
        Promise.resolve(lauf).then(reply).catch((e) => reply({ status: "uncertain", reason: "pamestoixima combo: " + String((e && e.message) || e) + " — check the bet history" }));
        return true;
      }
      return false;
    });
  }
  // fuer Tests im Rechner (vm): die reinen Funktionen
  try { window.__enginePameTest = { pruefeAuswahl, scheinEinzel, antwortAus, einzel, nachfragen, einmal }; } catch (_) {}
})();
