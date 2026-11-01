// books/trustdice.js — TrustDice adapter (BetBy / sptpub engine).
//
// Placement is a plain JSON POST authorised by the live x-session-id header set, so the engine needs
// a trustdice.win tab only as the *authenticated context* — it never clicks the widget. The tab can
// sit on any TrustDice page; it does NOT have to show the event (unlike MyStake).
//
// Stake handling: TrustDice is a BTC book. The operator sends euros, the adapter converts with a
// live rate and the content script enforces TrustDice's own BTC minimum. If no rate can be fetched
// the bet is BLOCKED (never guess a stake).
"use strict";

export const id = "trustdice";
export const kombi = true;   // 31.10.2026: Kombis ueber den Schein-Link des Widgets (content/trustdice-kombi.js)
export const hosts = { site: "https://trustdice.win", api: "sptpub.com" };

let _rate = { v: 0, ts: 0 };

export function arm(_ctx) { /* no background auth to harvest — the session lives in the page */ }
export function status() {
  return { ready: true, detail: "tab-based — keep trustdice.win open and signed in (session header is captured there)" };
}

// Kontostand: TrustDice hat eine EIGENE Konto-API (api.trustdice.win/account/wallet/, reine Cookie-Auth) —
// getrennt vom BetBy-Sportsbook. Der Content-Script (auf trustdice.win) liest sie + die Anzeige-Währung.
// Läuft im Heartbeat für aktive Bücher → zeigt den €-Saldo im Admin (und ist ein Session-Lebendcheck).
export async function balance() {
  try {
    const tabs = await tabsQuery({ url: "https://trustdice.win/*" });
    if (!tabs || !tabs.length) return null;
    const r = await sendTab(tabs[0].id, { cmd: "tdBalance" });
    if (r && r.ok && r.saldo != null) return { saldo: Number(r.saldo), bonus: 0, hold: 0, cur: r.cur || "EUR", ts: Date.now() };
  } catch (_) {}
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tabsQuery(q) { return new Promise((rs) => { try { chrome.tabs.query(q, (t) => rs(t || [])); } catch (_) { rs([]); } }); }
function tabUpdate(tabId, props) { return new Promise((rs) => { try { chrome.tabs.update(tabId, props, () => rs()); } catch (_) { rs(); } }); }
function tabCreate(props) { return new Promise((rs) => { try { chrome.tabs.create(props, (t) => rs(t)); } catch (_) { rs(null); } }); }
function sendTab(tabId, msg) {
  return new Promise((rs) => {
    try { chrome.tabs.sendMessage(tabId, msg, (r) => { const e = chrome.runtime.lastError; rs(e ? { error: e.message } : (r || { error: "no response" })); }); }
    catch (e) { rs({ error: String((e && e.message) || e) }); }
  });
}
async function waitComplete(tabId, ms) {
  const t0 = Date.now();
  for (;;) {
    const t = await new Promise((rs) => { try { chrome.tabs.get(tabId, (x) => rs(chrome.runtime.lastError ? null : x)); } catch (_) { rs(null); } });
    if (!t) return false;
    if (t.status === "complete") return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(300);
  }
}
async function inject(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["content/trustdice-inject.js"] }); } catch (_) {}
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ["content/trustdice-place.js"] }); } catch (e) { return String((e && e.message) || e); }
  return null;
}

