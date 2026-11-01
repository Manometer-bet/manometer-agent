// books/pamestoixima.js — pamestoixima.gr (OPAP / OpenBet). 1.2.76 (18.10.2026). Betreiber: „Ja, alles perfekt bauen, dass er und
// andere Bettoren Pame nutzen können.“
//
// Tab-based wie stoiximan.js: gelesen, geprueft und gesetzt wird aus der Seite www.pamestoixima.gr (Cloudflare laesst die
// Abrufe nur aus dem Seitenkontext zu, die Sitzung lebt in der Seite). Pame sperrt auslaendische Adressen — der Rechner des
// Bettors braucht eine GRIECHISCHE Adresse (sonst leitet die Seite auf …/foreign-ips-blocking/ um; das Script meldet das).
// Einzelwette: nur Fussball, Sieger-Markt MATCH_RESULT, nur vor dem Anpfiff, nur mit der GENAUEN Auswahl-Nummer des Operators
// (bookRef.outcomeId, aus dem Katalog des Edge-Dienstes) — die Engine sucht nie selbst eine Auswahl und uebersetzt nie Heim/Gast.
// Kombi: content/pamestoixima-kombi.js (byte-gleich mit dem des Operators), jedes Bein mit seiner Auswahl-Nummer.
// Kein Seitenwechsel: jeder offene Tab der Seite genuegt (die Abrufe brauchen kein bestimmtes Spiel auf dem Schirm); ist keiner
// offen, wird einer im Hintergrund geoeffnet. Antwortet im Tab ein Script einer anderen Version, wird er EINMAL neu geladen.
"use strict";

const ORIGIN = "https://www.pamestoixima.gr";

export const id = "pamestoixima";
export const sports = { fb: true };
export const kombi = true;
export const hosts = { pamestoixima: { origin: ORIGIN } };

// Stand der letzten Begegnung mit der Seite (angemeldet? griechische Adresse?) — fuer die Anzeige und den Heartbeat.
let _stand = { ready: true, detail: "tab-based (pamestoixima) — keep " + ORIGIN + " open and signed in (Greek IP address needed)" };
export function arm() { /* nichts vorzuwaermen — die Sitzung lebt in der Seite */ }
export function status() { return { ready: _stand.ready !== false, detail: _stand.detail }; }
function standAus(ort, grund) {
  if (ort) _stand = { ready: false, detail: "pamestoixima: " + ort };
  else if (grund && /not signed in/i.test(grund)) _stand = { ready: false, detail: "pamestoixima: signed out — sign in at " + ORIGIN };
  else _stand = { ready: true, detail: "tab-based (pamestoixima) — signed in, Greek IP ok" };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tabsQuery(q) { return new Promise((rs) => { try { chrome.tabs.query(q, (t) => rs(t || [])); } catch (_) { rs([]); } }); }
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
// Erst der Kombi-Baustein, dann das Setz-Script (beide nur im obersten Rahmen) — so kennt das Setz-Script PMKOMBI sofort.
async function inject(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ["content/pamestoixima-kombi.js", "content/pamestoixima-place.js"] }); return null; }
  catch (e) { return String((e && e.message) || e); }
}
async function seitenTab(ctx) {
  const MYVER = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return "?"; } })();
  let tab = (await tabsQuery({ url: ORIGIN + "/*" })).find((t) => t && !t.discarded) || null, neu = false;
  if (!tab) {
    tab = await tabCreate({ url: ORIGIN + "/", active: false });
    if (!tab) return { error: "could not open a tab for " + ORIGIN };
    neu = true; await waitComplete(tab.id, 25000); await sleep(1500);
  }
  for (let lauf = 0; lauf < 2; lauf++) {
    const err = await inject(tab.id);
    if (err) return { error: "script injection failed: " + err };
    const p = await sendTab(tab.id, { cmd: "pmePing" });
    if (p && p.ok && p.ort) { standAus(p.ort); return { error: p.ort }; }
    if (p && p.ok && p.version === MYVER && p.kombi === true) return { tabId: tab.id, warm: !neu && lauf === 0 };
    if (lauf === 0) {
      ctx.log(`pamestoixima: tab answers with ${p && p.ok ? "script " + (p.version || "(old)") + (p.kombi === true ? "" : " without parlay module") : "no script"} instead of ${MYVER} — reloading`);
      try { await new Promise((rs) => { try { chrome.tabs.reload(tab.id, {}, () => rs()); } catch (_) { rs(); } }); } catch (_) {}
      await waitComplete(tab.id, 25000); await sleep(1500);
    }
  }
  return { error: "pamestoixima page script did not answer" };
}

const NACHFRAGEN_MAX = 40;
let _nr = 0;
const auftragNr = (p, art) => (art + "-" + String(p.proposalId == null ? "" : p.proposalId).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 48) + "-" + Date.now().toString(36) + "-" + (++_nr)).slice(0, 80);
// Das Buch entscheidet noch: HIER warten und nachfragen (Zeitgeber im verdeckten Tab drosselt Chrome) — im Tab je Nachfrage ein Abruf.
async function warten(tabId, r, befehl) {
  let n = 0;
  while (r && r.status === "pending" && r.warteId && n < NACHFRAGEN_MAX) {
    n++;
    await sleep(Math.max(250, Math.min(5000, Number(r.nachMs) || 1500)));
    r = await sendTab(tabId, { cmd: befehl, warteId: r.warteId });
  }
  if (r && r.status === "pending") r = { status: "uncertain", reason: "pamestoixima: the book is still deciding after " + n + " follow-ups — check the bet history" };
  return { r, n };
}

