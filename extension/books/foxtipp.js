// books/foxtipp.js — foxtipp.com (reine JSON-API unter /backend/api). 31.10.2026.
//
//
// Tab-based wie pamestoixima.js: gelesen, geprueft und gesetzt wird aus der Seite (content/foxtipp-place.js, portiert aus handleFoxPlace in
// background.js des Operators). Die Anmeldung ist die des Kontoinhabers in seinem Tab; sie verlaesst den Tab nicht, dieser Adapter sieht sie nie.
// Kein Auto-Open (wie noAutoOpen beim Operator und books/elabet.js): ohne offenen, angemeldeten foxtipp.com-Tab wird nicht gesetzt.
// Einzelwette: nur Fussball, Sieger-Markt 997, nur vor dem Anpfiff, nur mit der GENAUEN Auswahl-Nummer des Operators (bookRef.outcomeId =
// Odds[].Id des Buchs, Buch-Sicht). sel ist die Sicht des Operators und wird hier nie in eine Buch-Seite uebersetzt: Foxtipp fuehrt Mannschaften
// auch andersherum, und das Einzige, das hier gegengeprueft werden kann, ist Remis (macht das Tab-Script). Keine Kombiwetten.
// Quoten: p.minOdds gilt gegen die NETTO-Quote (5 % Einsatzgebuehr eingerechnet), res.odds ist netto, res.stake der gesendete Einsatz in Euro —
// alles wie beim Operator (Kopf von content/foxtipp-place.js). Kein Kontostand: der Operator-Weg liest keinen, und er waere nur Anzeige.
//
// Doppel-Schutz: die Auftrags-Nummer folgt fest aus dem Vorschlag. Das Tab-Script fuehrt sie nie zweimal aus (Kit-Falle P24), und hier wird sie
// VOR der Uebergabe vermerkt (ctx.storageSet, ueberlebt den Neustart des Service Workers und das Neuladen des Tabs): ein zweiter Aufruf mit derselben
// Nummer sendet nichts, sondern meldet das erste Ergebnis. Frei wird die Nummer nur, wenn nachweislich nichts gesendet wurde (blocked).
"use strict";

const BUCH = "foxtipp";
const SEITE = "https://foxtipp.com";
const TAB_MUSTER = ["https://foxtipp.com/*", "https://www.foxtipp.com/*"];
const INHALT = "content/foxtipp-place.js";
const PING_FRIST_MS = 8000, AUFTRAG_FRIST_MS = 90000;   // das Tab-Script braucht hoechstens vier Abrufe zu je 15 s
const AUFTRAG_SCHLUESSEL = "foxtippAuftraege", AUFTRAG_MAX = 100, AUFTRAG_ALTER_MS = 24 * 3600e3;
const HINWEIS = "sign in at " + SEITE + " and keep the tab open";
const AUSWAHL = { home: true, draw: true, away: true };

export const id = BUCH;
export const sports = { fb: true };
export const hosts = { site: SEITE, api: SEITE + "/backend/api" };
export function arm() { /* nichts vorzuwaermen — die Sitzung lebt in der Seite */ }