// Three independent sources, same order the operator uses; last known rate is a better fallback
// than none, but a completely unknown rate blocks the bet.
async function btcEurRate() {
  if (_rate.v && Date.now() - _rate.ts < 60000) return _rate.v;
  const set = (v) => { if (v > 0 && isFinite(v)) { _rate = { v, ts: Date.now() }; return true; } return false; };
  try { const r = await fetch("https://api.coinbase.com/v2/prices/BTC-EUR/spot", { cache: "no-store" }); if (r.ok) { const j = await r.json(); if (set(parseFloat(j && j.data && j.data.amount))) return _rate.v; } } catch (_) {}
  try { const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur", { cache: "no-store" }); if (r.ok) { const j = await r.json(); if (set(j && j.bitcoin && j.bitcoin.eur)) return _rate.v; } } catch (_) {}
  try { const r = await fetch("https://api.kraken.com/0/public/Ticker?pair=XBTEUR", { cache: "no-store" }); if (r.ok) { const j = await r.json(); const k = j && j.result && Object.values(j.result)[0]; if (set(k && parseFloat(k.c[0]))) return _rate.v; } } catch (_) {}
  return _rate.v || null;
}

const SPORTSBOOK_URL = "https://trustdice.win/de/sports/soccer-1";
// Eine Seite OHNE geladenes Wett-Widget macht KEINE sptpub-Anfragen — dann fehlt die
// Cloudflare-Freigabe und jeder Quotenabruf scheitert mit "Failed to fetch", auch aus dem
// Seitenkontext. Belegt am 30.07.: Tab stand auf /de/sports, Diagnose meldete "(keine erfasst)".
// Der Operator navigiert vor jeder Platzierung auf die Event-Seite und hat das Problem nie.
function isSportsbookUrl(u) { return /^https:\/\/trustdice\.win\/[a-z]{2}\/sports\/[^/?#]+/i.test(String(u || "")); }
async function ensureTab(ctx) {
  let tab = (await tabsQuery({ url: "https://trustdice.win/*" }))[0] || null;
  if (!tab) {
    tab = await tabCreate({ url: SPORTSBOOK_URL, active: false });
    if (!tab) return { error: "could not open a trustdice.win tab" };
  } else if (!isSportsbookUrl(tab.url)) {
    ctx.log(`trustdice: tab is on "${String(tab.url || "").slice(0, 50)}", no betting widget there. Going to the sportsbook.`);
    await tabUpdate(tab.id, { url: SPORTSBOOK_URL });
    await waitComplete(tab.id, 25000);
    await sleep(2500);
  }
  // KEIN tabShow: BetBy braucht (anders als das MyStake/Jackbit-Widget) keinen sichtbaren Tab —
  // die Platzierung ist ein reiner API-POST. Der Vordergrund-Zwang war am 30.07. vorsorglich
  // ergaenzt und machte den Browser unbenutzbar (Burst-Polling holte den Tab im 5-s-Takt nach vorn).
  if (tab.status !== "complete") {
    await waitComplete(tab.id, 25000);
  }
  const err = await inject(tab.id);
  if (err) return { error: "script injection failed: " + err };
  // The session header only appears once the widget has made its own requests — give it a moment.
  const MYVER = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return "?"; } })();
  let reloadedOnce = false;
  for (let i = 0; i < 14; i++) {
    const p = await sendTab(tab.id, { cmd: "tdPing" });
    // VERALTETES SKRIPT: Ein Tab, der seit dem Update offen ist, laeuft mit altem Code weiter
    // (Marker verhindert das Ersetzen). Einmal neu laden holt die aktuelle Fassung in die Seite.
    // FEHLENDE Version = ALTES Skript (vor v1.2.18 gab es das Feld nicht) -> ebenfalls neu laden.
    // Die vorherige Fassung pruefte `p.version &&` und liess damit genau die Skripte durch,
    // die ausgetauscht werden muessen.
    if (p && p.ok && p.version !== MYVER && !reloadedOnce) {
      reloadedOnce = true;
      ctx.log(`trustdice: page runs script ${p.version || '(old, no version)'}, current is ${MYVER} — reloading the tab`);
      try { await new Promise((rs) => { try { chrome.tabs.reload(tab.id, {}, () => rs()); } catch (_) { rs(); } }); } catch (_) {}
      await waitComplete(tab.id, 25000);
      await sleep(2000);
      continue;
    }
    // Der WIDGET-Weg (Standard seit v1.2.29) braucht WEDER Session-Header NOCH API-Zugriff — er
    // klickt nur im DOM. Session/sptpub-Verkehr sind daher nur noch Zusatzinfo fuers Protokoll,
    // keine Bedingung: sonst blockiert die Vorpruefung eine Platzierung, die laufen koennte.
    const spoke = p && p.seen && Object.keys(p.seen).length > 0;
    if (p && p.ok) {
      // Diagnose-Zeile: damit ein gepastetes Protokoll ALLE Werte enthaelt, die zur Fehlersuche
      // noetig sind — Skriptversion in der Seite, API-Shard, Brand, BTC-Minimum, Tab-URL.
      let tabUrl = "";
      try { const t = await new Promise((rs) => { try { chrome.tabs.get(tab.id, (x) => rs(chrome.runtime.lastError ? null : x)); } catch (_) { rs(null); } }); tabUrl = (t && t.url) || ""; } catch (_) {}
      const seen = Object.keys(p.seen || {}).map((h) => h + "×" + p.seen[h]).join(" | ") || "(keine erfasst)";
      ctx.log(`trustdice: ready · script ${p.version || "(old)"} · session ${p.hasSession ? "yes" : "no"} · sptpub traffic ${spoke ? "yes" : "no"} · shard ${p.apiHost} [${p.hostSrc || "?"}] · MinBet ${p.minBet} · Tab ${tabUrl.slice(0, 70)}`);
      ctx.log(`trustdice: sptpub hosts used by the page: ${seen}`);
      return { tabId: tab.id };
    }
    await sleep(900);
    if (i === 6) await inject(tab.id);
    if (i === 9 && !(p && p.seen && Object.keys(p.seen).length)) {
      ctx.log("trustdice: widget does not talk to sptpub — reloading the page");
      try { await new Promise((rs) => { try { chrome.tabs.reload(tab.id, {}, () => rs()); } catch (_) { rs(); } }); } catch (_) {}
      await waitComplete(tab.id, 25000);
      await sleep(2500);
      await inject(tab.id);
    }
  }
  return { error: "BetBy session not captured — open trustdice.win, sign in and load the sportsbook once" };
}

