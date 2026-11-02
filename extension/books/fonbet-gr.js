// books/fonbet-gr.js — Fonbet GRIECHENLAND (fonbet.gr). Eigener Adapter, weil Hosts, Markt-Scope und
// Sprache abweichen; Logik und Vertrag sind identisch zum .com-Adapter.
//
// VERIFIZIERT aus dem HAR (fonbet.gr, 25.07.2026) und gegen den LIVE-Feed (29.07.2026):
//   - Auth identisch: fsid, sysId 21, clientId, CDI, deviceId — im JSON-Body jeder clientsapi-POST.
//   - Faktor-IDs identisch: 921 = "1", 922 = "X", 923 = "2" (aus betSlipInfo: factorId 923 → "2").
//   - Feed: https://line21.gr-resource.com/events/listBase?lang=en&scopeMarket=1900
//     (der .com-Feed nutzt scopeMarket 3100 — DAS ist der wesentliche Unterschied).
//   - **Event-IDs sind DIESELBEN wie bei .com**: 2620 gemeinsame IDs, 99 % identische Paarungen.
//     Darum funktioniert ein Proposal des Operators (der .com liest) hier unverändert.
//   - Quoten weichen bei rund 4 % der Spiele ab. Der Preis-Floor (minOdds) fängt das ab: liegt der
//     griechische Preis darunter, wird NICHT gesetzt.
//
// NICHT verifiziert: der Setz-Flow selbst (im HAR wurde keine Wette abgeschickt, nur betSlipInfo).
// Er ist 1:1 vom produktiv laufenden .com-Pfad übernommen — vor dem ersten scharfen Einsatz bitte
// eine kleine Testwette. Fonbet GR meldet in betSlipInfo einen Mindesteinsatz von 0,32 (sums.min).
"use strict";
import { couponOutcome, erlaubterBetrag, harvestAuth, feedZusatz, SPORT_ZIEL, sportWurzel, sportZiel, kombiSetzen, fbKontoLesen } from "./fonbet.js";   // geteilte Logik: Coupon-Verdikt, Page-Read der Session, Stand + Sperren, Sportarten (1.2.64), Kombiwette (1.2.72)

// _auth aus Sniff ODER (Fallback) direkt aus dem fonbet.gr-Tab lesen — behebt „keine Session" trotz Login.
async function ensureAuth(ctx) {
  if (_auth && _auth.fsid && _auth.clientId > 0 && _auth.deviceId) return _auth;
  try {
    const a = await harvestAuth("fonbet.gr");
    if (a && a.fsid && a.clientId > 0) {
      const first = !(_auth && _auth.fsid);
      _auth = Object.assign({}, _auth, a, { at: Date.now(), variant: "gr" });
      try { if (ctx && ctx.storageSet) ctx.storageSet("fonbetGrAuth", _auth); } catch (_) {}
      if (first && ctx && ctx.log) ctx.log("fonbet.gr: session read from the page (fsid/clientId" + (_auth.deviceId ? "/deviceId" : "") + ")");
    }
  } catch (_) {}
  return _auth;
}

const LINE_HOSTS = ["https://line21.gr-resource.com", "https://line31.gr-resource.com", "https://line32.gr-resource.com"];
const CLIENTS_HOSTS = ["https://clientsapi31.gr-resource.com", "https://clientsapi32.gr-resource.com", "https://clientsapi33.gr-resource.com"];
const SCOPE_MARKET = 1900;
const LANG = "en";
const FEED_TTL_MS = 90000;
const HDRS = { "Content-Type": "text/plain;charset=UTF-8", "Origin": "https://fonbet.gr", "Referer": "https://fonbet.gr/" };

let _auth = null;
let _cat = { at: 0, byId: null };
let _clients = CLIENTS_HOSTS[0];

async function fetchT(url, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 12000);
  try { return await fetch(url, Object.assign({}, opts || {}, { signal: ctl.signal })); }
  finally { clearTimeout(t); }
}

export const id = "fonbetgr";
export const hosts = { line: LINE_HOSTS, clients: CLIENTS_HOSTS, site: "https://fonbet.gr/" };
// Sportarten, die dieser Adapter setzt (engine-core.js adapterSetzt). basket seit 1.2.64 — nur mit genauem Faktor (fonbet.js sportZiel).
export const sports = { fb: true, cs2: true, basket: true };
// 1.2.72 (05.10.2026): dieser Adapter setzt Kombiwetten (mkt "parlay") — engine-core.js adapterKombi.
export const kombi = true;

