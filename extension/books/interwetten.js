// books/interwetten.js — interwetten.gr (eigene Plattform). 1.2.78 (21.10.2026). Betreiber: „Mache bitte alles final fertig inkl. der
// External Bettor App und der Sidebar.“
//
// Tab-based wie pamestoixima.js: gesetzt wird aus der Seite www.interwetten.gr (Cloudflare laesst den Wettschein nur aus dem
// Seitenkontext zu; die Sitzung lebt in der Seite). Einzelwette Sieger-Markt („Match“), Fussball und Basketball, vor dem Anpfiff und
// live, nur mit der GENAUEN Auswahl des Operators: bookRef.outcomeId = "<Ausgang>.<Markt>.<Spiel>" (Interwettens Nummern, Buch-Sicht,
// aus dem Edge-Dienst des Operators). Die Engine sucht nie selbst eine Auswahl und uebersetzt nie Heim/Gast.
// Kein Seitenwechsel: jeder offene Tab der Seite genuegt; ist keiner offen, wird einer im Hintergrund geoeffnet. Antwortet im Tab
// ein Script einer anderen Version, wird er EINMAL neu geladen.
// KOMBIWETTEN (mkt "parlay") ueber denselben Tab — placeKombi.
"use strict";
import { imTab, alsJson, r2 } from "./konto-lesen.js";

const ORIGIN = "https://www.interwetten.gr";

export const id = "interwetten";
export const sports = { fb: true, basket: true };
export const kombi = true;   // 1.2.79: Kombis ueber content/interwetten-place.js iwKombi → IWSETZEN.setzenKombi
export const hosts = { interwetten: { origin: ORIGIN } };

let _stand = { ready: true, detail: "tab-based (interwetten) — keep " + ORIGIN + " open and signed in" };
export function arm() { /* nichts vorzuwaermen — die Sitzung lebt in der Seite */ }
export function status() { return { ready: _stand.ready !== false, detail: _stand.detail }; }
function standAus(ort, grund) {
  if (ort) _stand = { ready: false, detail: "interwetten: " + ort };
  else if (grund && /not signed in/i.test(grund)) _stand = { ready: false, detail: "interwetten: signed out — sign in at " + ORIGIN };
  else if (grund && /Cloudflare/i.test(grund)) _stand = { ready: false, detail: "interwetten: open the tab and confirm the Cloudflare check once" };
  else _stand = { ready: true, detail: "tab-based (interwetten) — signed in" };
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
async function inject(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ["content/interwetten-setzen.js", "content/interwetten-place.js"] }); return null; }
  catch (e) { return String((e && e.message) || e); }
}
async function seitenTab(ctx, mitKombi) {
  const MYVER = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return "?"; } })();
  let tab = (await tabsQuery({ url: ORIGIN + "/*" })).find((t) => t && !t.discarded) || null, neu = false;
  if (!tab) {
    tab = await tabCreate({ url: ORIGIN + "/en/sportsbook", active: false });
    if (!tab) return { error: "could not open a tab for " + ORIGIN };
    neu = true; await waitComplete(tab.id, 25000); await sleep(1500);
  }
  for (let lauf = 0; lauf < 2; lauf++) {
    const err = await inject(tab.id);
    if (err) return { error: "script injection failed: " + err };
    const p = await sendTab(tab.id, { cmd: "iwPing" });
    if (p && p.ok && p.ort) { standAus(p.ort); return { error: p.ort }; }
    if (p && p.ok && p.abfrage) { standAus(null, "Cloudflare"); return { error: "Cloudflare check open in the Interwetten tab — confirm it once" }; }
    if (p && p.ok && p.version === MYVER && p.kern && (!mitKombi || p.kombi === true)) return { tabId: tab.id, warm: !neu && lauf === 0 };
    if (lauf === 0) {
      ctx.log(`interwetten: tab answers with ${p && p.ok ? "script " + (p.version || "(old)") + (mitKombi && p.kombi !== true ? " without parlays" : "") : "no script"} instead of ${MYVER} — reloading`);
      try { await new Promise((rs) => { try { chrome.tabs.reload(tab.id, {}, () => rs()); } catch (_) { rs(); } }); } catch (_) {}
      await waitComplete(tab.id, 25000); await sleep(1500);
    }
  }
  return { error: "interwetten page script did not answer" };
}

