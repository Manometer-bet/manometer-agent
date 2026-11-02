// books/fonbet.js — Fonbet adapter. Extracted 1:1 from the operator extension's production code
// (die Erweiterung des Betreibers), which places real money today. Nothing here is guessed:
//  - auth: fsid/clientId/deviceId are NOT cookies — Fonbet puts them in the JSON body of every
//    clientsapi POST. Harvested read-only via webRequest (verified in production).
//  - read: public listBase feed, no login. Football 1X2 factors 921="1" 922="X" 923="2";
//    CS2 same 921/923 (no draw). Map winners = CHILD events, kind 10200N ("N. Karte"), own factors.
//  - place: betRequestId -> coupon/bet (zone "es"), map bets go on the CHILD eventId. LIVE answers
//    with {betDelay} and the verdict comes from coupon/betResult (HAR-verified).
// Adapter contract (same for every future book): { id, hosts, arm(ctx), status(), place(p, stake, ctx) }
"use strict";

const LINE_HOST = "https://line01.fm41d5-resources.com";
const CLIENTS_HOST = "https://clientsapi01.fm41d5-resources.com";
const FEED_TTL_MS = 90000;
const HDRS = { "Content-Type": "text/plain;charset=UTF-8", "Origin": "https://fonbet001.com", "Referer": "https://fonbet001.com/" };

let _auth = null;
let _cat = { at: 0, byId: null };

async function fetchT(url, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 12000);
  try { return await fetch(url, Object.assign({}, opts || {}, { signal: ctl.signal })); }
  finally { clearTimeout(t); }
}

// Classify a coupon answer. AFTER coupon/bet was sent an unknown answer must NEVER be "rejected" —
// the bet may exist; only an explicit resultCode != 0 is a safe no-bet. (Operator lesson v1.20.291.)
export function couponOutcome(res) {
  const cp = res && res.coupon;
  if (cp && cp.resultCode === 0) return { kind: "placed", cp };
  const delay = res ? Number((cp && cp.betDelay) != null ? cp.betDelay : res.betDelay) : NaN;
  if (delay > 0) return { kind: "delay", ms: delay };
  // 04.10.2026: der Grund steht in errorMessageEng / errorMessage (ROH-Antwort am eigenen Konto: {"resultCode":2,
  // "errorMessageEng":"Odds changed …"} bzw. 100 „Bets on event too frequent"). Bisher wurde hier resultText gelesen — das Feld
  // gibt es nicht, in der Quittung stand nur „abgelehnt (resultCode 100)" ohne Grund.
  if (cp && cp.resultCode != null) return { kind: "rejected", rc: cp.resultCode, rt: String(cp.errorMessageEng || cp.errorMessage || cp.resultText || "").replace(/\s+/g, " ").trim().slice(0, 140) };
  return { kind: "unknown" };
}

// 04.10.2026 — LIVE: Stand und Sperren aus dem Feed (geteilt mit fonbet-gr.js).
//   * eventMiscs [{id, score1, score2, …}]: der aktuelle Stand. Die Seite schickt ihn bei einer Live-Wette mit
//     (bets[].score "h:a", mitgelesen an einer echten Live-Wette; am eigenen Konto seit 04.10. so gesetzt: 2 von 2 angenommen).
//   * eventBlocks [{eventId, state:"blocked"}] = alle Quoten des Ereignisses gesperrt, {state:"partial", factors:[…]} = nur diese,
//     blockAll = alles. Die Preise bleiben dabei im Feed stehen (Kit-Falle S54) — ein gesperrtes Ereignis wird nicht gesetzt.
export function feedZusatz(d) {
  const stand = new Map(), voll = new Set(), teil = new Map();
  for (const m of ((d && d.eventMiscs) || [])) { if (m && m.id != null && m.score1 != null && m.score2 != null && /^\d+$/.test(String(m.score1)) && /^\d+$/.test(String(m.score2))) stand.set(String(m.id), String(m.score1) + ":" + String(m.score2)); }
  for (const b of ((d && d.eventBlocks) || [])) {
    if (!b || b.eventId == null) continue;
    if (b.state === "blocked") voll.add(String(b.eventId));
    else if (b.state === "partial" && Array.isArray(b.factors)) teil.set(String(b.eventId), new Set(b.factors.map(Number)));
  }
  const alle = !!(d && d.blockAll === true);
  return { stand, gesperrt: (eid, faktor) => alle || voll.has(String(eid)) || !!(teil.get(String(eid)) && teil.get(String(eid)).has(Number(faktor))) };
}