// Keepalive (Operator-Parität, background.js:tdKeepalivePass): haelt die Session warm, erkennt
// Cloudflare-Challenges und laedt den Tab nach zweimal "dead" neu. Ohne das stirbt die Session im
// Hintergrund-Tab und JEDER sptpub-Abruf scheitert mit "Failed to fetch".
let _kaLast = 0, _kaState = "", _kaDead = 0;
export async function keepalive(ctx) {
  if (Date.now() - _kaLast < 170000) return _kaState;
  const tab = (await tabsQuery({ url: "https://trustdice.win/*" }))[0] || null;
  if (!tab) { _kaState = "notab"; return _kaState; }
  _kaLast = Date.now();
  try { chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch (_) {}   // Chrome darf den Tab nicht verwerfen
  let resp;
  try { resp = await sendTab(tab.id, { cmd: "tdKeepalive" }); }
  catch (e) { resp = { state: "error" }; }
  const state = (resp && resp.state) || "error";
  const changed = state !== _kaState;
  _kaState = state;
  if (state === "alive") { _kaDead = 0; if (changed) ctx.log("trustdice: session ok (keepalive)"); return state; }
  if (state === "challenge") { _kaDead = 0; ctx.log("trustdice: CLOUDFLARE CHECK active — please open the trustdice.win tab once and verify. Until then every odds fetch fails."); return state; }
  if (state === "dead") {
    _kaDead++;
    if (_kaDead < 2) { ctx.log("trustdice: session check negative (1/2) — watching"); return state; }
    ctx.log("trustdice: session lost — reloading the tab");
    try { chrome.tabs.reload(tab.id); } catch (_) {}
    _kaDead = 0; return state;
  }
  if (changed) ctx.log("trustdice: keepalive without status (tab may be loading)");
  return state;
}

// KOMBIWETTE Die Seite laedt mit ?btBets=… und legt die Beine selbst in den Schein. Pruefen, Einsatz und der Knopf laufen im
// Tab (trustdice-kombi.js), gewartet wird hier: Verdeckte Tabs werden gedrosselt. Nach der Abgabe gilt jeder Abbruch als unklar, nie als „nicht gesetzt“.
const KOMBI_NACHFRAGEN_MAX = 160;
const KOMBI_FEED = { fb: "soccer", basket: "basketball" };
let _kombiNr = 0;
async function injectKombi(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["content/trustdice-inject.js", "content/trustdice-kombi-inject.js"] }); } catch (_) {}
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ["content/trustdice-kombi.js", "content/trustdice-place.js"] }); } catch (e) { return String((e && e.message) || e); }
  return null;
}
async function placeKombi(p, stakeEur, ctx) {
  const TD = self.TDKOMBI;
  if (!TD) return { status: "blocked", reason: "trustdice: parlay module missing — nothing sent" };
  const legs = [];
  for (let i = 0; i < (Array.isArray(p.legs) ? p.legs.length : 0); i++) {
    const L = p.legs[i] || {}, feed = (L.sport == null || L.sport === "") ? "fb" : String(L.sport);
    const sport = Object.prototype.hasOwnProperty.call(KOMBI_FEED, feed) ? KOMBI_FEED[feed] : null;
    if (!sport) return { status: "blocked", reason: "trustdice: leg " + (i + 1) + " — sport " + feed + " is not connected for parlays" };
    if (typeof L.team1 !== "string" || !L.team1 || typeof L.team2 !== "string" || !L.team2) return { status: "blocked", reason: "trustdice: leg " + (i + 1) + " without the team names of the book — nothing sent" };
    const bein = { eventId: String(L.eventId), tip: L.tip, minOdds: Number(L.minOdds), team1: L.team1, team2: L.team2, sport };
    const a = TD.auswahl(bein);
    if (a.fehler) return { status: "blocked", reason: "trustdice: leg " + (i + 1) + " — " + a.fehler };
    legs.push(bein);
  }
  if (legs.length < 2) return { status: "blocked", reason: "trustdice: a parlay needs at least two legs" };
  if (!(Number(p.minOdds) > 1)) return { status: "blocked", reason: "trustdice: minimum odds missing" };
  const ziel = TD.adresse(legs);
  if (ziel.fehler) return { status: "blocked", reason: "trustdice: " + ziel.fehler };
  const rate = await btcEurRate();
  const amountBtc = rate ? Math.round((stakeEur / rate) * 1e8) / 1e8 : null;
  const opened = await ensureTab(ctx);
  if (opened.error) return { status: "blocked", reason: "trustdice: " + opened.error };
  _kaLast = 0;
  const ka = await keepalive(ctx);
  if (ka === "challenge") return { status: "blocked", reason: "trustdice: Cloudflare check active — open the tab and verify. Nothing was sent." };
  if (ka === "dead") return { status: "blocked", reason: "trustdice: session dead — sign in again at trustdice.win. Nothing was sent." };
  await tabUpdate(opened.tabId, { url: ziel.url });
  await waitComplete(opened.tabId, 25000);
  await sleep(1500);
  const err = await injectKombi(opened.tabId);
  if (err) return { status: "blocked", reason: "trustdice: script injection failed: " + err };
  let pg = null;
  for (let i = 0; i < 8 && !(pg && pg.ok && pg.kombi === true); i++) { pg = await sendTab(opened.tabId, { cmd: "tdPing" }); if (!(pg && pg.ok && pg.kombi === true)) await sleep(500); }
  if (!(pg && pg.ok && pg.kombi === true)) return { status: "blocked", reason: "trustdice: the tab does not know parlays (old script) — reload trustdice.win" };
  const auftragId = ("p-" + String(p.proposalId == null ? "" : p.proposalId).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 48) + "-" + Date.now().toString(36) + "-" + (++_kombiNr)).slice(0, 80);
  ctx.log("trustdice: parlay · " + legs.length + " legs · " + stakeEur + " EUR" + (amountBtc != null ? " ≈ " + amountBtc.toFixed(8) + " BTC" : "") + " @ ≥" + Number(p.minOdds));
  const t0 = Date.now();
  let r = await sendTab(opened.tabId, { cmd: "tdPlaceCombo", auftragId, armed: true, amount: stakeEur, amountBtc, minTotalOdds: Number(p.minOdds), legs });
  if (r && r.error && !r.status && /Receiving end does not exist|Could not establish connection/i.test(String(r.error))) return { status: "blocked", reason: "trustdice: tab not reachable (the order did not arrive)" };
  let nach = 0;
  while (r && r.status === "pending" && r.warteId && nach < KOMBI_NACHFRAGEN_MAX) {
    nach++;
    const wartet = r;
    await sleep(Math.max(250, Math.min(5000, Number(r.nachMs) || 500)));
    r = await sendTab(opened.tabId, { cmd: "tdKombiNachfragen", warteId: wartet.warteId });
    if (!r || !r.status) r = { status: "uncertain", reason: "trustdice: tab does not answer the follow-up (" + String(r && r.error).slice(0, 100) + ") — POSSIBLY placed, check the bet history" };
  }
  if (r && r.status === "pending") r = { status: "uncertain", reason: "trustdice: no result after " + nach + " follow-ups — POSSIBLY placed, check the bet history" };
  ctx.log("trustdice: parlay answer after " + (Date.now() - t0) + " ms · " + (r && r.status ? r.status : "?") + (r && r.ticket ? " · Ticket " + r.ticket : "") + (r && r.reason ? " · " + String(r.reason).slice(0, 200) : ""));
  if (!r || !r.status) return { status: "uncertain", reason: "trustdice: no answer from the tab — POSSIBLY placed, check the bet history" };
  return { status: r.status, odds: r.odds, stake: r.stake, cur: r.cur, reason: r.reason, note: r.note, ticket: r.ticket != null ? String(r.ticket) : undefined, legs: r.legs, ms: r.ms };
}

