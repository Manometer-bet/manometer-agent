// books/stoiximan.js — Stoiximan (en.stoiximan.gr) adapter. Kaizen/"Danae" sportsbook.
//
// Tab-based, like mystake.js: the betslip + Cloudflare-Turnstile + login-auth all live in the page,
// so a blind API replay of POST /api/betslip/v3/place is impossible (and we do not mint Turnstile
// tokens). The adapter opens the operator-named event, injects the placement script, and hands over.
// It NEVER resolves an event by team name — bookRef.eventId is the Stoiximan event id.
//
// eventUrl: from the recon HAR only the LIVE path shape is known: /live/<slug>/<eventId>/. Kaizen
// resolves the event by id regardless of the slug, so we send a stable slug. Prematch path is a
// best-effort guess ; most CS2 map-winner proposals are live.
"use strict";

const ORIGIN = "https://en.stoiximan.gr";
const liveUrl = (id) => `${ORIGIN}/match-odds/x/${id}/`;   // 26.09.: wie Sidebar (background.js eventUrl); behaelt die Id, leitet Live selbst um
const preUrl  = (id) => `${ORIGIN}/match-odds/x/${id}/`;   // 26.09.: alt /sports/event/<id>/ = HTTP 404 (gemessen)

export const id = "stoiximan";
// Sportarten, die dieser Adapter setzt (engine-sw.js prueft das vor place). basket seit 1.2.64 (04.10.2026): Sieger-Markt
// „Winner" (H2HT) nur ueber die Wettschein-Schnittstelle und nur mit der genauen Auswahl-Nummer des Operators.
export const sports = { fb: true, cs2: true, basket: true };
// 1.2.68 (05.10.2026): dieser Adapter setzt Kombiwetten (mkt "parlay") — engine-core.js adapterKombi. Betreiber: „lasse uns Stück
// für Stück die anderen Bookies anbinden, sodass man auch bei denen die Parlays setzen kann.“
export const kombi = true;
export const hosts = { stoiximan: { origin: ORIGIN, live: liveUrl, pre: preUrl } };

export function arm() { /* nothing to warm up — session lives in the page */ }
export function status() {
  return { ready: true, detail: `tab-based (stoiximan) — make sure you are signed in at ${ORIGIN}` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tabsQuery(q) { return new Promise((rs) => { try { chrome.tabs.query(q, (t) => rs(t || [])); } catch (_) { rs([]); } }); }
function tabUpdate(tabId, props) { return new Promise((rs) => { try { chrome.tabs.update(tabId, props, (t) => rs(t)); } catch (_) { rs(null); } }); }
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
// Like MyStake: the sportsbook only completes its session handshake in a VISIBLE tab. On the
// dedicated betting machine, briefly focusing the tab is acceptable and needed.
function tabShow(tabId) {
  return new Promise((rs) => {
    try { chrome.tabs.update(tabId, { active: true }, (t) => { try { if (t && t.windowId != null) chrome.windows.update(t.windowId, { focused: true }, () => rs()); else rs(); } catch (_) { rs(); } }); }
    catch (_) { rs(); }
  });
}
async function inject(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content/stoiximan-place.js"] }); return null; }
  catch (e) { return String((e && e.message) || e); }
}
// Kombi-Baustein (content/stoiximan-kombi.js, byte-gleich mit dem des Operators): nur in den obersten Rahmen — nur der
// beantwortet Kombi-Befehle. Die Datei ersetzt eine aeltere Fassung im Tab, solange dort kein Auftrag laeuft oder wartet.
async function injectKombi(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ["content/stoiximan-kombi.js"] }); return null; }
  catch (e) { return String((e && e.message) || e); }
}
async function openEvent(eventId, isLive, ctx) {
  const url = isLive ? liveUrl(eventId) : preUrl(eventId);
  let tab = (await tabsQuery({ url: ORIGIN + "/*" }))[0] || null;
  if (tab) await tabUpdate(tab.id, { url, active: false });
  else tab = await tabCreate({ url, active: false });
  if (!tab) return { error: "could not open a tab for " + ORIGIN };
  await tabShow(tab.id);
  await waitComplete(tab.id, 20000);
  const err = await inject(tab.id);
  if (err) return { error: "script injection failed: " + err };
  const MYVER = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return "?"; } })();
  let reloadedOnce = false;
  for (let i = 0; i < 12; i++) {
    const p = await sendTab(tab.id, { cmd: "sxPing" });
    if (p && p.ok && p.version && p.version !== MYVER && !reloadedOnce) {
      reloadedOnce = true;
      ctx.log(`stoiximan: page runs script ${p.version} instead of ${MYVER} — reloading the tab`);
      try { await new Promise((rs) => { try { chrome.tabs.reload(tab.id, {}, () => rs()); } catch (_) { rs(); } }); } catch (_) {}
      await waitComplete(tab.id, 20000); await sleep(1500); await inject(tab.id); continue;
    }
    if (p && p.ok && p.eventId && String(p.eventId) === String(eventId)) {
      ctx.log(`stoiximan: ready · script ${p.version || "(old)"} · event ${p.eventId}`);
      return { tabId: tab.id };
    }
    await sleep(700);
    if (i === 5) await inject(tab.id);   // iframe/SPA may have (re)loaded late
  }
  return { error: "stoiximan page did not report the requested event (" + eventId + ")" };
}