// Stand der letzten Begegnung mit der Seite. Beginnt optimistisch wie pamestoixima.js: nach einem Neustart des Service Workers soll der erste
// Heartbeat keinen falschen Abriss melden (bettor-verbindungserkennung); der naechste ruft balance() und sagt die Wahrheit.
let _stand = { ready: true, detail: "tab-based (foxtipp) — keep " + SEITE + " open and signed in" };
export function status() { return { ready: _stand.ready !== false, detail: _stand.detail }; }
function standAus(grund) {
  if (grund && /not signed in|currency/i.test(grund)) _stand = { ready: false, detail: String(grund).replace(/ — nothing sent$/, "") + " — " + HINWEIS };
  else _stand = { ready: true, detail: "tab-based (foxtipp) — signed in" };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tabsQuery(q) { return new Promise((rs) => { try { chrome.tabs.query(q, (t) => rs(t || [])); } catch (_) { rs([]); } }); }
function sendTab(tabId, msg, fristMs) {
  return new Promise((rs) => {
    const frist = setTimeout(() => rs({ error: "no answer within " + Math.round(fristMs / 1000) + " s" }), fristMs);
    const ende = (v) => { clearTimeout(frist); rs(v); };
    try { chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, (r) => { const e = chrome.runtime.lastError; ende(e ? { error: e.message } : (r || { error: "no response" })); }); }
    catch (e) { ende({ error: String((e && e.message) || e) }); }
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
async function offenerTab() {
  const tabs = await tabsQuery({ url: TAB_MUSTER });
  return tabs.find((t) => t && t.status === "complete" && !t.discarded) || tabs.find((t) => t && !t.discarded) || null;
}
async function inject(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, files: [INHALT] }); return null; }
  catch (e) { return String((e && e.message) || e); }
}
// Der Tab muss GENAU unser Setz-Script tragen: nachladen (doppelt ist unschaedlich, das Script schuetzt sich selbst), dann fragen. Antwortet eine
// andere Version, wird der Tab EINMAL neu geladen — das ist alles VOR dem Auftrag.
async function seitenBereit(tab, ctx) {
  const MYVER = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return "?"; } })();
  for (let lauf = 0; lauf < 2; lauf++) {
    const err = await inject(tab.id);
    if (err) return { error: "script injection failed: " + err.slice(0, 120) };
    const p = await sendTab(tab.id, { cmd: "fxPing" }, PING_FRIST_MS);
    if (p && p.ok && p.bm === BUCH && p.ort) return { error: p.ort };
    if (p && p.ok && p.bm === BUCH && p.version === MYVER) return { tabId: tab.id, warm: lauf === 0 };
    if (lauf === 0) {
      ctx.log(`foxtipp: im Tab antwortet ${p && p.ok ? "Skript " + (p.version || "(alt)") : "kein Skript"} statt ${MYVER} — Tab neu laden`);
      try { await new Promise((rs) => { try { chrome.tabs.reload(tab.id, {}, () => rs()); } catch (_) { rs(); } }); } catch (_) {}
      await waitComplete(tab.id, 25000); await sleep(1500);
    }
  }
  return { error: "the page script did not answer" };
}

// Login-Probe im Heartbeat (Muster books/superbet.js, nur ohne Abruf): ist ein Tab offen, liegt dort eine Sitzung, ist das Konto in Euro? Laeuft im
// Tab und muss fuer sich allein stehen. Zurueck kommen nur Ja/Nein und die Waehrung, nie die Sitzung. Eine echte Pruefung beim Buch macht erst der Auftrag.
function anmeldungImTab() {
  let cur = null;
  try { const j = JSON.parse(localStorage.getItem("reduxPersist:profile")), c = j && j.profile && j.profile.Currency; if (/^[A-Za-z]{3}$/.test(String(c == null ? "" : c))) cur = String(c).toUpperCase(); } catch (_) {}
  let an = false;
  try { an = /^[0-9a-f-]{20,}$/i.test(String(localStorage.getItem("token") || "")); } catch (_) {}
  return { an, cur };
}
export async function balance() {
  const tab = await offenerTab();
  if (!tab) { _stand = { ready: false, detail: "foxtipp: no tab open — " + HINWEIS }; return null; }
  const r = await new Promise((fertig) => {
    const frist = setTimeout(() => fertig(null), 5000);
    const ende = (v) => { clearTimeout(frist); fertig(v); };
    try { Promise.resolve(chrome.scripting.executeScript({ target: { tabId: tab.id }, func: anmeldungImTab })).then((e) => ende((e && e[0] && e[0].result) || null), () => ende(null)); }
    catch (_) { ende(null); }
  });
  if (!r) _stand = { ready: false, detail: "foxtipp: the tab does not answer — " + HINWEIS };
  else if (!r.an) _stand = { ready: false, detail: "foxtipp: signed out — " + HINWEIS };
  else if (!r.cur) _stand = { ready: false, detail: "foxtipp: the currency of the account is not readable in this tab" };
  else if (r.cur !== "EUR") _stand = { ready: false, detail: "foxtipp: the account runs in " + r.cur + ", stakes come in EUR and this path does not convert" };
  else _stand = { ready: true, detail: "tab-based (foxtipp) — signed in" };
  return null;
}