// Page-Read-Fallback (shared, auch von fonbet-gr genutzt): liest fsid/clientId/deviceId DIREKT aus einem
// offenen Fonbet-Tab (localStorage/sessionStorage), wenn der webRequest-Sniff (noch) nichts hat. Behebt den
// Fehlalarm „keine Session", obwohl eingeloggt (frisch eingeloggt / Tab gedrosselt / SW-Neustart). Pinnt den
// Tab zugleich wach (autoDiscardable:false), damit Session-Zugriff + künftige Sniffs stabil bleiben.
export async function harvestAuth(host) {
  let tabs = [];
  try { tabs = await new Promise((rs) => { try { chrome.tabs.query({ url: "https://" + host + "/*" }, (t) => rs(t || [])); } catch (_) { rs([]); } }); } catch (_) {}
  if (!tabs.length) return null;
  const tab = tabs[0];
  try { chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch (_) {}
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      function deepFind(o, depth) {
        if (!o || depth > 6 || typeof o !== "object") return null;
        if (o.fsid && (o.clientId != null)) return { fsid: String(o.fsid), clientId: Number(o.clientId), deviceId: o.deviceId ? String(o.deviceId) : null };
        for (const k in o) { try { const r = deepFind(o[k], depth + 1); if (r) return r; } catch (_) {} }
        return null;
      }
      const vals = [];
      try { for (let i = 0; i < localStorage.length; i++) vals.push(localStorage.getItem(localStorage.key(i))); } catch (_) {}
      try { for (let j = 0; j < sessionStorage.length; j++) vals.push(sessionStorage.getItem(sessionStorage.key(j))); } catch (_) {}
      let found = null;
      for (const s of vals) { if (!s || s.indexOf("fsid") < 0) continue; try { const r = deepFind(JSON.parse(s), 0); if (r && r.fsid && r.clientId) { found = r; break; } } catch (_) {} }
      if (found && !found.deviceId) { for (const s of vals) { if (!s) continue; const m = s.match(/[0-9A-Fa-f]{32}/); if (m) { found.deviceId = m[0].toUpperCase(); break; } } }
      return found;
    } });
    const a = res && res[0] && res[0].result;
    if (a && a.fsid && Number(a.clientId) > 0) return { fsid: String(a.fsid), clientId: Number(a.clientId), deviceId: a.deviceId ? String(a.deviceId) : null };
  } catch (_) {}
  return null;
}

// 1.2.64 — SPORTARTEN AUSSER FUSSBALL / CS2 (geteilt mit fonbet-gr.js). Basketball: Sieger ueber das ganze Spiel INKLUSIVE
// Verlaengerung = Faktoren 921 / 923 am MATCH-Ereignis. Gemessen am echten Katalog (04.10.2026, 243 Basketball-Ereignisse):
// 221 mit 921 und 923, bei KEINEM ein 922 (Remis) am Match; die Viertel-/Halbzeit-Kinder tragen keine Mannschaften, kind 121
// sind Platzhalter. Die Engine uebersetzt home/away hier NIE selbst (das Buch kann die Mannschaften andersherum fuehren als
// die Zeile des Operators — bei Basketball ueblich): der Vorschlag nennt den genauen FAKTOR (bookRef.outcomeId "921" | "923"),
// genommen aus dem Katalog des Edge-Dienstes, in dem die Quote steht, die den Vorschlag ausgeloest hat. Ohne ihn wird nicht
// gesetzt. Hier geprueft: das Ereignis ist beim Buch Basketball und ein Match (kind 1, kein Kind), es fuehrt KEIN 922 (sonst
// 3-Weg regulaere Spielzeit = eine andere Wette), die Phase stimmt (Live-Auftrag nur im laufenden Spiel, Vorspiel nur davor),
// der Faktor ist offen und hat einen Preis.
// 24 von 42 Fonbet-Versuchen scheiterten an „Bet amount 10.00 more than the limit 4.76“ (1,92 bis 7,81 €, nie ohne Betrag). Das Buch nennt, was es nimmt; einmal mit genau dem Betrag neu setzen.
// Nur bei dieser ausdrücklichen Ablehnung: Da liegt sicher keine Wette. Nie mehr als der Wunsch, Preis und Mindestquote wie beim ersten Versuch (der Schein trägt dieselbe Quote, flexBet "up").
export function erlaubterBetrag(grund, wunsch) {
  const m = /more than the limit\s+(\d+(?:[.,]\d+)?)/i.exec(String(grund || ""));
  if (!m) return 0;
  const x = Math.floor(Number(m[1].replace(",", ".")) * 100 + 1e-6) / 100;
  return x >= KOMBI_MIN_EINSATZ && x < wunsch ? x : 0;
}
export const SPORT_ZIEL = { basket: { alias: "basketball", kind: 1, faktoren: ["921", "923"], ohne: 922 } };
// Wurzel-Sportart eines Liga-Knotens (alias der obersten Ebene, z. B. "basketball") — fuer den Katalog beider Adapter.
export function sportWurzel(d) {
  const byId = {}; ((d && d.sports) || []).forEach((s) => { if (s && s.id != null) byId[s.id] = s; });
  return (sid) => { let s = byId[sid], n = 0; while (s && s.parentId != null && byId[s.parentId] && n < 8) { s = byId[s.parentId]; n++; } return s ? String(s.alias || s.name || "").toLowerCase() : ""; };
}
// PURE: Ziel eines Vorschlags in einer Sportart aus SPORT_ZIEL — { eventId, factor, odds, live, score } | { error }.
export function sportZiel(rec, p) {
  const S = (p && Object.prototype.hasOwnProperty.call(SPORT_ZIEL, String(p.sport))) ? SPORT_ZIEL[String(p.sport)] : null;
  if (!S) return { error: "sport " + String(p && p.sport) + " not supported by the fonbet adapter" };
  if (!rec) return { error: "event no longer offered" };
  if (p.mkt !== "ml" || (p.scope != null && p.scope !== "match")) return { error: "only the match winner is supported for " + String(p.sport) };
  const nr = String((p.bookRef && p.bookRef.outcomeId != null) ? p.bookRef.outcomeId : "");
  if (S.faktoren.indexOf(nr) < 0) return { error: "proposal without the exact selection (factor " + S.faktoren.join(" / ") + ") — not placed" };
  if (rec.sportAlias !== S.alias || rec.kind !== S.kind) return { error: "event is not a " + S.alias + " match at the book" };
  if (rec.hatRemis === true) return { error: "the winner market lists a draw (3-way, regular time) — a different bet" };
  if ((p.live === true) !== (rec.live === true)) return { error: p.live === true ? "game is not live at the book — live order only in a running game" : "game is already live at the book — pre-match only" };
  const seite = nr === S.faktoren[0] ? "home" : "away";
  const o = rec.ml ? Number(rec.ml[seite]) || 0 : 0;
  if (!(o > 1)) return { error: "outcome not offered" };
  if (rec.gesperrt && rec.gesperrt[seite]) return { error: "selection suspended right now (the price in the feed is frozen)" };
  return { eventId: rec.eventId, factor: Number(nr), odds: o, live: rec.live === true, score: rec.score || null };
}