// ---- 1.2.79 (25.10.2026) KOMBIWETTE -------------------------------------------------------------------------------------------------
// Der ganze Schein laeuft als EIN Auftrag im Tab (content/interwetten-place.js iwKombi → IWSETZEN.setzenKombi, byte-gleich mit dem Kern des
// Operators): AddBets je Bein, SetCombiAmount, RequestLiveSubmit/DoLiveSubmit, RemoveBets. Jedes Bein braucht die GENAUE Auswahl des Operators
// (legs[].outcomeId = "<Ausgang>.<Markt>.<Spiel>", wie bookRef.outcomeId der Einzelwette) — die Engine sucht nie selbst eine Auswahl und
// uebersetzt nie Heim/Gast. Nur vor dem Anpfiff (engine-core prueft startsTs). Auftrags-Nummer je Versuch: der Tab fuehrt sie nie zweimal aus.
// Kein Nachfragen: der Tab antwortet erst mit dem Ergebnis (das Buch entscheidet in Sekunden; sendMessage wartet).
const KOMBI_SPORT_SEITE = { fb: true, basket: true };
let _kombiNr = 0;
async function placeKombi(p, stakeEur, ctx) {
  const legs = [];
  for (let i = 0; i < (Array.isArray(p.legs) ? p.legs.length : 0); i++) {
    const L = p.legs[i] || {}, feed = (L.sport == null || L.sport === "") ? "fb" : String(L.sport);
    if (!KOMBI_SPORT_SEITE[feed]) return { status: "blocked", reason: "interwetten: leg " + (i + 1) + " — sport " + feed + " is not connected for parlays (football, basketball)" };
    const m = /^(\d{4,13})\.(\d{4,13})\.(\d{4,13})$/.exec(String(L.outcomeId == null ? "" : L.outcomeId));
    if (!m) return { status: "blocked", reason: "interwetten: leg " + (i + 1) + " without the exact selection of the operator (outcomeId) — nothing sent" };
    if (!(Number(L.minOdds) > 1)) return { status: "blocked", reason: "interwetten: leg " + (i + 1) + " without minimum odds — nothing sent" };
    legs.push({ outcomeId: Number(m[1]), marketId: Number(m[2]), eventId: Number(m[3]), minOdds: Number(L.minOdds) });
  }
  if (legs.length < 2) return { status: "blocked", reason: "interwetten: a parlay needs at least two legs" };
  if (!(Number(p.minOdds) > 1)) return { status: "blocked", reason: "interwetten: minimum total odds missing" };
  const t0 = Date.now();
  const offen = await seitenTab(ctx, true);
  if (offen.error) return { status: "blocked", reason: "interwetten: " + offen.error + " — nothing sent" };
  const auftragId = ("k-" + String(p.proposalId == null ? "" : p.proposalId).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 48) + "-" + Date.now().toString(36) + "-" + (++_kombiNr)).slice(0, 80);
  ctx.log(`interwetten: parlay · ${legs.length} legs · ${stakeEur} € @ ≥${p.minOdds}` + (offen.warm ? " · tab ready" : " · tab opened or reloaded"));
  const r = await sendTab(offen.tabId, { cmd: "iwKombi", auftragId, armed: true, legs, amount: stakeEur, minTotalOdds: Number(p.minOdds) });
  if (r && r.error && !r.status && /Receiving end does not exist|Could not establish connection/i.test(String(r.error))) return { status: "blocked", reason: "interwetten: the tab went away before the order was delivered — nothing sent" };
  ctx.log(`interwetten: parlay answer after ${Date.now() - t0} ms · ${r && r.status ? r.status : "?"}${r && r.ticket ? " · Ticket " + r.ticket : ""}${r && r.reason ? " · " + String(r.reason).slice(0, 200) : ""}`);
  if (!r || (r.error && !r.status)) return { status: "uncertain", reason: "interwetten: no answer from the page (" + ((r && r.error) || "empty") + ") — check the bet history" };
  standAus(null, r.reason);
  return { status: r.status === "staged" ? "blocked" : r.status, odds: r.odds, stake: r.stake, reason: r.reason, note: r.note, ticket: r.ticket != null ? String(r.ticket) : undefined, verified: r.verified, legs: r.legs };
}

