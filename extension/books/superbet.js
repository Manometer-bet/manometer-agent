// books/superbet.js — Superbet.gr (Plattform „betler"), GRIECHENLAND. Eigener Adapter.
//
// Zwei Wege, wie beim Haupt-Agenten (HAR-verifiziert 01.09.2026, LIVE-Platzierung bewiesen 02.09.2026):
//   1) LESEN/AUFLÖSEN: offener Offer-Feed (kein Login) — der Service-Worker holt den Katalog selbst und
//      findet das Event über bookRef.eventId (= Superbet event_id, identisch für Operator und Bettor,
//      da beide denselben GR-Feed treffen). Frische Quote + Floor-Check hier.
//   2) SETZEN: submitTicket braucht die Login-COOKIE-Session → geht NUR aus einem superbet.gr-Tab
//      (content/superbet-place.js, credentials:include, same-site zur api-Subdomain). Dieser Adapter
//      baut das Ticket-Item und schickt es dem Tab; der Tab setzt + liest per Read-back zurück.
//
// GOTCHA (Feed): startDate/endDate MÜSSEN volle Stunden sein, sonst HTTP 400
//   („startDate must be whole-hour precision"). Deshalb hourFloor().
// Bestätigung: „placed" nur bei code:0 + ticketId (submitTicket-Verdikt) ODER wenn der Read-back das
//   Ticket wiederfindet. Sonst „uncertain" — nie fälschlich placed (Phantom-Bet-Schutz).
"use strict";

const SB_OFFER = "https://production-superbet-offer-gr.freetls.fastly.net";
const SITE = "https://superbet.gr/";
const FEED_TTL_MS = 90000;

let _cat = { at: 0, byId: null };

async function fetchT(url, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 12000);
  try { return await fetch(url, Object.assign({}, opts || {}, { signal: ctl.signal })); }
  finally { clearTimeout(t); }
}
function tabsQuery(q) { return new Promise((rs) => { try { chrome.tabs.query(q, (t) => rs(t || [])); } catch (_) { rs([]); } }); }
function tabCreate(props) { return new Promise((rs) => { try { chrome.tabs.create(props, (t) => rs(t)); } catch (_) { rs(null); } }); }
function tabGet(tabId) { return new Promise((rs) => { try { chrome.tabs.get(tabId, (x) => rs(chrome.runtime.lastError ? null : x)); } catch (_) { rs(null); } }); }
function sendTab(tabId, msg) {
  return new Promise((rs) => {
    try { chrome.tabs.sendMessage(tabId, msg, (r) => { const e = chrome.runtime.lastError; rs(e ? { error: e.message } : (r || { error: "no response" })); }); }
    catch (e) { rs({ error: String((e && e.message) || e) }); }
  });
}
async function inject(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ["content/superbet-place.js"] }); return null; }
  catch (e) { return String((e && e.message) || e); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitComplete(tabId, ms) {
  const t0 = Date.now();
  for (;;) {
    const x = await tabGet(tabId);
    if (!x) return false;
    if (x.status === "complete") return true;
    if (Date.now() - t0 > (ms || 15000)) return false;
    await sleep(300);
  }
}

export const id = "superbet";
// 1.2.71 (05.10.2026): dieser Adapter setzt Kombiwetten (mkt "parlay") — engine-core.js adapterKombi.
export const kombi = true;
export const hosts = { offer: SB_OFFER, site: SITE };

export function arm() { /* nichts vorzuwärmen — Session lebt im superbet.gr-Tab */ }

// Echter Login-Status: checkLoginSession im superbet.gr-Tab (Cookie, same-site). Ergebnis gecacht, damit
// status() (synchron, jeden Heartbeat) die WAHRHEIT meldet statt optimistisch „ready". balance() frischt.
let _auth = { ready: false, ts: 0, cash: null };
async function probeAuth() {
  let tabs = await tabsQuery({ url: "https://superbet.gr/*" });
  if (!tabs || !tabs.length) { _auth = { ready: false, ts: Date.now(), cash: null, why: "kein superbet.gr-Tab offen" }; return _auth; }
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, func: async () => {
      const API = "https://api.web.production.betler.superbet.gr";
      let ready = false, cash = null;
      try {
        const r = await fetch(API + "/api/v1/checkLoginSession?clientSourceType=Desktop_new", { credentials: "include", cache: "no-store" });
        if (r.status !== 401 && r.status !== 403) { const j = await r.json().catch(() => null); ready = !!(j && j.error === false && j.data && j.data.LogonSession && j.data.LogonSession.PlayerId); }
      } catch (_) {}
      if (ready) { try { const b = await fetch(API + "/api/v3/getPlayerBalance?clientSourceType=Desktop_new", { credentials: "include", cache: "no-store" }); const bj = await b.json().catch(() => null); if (bj && bj.data && bj.data.cash) cash = Number(bj.data.cash.total); } catch (_) {} }
      return { ready, cash };
    } });
    const out = (res && res[0] && res[0].result) || { ready: false, cash: null };
    _auth = { ready: !!out.ready, ts: Date.now(), cash: (out.cash != null ? out.cash : null), why: out.ready ? "eingeloggt" : "nicht eingeloggt" };
  } catch (e) { _auth = { ready: false, ts: Date.now(), cash: null, why: String((e && e.message) || e) }; }
  return _auth;
}