export const id = "fonbet";
export const hosts = { line: LINE_HOST, clients: CLIENTS_HOST, site: "https://fonbet001.com/" };
// Sportarten, die dieser Adapter setzt (engine-core.js adapterSetzt). basket seit 1.2.64 — nur mit genauem Faktor (sportZiel).
export const sports = { fb: true, cs2: true, basket: true };
// 1.2.72 (05.10.2026): dieser Adapter setzt Kombiwetten (mkt "parlay") — engine-core.js adapterKombi.
export const kombi = true;

// _auth aus dem webRequest-Sniff ODER (Fallback) aus der Seite sicherstellen. Wird vor status-relevanten
// Aktionen (balance/place) aufgerufen → ein eingeloggter Betreiber wird erkannt, auch ohne frischen Sniff.
async function ensureAuth(ctx) {
  if (_auth && _auth.fsid && _auth.clientId > 0 && _auth.deviceId) return _auth;
  try {
    const a = await harvestAuth("fonbet001.com");
    if (a && a.fsid && a.clientId > 0) {
      const first = !(_auth && _auth.fsid);
      _auth = Object.assign({}, _auth, a, { at: Date.now() });
      try { if (ctx && ctx.storageSet) ctx.storageSet("fonbetAuth", _auth); } catch (_) {}
      if (first && ctx && ctx.log) ctx.log("fonbet: session read from the page (fsid/clientId" + (_auth.deviceId ? "/deviceId" : "") + ")");
    }
  } catch (_) {}
  return _auth;
}

// Arm the auth harvester. Read-only: inspects request bodies, never modifies a request.
export function arm(ctx) {
  try {
    ctx.storageGet("fonbetAuth").then((v) => { if (v && v.fsid) _auth = v; });
  } catch (_) {}
  try {
    if (!(chrome.webRequest && chrome.webRequest.onBeforeRequest)) return;
    chrome.webRequest.onBeforeRequest.addListener((d) => {
      try {
        const raw = d.requestBody && d.requestBody.raw && d.requestBody.raw[0] && d.requestBody.raw[0].bytes;
        if (!raw) return;
        const txt = new TextDecoder("utf-8").decode(raw);
        if (txt.indexOf("fsid") < 0 || txt.indexOf("clientId") < 0) return;
        const j = JSON.parse(txt);
        if (!(j && j.fsid && j.clientId)) return;
        const first = !(_auth && _auth.fsid);
        _auth = Object.assign({}, _auth, { fsid: String(j.fsid), clientId: Number(j.clientId), at: Date.now() },
          j.deviceId ? { deviceId: String(j.deviceId) } : {});
        ctx.storageSet("fonbetAuth", _auth);
        if (first) ctx.log("fonbet: session auth captured (fsid/clientId" + (_auth.deviceId ? "/deviceId" : "") + ")");
      } catch (_) {}
    }, { urls: [CLIENTS_HOST + "/*", "https://clientsapi11.fm41d5-resources.com/*"] }, ["requestBody"]);
  } catch (e) { ctx.log("fonbet: webRequest arm failed: " + String((e && e.message) || e)); }
}

export function status() {
  if (!_auth || !_auth.fsid || !(_auth.clientId > 0)) return { ready: false, detail: "not logged in — open fonbet001.com and sign in" };
  if (!_auth.deviceId) return { ready: false, detail: "deviceId not captured yet — open a betslip once on fonbet001.com" };
  return { ready: true, detail: "ready (session captured)" };
}