// LIVE-1X2 (04.10.2026): KEIN Seitenwechsel. Der Schein laeuft ueber die Wettschein-Schnittstelle und geht aus JEDEM offenen
// Stoiximan-Tab (gleiche Herkunft). Das Oeffnen des Spiels kostete 10–20 s — ein Live-Vorschlag gilt 20 s, in der Zeit laeuft
// die Quote weg (gemessen 04.10.: Vorschlag 08:10:48 UTC, Antwort 08:11:51). Der Tab wird dafuer auch nicht nach vorn geholt.
// Antwortet im Tab kein Script dieser Version (Paket gerade erneuert), wird er EINMAL neu geladen.
async function liveTab(ctx) {
  const tab = (await tabsQuery({ url: ORIGIN + "/*" })).find((t) => t && !t.discarded) || null;
  if (!tab) return null;                                   // kein Stoiximan-Tab offen → der bisherige Weg oeffnet einen
  const MYVER = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return "?"; } })();
  for (let lauf = 0; lauf < 2; lauf++) {
    const err = await inject(tab.id);
    if (err) return { error: "script injection failed: " + err };
    const p = await sendTab(tab.id, { cmd: "sxPing" });
    if (p && p.ok && p.version === MYVER) return { tabId: tab.id };
    if (lauf === 0) {
      ctx.log(`stoiximan: tab answers with ${p && p.ok ? "script " + (p.version || "(old)") : "no script"} instead of ${MYVER} — reloading`);
      try { await new Promise((rs) => { try { chrome.tabs.reload(tab.id, {}, () => rs()); } catch (_) { rs(); } }); } catch (_) {}
      await waitComplete(tab.id, 20000); await sleep(1500);
    }
  }
  return { error: "stoiximan page script did not answer" };
}

const NACHFRAGEN_MAX = 60;                                   // Obergrenze der Nachfragen; die Frist selbst haelt das Seiten-Script (30 s)