export function arm(ctx) {
  try { ctx.storageGet("fonbetGrAuth").then((v) => { if (v && v.fsid) _auth = v; }); } catch (_) {}
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
        try { const h = new URL(d.url).origin; if (CLIENTS_HOSTS.indexOf(h) >= 0) _clients = h; } catch (_) {}
        ctx.storageSet("fonbetGrAuth", _auth);
        if (first) ctx.log("fonbet.gr: session captured (fsid/clientId" + (_auth.deviceId ? "/deviceId" : "") + ")");
      } catch (_) {}
    }, { urls: CLIENTS_HOSTS.map((h) => h + "/*") }, ["requestBody"]);
  } catch (e) { ctx.log("fonbet.gr: webRequest arm fehlgeschlagen: " + String((e && e.message) || e)); }
}

export function status() {
  if (!_auth || !_auth.fsid || !(_auth.clientId > 0)) return { ready: false, detail: "not signed in — sign in at fonbet.gr" };
  if (!_auth.deviceId) return { ready: false, detail: "device id missing — open a betslip at fonbet.gr once" };
  return { ready: true, detail: "ready (session captured)" };
}

// Kontostand: session/info (gleiche API wie .com; saldo verfügbar, holdSaldo in offenen Wetten).
export async function balance() {
  const a = await ensureAuth();   // Heartbeat: Session ggf. aus der Seite lesen → status() bleibt ehrlich
  if (!a || !a.fsid || !(a.clientId > 0)) return null;
  try {
    const r = await fetchT(_clients + "/session/info", { method: "POST", headers: HDRS, body: JSON.stringify({ lang: "en", fsid: a.fsid, sysId: 21, clientId: a.clientId, CDI: Number(a.clientId) % 1001, deviceId: a.deviceId }) }, 12000);
    const j = await r.json();
    if (!j || j.saldo == null) return null;
    return { saldo: Number(j.saldo), bonus: Number(j.bonusSaldo) || 0, hold: Number(j.holdSaldo) || 0, cur: (j.currency && j.currency.currency) || "EUR", ts: Date.now() };
  } catch (_) { return null; }
}