// Kontostand: session/info (verifiziert im Live-Chrome 01.09.). saldo = verfügbar, holdSaldo = in offenen
// Wetten gebunden. Nutzt dieselbe Auth wie coupon/bet. Rückgabe null, wenn (noch) keine Session.
export async function balance() {
  const a = await ensureAuth();   // Heartbeat: harvestet die Session aus der Seite, falls der Sniff nichts hat → status() bleibt ehrlich
  if (!a || !a.fsid || !(a.clientId > 0)) return null;
  try {
    const r = await fetchT(CLIENTS_HOST + "/session/info", { method: "POST", headers: HDRS, body: JSON.stringify({ lang: "de", fsid: a.fsid, sysId: 21, clientId: a.clientId, CDI: Number(a.clientId) % 1001, deviceId: a.deviceId }) }, 12000);
    const j = await r.json();
    if (!j || j.saldo == null) return null;
    return { saldo: Number(j.saldo), bonus: Number(j.bonusSaldo) || 0, hold: Number(j.holdSaldo) || 0, cur: (j.currency && j.currency.currency) || "EUR", ts: Date.now() };
  } catch (_) { return null; }
}

// Catalog: football roots + CS2 roots (prematch "line" AND running "live") with their map children.
async function catalog(force) {
  if (!force && _cat.byId && Date.now() - _cat.at < FEED_TTL_MS) return _cat;
  const r = await fetchT(LINE_HOST + "/events/listBase?lang=de&scopeMarket=3100", { headers: { "Origin": "https://fonbet001.com", "Referer": "https://fonbet001.com/" } }, 20000);
  if (!r || !r.ok) throw new Error("listBase HTTP " + (r ? r.status : "—"));
  const d = await r.json();
  const cf = {}; (d.customFactors || []).forEach((c) => { const m = {}; (c.factors || []).forEach((f) => { m[f.f] = f.v; }); cf[c.e] = m; });
  const kids = {};
  for (const ev of (d.events || [])) if (ev.parentId != null) (kids[ev.parentId] = kids[ev.parentId] || []).push(ev);
  const zus = feedZusatz(d);                           // 04.10.2026: Stand + Sperren (s. feedZusatz)
  const wurzel = sportWurzel(d);                       // 1.2.64: Sportart des Ereignisses (fuer sportZiel)
  const byId = new Map();
  for (const ev of (d.events || [])) {
    if ((ev.place !== "line" && ev.place !== "live") || !ev.team1 || !ev.team2) continue;
    if (!(ev.level === 1 || ev.parentId == null)) continue;
    const f = cf[ev.id] || {};
    const maps = {};
    for (const c of (kids[ev.id] || [])) {
      let n = null;
      const km = /^10200([1-9])$/.exec(String(c.kind || "")); if (km) n = km[1];
      if (!n) { const nm = /^([1-9])\.\s*Karte/i.exec(String(c.name || "")); if (nm) n = nm[1]; }
      if (!n) continue;
      const fc = cf[c.id] || {};
      if (fc[921] > 1 && fc[923] > 1) maps[n] = { eventId: String(c.id), home: Number(fc[921]), away: Number(fc[923]), score: zus.stand.get(String(c.id)) || null,
        gesperrt: { home: zus.gesperrt(c.id, 921), away: zus.gesperrt(c.id, 923) } };
    }
    byId.set(String(ev.id), {
      eventId: String(ev.id), team1: ev.team1, team2: ev.team2, startTime: ev.startTime, live: ev.place === "live",
      ml: { home: Number(f[921]) || 0, draw: Number(f[922]) || 0, away: Number(f[923]) || 0 }, maps,
      score: zus.stand.get(String(ev.id)) || null,
      gesperrt: { home: zus.gesperrt(ev.id, 921), draw: zus.gesperrt(ev.id, 922), away: zus.gesperrt(ev.id, 923) },
      // 1.2.64: Sportart, Art des Ereignisses und ob ein Remis-Faktor GELISTET ist (auch gesperrt) — fuer sportZiel
      sportAlias: wurzel(ev.sportId), kind: ev.kind, hatRemis: f[922] != null,
    });
  }
  _cat = { at: Date.now(), byId };
  return _cat;
}

// Pick the bet target for a proposal: which eventId to bet on, which factor, and the CURRENT price.
// Factor ids are the production-proven ones: 921 = "1"/team1, 922 = "X", 923 = "2"/team2.
export function selectTarget(rec, p) {
  if (p && Object.prototype.hasOwnProperty.call(SPORT_ZIEL, String(p.sport))) return sportZiel(rec, p);   // 1.2.64: Basketball — nur der genaue Faktor
  if (!rec) return { error: "event no longer offered" };
  if (p.mkt === "mapWinner") {
    const m = /^map([123])$/.exec(String(p.scope || ""));
    if (!m) return { error: "bad scope for mapWinner" };
    const t = (rec.maps || {})[m[1]];
    if (!t) return { error: "map " + m[1] + " market not offered" };
    if (p.sel !== "home" && p.sel !== "away") return { error: "mapWinner needs home/away" };
    if (t.gesperrt && t.gesperrt[p.sel]) return { error: "selection suspended right now (the price in the feed is frozen)" };
    return { eventId: t.eventId, factor: p.sel === "home" ? 921 : 923, odds: Number(p.sel === "home" ? t.home : t.away) || 0, live: rec.live === true, score: t.score || null };
  }
  if (p.mkt === "ml") {
    const f = { home: 921, draw: 922, away: 923 }[p.sel];
    const o = rec.ml ? Number(rec.ml[p.sel]) || 0 : 0;
    if (!f) return { error: "bad sel for ml" };
    if (!(o > 1)) return { error: "outcome not offered" };
    if (rec.gesperrt && rec.gesperrt[p.sel]) return { error: "selection suspended right now (the price in the feed is frozen)" };
    return { eventId: rec.eventId, factor: f, odds: o, live: rec.live === true, score: rec.score || null };
  }
  return { error: "market " + String(p.mkt) + " not supported by the fonbet adapter" };
}