// ---- Auftrags-Vermerk (Speicher der Engine + Modul) --------------------------------------------------------------------------------------------
const _auftraege = new Map();
const auftragNr = (p) => "e-" + String(p.proposalId == null ? "" : p.proposalId).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(-76);
async function vermerkeLesen(ctx) {
  let v = null;
  try { if (ctx && typeof ctx.storageGet === "function") v = await ctx.storageGet(AUFTRAG_SCHLUESSEL); } catch (_) {}
  return (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
}
async function vermerkLesen(nr, ctx) {
  if (_auftraege.has(nr)) return _auftraege.get(nr);
  const v = await vermerkeLesen(ctx);
  return Object.prototype.hasOwnProperty.call(v, nr) ? v[nr] : null;
}
async function vermerkSchreiben(nr, wert, ctx) {
  if (wert) _auftraege.set(nr, wert); else _auftraege.delete(nr);
  while (_auftraege.size > AUFTRAG_MAX) _auftraege.delete(_auftraege.keys().next().value);
  try {
    if (!ctx || typeof ctx.storageSet !== "function") return;
    const v = await vermerkeLesen(ctx), jetzt = Date.now();
    if (wert) v[nr] = wert; else delete v[nr];
    const reste = Object.keys(v).filter((k) => v[k] && jetzt - Number(v[k].ts) < AUFTRAG_ALTER_MS).sort((a, b) => Number(v[a].ts) - Number(v[b].ts)).slice(-AUFTRAG_MAX);
    await ctx.storageSet(AUFTRAG_SCHLUESSEL, Object.fromEntries(reste.map((k) => [k, v[k]])));
  } catch (_) {}
}

export async function place(p, stakeEur, ctx) {
  const nein = (grund) => ({ status: "blocked", reason: "foxtipp: " + grund + " — nothing sent" });
  if (p.mkt === "parlay") return nein("parlays are not connected");
  if (p.sport && p.sport !== "fb") return nein("sport " + String(p.sport) + " is not connected (football only)");
  if (p.mkt && p.mkt !== "ml") return nein("market " + String(p.mkt) + " is not connected (match winner only)");
  if (p.scope && p.scope !== "match") return nein("scope " + String(p.scope) + " is not connected (whole match only)");
  if (p.live === true || (p.eventIdentity && p.eventIdentity.live === true)) return nein("live bets are not connected, pre-match only");
  if (!Object.prototype.hasOwnProperty.call(AUSWAHL, String(p.sel))) return nein("invalid selection " + String(p.sel));
  const eventId = String((p.bookRef && p.bookRef.eventId) == null ? "" : p.bookRef.eventId), outcomeId = String((p.bookRef && p.bookRef.outcomeId) == null ? "" : p.bookRef.outcomeId);
  if (!/^\d{4,12}$/.test(eventId)) return nein("bookRef.eventId missing");
  if (!/^\d{4,14}$/.test(outcomeId)) return nein("bookRef.outcomeId missing (without the exact selection number of the operator nothing is placed)");
  const einsatz = Math.round(Number(stakeEur) * 100) / 100, minOdds = Number(p.minOdds);
  if (!(einsatz > 0)) return nein("stake missing");
  if (!(minOdds > 1)) return nein("minimum odds missing");
  if (!p.proposalId) return nein("proposal without a number");

  const auftragId = auftragNr(p), vorher = await vermerkLesen(auftragId, ctx);
  if (vorher) {
    ctx.log(`foxtipp: Auftrag ${auftragId} war schon beim Tab — nichts erneut gesendet`);
    if (!vorher.res) return { status: "uncertain", reason: "foxtipp: this order already went to the tab and its result is unknown — nothing sent again, check the bet history" };
    return Object.assign({}, vorher.res, { note: [vorher.res.note, "repeat of the same order — nothing sent again"].filter(Boolean).join(" · ") });
  }

  const tab = await offenerTab();
  if (!tab) { _stand = { ready: false, detail: "foxtipp: no tab open — " + HINWEIS }; return nein("no tab open — " + HINWEIS); }
  const t0 = Date.now();
  const offen = await seitenBereit(tab, ctx);
  if (offen.error) return nein(offen.error);

  // AB HIER kann der Auftrag beim Buch ankommen: erst vermerken, dann uebergeben. Wiederholung gibt es keine.
  await vermerkSchreiben(auftragId, { ts: Date.now(), res: null }, ctx);
  ctx.log(`foxtipp: Spiel ${eventId} · Auswahl ${outcomeId} (${String(p.sel)} aus Operator-Sicht) · ${einsatz} € @ ≥${minOdds} netto` + (offen.warm ? " · tab ready" : " · tab reloaded"));
  const r = await sendTab(offen.tabId, { cmd: "fxPlace", auftragId, armed: true, eventId, outcomeId, sel: p.sel, amount: einsatz, minOdds }, AUFTRAG_FRIST_MS);
  ctx.log(`foxtipp: Antwort nach ${Date.now() - t0} ms · ${r && r.status ? r.status : "?"}${r && r.ticket ? " · Ticket " + r.ticket : ""}${r && r.brutto ? " · brutto " + r.brutto : ""}${r && r.odds ? " · netto " + r.odds : ""}${r && r.stake ? " · Einsatz " + r.stake : ""}${r && r.gekappt ? " (auf das Maximum des Buchs gekappt)" : ""}${r && r.totalStake ? " · gestellt " + r.totalStake : ""}${r && r.reason ? " · " + String(r.reason).slice(0, 220) : ""}`);

  // „Kein Empfaenger“ gleich nach dem beantworteten Ping: der Auftrag kam im Tab nie an — nachweislich nichts gesendet. Jeder andere Abriss kann
  // NACH dem Senden liegen: uncertain (Wahrheitstabelle, Kit-Falle P20), und die Nummer bleibt belegt.
  if (r && r.error && !r.status && /Receiving end does not exist|Could not establish connection/i.test(String(r.error))) {
    await vermerkSchreiben(auftragId, null, ctx);
    return nein("the tab went away before the order was delivered");
  }
  let aus;
  if (!r || (r.error && !r.status)) aus = { status: "uncertain", reason: "foxtipp: no answer from the page (" + String((r && r.error) || "empty").slice(0, 120) + ") — check the bet history" };
  else if (r.status === "placed" && !r.ticket) aus = { status: "uncertain", reason: "foxtipp: the page reports a bet without a ticket number — check the bet history", odds: r.odds, stake: r.stake };
  else if (r.status === "placed" || r.status === "failed") aus = { status: r.status, odds: r.odds, stake: r.stake, ticket: r.ticket != null ? String(r.ticket) : undefined, reason: r.reason, note: r.note };
  else if (r.status === "blocked" || r.status === "staged") aus = { status: "blocked", reason: r.reason || "foxtipp: the page did not send the order — nothing sent", odds: r.odds };
  else aus = { status: "uncertain", reason: r.reason || "foxtipp: unclear answer from the page — check the bet history", odds: r.odds, stake: r.stake };

  await vermerkSchreiben(auftragId, aus.status === "blocked" ? null : { ts: Date.now(), res: aus }, ctx);
  standAus(aus.reason);
  return aus;
}