export function status() {
  const fresh = _auth.ts && (Date.now() - _auth.ts < 180000);   // Cache 3 Min (balance() frischt jeden Heartbeat)
  if (!fresh) return { ready: false, detail: "sign-in not checked yet (superbet.gr tab open and signed in?)" };
  return { ready: !!_auth.ready, detail: _auth.ready ? ("signed in" + (_auth.cash != null ? " · " + _auth.cash.toFixed(2) + " €" : "")) : (_auth.why || "nicht eingeloggt — auf superbet.gr einloggen") };
}

// balance() läuft im Heartbeat für aktive Bücher → nutzen wir zugleich als Login-Probe (frischt _auth).
export async function balance() {
  const a = await probeAuth();
  if (!a.ready || a.cash == null) return null;
  return { saldo: a.cash, bonus: 0, hold: 0, cur: "EUR", ts: Date.now() };
}

function hourFloor(ms) { const d = new Date(ms); d.setUTCMinutes(0, 0, 0); return d.toISOString(); }

async function catalog(force) {
  if (!force && _cat.byId && Date.now() - _cat.at < FEED_TTL_MS) return _cat;
  const now = Date.now();
  const s = hourFloor(now - 3 * 3600e3), e = hourFloor(now + 4 * 24 * 3600e3);
  const r = await fetchT(`${SB_OFFER}/v3/en-GR/events?startDate=${encodeURIComponent(s)}&endDate=${encodeURIComponent(e)}`, {}, 25000);
  if (!r || !r.ok) throw new Error("offer HTTP " + (r ? r.status : "—"));
  const d = await r.json();
  const byId = new Map();
  for (const ev of (d.events || [])) {
    const fx = ev.fixture || {};
    if (String(fx.sport_id) !== "5") continue;                       // nur Fußball
    const mk = (ev.markets || []).find((m) => Number(m.id) === 547 || /full time/i.test(m.name || ""));
    if (!mk || !Array.isArray(mk.odds)) continue;
    const o = {}, u = {};
    for (const od of mk.odds) {
      const md = od.metadata || {};
      const nm = String(md.name || md.code || "");
      const tip = (nm === "1" || nm === "X" || nm === "2") ? nm : null;
      if (!tip || !(Number(od.price) > 1)) continue;
      o[tip] = Number(od.price);
      u[tip] = { oddUuid: od.uuid, marketUuid: md.market_line_uuid, price: Number(od.price), oddId: md.outcome_id, oddDesc: md.info || "", code: nm };
    }
    if (!(o["1"] > 1 && o["2"] > 1)) continue;
    const name = String(fx.event_name || "");
    const parts = name.includes("·") ? name.split("·") : name.split(/\s[–-]\s/);
    byId.set(String(ev.event_id), {
      eventId: ev.event_id, uuid: fx.uuid, betradarId: String(fx.betradar_id || ""), name,
      home: (parts[0] || "").trim(), away: (parts[1] || "").trim(),
      matchDate: String(fx.utc_date || "").replace("T", " ").slice(0, 19),
      eventCode: fx.event_code, tournamentId: fx.tournament_id, teamId1: fx.home_team_id, teamId2: fx.away_team_id,
      marketId: mk.id, marketName: mk.name || "Full Time", allOdds: o, uuids: u,
    });
  }
  _cat = { at: Date.now(), byId };
  return _cat;
}