// Place. Returns the operator-side status vocabulary: placed | blocked | uncertain.
export async function place(p, stakeEur, ctx) {
  if (p && p.mkt === "parlay") return await placeKombi(p, stakeEur, ctx);
  const a = await ensureAuth(ctx);   // vor dem Blocken: Session aus der Seite lesen (Fehlalarm „keine Session" trotz Login vermeiden)
  if (!a || !a.fsid || !(a.clientId > 0)) return { status: "blocked", reason: "fonbet: no session — sign in at fonbet001.com" };
  if (!a.deviceId) return { status: "blocked", reason: "fonbet: deviceId not captured — open a betslip once on fonbet001.com" };
  let cat;
  try { cat = await catalog(true); }   // always fresh before placing: live prices move by the second
  catch (e) { return { status: "blocked", reason: "fonbet: catalog fetch failed: " + String((e && e.message) || e) }; }
  const rec = cat.byId.get(String(p.bookRef.eventId));
  const tgt = selectTarget(rec, p);
  if (tgt.error) return { status: "blocked", reason: "fonbet: " + tgt.error };
  if (!(tgt.odds > 1)) return { status: "blocked", reason: "fonbet: no price for this outcome" };
  if (tgt.odds < Number(p.minOdds)) return { status: "blocked", reason: `fonbet: ${tgt.odds.toFixed(2)} below min ${Number(p.minOdds).toFixed(2)} (slippage floor)` };

  const wunsch = Math.round(Number(stakeEur) * 100) / 100;
  const r = await scheinSenden(p, wunsch, ctx, a, tgt);
  const erlaubt = r.status === "blocked" ? erlaubterBetrag(r.reason, wunsch) : 0;
  if (!erlaubt) return r;
  ctx.log(`fonbet: book limit, placing the allowed ${erlaubt} € instead of ${wunsch} €`);
  return await scheinSenden(p, erlaubt, ctx, a, tgt);
}
async function scheinSenden(p, amount, ctx, a, tgt) {
  const authBody = { lang: "de", fsid: a.fsid, sysId: 21, clientId: a.clientId, CDI: Number(a.clientId) % 1001, deviceId: a.deviceId };   // CDI = Konto-Nr. mod 1001, wie die Seite es rechnet (bis 1.2.72 fest 960, der Wert EINES Kontos)
  let rid;
  try {
    const r1 = await fetchT(CLIENTS_HOST + "/coupon/betRequestId", { method: "POST", headers: HDRS, body: JSON.stringify(authBody) }, 15000);
    const j1 = await r1.json(); rid = j1 && j1.requestId;
  } catch (e) { return { status: "blocked", reason: "fonbet: betRequestId failed: " + String((e && e.message) || e), odds: tgt.odds }; }
  if (!rid) return { status: "uncertain", reason: "fonbet: no requestId (check the account)", odds: tgt.odds, stake: amount };

  // 04.10.2026 LIVE: die Seite schickt bei einem laufenden Spiel den Stand mit (score "h:a") — ohne ihn lehnte fonbet.gr die
  // Live-Auftraege des Bots ab (12:36/12:37 UTC, resultCode 100 nach der Wartezeit). Vorspiel und ein Live-Ziel ohne lesbaren
  // Stand gehen wie bisher ohne das Feld raus.
  const wette = Object.assign({ num: 1, event: Number(tgt.eventId), factor: tgt.factor, value: tgt.odds }, (tgt.live && tgt.score) ? { score: tgt.score } : {}, { zone: "es" });
  const body = { requestId: rid, lang: "de",
    coupon: { amount, flexBet: "up", flexParam: false, mirror: "https://fonbet001.com", bets: [wette] },
    fsid: a.fsid, sysId: 21, clientId: a.clientId };
  ctx.log(`fonbet: placing ${p.mkt}/${p.scope || "match"} ${p.sel} on event ${tgt.eventId} · factor ${tgt.factor} · ${amount} € @ ${tgt.odds}` + (tgt.live ? " · LIVE, score " + (tgt.score || "unknown") : ""));
  let res;
  try {
    const r2 = await fetchT(CLIENTS_HOST + "/coupon/bet", { method: "POST", headers: HDRS, body: JSON.stringify(body) }, 20000);
    res = await r2.json();
  } catch (e) { return { status: "uncertain", reason: "fonbet: bet request aborted (check the account): " + String((e && e.message) || e), odds: tgt.odds, stake: amount }; }

  let oc = couponOutcome(res);
  // READ-BACK: bei JEDEM unklaren Verdikt (nicht nur Live-`delay`) per requestId nachfassen → aus
  // „uncertain" wird ein sicheres placed/rejected (bestehender coupon/betResult-Endpunkt).
  if (oc.kind !== "placed" && oc.kind !== "rejected") {
    const waitMs = (oc.kind === "delay") ? (Math.min(Number(oc.ms) || 5000, 8000) + 500) : 1200;
    await new Promise((rs) => setTimeout(rs, waitMs));
    for (let i = 0; i < 4; i++) {
      let jr = null;
      try {
        const r3 = await fetchT(CLIENTS_HOST + "/coupon/betResult", { method: "POST", headers: HDRS, body: JSON.stringify({ lang: "de", requestId: rid, fsid: a.fsid, sysId: 21, clientId: a.clientId, CDI: Number(a.clientId) % 1001, deviceId: a.deviceId }) }, 15000);
        jr = await r3.json();
      } catch (_) { jr = null; }
      const oc2 = couponOutcome(jr);
      if (oc2.kind === "placed" || oc2.kind === "rejected") { oc = oc2; break; }
      await new Promise((rs) => setTimeout(rs, 1500));
    }
  }
  if (oc.kind === "placed") {
    const cp = oc.cp, fill = Number(cp.originalK) || tgt.odds;
    return { status: "placed", odds: fill, ticket: String(cp.regId), stake: amount,
             note: (p.minOdds && fill < Number(p.minOdds)) ? `filled @ ${fill.toFixed(2)} BELOW min ${Number(p.minOdds).toFixed(2)} — check` : undefined };
  }
  if (oc.kind === "rejected") return { status: "blocked", reason: "fonbet: rejected (resultCode " + oc.rc + ")" + (oc.rt ? ": " + oc.rt : ""), odds: tgt.odds };
  return { status: "uncertain", reason: "fonbet: no clear coupon/betResult verdict (check the account)", odds: tgt.odds, stake: amount };
}