export async function place(p, stakeEur, ctx) {
  if (p.mkt === "parlay") return await placeKombi(p, stakeEur, ctx);
  const feed = (p.sport == null || p.sport === "") ? "fb" : String(p.sport);
  if (!sports[feed]) return { status: "blocked", reason: "interwetten: sport " + feed + " is not connected (football, basketball)" };
  if (p.mkt && p.mkt !== "ml") return { status: "blocked", reason: "interwetten: market " + String(p.mkt) + " is not connected (match winner only)" };
  const ref = String((p.bookRef && p.bookRef.outcomeId) == null ? "" : p.bookRef.outcomeId), m = /^(\d{4,13})\.(\d{4,13})\.(\d{4,13})$/.exec(ref);
  if (!m) return { status: "blocked", reason: "interwetten: bookRef.outcomeId missing (without the exact selection of the operator nothing is placed)" };
  const live = p.live === true || !!(p.eventIdentity && p.eventIdentity.live === true);
  const t0 = Date.now();
  const offen = await seitenTab(ctx);
  if (offen.error) return { status: "blocked", reason: "interwetten: " + offen.error + " — nothing sent" };
  ctx.log(`interwetten: Auswahl ${m[1]} · Markt ${m[2]} · Spiel ${m[3]} (${String(p.sel)} aus Operator-Sicht) · ${live ? "live" : "vor dem Anpfiff"} · ${stakeEur} € @ ≥${p.minOdds}` + (offen.warm ? " · tab ready" : " · tab opened or reloaded"));
  const r = await sendTab(offen.tabId, { cmd: "iwPlace", armed: true, outcomeId: Number(m[1]), marketId: Number(m[2]), eventId: Number(m[3]), isLive: live, amount: stakeEur, minOdds: Number(p.minOdds) });
  if (r && r.error && !r.status && /Receiving end does not exist|Could not establish connection/i.test(String(r.error))) return { status: "blocked", reason: "interwetten: the tab went away before the order was delivered — nothing sent" };
  ctx.log(`interwetten: answer after ${Date.now() - t0} ms · ${r && r.status ? r.status : "?"}${r && r.ticket ? " · Ticket " + r.ticket : ""}${r && r.reason ? " · " + String(r.reason).slice(0, 200) : ""}`);
  if (!r || (r.error && !r.status)) return { status: "uncertain", reason: "interwetten: no answer from the page (" + ((r && r.error) || "empty") + ") — check the bet history" };
  standAus(null, r.reason);
  return { status: r.status, odds: r.odds, stake: r.stake, ticket: r.ticket != null ? String(r.ticket) : undefined, verified: r.verified, reason: r.reason };
}

// 01.11.2026: Die Seite ist umgebaut, der Kontostand kommt jetzt aus /api/account/balances (assets/service-*.js: fetchAccountBalance, Feld totalBalance; ohne Anmeldung kein totalBalance). Nur aus der Seite, Cloudflare. Am echten Konto bestätigt.
let _saldo = null;
export async function balance() {
  if (_saldo && Date.now() - _saldo.t < 60000) return _saldo.w;
  const j = alsJson(await imTab(ORIGIN, "/api/account/balances"));
  const s = j && typeof j === "object" && "totalBalance" in j ? Number(j.totalBalance) : NaN;
  const w = isFinite(s) ? { saldo: r2(s), bonus: 0, hold: 0, cur: "EUR", ts: Date.now() } : null;
  _saldo = { t: Date.now(), w };
  return w;
}