// ---- 1.2.68 — KOMBIWETTE ---------------------------------------------------------------------------------------------------
// Der ganze Schein laeuft als EIN Auftrag im Seiten-Baustein (content/stoiximan-kombi.js) ueber die Wettschein-Schnittstelle:
// Beine anhaengen, jedes pruefen (Spiel, Sieger-Markt, Mannschaften, Seite, Anpfiff, Mindestquote), genau EIN Kombi-Eintrag,
// Einsatz rechnen, abgeben. Kein Seitenwechsel, der Tab kommt nicht nach vorn. Jedes Bein braucht die GENAUE AUSWAHL-NUMMER
// des Operators (legs[].outcomeId) — die Engine sucht nie selbst eine Auswahl.
const KOMBI_SPORT_SEITE = { fb: "soccer", basket: "basketball" };   // Feed-Name der Sportart eines Beins → Name im Baustein
// Ein offener Stoiximan-Tab mit dem Script DIESER Version und dem Kombi-Baustein; ist keiner offen, wird einer im Hintergrund
// geoeffnet. Antwortet ein anderes oder kein Script (Paket gerade erneuert), wird der Tab EINMAL neu geladen.
async function kombiTab(ctx) {
  const MYVER = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return "?"; } })();
  let tab = (await tabsQuery({ url: ORIGIN + "/*" })).find((t) => t && !t.discarded) || null, neu = false;
  if (!tab) {
    tab = await tabCreate({ url: ORIGIN + "/", active: false });
    if (!tab) return { error: "could not open a tab for " + ORIGIN };
    neu = true; await waitComplete(tab.id, 20000); await sleep(1500);
  }
  for (let lauf = 0; lauf < 2; lauf++) {
    const err = (await inject(tab.id)) || (await injectKombi(tab.id));
    if (err) return { error: "script injection failed: " + err };
    const p = await sendTab(tab.id, { cmd: "sxKombiPing" });
    if (p && p.ok && p.version === MYVER && p.kombi === true) return { tabId: tab.id, warm: !neu && lauf === 0 };
    if (lauf === 0) {
      ctx.log(`stoiximan: tab answers with ${p && p.ok ? "script " + (p.version || "(old)") + (p.kombi === true ? "" : " without parlay module") : "no script"} instead of ${MYVER} — reloading`);
      try { await new Promise((rs) => { try { chrome.tabs.reload(tab.id, {}, () => rs()); } catch (_) { rs(); } }); } catch (_) {}
      await waitComplete(tab.id, 20000); await sleep(1500);
    }
  }
  return { error: "stoiximan page script did not answer" };
}
let _kombiNr = 0;
async function placeKombi(p, stakeEur, ctx) {
  const legs = [];
  for (let i = 0; i < (Array.isArray(p.legs) ? p.legs.length : 0); i++) {
    const L = p.legs[i] || {}, feed = (L.sport == null || L.sport === "") ? "fb" : String(L.sport);
    const sport = Object.prototype.hasOwnProperty.call(KOMBI_SPORT_SEITE, feed) ? KOMBI_SPORT_SEITE[feed] : null;
    if (!sport) return { status: "blocked", reason: "stoiximan: leg " + (i + 1) + " — sport " + feed + " is not connected for parlays" };
    if (!/^\d{4,20}$/.test(String(L.outcomeId == null ? "" : L.outcomeId))) return { status: "blocked", reason: "stoiximan: leg " + (i + 1) + " without the exact selection number of the operator (outcomeId) — nothing sent" };
    legs.push({ eventId: String(L.eventId), outcomeId: String(L.outcomeId), tip: L.tip, minOdds: Number(L.minOdds), team1: String(L.team1), team2: String(L.team2), sport });
  }
  if (legs.length < 2) return { status: "blocked", reason: "stoiximan: a parlay needs at least two legs" };
  const t0 = Date.now();
  const opened = await kombiTab(ctx);
  if (opened.error) return { status: "blocked", reason: "stoiximan: " + opened.error };
  const tabId = opened.tabId;
  // Auftrags-Nummer JE VERSUCH: der Baustein fuehrt dieselbe Nummer nie zweimal aus (zwei Empfaenger, doppelte Zustellung);
  // ein spaeterer neuer Versuch desselben Vorschlags bekommt eine neue.
  const auftragId = ("p-" + String(p.proposalId == null ? "" : p.proposalId).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 48) + "-" + Date.now().toString(36) + "-" + (++_kombiNr)).slice(0, 80);
  ctx.log("stoiximan: parlay · " + legs.length + " legs · " + stakeEur + " € @ ≥" + p.minOdds + (opened.warm ? " · tab ready" : " · tab opened or reloaded"));
  let r = await sendTab(tabId, { cmd: "sxKombi", auftragId, armed: true, amount: stakeEur, minTotalOdds: Number(p.minOdds), legs });
  // „kein Empfaenger“ gleich nach dem beantworteten Ping: der Tab ist weggegangen, niemand hat den Auftrag angenommen.
  if (r && r.error && !r.status && /Receiving end does not exist|Could not establish connection/i.test(String(r.error))) return { status: "blocked", reason: "stoiximan: the tab went away before the order was delivered — nothing sent" };
  // Das Buch wartet: HIER warten und nachfragen (Zeitgeber im verdeckten Tab drosselt Chrome) — im Tab je Nachfrage ein Abruf.
  let nachfragen = 0;
  while (r && r.status === "pending" && r.warteId && nachfragen < NACHFRAGEN_MAX) {
    nachfragen++;
    await sleep(Math.max(250, Math.min(5000, Number(r.nachMs) || 1000)));
    r = await sendTab(tabId, { cmd: "sxKombiNachfragen", warteId: r.warteId });
  }
  if (r && r.status === "pending") r = { status: "uncertain", reason: "stoiximan: the book is still waiting after " + nachfragen + " follow-ups — check the bet history" };
  ctx.log("stoiximan: parlay answer after " + (Date.now() - t0) + " ms (page " + ((r && r.ms && r.ms.gesamt) != null ? r.ms.gesamt : "?") + " ms" + (nachfragen ? ", " + nachfragen + " follow-ups" : "") + ") · " + ((r && r.status) || "?") + (r && r.reason ? " · " + String(r.reason).slice(0, 220) : ""));
  if (!r || (r.error && !r.status)) return { status: "uncertain", reason: "stoiximan: no answer from the page (" + ((r && r.error) || "empty") + ") — check the bet history" };
  return { status: r.status, odds: r.odds, stake: r.stake, reason: r.reason, note: r.note, ticket: r.ticket != null ? String(r.ticket) : undefined, verified: r.verified, legs: r.legs, ms: r.ms };
}