// ANY logged-in superbet.gr-Tab finden, sonst einen (Hintergrund) öffnen und laden lassen.
async function ensureTab(ctx) {
  let tabs = await tabsQuery({ url: "https://superbet.gr/*" });
  if (tabs && tabs.length) return tabs[0].id;
  ctx.log("superbet: no superbet.gr tab open — opening one in the background");
  const t = await tabCreate({ url: SITE, active: false });
  if (!t || t.id == null) return null;
  await waitComplete(t.id, 20000);
  await sleep(1200);                                                  // content script (document_idle) + App-Init
  return t.id;
}

export async function place(p, stakeEur, ctx) {
  if (p && p.mkt === "parlay") return await placeKombi(p, stakeEur, ctx);
  const tip = { home: "1", draw: "X", away: "2" }[p.sel];
  if (!tip) return { status: "blocked", reason: "superbet: ungültige Auswahl " + String(p.sel) };
  if ((p.mkt || "ml") !== "ml") return { status: "blocked", reason: "superbet: Markt " + String(p.mkt) + " nicht unterstützt" };

  let cat;
  try { cat = await catalog(true); }                                 // frisch: Quoten bewegen sich
  catch (e) { return { status: "blocked", reason: "superbet: Offer-Fetch fehlgeschlagen: " + String((e && e.message) || e) }; }
  const rec = cat.byId.get(String(p.bookRef && p.bookRef.eventId));
  if (!rec) return { status: "blocked", reason: "superbet: Event wird nicht (mehr) angeboten" };
  const u = rec.uuids[tip];
  if (!u || !u.oddUuid || !(u.price > 1)) return { status: "blocked", reason: "superbet: kein Preis für " + p.sel };
  if (u.price < Number(p.minOdds)) return { status: "blocked", reason: `superbet: ${u.price.toFixed(2)} unter Min ${Number(p.minOdds).toFixed(2)} (Slippage-Floor)`, odds: u.price };

  const item = {
    value: String(u.price), type: "sport", fix: false, betRadarId: rec.betradarId,
    eventId: rec.eventId, eventUuid: rec.uuid, oddUuid: u.oddUuid, sourceType: 101, sourceScreen: 801,
    betGroupId: rec.marketId, eventName: rec.name, eventCode: rec.eventCode, live: false,
    marketId: rec.marketId, marketName: rec.marketName, marketUuid: u.marketUuid,
    matchDate: rec.matchDate, matchDateUtc: rec.matchDate, matchId: rec.eventId, matchName: rec.name,
    oddCode: u.code, oddDescription: u.oddDesc, oddFullName: u.code, oddId: u.oddId, oddName: u.code, oddTypeId: u.oddId,
    rules: [], sbValue: "", selected: true, sportId: 5, sportName: "Football",
    teamId1: String(rec.teamId1 || ""), teamId2: String(rec.teamId2 || ""),
    teamnameone: rec.home, teamnametwo: rec.away, tournamentId: rec.tournamentId, tournamentName: "",
    uuid: u.oddUuid,
  };

  const tabId = await ensureTab(ctx);
  if (tabId == null) return { status: "blocked", reason: "superbet: kein superbet.gr-Tab verfügbar (einloggen + Tab offen lassen)" };
  const ierr = await inject(tabId);
  if (ierr) return { status: "blocked", reason: "superbet: Injektion fehlgeschlagen: " + ierr };

  ctx.log(`superbet: placing ml ${p.sel} on event ${rec.eventId} (${rec.home} – ${rec.away}) · ${stakeEur} € @ ${u.price}`);
  const _t0 = Date.now();
  const r = await sendTab(tabId, { cmd: "sbPlace", item, total: stakeEur, minOdds: p.minOdds, ident: { eventId: String(rec.eventId), betradarId: rec.betradarId } });
  ctx.log(`superbet: answer after ${Date.now() - _t0} ms · ${r && r.status ? r.status : "?"}${r && r.ticket ? " · Ticket " + r.ticket : ""}${r && r.reason ? " · " + String(r.reason).slice(0, 220) : ""}`);
  if (r && r.error && !r.status) return { status: "uncertain", reason: "superbet: keine Antwort vom Tab (" + r.error + ") — im Konto prüfen", odds: u.price };
  return r;
}