// ---- Konto lesen (01.11.2026, gelesen am echten Konto 01.11.2026, books/konto-lesen.js) ----------------------------------------
// Kontoauszug: GET /en/journal/accountturnoverpartial?pageIndex=N&filterId=1 → { html }, 25 Zeilen je Seite, neueste zuerst, bis zur Kontoeröffnung. data-id der Zeile = Wette. Die Summe aller 83 Zeilen ergab auf den Cent den Kontostand.
// Wette: /en/journal/betdetail/<id>, Typ und Zeit im h1, Zeilen ul.flex-table, Fuß „Profit / Stake / Odds“, Profit = ganze Auszahlung. Alle 55 Wetten stimmten mit dem Auszug überein. Die Liste /en/journal/bets/<0|1|2> zeigt je höchstens 20 ohne Weiterblättern, Reiter 1 = offen; sie dient nur dazu, offene Wetten zu erkennen.
// Zeiten: Die Seite zeigt mitteleuropäische Zeit, obwohl das Konto auf Athen steht (Anstoßzeiten gegen unsere Daten, Browser in Berlin). Mit einem Browser in anderer Zeitzone nicht geprüft; das träfe nur ts, nie die Beträge.
// Belegt sind Einzelwetten gewonnen und verloren. Offene, Kombis, Storno und Cashout kamen im Konto nicht vor: Ohne Symbol zählt der Reiter „offen“, sonst bleibt es „unklar“. Es wird nichts geraten.
const IW_ART = { stake: "einsatz", winnings: "gewinn", "pay in": "einzahlung", "pay out": "auszahlung", bonus: "bonus" };
const IW_SPORT = { 10: "soccer", 15: "basketball", 11: "tennis", 14: "baseball", 1002: "handball", 1012: "volleyball", 1015: "tabletennis" };
const IW_SEITEN_MAX = 40, IW_DETAIL_MAX = 40, IW_NACHSEHEN_MS = 6 * 3600e3, IW_WARTE_MAX = 200;
const IW_ZEICHEN = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function iwText(h) {
  return String(h == null ? "" : h).replace(/<[^>]*>/g, " ").replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (m, d, x, n) => (d ? String.fromCodePoint(Number(d)) : x ? String.fromCodePoint(parseInt(x, 16)) : IW_ZEICHEN[n.toLowerCase()] || m)).replace(/\s+/g, " ").trim();
}
// Die Seite schreibt Attribute nicht einheitlich in doppelten Anführungszeichen
const iwAttr = (a, n) => { const m = new RegExp("\\b" + n + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i").exec(a); return m ? (m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]) : null; };
const iwBetrag = (s) => { const t = String(s == null ? "" : s).trim(); return /^-?\d[\d.]*(,\d+)?$/.test(t) ? Number(t.replace(/\./g, "").replace(",", ".")) : null; };
const iwQuote = (s) => { const t = String(s == null ? "" : s).trim(); return /^\d+(\.\d+)?$/.test(t) && Number(t) >= 1 ? Number(t) : null; };   // nur Dezimalquoten; steht das Konto auf einem anderen Format, bleibt das Feld leer
// „31.10.2026 17:30“, „31.10.2026, 17:30“, „31.10.2026 | 18:00“ → UTC. Sommerzeit: letzter Sonntag im März bis letzter Sonntag im Oktober, je 01:00 UTC.
export function iwZeit(t) {
  const m = /(\d{2})\.(\d{2})\.(\d{4})\D+(\d{2}):(\d{2})/.exec(String(t || ""));
  if (!m) return null;
  const jahr = Number(m[3]), ort = Date.UTC(jahr, Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5]));
  const wechsel = (monat) => { const d = new Date(Date.UTC(jahr, monat + 1, 0)); return Date.UTC(jahr, monat, d.getUTCDate() - d.getUTCDay(), 1); };
  return ort - (ort - 72e5 >= wechsel(2) && ort - 72e5 < wechsel(9) ? 72e5 : 36e5);
}
// → { zeilen: [{ id, ts, art, betrag, wette }], seite, seiten }
export function iwAuszugAus(html) {
  const h = String(html || ""), zeilen = [];
  for (const z of h.matchAll(/<tr\b([^>]*\bJOURNALDETAIL\b[^>]*)>([\s\S]*?)<\/tr>/gi)) {
    const zellen = [...z[2].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => iwText(c[1])), kopf = /(\d+)\s*$/.exec(zellen[0] || ""), wette = iwAttr(z[1], "data-id");
    if (zellen.length < 5 || !kopf) continue;
    const name = zellen[1].toLowerCase();
    zeilen.push({ id: kopf[1], ts: iwZeit(zellen[0]), art: IW_ART[name] || name.slice(0, 24), betrag: Math.round(((iwBetrag(zellen[3]) || 0) - (iwBetrag(zellen[4]) || 0)) * 100) / 100, wette: /^\d+$/.test(wette || "") ? wette : null });
  }
  const p = /Page\s+(\d+)\s+of\s+(\d+)/i.exec(iwText(h.slice(Math.max(0, h.lastIndexOf("d-pager")))));
  return { zeilen, seite: p ? Number(p[1]) : 1, seiten: p ? Number(p[2]) : 1 };
}
export function iwOffeneAus(html) {
  const ids = new Set();
  for (const u of String(html || "").matchAll(/<ul\b([^>]*)>/gi)) { const k = iwAttr(u[1], "class"), d = iwAttr(u[1], "data-id"); if (k && /^\d+$/.test(d || "") && /\bflex-table\b/.test(k) && /\brow\b/.test(k)) ids.add(d); }
  return ids;
}
const iwSymbol = (h) => { const s = /styles-account-bet-(won|lost)\b/.exec(h); return s ? (s[1] === "won" ? "gewonnen" : "verloren") : null; };
export function iwWetteAus(id, html, offene) {
  const h = String(html || ""), start = h.search(/class\s*=\s*["']?[^"'>]*\bbetdetail\b/i), fuss = start < 0 ? -1 : h.indexOf("bet-detail-footer", start), titel = [...h.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => iwText(m[1])).find((t) => /\d{2}\.\d{2}\.\d{4}/.test(t));
  if (fuss < 0 || !titel) return null;
  const block = h.slice(start, fuss), fussText = iwText(h.slice(fuss, fuss + 2000)), einsatz = /Stake:\s*([\d.,]+)\s*([A-Z]{3})?/.exec(fussText);
  if (!einsatz) return null;
  const reihen = [...block.matchAll(/<ul\b([^>]*\bflex-table\b[^>]*)>([\s\S]*?)<\/ul>/gi)].filter((u) => !/\bthead\b/.test(u[1]));
  // Bei mehreren Zeilen zählt nur ein Symbol außerhalb der Zeilen, das einer Zeile sagt nichts über den ganzen Schein
  const symbol = iwSymbol(reihen.length > 1 ? reihen.reduce((t, u) => t.replace(u[0], ""), block) : block), status = symbol || (offene && offene.has(String(id)) ? "offen" : "unklar");
  const beine = reihen.map((u) => {
    const c = {};
    for (const l of u[2].matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)) { const k = iwAttr(l[1], "class"); if (k) c[k.trim().split(/\s+/).pop()] = l[2]; }
    const d = /^(.*?)\s+\(([^()]*)\)\s*-+>\s*(.*?)\s*\/\s*(\S+)\s*$/.exec(iwText(c.desc)), teams = d ? d[1].split(" - ") : [], sport = /sports-kos-(\d+)/.exec(c.image || "");
    return { spielId: null, start: iwZeit(iwText(c.extended)), heim: teams[0] || null, gast: teams.slice(1).join(" - ") || null, liga: null, sport: sport ? IW_SPORT[sport[1]] || null : null, markt: d ? d[2] : null, tipp: d ? d[3] : null, quote: d ? iwQuote(d[4]) : null, ergebnis: reihen.length === 1 ? status : iwSymbol(u[2]) || "unklar", stand: iwText(c.result).replace(/^Result\s*/i, "") || null, live: /live/i.test(iwText(c.type)) };
  });
  const kombi = beine.length > 1 || !/^single/i.test(titel), quote = /Odds:\s*(\S+)/.exec(fussText), profit = /Profit:\s*([\d.,]+)/.exec(fussText);
  return { id: String(id), ts: iwZeit(titel), einsatz: iwBetrag(einsatz[1]), quote: quote ? iwQuote(quote[1]) : null, status, auszahlung: profit ? iwBetrag(profit[1]) : null, waehrung: einsatz[2] || null, kombi, bonus: false, beine };
}
export async function kontoLesen(venue, m) {
  m = m || {};
  const jetzt = Date.now(), bis = Number(m.iwBis) || 0, buchungen = [], neu = new Set(Array.isArray(m.iwNeu) ? m.iwNeu : []);
  let seite = Number(m.iwSeite) || 0, oben = seite ? Number(m.iwOben) || 0 : 0, ende = false, gelesen = 0;
  while (gelesen < IW_SEITEN_MAX) {
    const j = alsJson(await imTab(ORIGIN, "/en/journal/accountturnoverpartial?pageIndex=" + seite + "&filterId=1", { headers: { "X-Requested-With": "XMLHttpRequest" } }));
    if (!j || typeof j.html !== "string") { if (!gelesen) return null; break; }
    const a = iwAuszugAus(j.html);
    if (!oben && a.zeilen.length) oben = Number(a.zeilen[0].id);
    for (const z of a.zeilen) {
      if (Number(z.id) <= bis) { ende = true; break; }
      buchungen.push({ id: z.id, ts: z.ts, betrag: z.betrag, art: z.art, bezug: z.wette });
      if (z.wette) neu.add(z.wette);
    }
    gelesen++; seite++;
    if (ende || !a.zeilen.length || a.seite >= a.seiten) { ende = true; break; }
    await sleep(300);
  }
  // Offene Wetten nur neu lesen, wenn sie den Reiter verlassen haben oder eine neue Zeile sie nennt. Der Reiter fasst höchstens 20; was nicht drinsteht und ungeklärt ist, kommt alle 6 h dran.
  const r = await imTab(ORIGIN, "/en/journal/bets/1"), offene = r && r.s === 200 ? iwOffeneAus(r.t) : null, warte = Object.assign({}, m.iwOffen), liste = new Set(Array.isArray(m.iwListe) ? m.iwListe : []);
  if (offene) for (const id of Object.keys(warte)) if (!offene.has(id) && (liste.has(id) || jetzt - warte[id] >= IW_NACHSEHEN_MS)) neu.add(id);
  const wetten = [], rest = [];
  let abrufe = 0, abgemeldet = false;
  for (const id of neu) {
    if (abgemeldet || abrufe >= IW_DETAIL_MAX) { rest.push(id); continue; }
    abrufe++;
    const d = await imTab(ORIGIN, "/en/journal/betdetail/" + id);
    if (!d || d.s == null) { rest.push(id); continue; }
    const w = d.s === 200 ? iwWetteAus(id, d.t, offene) : null;
    if (w) { wetten.push(w); if (w.status === "offen" || w.status === "unklar") warte[id] = jetzt; else delete warte[id]; }
    else if (d.s === 200 && !/\/account\/logout/i.test(d.t)) { abgemeldet = true; rest.push(id); }   // Mitten im Lauf abgemeldet: nichts geht verloren, es kommt beim nächsten Mal dran
    else if (d.s === 200) warte[id] = jetzt;   // angemeldet, aber nicht lesbar: alle 6 h wieder, statt die Wette still zu verlieren
    await sleep(200);
  }
  const ids = Object.keys(warte).sort((x, y) => Number(y) - Number(x));
  for (const id of ids.slice(IW_WARTE_MAX)) delete warte[id];
  return { wetten, buchungen, summen: null, voll: ende && !rest.length, merker: { iwBis: ende ? Math.max(oben, bis) : bis, iwOben: ende ? 0 : oben, iwSeite: ende ? 0 : seite, iwNeu: rest, iwOffen: warte, iwListe: offene ? [...offene] : [...liste] } };
}