export async function place(p, stakeEur, ctx) {
  if (p.mkt === "parlay") return await placeKombi(p, stakeEur, ctx);
  const eventId = String(p.bookRef && p.bookRef.eventId);
  if (!eventId || eventId === "undefined") return { status: "blocked", reason: "stoiximan: bookRef.eventId missing" };
  const isLive = !!(p.live || (p.eventIdentity && p.eventIdentity.live) || p.sport === "cs2");   // CS2 map-winner is in-play
  const liveApi = p.live === true && (!p.sport || p.sport === "fb") && (!p.mkt || p.mkt === "ml");
  // Basketball (Sieger-Markt): immer ueber die Wettschein-Schnittstelle — kein Seitenwechsel noetig, vor dem Anpfiff wie live.
  // Ohne die genaue Auswahl-Nummer des Operators geht nichts an den Tab.
  const nurApi = p.sport === "basket";
  if (nurApi && !/^\d{1,20}$/.test(String((p.bookRef && p.bookRef.outcomeId) == null ? "" : p.bookRef.outcomeId))) return { status: "blocked", reason: "stoiximan: bookRef.outcomeId fehlt (ohne genaue Auswahl-Nummer des Operators wird nicht gesetzt)" };
  if (nurApi && p.sel !== "home" && p.sel !== "away") return { status: "blocked", reason: "stoiximan: ungueltige Auswahl " + String(p.sel) };
  let opened = (liveApi || nurApi) ? await liveTab(ctx) : null;
  if (!opened || opened.error) opened = await openEvent(eventId, isLive, ctx);
  if (opened.error) return { status: "blocked", reason: "stoiximan: " + opened.error };
  const tabId = opened.tabId;
  ctx.log(`stoiximan: event ${eventId} ${(liveApi || nurApi) ? (p.live === true ? "live" : "pre-match") + " (no page change)" : "open"}, placing ${p.sport}/${p.mkt}/${p.scope || "match"} ${p.sel}${nurApi ? " (Auswahl " + String(p.bookRef.outcomeId) + ")" : ""} · ${stakeEur} € @ ≥${p.minOdds}`);
  const _t0 = Date.now();
  let r = await sendTab(tabId, { cmd: "sxPlace", proposal: p, amount: stakeEur, minOdds: p.minOdds });
  // Das Buch wartet (Live-Verzoegerung oder Pruefung): HIER warten und nachfragen — Zeitgeber im verdeckten Tab drosselt
  // Chrome, die im Service Worker nicht. Jede Nachfrage ist im Tab genau ein Abruf (content/stoiximan-place.js).
  let nachfragen = 0;
  while (r && r.status === "pending" && r.warteId && nachfragen < NACHFRAGEN_MAX) {
    nachfragen++;
    await sleep(Math.max(250, Math.min(5000, Number(r.nachMs) || 1000)));
    r = await sendTab(tabId, { cmd: "sxNachfragen", warteId: r.warteId });
  }
  if (r && r.status === "pending") r = { status: "uncertain", reason: "stoiximan: das Buch wartet nach " + nachfragen + " Nachfragen noch — im Konto prüfen" };
  ctx.log(`stoiximan: answer after ${Date.now() - _t0} ms${nachfragen ? " (" + nachfragen + " follow-ups)" : ""} · ${r && r.status ? r.status : "?"}${r && r.ticketId ? " · Ticket " + r.ticketId : ""}${r && r.reason ? " · " + String(r.reason).slice(0, 220) : ""}`);
  if (r && r.error && !r.status) return { status: "uncertain", reason: "stoiximan: no answer from the page (" + r.error + ") — check the bet history" };
  if (r && r.ticketId) r.ticket = r.ticketId;
  return r;
}