// ---- 1.2.71 — KOMBIWETTE ---------------------------------------------------------------------------------------------------
// EIN Schein mit mehreren Spielen: derselbe Abruf submitTicket wie die Einzelwette, mit je Spiel einem Eintrag. Der ganze Ablauf
// steht im Seiten-Baustein content/superbet-kombi.js (byte-gleich mit superbet-kombi.js des Operators): frisches Angebot ALLER
// Beine in einem oeffentlichen Abruf, Mannschaften / Markt / Seite / Mindestquote je Bein, Rechnung des Scheins wie die Seite,
// zweite Pruefung des fertigen Scheins, dann EIN Aufruf. Jedes Bein kommt vom Operator in der Reihenfolge des BUCHS und mit
// dessen Mannschaftsnamen — die Engine sucht nie selbst ein Spiel oder eine Seite. Die Anmeldung ist die Sitzung des Tabs.
const KOMBI_BAUSTEIN = "content/superbet-kombi.js";
const KOMBI_SPORT = { fb: "soccer", basket: "basketball" };     // Feed-Name der Sportart eines Beins → Name im Baustein
const KOMBI_NACHFRAGEN_MAX = 12;                               // der Baustein gleicht hoechstens sieben Mal ab (alle 3 s)
const KOMBI_MIN_EINSATZ = 0.1, KOMBI_MAX_EINSATZ = 1000;       // wie der Baustein (EUR)
let _kombiNr = 0;
// Kennt das Setz-Script im Tab den Kombi-Baustein? Fehlt eines von beiden, werden sie nachgeladen — der Baustein ZUERST. Beide
// schuetzen sich selbst vor doppeltem Laden; ein laufender Baustein (mit seinem Doppel-Schutz) wird nie ersetzt, weil nur
// nachgeladen wird, wenn die Antwort ihn nicht nennt.
async function kombiBereit(tabId) {
  let r = await sendTab(tabId, { cmd: "ping" });
  if (!(r && r.ok && r.kombi === true)) {
    try { await chrome.scripting.executeScript({ target: { tabId }, files: [KOMBI_BAUSTEIN, "content/superbet-place.js"] }); } catch (e) { return "Injektion fehlgeschlagen: " + String((e && e.message) || e).slice(0, 80); }
    r = await sendTab(tabId, { cmd: "ping" });
  }
  return (r && r.ok && r.bm === "superbet" && r.kombi === true) ? null : "Setz-Script im Tab kennt die Kombiwette nicht (alte Fassung)";
}
async function placeKombi(p, stakeEur, ctx) {
  const legs = [];
  for (let i = 0; i < (Array.isArray(p.legs) ? p.legs.length : 0); i++) {
    const L = p.legs[i] || {}, feed = (L.sport == null || L.sport === "") ? "fb" : String(L.sport);
    const sport = Object.prototype.hasOwnProperty.call(KOMBI_SPORT, feed) ? KOMBI_SPORT[feed] : null;
    if (!sport) return { status: "blocked", reason: "superbet: leg " + (i + 1) + " — sport " + feed + " is not connected for parlays" };
    if (!/^\d{4,12}$/.test(String(L.eventId == null ? "" : L.eventId))) return { status: "blocked", reason: "superbet: leg " + (i + 1) + " — game number unreadable" };
    if (typeof L.team1 !== "string" || !L.team1 || typeof L.team2 !== "string" || !L.team2) return { status: "blocked", reason: "superbet: leg " + (i + 1) + " without the team names of the book — nothing sent" };
    legs.push({ eventId: String(L.eventId), tip: L.tip, minOdds: Number(L.minOdds), team1: L.team1, team2: L.team2, sport });
  }
  if (legs.length < 2) return { status: "blocked", reason: "superbet: a parlay needs at least two legs" };
  const einsatz = Math.round(Number(stakeEur) * 100) / 100;
  if (!(einsatz >= KOMBI_MIN_EINSATZ) || einsatz > KOMBI_MAX_EINSATZ) return { status: "blocked", reason: "superbet: Einsatz " + einsatz + " ausserhalb " + KOMBI_MIN_EINSATZ + "-" + KOMBI_MAX_EINSATZ };
  if (!(Number(p.minOdds) > 1)) return { status: "blocked", reason: "superbet: minOdds fehlt" };
  const tabId = await ensureTab(ctx);
  if (tabId == null) return { status: "blocked", reason: "superbet: kein superbet.gr-Tab verfügbar (einloggen + Tab offen lassen)" };
  const nichtBereit = await kombiBereit(tabId);
  if (nichtBereit) return { status: "blocked", reason: "superbet: " + nichtBereit + " — superbet.gr-Tab neu laden" };
  // Auftrags-Nummer JE VERSUCH: der Baustein fuehrt dieselbe Nummer nie zweimal aus.
  const auftragId = ("p-" + String(p.proposalId == null ? "" : p.proposalId).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 48) + "-" + Date.now().toString(36) + "-" + (++_kombiNr)).slice(0, 80);
  ctx.log("superbet: parlay · " + legs.length + " legs · " + einsatz + " EUR @ ≥" + Number(p.minOdds));
  const t0 = Date.now();
  let r = await sendTab(tabId, { cmd: "sbPlaceCombo", auftragId, armed: true, amount: einsatz, minTotalOdds: Number(p.minOdds), legs });
  // „kein Empfaenger“ gleich nach dem beantworteten Ping: der Auftrag kam im Tab nie an — nachweislich nichts gesendet.
  if (r && r.error && !r.status && /Receiving end does not exist|Could not establish connection/i.test(String(r.error))) return { status: "blocked", reason: "superbet: Tab nicht erreichbar (Auftrag kam nicht an)" };
  // Meldet der Baustein „pending“, ist der Schein beim Buch: HIER warten und nachfragen (Zeitgeber des Service Workers).
  let nachfragen = 0;
  while (r && r.status === "pending" && r.warteId && nachfragen < KOMBI_NACHFRAGEN_MAX) {
    nachfragen++;
    const wartet = r;
    await sleep(Math.max(250, Math.min(10000, Number(r.nachMs) || 0)));
    r = await sendTab(tabId, { cmd: "sbKombiNachfragen", warteId: wartet.warteId });
    if (!r || !r.status) r = { status: "uncertain", ticket: wartet.ticket, odds: wartet.odds, reason: "superbet: Tab antwortet beim Nachfragen nicht (" + String(r && r.error).slice(0, 100) + ") — der Schein war beim Buch, im Konto pruefen" };
    else if (!r.ticket && wartet.ticket) r.ticket = wartet.ticket;
  }
  if (r && r.status === "pending") r = { status: "uncertain", ticket: r.ticket, odds: r.odds, reason: "superbet: nach " + nachfragen + " Nachfragen noch kein Ergebnis — im Konto pruefen" };
  ctx.log("superbet: parlay answer after " + (Date.now() - t0) + " ms" + (nachfragen ? " (" + nachfragen + " follow-ups)" : "") + " · " + (r && r.status ? r.status : "?") + (r && r.ticket ? " · Ticket " + r.ticket : "") + (r && r.reason ? " · " + String(r.reason).slice(0, 260) : "") + (r && r.note ? " · " + String(r.note).slice(0, 200) : "") + (r && r.info ? " · " + String(r.info).slice(0, 200) : ""));
  if (!r || !r.status) return { status: "uncertain", reason: "superbet: keine Antwort vom Tab (" + String(r && r.error) + ") — im Konto pruefen" };
  return { status: r.status, odds: r.odds, stake: r.stake, reason: r.reason, note: r.note, ticket: r.ticket != null ? String(r.ticket) : undefined, verified: r.verified, legs: r.legs, ms: r.ms, tax: r.tax, netOdds: r.netOdds, bonus: r.bonus, info: r.info };
}