// Katalog: Prematch ("line") UND laufende ("live") Spiele mit Karten-Kindern — wie beim .com-Adapter.
async function catalog(force) {
  if (!force && _cat.byId && Date.now() - _cat.at < FEED_TTL_MS) return _cat;
  let d = null, lastErr = null;
  for (const host of LINE_HOSTS) {                    // Spiegel der Reihe nach probieren
    try {
      const r = await fetchT(host + `/events/listBase?lang=${LANG}&scopeMarket=${SCOPE_MARKET}`,
        { headers: { "Origin": "https://fonbet.gr", "Referer": "https://fonbet.gr/" } }, 20000);
      if (r && r.ok) { d = await r.json(); break; }
      lastErr = "HTTP " + (r ? r.status : "—");
    } catch (e) { lastErr = String((e && e.message) || e); }
  }
  if (!d) throw new Error("listBase (GR): " + (lastErr || "kein Spiegel erreichbar"));
  const cf = {}; (d.customFactors || []).forEach((c) => { const m = {}; (c.factors || []).forEach((f) => { m[f.f] = f.v; }); cf[c.e] = m; });
  const kids = {};
  for (const ev of (d.events || [])) if (ev.parentId != null) (kids[ev.parentId] = kids[ev.parentId] || []).push(ev);
  // 04.10.2026: Stand + Sperren (fonbet.js feedZusatz). Gemessen am griechischen Feed: 223 laufende Spiele, alle mit Stand in
  // eventMiscs; 27 Sperr-Eintraege (19 „blocked", 8 „partial").
  const zus = feedZusatz(d);
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
      if (!n) { const nm = /^([1-9])\.\s*(?:Karte|Map)/i.exec(String(c.name || "")); if (nm) n = nm[1]; }
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

export function selectTarget(rec, p) {
  if (p && Object.prototype.hasOwnProperty.call(SPORT_ZIEL, String(p.sport))) return sportZiel(rec, p);   // 1.2.64: Basketball — nur der genaue Faktor
  if (!rec) return { error: "Event wird nicht (mehr) angeboten" };
  if (p.mkt === "mapWinner") {
    const m = /^map([123])$/.exec(String(p.scope || ""));
    if (!m) return { error: "ungültiger Scope für mapWinner" };
    const t = (rec.maps || {})[m[1]];
    if (!t) return { error: "Karte " + m[1] + " wird nicht angeboten" };
    if (p.sel !== "home" && p.sel !== "away") return { error: "mapWinner braucht home/away" };
    if (t.gesperrt && t.gesperrt[p.sel]) return { error: "Ausgang gerade gesperrt (die Quote im Feed steht nur noch)" };
    return { eventId: t.eventId, factor: p.sel === "home" ? 921 : 923, odds: Number(p.sel === "home" ? t.home : t.away) || 0, live: rec.live === true, score: t.score || null };
  }
  if (p.mkt === "ml") {
    const f = { home: 921, draw: 922, away: 923 }[p.sel];
    const o = rec.ml ? Number(rec.ml[p.sel]) || 0 : 0;
    if (!f) return { error: "ungültige Auswahl für ml" };
    if (!(o > 1)) return { error: "Ausgang wird nicht angeboten" };
    if (rec.gesperrt && rec.gesperrt[p.sel]) return { error: "Ausgang gerade gesperrt (die Quote im Feed steht nur noch)" };
    return { eventId: rec.eventId, factor: f, odds: o, live: rec.live === true, score: rec.score || null };
  }
  return { error: "Markt " + String(p.mkt) + " wird vom Fonbet-GR-Adapter nicht unterstützt" };
}

export async function place(p, stakeEur, ctx) {
  if (p && p.mkt === "parlay") return await placeKombi(p, stakeEur, ctx);
  const a = await ensureAuth(ctx);   // vor dem Blocken: Session aus der Seite lesen (Fehlalarm „keine Session" trotz Login vermeiden)
  if (!a || !a.fsid || !(a.clientId > 0)) return { status: "blocked", reason: "fonbet.gr: keine Session — auf fonbet.gr einloggen" };
  if (!a.deviceId) return { status: "blocked", reason: "fonbet.gr: deviceId fehlt — einmal einen Wettschein öffnen" };
  let cat;
  try { cat = await catalog(true); }                  // immer frisch: Live-Preise laufen im Sekundentakt
  catch (e) { return { status: "blocked", reason: "fonbet.gr: Katalog-Fetch fehlgeschlagen: " + String((e && e.message) || e) }; }
  const rec = cat.byId.get(String(p.bookRef.eventId));
  const tgt = selectTarget(rec, p);
  if (tgt.error) return { status: "blocked", reason: "fonbet.gr: " + tgt.error };
  if (!(tgt.odds > 1)) return { status: "blocked", reason: "fonbet.gr: kein Preis für diesen Ausgang" };
  if (tgt.odds < Number(p.minOdds)) return { status: "blocked", reason: `fonbet.gr: ${tgt.odds.toFixed(2)} unter Min ${Number(p.minOdds).toFixed(2)} (Slippage-Floor)` };

  // 01.11.2026: Nennt das Buch ein Limit, einmal mit genau dem Betrag neu setzen (fonbet.js erlaubterBetrag).
  const wunsch = Math.round(Number(stakeEur) * 100) / 100;
  const r = await scheinSenden(p, wunsch, ctx, a, tgt);
  const erlaubt = r.status === "blocked" ? erlaubterBetrag(r.reason, wunsch) : 0;
  if (!erlaubt) return r;
  ctx.log(`fonbet.gr: book limit, placing the allowed ${erlaubt} € instead of ${wunsch} €`);
  return await scheinSenden(p, erlaubt, ctx, a, tgt);
}
async function scheinSenden(p, amount, ctx, a, tgt) {
  const host = _clients;
  const authBody = { lang: LANG, fsid: a.fsid, sysId: 21, clientId: a.clientId, CDI: Number(a.clientId) % 1001, deviceId: a.deviceId };   // CDI = Konto-Nr. mod 1001, wie die Seite es rechnet (bis 1.2.72 fest 649, der Wert EINES Kontos)
  let rid;
  try {
    const r1 = await fetchT(host + "/coupon/betRequestId", { method: "POST", headers: HDRS, body: JSON.stringify(authBody) }, 15000);
    const j1 = await r1.json(); rid = j1 && j1.requestId;
  } catch (e) { return { status: "blocked", reason: "fonbet.gr: betRequestId fehlgeschlagen: " + String((e && e.message) || e), odds: tgt.odds }; }
  if (!rid) return { status: "uncertain", reason: "fonbet.gr: keine requestId erhalten (Konto prüfen)", odds: tgt.odds, stake: amount };

  // 04.10.2026 LIVE: bei einem laufenden Spiel geht der Stand mit (score "h:a"), wie ihn die Seite schickt — s. fonbet.js.
  const wette = Object.assign({ num: 1, event: Number(tgt.eventId), factor: tgt.factor, value: tgt.odds }, (tgt.live && tgt.score) ? { score: tgt.score } : {}, { zone: "es" });
  const body = { requestId: rid, lang: LANG,
    coupon: { amount, flexBet: "up", flexParam: false, mirror: "https://fonbet.gr", bets: [wette] },
    fsid: a.fsid, sysId: 21, clientId: a.clientId };
  ctx.log(`fonbet.gr: placing ${p.mkt}/${p.scope || "match"} ${p.sel} on event ${tgt.eventId} · factor ${tgt.factor} · ${amount} € @ ${tgt.odds}` + (tgt.live ? " · LIVE, Stand " + (tgt.score || "unbekannt") : ""));
  let res;
  try {
    const r2 = await fetchT(host + "/coupon/bet", { method: "POST", headers: HDRS, body: JSON.stringify(body) }, 20000);
    res = await r2.json();
  } catch (e) { return { status: "uncertain", reason: "fonbet.gr: Setz-Request abgebrochen (im Konto prüfen): " + String((e && e.message) || e), odds: tgt.odds, stake: amount }; }

  let oc = couponOutcome(res);
  // READ-BACK: nicht nur bei Live-`delay`, sondern bei JEDEM unklaren Verdikt per requestId nachfassen
  // (coupon/betResult). So wird aus „uncertain" ein sicheres placed/rejected — die Wette liegt ja oft
  // trotzdem, fonbet gibt nur kein sofortiges Verdikt. Kein neuer Endpunkt, nur der bestehende.
  if (oc.kind !== "placed" && oc.kind !== "rejected") {
    const waitMs = (oc.kind === "delay") ? (Math.min(Number(oc.ms) || 5000, 8000) + 500) : 1200;
    await new Promise((rs) => setTimeout(rs, waitMs));
    for (let i = 0; i < 4; i++) {
      let jr = null;
      try {
        const r3 = await fetchT(host + "/coupon/betResult", { method: "POST", headers: HDRS, body: JSON.stringify(Object.assign({ requestId: rid }, authBody)) }, 15000);
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
             note: (p.minOdds && fill < Number(p.minOdds)) ? `gefüllt @ ${fill.toFixed(2)} UNTER Min ${Number(p.minOdds).toFixed(2)} — prüfen` : undefined };
  }
  if (oc.kind === "rejected") return { status: "blocked", reason: "fonbet.gr: abgelehnt (resultCode " + oc.rc + ")" + (oc.rt ? ": " + oc.rt : ""), odds: tgt.odds };
  return { status: "uncertain", reason: "fonbet.gr: kein eindeutiges Coupon-/betResult-Verdikt (im Konto prüfen)", odds: tgt.odds, stake: amount };
}

// ---- 1.2.72 — KOMBIWETTE („Express“) -------------------------------------------------------------------------------------------
// Derselbe Ablauf wie beim .com-Adapter (fonbet.js kombiSetzen, Baustein content/fonbet-kombi.js) — hier mit dem Ort "gr":
// Seite fonbet.gr, Sprache en, Markt-Scope 1900, die Konto-Schnittstelle dieses Adapters; bei fonbet.gr nennt das Buch in der
// Schein-Auskunft die Gewinnsteuer und was es davon traegt — damit prueft der Baustein die Mindest-Gesamtquote.
async function placeKombi(p, stakeEur, ctx) {
  const a = await ensureAuth(ctx);
  return await kombiSetzen(p, stakeEur, ctx, "fonbet.gr", "gr", "fonbet.gr", { host: _clients, fsid: a && a.fsid, clientId: a && a.clientId, deviceId: a && a.deviceId });
}

export async function kontoLesen(venue, m) { return fbKontoLesen(_clients, HDRS, "en", await ensureAuth(), m); }   // 01.11.2026: wie fonbet.js, dort am echten Konto gelesen