// ---- 1.2.72 — KOMBIWETTE („Express“) -------------------------------------------------------------------------------------------
// EIN Schein mit mehreren Spielen: der Schein der Einzelwette mit mehreren Wetten. Der ganze Ablauf steht im Baustein
// content/fonbet-kombi.js (byte-gleich mit fonbet-kombi.js des Operators; engine-sw.js bindet ihn ein — die Engine setzt bei
// Fonbet aus ihrem Service Worker, also laeuft auch der Baustein dort): das Buch prueft und bepreist den ganzen Schein in EINEM Abruf
// (coupon/betSlipInfo, mit der Sitzung: Grenzen des Kontos und bei fonbet.gr die Gewinnsteuer); je Bein dasselbe Spiel
// (Mannschafts-Nummern des Buchs, sonst genau die Namen), vor dem Anpfiff, nicht gesperrt, der Faktor des Tipps, Mindestquote;
// zweite Pruefung des fertigen Auftrags, dann EIN Aufruf coupon/bet. Jedes Bein kommt vom Operator in der Reihenfolge des BUCHS
// — die Engine sucht nie selbst ein Spiel oder eine Seite. Geteilt mit fonbet-gr.js: ort "com" = fonbet001.com, "gr" = fonbet.gr.
const KOMBI_SPORT = { fb: "soccer", basket: "basketball" };     // Feed-Name der Sportart eines Beins → Name im Baustein
const KOMBI_NACHFRAGEN_MAX = 12;                               // der Baustein fragt hoechstens acht Mal nach dem Ergebnis
const KOMBI_MIN_EINSATZ = 0.1, KOMBI_MAX_EINSATZ = 1000;       // wie der Baustein (EUR)
let _kombiNr = 0;
// name = Kennung fuers Protokoll, ort = "com" | "gr", seite = wo man sich anmeldet, sitz = { host, fsid, clientId, deviceId }.
// Die Sitzungswerte gehen nur an den Baustein — nie ins Protokoll und in keine Rueckgabe.
export async function kombiSetzen(p, stakeEur, ctx, name, ort, seite, sitz) {
  const FB = (typeof self !== "undefined" && self && self.FBKOMBI) || null;
  if (!(FB && typeof FB.place === "function" && typeof FB.nachfragen === "function")) return { status: "blocked", reason: name + ": combo module missing in this engine package — nothing sent" };
  const legs = [];
  for (let i = 0; i < (Array.isArray(p.legs) ? p.legs.length : 0); i++) {
    const L = p.legs[i] || {}, feed = (L.sport == null || L.sport === "") ? "fb" : String(L.sport);
    const sport = Object.prototype.hasOwnProperty.call(KOMBI_SPORT, feed) ? KOMBI_SPORT[feed] : null;
    if (!sport) return { status: "blocked", reason: name + ": leg " + (i + 1) + " — sport " + feed + " is not connected for parlays" };
    if (!/^\d{4,12}$/.test(String(L.eventId == null ? "" : L.eventId))) return { status: "blocked", reason: name + ": leg " + (i + 1) + " — game number unreadable" };
    if (typeof L.team1 !== "string" || !L.team1 || typeof L.team2 !== "string" || !L.team2) return { status: "blocked", reason: name + ": leg " + (i + 1) + " without the team names of the book — nothing sent" };
    // Ausser Fussball nur mit dem genauen FAKTOR des Operators (wie die Einzelwette, sportZiel): er stammt aus dem Katalog, der
    // den 2-Weg-Sieger belegt. Der Baustein vergleicht ihn mit dem Faktor des Tipps und macht beim Buch die Gegenprobe.
    if (sport !== "soccer" && L.outcomeId == null) return { status: "blocked", reason: name + ": leg " + (i + 1) + " without the exact selection (factor) — not placed" };
    const bein = { eventId: String(L.eventId), tip: L.tip, minOdds: Number(L.minOdds), team1: L.team1, team2: L.team2, sport };
    if (L.outcomeId != null) bein.outcomeId = String(L.outcomeId);
    if (L.t1Id != null && L.t2Id != null) { bein.t1Id = L.t1Id; bein.t2Id = L.t2Id; }      // Mannschafts-Nummern des Buchs (an beiden Orten gleich)
    legs.push(bein);
  }
  if (legs.length < 2) return { status: "blocked", reason: name + ": a parlay needs at least two legs" };
  const einsatz = Math.round(Number(stakeEur) * 100) / 100;
  if (!(einsatz >= KOMBI_MIN_EINSATZ) || einsatz > KOMBI_MAX_EINSATZ) return { status: "blocked", reason: name + ": Einsatz " + einsatz + " ausserhalb " + KOMBI_MIN_EINSATZ + "-" + KOMBI_MAX_EINSATZ };
  if (!(Number(p.minOdds) > 1)) return { status: "blocked", reason: name + ": minOdds fehlt" };
  if (!sitz || !sitz.fsid || !(Number(sitz.clientId) > 0)) return { status: "blocked", reason: name + ": no session — sign in at " + seite };
  if (!sitz.deviceId) return { status: "blocked", reason: name + ": deviceId not captured — open a betslip once on " + seite };
  // Auftrags-Nummer JE VERSUCH: der Baustein fuehrt dieselbe Nummer nie zweimal aus.
  const auftragId = ("p-" + String(p.proposalId == null ? "" : p.proposalId).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 48) + "-" + Date.now().toString(36) + "-" + (++_kombiNr)).slice(0, 80);
  ctx.log(name + ": parlay · " + legs.length + " legs · " + einsatz + " EUR @ ≥" + Number(p.minOdds));
  const t0 = Date.now();
  let r;
  try { r = await FB.place({ auftragId, armed: true, amount: einsatz, minTotalOdds: Number(p.minOdds), legs, sitz: { ort, host: String(sitz.host), fsid: String(sitz.fsid), clientId: Number(sitz.clientId), deviceId: String(sitz.deviceId) } }, {}); }
  catch (e) { return { status: "uncertain", reason: name + ": Ausnahme im Kombi-Baustein (" + String((e && e.message) || e).slice(0, 100) + ") — im Konto pruefen" }; }
  // Meldet der Baustein „pending“, ist der Schein beim Buch: HIER warten und nach dem Ergebnis fragen (liest nur).
  let nachfragen = 0;
  while (r && r.status === "pending" && r.warteId && nachfragen < KOMBI_NACHFRAGEN_MAX) {
    nachfragen++;
    const wartet = r;
    await new Promise((rs) => setTimeout(rs, Math.max(250, Math.min(10000, Number(r.nachMs) || 0))));
    try { r = await FB.nachfragen(wartet.warteId); } catch (e) { r = { error: String((e && e.message) || e) }; }
    if (!r || !r.status) r = { status: "uncertain", ticket: wartet.ticket, odds: wartet.odds, reason: name + ": keine Antwort beim Nachfragen (" + String(r && r.error).slice(0, 100) + ") — der Schein war beim Buch, im Konto pruefen" };
    else if (!r.ticket && wartet.ticket) r.ticket = wartet.ticket;
  }
  if (r && r.status === "pending") r = { status: "uncertain", ticket: r.ticket, odds: r.odds, reason: name + ": nach " + nachfragen + " Nachfragen noch kein Ergebnis — im Konto pruefen" };
  ctx.log(name + ": parlay answer after " + (Date.now() - t0) + " ms" + (nachfragen ? " (" + nachfragen + " follow-ups)" : "") + " · " + (r && r.status ? r.status : "?") + (r && r.ticket ? " · Ticket " + r.ticket : "") + (r && r.reason ? " · " + String(r.reason).slice(0, 260) : "") + (r && r.note ? " · " + String(r.note).slice(0, 200) : "") + (r && r.info ? " · " + String(r.info).slice(0, 200) : ""));
  if (!r || !r.status) return { status: "uncertain", reason: name + ": keine Antwort vom Kombi-Baustein — im Konto pruefen" };
  return { status: r.status, odds: r.odds, stake: r.stake, reason: r.reason, note: r.note, ticket: r.ticket != null ? String(r.ticket) : undefined, verified: r.verified, legs: r.legs, ms: r.ms, tax: r.tax, netOdds: r.netOdds, bonus: r.bonus, info: r.info };
}
async function placeKombi(p, stakeEur, ctx) {
  const a = await ensureAuth(ctx);
  return await kombiSetzen(p, stakeEur, ctx, "fonbet", "com", "fonbet001.com", { host: CLIENTS_HOST, fsid: a && a.fsid, clientId: a && a.clientId, deviceId: a && a.deviceId });
}