// Kontostand (26.09.2026, Betreiber: bei einem Konto fehlte der Stoiximan-Kontostand, Superbet/Fonbet zeigen ihn). GET /api/balance —
// Antwortform aus dem Recon-Mitschnitt (angemeldet): { data: { customerCode, balances: [ { cashBalance, bettingBalance,
// openBetsBalance, totalDisplayBonusBalance, currencyCode, … } ] } }; abgemeldet: HTTP 401 (26.09. in Edge geprueft).
// Erst direkt aus dem Service Worker (Host-Berechtigung, Cookies des Profils — wie superbet.js), sonst ueber einen OFFENEN
// Stoiximan-Tab (Seitenkontext, Befehl sxBalance). Oeffnet NIE einen Tab; kein Login/keine Antwort → null (Heartbeat laeuft weiter).
// saldo = der Betrag, den Stoiximan oben anzeigt —
// totalDisplayBalance (= bettingBalance = Guthaben + freigeschalteter Bonus), sonst
// bettingBalance, sonst cashBalance. Vorher cashBalance allein → der 100-€-Bonus fehlte. Die Anzeige zaehlt bonus nicht dazu.
export function balanceAus(j) {
  const b = j && j.data && Array.isArray(j.data.balances) ? j.data.balances[0] : null;
  if (!b) return null;
  const zahl = (v) => (v != null && v !== "" && isFinite(Number(v))) ? Number(v) : null;
  const saldo = [b.totalDisplayBalance, b.bettingBalance, b.cashBalance].map(zahl).find((v) => v != null);
  if (saldo == null) return null;
  return { saldo, bonus: zahl(b.totalDisplayBonusBalance) || 0, hold: zahl(b.openBetsBalance) || 0, cur: b.currencyCode || "EUR", ts: Date.now() };
}
export async function balance() {
  try {
    const r = await fetch(ORIGIN + "/api/balance", { credentials: "include", headers: { accept: "application/json" }, cache: "no-store" });
    if (r.ok) { const v = balanceAus(await r.json()); if (v) return v; }
  } catch (_) {}
  try {
    const tab = (await tabsQuery({ url: ORIGIN + "/*" }))[0];
    if (tab) { const p = await sendTab(tab.id, { cmd: "sxBalance" }); const v = p && p.ok ? balanceAus(p.j) : null; if (v) return v; }
  } catch (_) {}
  return null;
}