async function placeKombi(p, stakeEur, ctx) {
  const legs = [];
  for (let i = 0; i < (Array.isArray(p.legs) ? p.legs.length : 0); i++) {
    const L = p.legs[i] || {}, feed = (L.sport == null || L.sport === "") ? "fb" : String(L.sport);
    if (feed !== "fb") return { status: "blocked", reason: "pamestoixima: leg " + (i + 1) + " — sport " + feed + " is not connected (football only)" };
    if (!/^\d{4,14}$/.test(String(L.outcomeId == null ? "" : L.outcomeId))) return { status: "blocked", reason: "pamestoixima: leg " + (i + 1) + " without the exact selection number of the operator (outcomeId) — nothing sent" };
    legs.push({ eventId: String(L.eventId), outcomeId: String(L.outcomeId), tip: L.tip, minOdds: Number(L.minOdds), team1: String(L.team1), team2: String(L.team2), sport: "soccer" });
  }
  if (legs.length < 2) return { status: "blocked", reason: "pamestoixima: a parlay needs at least two legs" };
  const t0 = Date.now();
  const offen = await seitenTab(ctx);
  if (offen.error) return { status: "blocked", reason: "pamestoixima: " + offen.error + " — nothing sent" };
  ctx.log("pamestoixima: parlay · " + legs.length + " legs · " + stakeEur + " € @ ≥" + p.minOdds + (offen.warm ? " · tab ready" : " · tab opened or reloaded"));
  let r = await sendTab(offen.tabId, { cmd: "pmeKombi", auftragId: auftragNr(p, "k"), armed: true, amount: stakeEur, minTotalOdds: Number(p.minOdds), legs });
  if (r && r.error && !r.status && /Receiving end does not exist|Could not establish connection/i.test(String(r.error))) return { status: "blocked", reason: "pamestoixima: the tab went away before the order was delivered — nothing sent" };
  const w = await warten(offen.tabId, r, "pmeKombiNachfragen"); r = w.r;
  ctx.log("pamestoixima: parlay answer after " + (Date.now() - t0) + " ms" + (w.n ? " (" + w.n + " follow-ups)" : "") + " · " + ((r && r.status) || "?") + (r && r.reason ? " · " + String(r.reason).slice(0, 220) : ""));
  if (!r || (r.error && !r.status)) return { status: "uncertain", reason: "pamestoixima: no answer from the page (" + ((r && r.error) || "empty") + ") — check the bet history" };
  standAus(null, r.reason);
  return { status: r.status === "staged" ? "blocked" : r.status, odds: r.odds, stake: r.stake, reason: r.reason, note: r.note, ticket: r.ticket != null ? String(r.ticket) : undefined, verified: r.verified, legs: r.legs, ms: r.ms };
}

export async function place(p, stakeEur, ctx) {
  if (p.mkt === "parlay") return await placeKombi(p, stakeEur, ctx);
  if (p.sport && p.sport !== "fb") return { status: "blocked", reason: "pamestoixima: sport " + String(p.sport) + " is not connected (football only)" };
  if (p.mkt && p.mkt !== "ml") return { status: "blocked", reason: "pamestoixima: market " + String(p.mkt) + " is not connected (match winner only)" };
  if (p.live === true || (p.eventIdentity && p.eventIdentity.live === true)) return { status: "blocked", reason: "pamestoixima: live bets are not connected — pre-match only" };
  const eventId = String((p.bookRef && p.bookRef.eventId) == null ? "" : p.bookRef.eventId), outcomeId = String((p.bookRef && p.bookRef.outcomeId) == null ? "" : p.bookRef.outcomeId);
  if (!/^\d{4,12}$/.test(eventId)) return { status: "blocked", reason: "pamestoixima: bookRef.eventId missing" };
  if (!/^\d{4,14}$/.test(outcomeId)) return { status: "blocked", reason: "pamestoixima: bookRef.outcomeId missing (without the exact selection number of the operator nothing is placed)" };
  const t0 = Date.now();
  const offen = await seitenTab(ctx);
  if (offen.error) return { status: "blocked", reason: "pamestoixima: " + offen.error + " — nothing sent" };
  ctx.log(`pamestoixima: event ${eventId} · Auswahl ${outcomeId} (${String(p.sel)} aus Operator-Sicht) · ${stakeEur} € @ ≥${p.minOdds}` + (offen.warm ? " · tab ready" : " · tab opened or reloaded"));
  let r = await sendTab(offen.tabId, { cmd: "pmePlace", auftragId: auftragNr(p, "e"), armed: true, eventId, outcomeId, amount: stakeEur, minOdds: Number(p.minOdds) });
  if (r && r.error && !r.status && /Receiving end does not exist|Could not establish connection/i.test(String(r.error))) return { status: "blocked", reason: "pamestoixima: the tab went away before the order was delivered — nothing sent" };
  const w = await warten(offen.tabId, r, "pmeNachfragen"); r = w.r;
  ctx.log(`pamestoixima: answer after ${Date.now() - t0} ms${w.n ? " (" + w.n + " follow-ups)" : ""} · ${r && r.status ? r.status : "?"}${r && r.ticket ? " · Ticket " + r.ticket : ""}${r && r.reason ? " · " + String(r.reason).slice(0, 220) : ""}`);
  if (!r || (r.error && !r.status)) return { status: "uncertain", reason: "pamestoixima: no answer from the page (" + ((r && r.error) || "empty") + ") — check the bet history" };
  standAus(null, r.reason);
  return { status: r.status === "staged" ? "blocked" : r.status, odds: r.odds, stake: r.stake, ticket: r.ticket != null ? String(r.ticket) : undefined, verified: r.verified, reason: r.reason, note: r.note };
}