// ---- Konto lesen (01.11.2026, gelesen am echten Konto 01.11.2026, books/konto-lesen.js) ----------------------------------------
// Wetten: betsHistory/getLastCoupons + getPrevCoupons (lastSequenceId, lastMaxLoadedVersion). Beine: coupon/info (regId, betTypeName "sport"; Beträge dort in Cent). Kontobuch: session/client/lastOperations (maxCount, Beträge in Euro).
// operationId 1 = Wette platziert, 2 = abgerechnet (Auszahlung), 4 = verloren (0 €). Andere stehen als op<Nummer> drin, bis sie belegt sind. Der Kopf von coupon/info nennt auch IP und Prüfcode: Die werden hier nicht übernommen.
const FB_STATUS = { win: "gewonnen", lose: "verloren", registered: "offen" }, FB_ART = { 1: "einsatz", 2: "gewinn", 4: "verloren" };
const fbBreak = (ms) => new Promise((r) => setTimeout(r, ms));
export function fbWetteAus(c, info) {
  const h = (info && info.header) || {}, b = (info && info.body) || {}, x = c.extra || {}, status = (s) => FB_STATUS[String(s || "").toLowerCase()] || "unklar";
  const bein = (e) => {
    const n = String(e.eventName || "").split(" – ");
    return { spielId: e.eventId != null ? String(e.eventId) : null, start: e.eventStartTime ? e.eventStartTime * 1000 : null, heim: n[0] || null, gast: n[1] || null, liga: null, sport: e.sportName || null, markt: e.factorId != null ? "factor " + e.factorId : null, tipp: e.stakeName || null, quote: e.factorValue != null ? Number(e.factorValue) : null, ergebnis: status(e.result), stand: e.resultScore || null, live: e.live === true };
  };
  return { id: String(c.couponId), ts: c.registrationTime ? c.registrationTime * 1000 : null, einsatz: c.betSum != null ? Number(c.betSum) : null, quote: x.couponK != null ? Number(x.couponK) : (h.couponK != null ? Number(h.couponK) : null), status: status(c.betState), auszahlung: c.winSum != null ? Number(c.winSum) : null, waehrung: h.currency || null, kombi: Number(x.betCount) > 1, bonus: x.betMode != null && x.betMode !== "Coupon", beine: Array.isArray(b.bets) ? b.bets.map(bein) : [] };
}
export function fbBuchungAus(o) { return { id: o.saldoId + "-" + o.Id, ts: o.time ? o.time * 1000 : null, betrag: Number(o.sum) || 0, art: FB_ART[o.operationId] || "op" + o.operationId, bezug: o.markerId != null ? String(o.markerId) : null }; }
// Geteilt mit fonbet-gr.js: gleicher Aufbau, andere Adresse und Sprache.
export async function fbKontoLesen(host, hdrs, lang, a, m) {
  if (!a || !a.fsid || !(a.clientId > 0)) return null;
  const basis = { lang, fsid: a.fsid, sysId: 21, clientId: a.clientId, CDI: Number(a.clientId) % 1001, deviceId: a.deviceId };
  const rufe = async (p, x) => { const r = await fetchT(host + p, { method: "POST", headers: hdrs, body: JSON.stringify(Object.assign({}, basis, x || {})) }, 15000); return r.json(); };
  const alt = (m && m.infos) || {}, voll = !!(m && m.voll);
  let j = await rufe("/betsHistory/getLastCoupons");
  if (!j || !Array.isArray(j.coupons)) return null;
  const coupons = j.coupons.slice(); let seiten = 0, ende = !j.hasMoreData;
  while (!voll && j.hasMoreData && seiten < 40) {
    j = await rufe("/betsHistory/getPrevCoupons", { lastSequenceId: j.lastSequenceId, lastMaxLoadedVersion: j.lastMaxLoadedVersion });
    if (!j || !Array.isArray(j.coupons)) { ende = false; break; }
    coupons.push(...j.coupons); ende = !j.hasMoreData; seiten++;
    await fbBreak(300);
  }
  const infos = Object.assign({}, alt), wetten = []; let abrufe = 0;
  for (const c of coupons) {
    const k = String(c.couponId), st = String(c.betState);
    if (alt[k] === st) continue;                                // nichts Neues an diesem Schein
    let info = null;
    if (abrufe < 60 && /sport/i.test(String(c.betTypeName || ""))) {
      abrufe++;
      try { const d = await rufe("/coupon/info", { regId: Number(c.couponId), betTypeName: "sport" }); if (d && d.result === "couponInfo") { info = d; infos[k] = st; } } catch (_) {}
      await fbBreak(250);
    }
    wetten.push(fbWetteAus(c, info));
  }
  const schluessel = Object.keys(infos); if (schluessel.length > 5000) for (const k of schluessel.slice(0, schluessel.length - 5000)) delete infos[k];
  let buchungen = [];
  try { const o = await rufe("/session/client/lastOperations", { maxCount: 1000 }); if (o && Array.isArray(o.operations)) buchungen = o.operations.map(fbBuchungAus); } catch (_) {}
  return { wetten, buchungen, summen: null, voll: voll || ende, merker: { infos } };
}
export async function kontoLesen(venue, m) { return fbKontoLesen(CLIENTS_HOST, HDRS, "de", await ensureAuth(), m); }