export async function place(p, stakeEur, ctx) {
  if (p && p.mkt === "parlay") return await placeKombi(p, stakeEur, ctx);
  // Kurs nur für BTC-Konten nötig — best effort holen, aber NICHT hart blocken: bei EUR/USDT-Konto setzt
  // das Content-Script den €-Betrag direkt (kein BTC). Fehlt der Kurs UND ist das Konto BTC, blockt der
  // Content-Script dort sauber (currency-aware).
  const rate = await btcEurRate();
  const amountBtc = rate ? Math.round((stakeEur / rate) * 1e8) / 1e8 : null;

  const opened = await ensureTab(ctx);
  if (opened.error) return { status: "blocked", reason: "trustdice: " + opened.error };
  // Sessionzustand VOR dem Abruf klaeren — sonst endet eine Cloudflare-Challenge als "Failed to fetch".
  _kaLast = 0;                                   // fuer die Platzierung immer frisch pruefen
  const ka = await keepalive(ctx);
  if (ka === "challenge") return { status: "blocked", reason: "trustdice: Cloudflare check active — open the tab and verify. Nothing was sent." };
  if (ka === "dead") return { status: "blocked", reason: "trustdice: session dead — sign in again at trustdice.win. Nothing was sent." };

  // Event-Daten HIER im Service Worker holen (host_permission greift, kein CORS) und mitgeben —
  // im Content-Skript scheitert derselbe Abruf mit "Failed to fetch" (Fund 30.07.).
  // OPERATOR-PARITAET (placeTrustdiceSameTab): erst auf die Event-Seite navigieren, dem BetBy-Widget
  // 3 s zum Rendern geben, dann setzen. Bisher fragte die Engine die Event-Daten von einer beliebigen
  // Seite ab — ein Muster, das sptpub mit 503 ("access blocked") quittiert. Schlaegt die URL-Ermittlung
  // fehl, wird wie im Operator auf der aktuellen Seite gesetzt.
  try {
    // Bevorzugt die URL AUS DEM PROPOSAL (bookRef.url): der Operator kennt die Event-Seite ohnehin,
    // und die Eigenermittlung braucht denselben Abruf, der beim Bettor blockiert sein kann.
    // Ohne offene Event-Seite findet das Widget den Quoten-Button nicht — dann bleibt nur der
    // API-Weg, und der laeuft in HTTP 401 (30.07. verifiziert).
    const fromProposal = (p.bookRef && p.bookRef.url && /^https:\/\/trustdice\.win\//.test(p.bookRef.url)) ? { ok: true, url: p.bookRef.url, teams: "(URL aus dem Proposal)" } : null;
    const eu = fromProposal || await sendTab(opened.tabId, { cmd: "tdEventUrl", eventId: String(p.bookRef.eventId) });
    if (eu && eu.ok && eu.url) {
      ctx.log("trustdice: going to the event page " + (eu.teams || ""));
      await tabUpdate(opened.tabId, { url: eu.url });
      await waitComplete(opened.tabId, 25000);
      await sleep(3000);
      await inject(opened.tabId);
      for (let i = 0; i < 10; i++) { const pg = await sendTab(opened.tabId, { cmd: "tdPing" }); if (pg && pg.ok && pg.hasSession) break; await sleep(700); }
    } else {
      ctx.log("trustdice: event address unknown (" + ((eu && eu.error) || "?") + ") — placing on the current page");
    }
  } catch (e) { ctx.log("trustdice: going to the event page failed (" + String((e && e.message) || e) + ")"); }

  // oddsHint: die vom Operator gelesene Quote. Nur ein NOTWEG, falls der eigene Abruf blockiert ist.
  const msg = { cmd: "tdPlace", eventId: String(p.bookRef.eventId), amount: stakeEur, amountBtc, rate, minOdds: p.minOdds, oddsHint: Number(p.odds) || null };
  if (p.sport === "cs2") {
    // CS2 needs the operator's VERIFIED descriptor — the engine does not derive market ids itself.
    const r = p.bookRef || {};
    if (!r.marketId || r.outcomeId == null) return { status: "blocked", reason: "trustdice: proposal lacks the CS2 descriptor (bookRef.marketId/specifiers/outcomeId)" };
    Object.assign(msg, { market: "cs2", marketId: String(r.marketId), specifiers: String(r.specifiers || ""), outcomeId: String(r.outcomeId) });
  } else if (p.mkt === "ah") {
    Object.assign(msg, { market: "ah", side: p.sel, line: p.line });
  } else {
    const tip = { home: "1", draw: "X", away: "2" }[p.sel];
    if (!tip) return { status: "blocked", reason: "trustdice: bad selection for 1X2" };
    Object.assign(msg, { market: "ml", tip });
  }
  ctx.log(`trustdice: placing ${p.mkt}/${p.scope || "match"} ${p.sel} on event ${p.bookRef.eventId} · ${stakeEur} €${amountBtc != null ? " ≈ " + amountBtc.toFixed(8) + " BTC" : " (account currency is read in the widget)"} @ ≥${p.minOdds}`);
  const t0 = Date.now();
  const r = await sendTab(opened.tabId, msg);
  // SELBSTDIAGNOSE bei Quoten-Fehlern: denselben Abruf einmal aus dem Seitenkontext (MAIN) machen.
  // Klappt er dort, liegt es an der Erweiterung; klappt er auch dort nicht, am Rechner/Netz.
  // Damit muss niemand mehr von Hand in der Konsole testen.
  if (r && r.status === "blocked" && /odds not loadable/i.test(String(r.reason || ""))) {
    try {
      const png = await sendTab(opened.tabId, { cmd: "tdPing" });
      const host = (png && png.apiHost) || "api-a-c7818b61-600.sptpub.com";
      const brand = (png && png.brand) || "2548727380772532233";
      const url = `https://${host}/api/v4/prematch/brand/${brand}/event/de/${String(p.bookRef.eventId)}`;
      const out = await chrome.scripting.executeScript({
        target: { tabId: opened.tabId }, world: "MAIN",
        func: async (u) => {
          const res = {};
          try { const a = await fetch(u, { credentials: "omit" }); res.seite = a.status + " (" + (await a.text()).length + " B)"; }
          catch (e) { res.seite = "Fehler: " + String((e && e.message) || e); }
          try { res.ort = location.href.slice(0, 60); } catch (_) {}
          return res;
        },
        args: [url],
      });
      const d = out && out[0] && out[0].result;
      ctx.log(`trustdice DIAGNOSE · Erweiterung: fehlgeschlagen · Seitenkontext: ${(d && d.seite) || "?"} · Seite: ${(d && d.ort) || "?"}`);
      ctx.log("trustdice DIAGNOSE · Deutung: " + ((d && /^200/.test(String(d.seite))) ? "Seite kommt durch -> Problem liegt an der Erweiterung" : "auch die Seite kommt nicht durch -> Rechner/Netz/Buchmacher"));
    } catch (e) { ctx.log("trustdice DIAGNOSE fehlgeschlagen: " + String((e && e.message) || e)); }
  }
  ctx.log(`trustdice: answer after ${Date.now() - t0} ms · ${r && r.status ? r.status : "?"}${r && r.ticket ? " · Ticket " + r.ticket : ""}${r && r.odds ? " · odds " + r.odds : ""}${r && r.reason ? " · " + String(r.reason).slice(0, 200) : ""}`);
  if (r && r.error && !r.status) return { status: "uncertain", reason: "trustdice: no answer from the page (" + r.error + ") — check the bet history" };
  return r;
}
