// books/mystake.js — MyStake (brand 28) and Jackbit (brand 94) adapter. Both run the same
// sportsbook engine; the operator verified brand 94 serves identical CS2 payloads (same market ids,
// same pos ids, even the same ItemIDs). One adapter file, two host sets.
//
// Unlike Fonbet this book needs a tab: the betslip is a widget that builds the ticket (and, at
// MyStake, a hash) itself — a blind API replay is not possible. The adapter therefore opens the
// event page the OPERATOR named (bookRef.eventId = gameId), injects the placement script and hands
// over. It never searches for an event by team name.
"use strict";
import { imKonto, alsJson, r2 } from "./konto-lesen.js";

const SITES = {
  // Ein laufendes Spiel hat seine eigene Seite.
  mystake: { origin: "https://mystake.com", event: (id) => `https://mystake.com/en/sportsbook/prematch/match/${id}`, live: (id) => `https://mystake.com/en/sportsbook/live/eventview/${id}`,
             eventCs2: (id) => `https://mystake.com/en/sportsbook/prematch/match/0/${id}` },
  jackbit: { origin: "https://jack.com", event: (id) => `https://jack.com/en/sportsbook/prematch/match/${id}`, live: (id) => `https://jack.com/en/sportsbook/live/eventview/${id}`,
             eventCs2: (id) => `https://jack.com/en/sportsbook/esports/match/0/${id}` },
};

export const id = "mystake";
export const hosts = SITES;
// 1.2.65: dieser Adapter setzt Kombiwetten (mkt "parlay") — engine-core.js adapterKombi. Bisher nur fuer MyStake selbst
// gemessen (04.10.2026, mystake.com /sportsbookv4/); Jackbit laeuft auf demselben Sportsbook, ist aber ungeprueft und bleibt zu.
export const kombi = true;
const KOMBI_ORTE = { mystake: true };

// WICHTIG: mystake und jackbit teilen sich dieses Modul. Der Ausfuehrungsort kommt deshalb PRO
// AUFRUF vom Kern (ctx.venue / status(venue)) — eine Modulvariable kann nur EINEN Wert halten und
// stand bis v1.2.4 dauerhaft auf "mystake": jede Jackbit-Platzierung oeffnete mystake.com.
let _brand = "mystake";   // nur noch Fallback, wenn kein venue uebergeben wird
export function arm(ctx) {
  try { ctx.storageGet("engineCfg").then((c) => { if (c && c.brand === "jackbit") _brand = "jackbit"; }); } catch (_) {}
}
export function status() {
  // A logged-out session is only detectable on the page itself; the placement attempt reports it.
  return { ready: true, detail: `tab-based (${arguments[0] || _brand}) — make sure you are signed in at ${SITES[arguments[0] || _brand].origin}` };
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
async function inject(tabId) {
  // MAIN world first (ticket hook), then the placement script — both in all frames, because the
  // sportsbook lives in an iframe (/sportsbookv4/).
  try { await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", files: ["content/mystake-inject.js", "content/mystake-kombi-inject.js"] }); } catch (_) {}
  try { await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content/mystake-kombi.js", "content/mystake-place.js"] }); } catch (e) { return String((e && e.message) || e); }
  return null;
}

// Open (or reuse) the tab showing exactly the operator-named event, then wait for the sportsbook
// iframe to answer a ping.
// Tab in den Vordergrund holen. Grund (DIAG 30.07.: "sicht=hidden ... NOT_AUTHORIZED"):
// das Sportsbook-Widget vollzieht seinen Session-Handshake nur in einem SICHTBAREN Tab — im
// Hintergrund fuellt es den Schein, verweigert aber das Abschicken kommentarlos. Auf dem
// dedizierten Setz-Rechner ist das kurze In-den-Vordergrund-Holen akzeptabel und noetig.
function tabShow(tabId) {
  return new Promise((rs) => {
    try {
      chrome.tabs.update(tabId, { active: true }, (t) => {
        try { if (t && t.windowId != null) chrome.windows.update(t.windowId, { focused: true }, () => rs()); else rs(); }
        catch (_) { rs(); }
      });
    } catch (_) { rs(); }
  });
}
async function openEvent(gameId, isCs2, ctx, brand, live) {
  const site = SITES[brand || _brand];
  const url = live ? site.live(gameId) : isCs2 ? site.eventCs2(gameId) : site.event(gameId);
  let tab = (await tabsQuery({ url: site.origin + "/*" }))[0] || null;
  if (tab && String(tab.url || "") === url) { /* steht schon auf diesem Spiel: nicht neu laden */ }
  else if (tab) await tabUpdate(tab.id, { url, active: false });
  else tab = await tabCreate({ url, active: false });
  if (!tab) return { error: "could not open a tab for " + site.origin };
  await tabShow(tab.id);
  await waitComplete(tab.id, 20000);
  const err = await inject(tab.id);
  if (err) return { error: "script injection failed: " + err };
  const MYVER = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return "?"; } })();
  let reloadedOnce = false;
  for (let i = 0; i < 12; i++) {
    const p = await sendTab(tab.id, { cmd: "msPing" });
    // FEHLENDE Version = ALTES Skript (vor v1.2.18 gab es das Feld nicht) -> ebenfalls neu laden.
    // Die vorherige Fassung pruefte `p.version &&` und liess damit genau die Skripte durch,
    // die ausgetauscht werden muessen.
    if (p && p.ok && p.version !== MYVER && !reloadedOnce) {
      reloadedOnce = true;
      ctx.log(`${brand || _brand}: page runs script ${p.version || '(old, no version)'}, current is ${MYVER} — reloading the tab`);
      try { await new Promise((rs) => { try { chrome.tabs.reload(tab.id, {}, () => rs()); } catch (_) { rs(); } }); } catch (_) {}
      await waitComplete(tab.id, 20000);
      await sleep(1500);
      await inject(tab.id);
      continue;
    }
    if (p && p.ok && p.eventId && String(p.eventId) === String(gameId) && p.frame === "sportsbookv4") {
      ctx.log(`${brand || _brand}: ready · script ${p.version || "(old)"} · event ${p.eventId} · frame ${p.frame}`);
      return { tabId: tab.id };
    }
    await sleep(700);
    if (i === 5) await inject(tab.id);   // re-inject once: the iframe may have loaded late
  }
  return { error: "sportsbook frame did not report the requested event (" + gameId + ")" };
}

// der Tab
// wird NICHT neu geladen, wenn er schon im Sportsbook steht und dessen Rahmen mit dem aktuellen Skript antwortet — der ganze
// Schein (alle Beine einlegen, pruefen, abgeben) laeuft dann als EIN Auftrag im Seiten-Script (content/mystake-kombi.js,
// byte-gleich mit dem des Operators; dort ohne Zeitgeber-Warten: gemessen 0,6 s fuer vier Beine).
async function openSportsbook(ctx, brand) {
  const site = SITES[brand];
  const MYVER = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return "?"; } })();
  let tab = (await tabsQuery({ url: site.origin + "/*" }))[0] || null;
  if (tab && /\/sportsbook\//.test(String(tab.url || ""))) {
    await inject(tab.id);                                // prallt an den Markern ab, wenn die Skripte schon da sind
    const p = await sendTab(tab.id, { cmd: "msPing" });
    if (p && p.ok && p.frame === "sportsbookv4" && p.version === MYVER && p.kombi === true) { await tabShow(tab.id); return { tabId: tab.id, warm: true }; }
  }
  const url = site.origin + "/en/sportsbook/prematch";
  if (tab) await tabUpdate(tab.id, { url, active: false });
  else tab = await tabCreate({ url, active: false });
  if (!tab) return { error: "could not open a tab for " + site.origin };
  await tabShow(tab.id);
  await waitComplete(tab.id, 20000);
  const err = await inject(tab.id);
  if (err) return { error: "script injection failed: " + err };
  let neuGeladen = false;
  for (let i = 0; i < 14; i++) {
    const p = await sendTab(tab.id, { cmd: "msPing" });
    if (p && p.ok && p.frame === "sportsbookv4" && (p.version !== MYVER || p.kombi !== true) && !neuGeladen) {
      neuGeladen = true;                                  // altes Skript in einem seit dem Update offenen Tab → einmal neu laden
      ctx.log(brand + ": page runs an old script — reloading the tab");
      try { await new Promise((rs) => { try { chrome.tabs.reload(tab.id, {}, () => rs()); } catch (_) { rs(); } }); } catch (_) {}
      await waitComplete(tab.id, 20000); await sleep(1500); await inject(tab.id);
      continue;
    }
    if (p && p.ok && p.frame === "sportsbookv4" && p.version === MYVER && p.kombi === true) return { tabId: tab.id, warm: false };
    await sleep(500);
    if (i === 6) await inject(tab.id);                   // der Rahmen kann spaet geladen haben
  }
  return { error: "sportsbook frame did not answer" };
}
// Feed-Name der Sportart eines Beins → Name der Sportart im Seiten-Baustein. Was hier fehlt, kennt der Baustein nicht (er lehnt ab).
const KOMBI_SPORT_SEITE = { fb: "soccer", basket: "basketball" };
async function placeKombi(p, stakeEur, ctx, brand) {
  if (KOMBI_ORTE[brand] !== true) return { status: "blocked", reason: brand + ": parlays are not connected at this site yet" };
  const t0 = Date.now();
  const opened = await openSportsbook(ctx, brand);
  if (opened.error) return { status: "blocked", reason: brand + ": " + opened.error };
  const tabId = opened.tabId;
  const msg = { cmd: "msPlaceCombo", armed: true, amount: stakeEur, amountEur: stakeEur, minTotalOdds: Number(p.minOdds),
    // 1.2.67: Sportart je Bein (Feed-Name des Vorschlags → Name im Seiten-Baustein mystake-kombi.js SPORT_CFG); ohne Angabe Fussball
    legs: p.legs.map((L) => ({ eventId: String(L.eventId), tip: L.tip, minOdds: Number(L.minOdds), team1: String(L.team1), team2: String(L.team2), sport: KOMBI_SPORT_SEITE[(L.sport == null || L.sport === "") ? "fb" : String(L.sport)] || String(L.sport) })) };
  ctx.log(brand + ": parlay · " + msg.legs.length + " legs · " + stakeEur + " € @ ≥" + p.minOdds + (opened.warm ? " · tab ready" : " · tab opened"));
  let r = await sendTab(tabId, msg);
  if (r && r.status === "failed" && /NOT_?AUTHORIZ/i.test(String(r.reason || ""))) {
    // Widget ohne Session (Handshake beim Laden im Hintergrund uebersprungen): das Buch hat ABGELEHNT, es ist nichts gesetzt.
    // Tab (jetzt sichtbar) neu laden und den Schein EINMAL neu bauen — wie beim Einzelschein.
    ctx.log(brand + ": widget reports NOT_AUTHORIZED — reloading the visible tab, one retry");
    try { await new Promise((rs) => { try { chrome.tabs.reload(tabId, {}, () => rs()); } catch (_) { rs(); } }); } catch (_) {}
    await waitComplete(tabId, 20000); await sleep(3000); await inject(tabId);
    for (let i = 0; i < 8; i++) { const pg = await sendTab(tabId, { cmd: "msPing" }); if (pg && pg.ok && pg.frame === "sportsbookv4") break; await sleep(700); }
    r = await sendTab(tabId, msg);
  }
  ctx.log(brand + ": parlay answer after " + (Date.now() - t0) + " ms (page " + ((r && r.ms && r.ms.gesamt) != null ? r.ms.gesamt : "?") + " ms) · " + ((r && r.status) || "?") + (r && r.reason ? " · " + String(r.reason).slice(0, 220) : ""));
  if (!r || (r.error && !r.status)) return { status: "uncertain", reason: brand + ": no answer from the page (" + ((r && r.error) || "empty") + ") — check the bet history" };
  // Vokabular der Quittung: ticket als Text
  const t = r.ticket && typeof r.ticket === "object" ? (r.ticket.ID != null ? r.ticket.ID : (Array.isArray(r.ticket.Tickets) && r.ticket.Tickets[0] ? (r.ticket.Tickets[0].ID != null ? r.ticket.Tickets[0].ID : r.ticket.Tickets[0].TicketID) : null)) : r.ticket;
  return { status: r.status, odds: r.odds, stake: r.stake, reason: r.reason, note: r.note, ticket: t != null ? String(t) : undefined, legs: r.legs, ms: r.ms };
}

// Gemessen im Protokoll von SharpShark, 08:24–12:57 UTC: 33 Seitenwechsel, im Mittel einer je Minute, keine Einzelwette gesetzt. Derselbe Vorschlag kam bis zu viermal, jedes Mal mit neuer Seite.
// Darum: Quote und Markt zuerst ohne Tab lesen, eine Absage des Buchs gilt für diesen Vorschlag endgültig, und jeder Versuch mit Seite zählt für die Pause je Buch (seite: true, engine-sw.js).
const MARKE_NR = { mystake: 28, jackbit: 94 }, LIVE_CACHE = "https://wss-eu-uk1.ws-amazon.com/api/cache/get?key=", DATA = "https://analytics-sp.googleserv.tech/api";
// → { quote } | { fehlt: true } (nur live: Der Sieger-Markt ist gerade nicht im Angebot) | null (nicht sicher lesbar: Dann entscheidet wie bisher die Seite)
async function quoteOhneSeite(brand, gameId, tip, live) {
  try {
    const res = await fetch(live ? LIVE_CACHE + "live/gamenew/" + gameId : `${DATA}/prematch/getprematchgamefull/${MARKE_NR[brand]}/${gameId}`, { credentials: "omit" });
    if (!res.ok) return null;
    if (live) {
      const b64 = (await res.text()).trim().replace(/^"|"$/g, ""), bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const voll = JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text());
      if (!voll || !Array.isArray(voll.gmk)) return null;
      const z = voll.gmk.find((x) => x && String(x.mid) === "602" && String(x.pn).toLowerCase() === tip.toLowerCase() && x.visible !== false && Number(x.v) > 1);
      return z ? { quote: Number(z.v) } : { fehlt: true };
    }
    const obj = await res.json(), game = typeof obj.game === "string" ? JSON.parse(obj.game) : obj.game;
    if (!game || !game.ev) return null;
    // Vor dem Spiel sucht die Seite den Markt notfalls auch unter anderer Nummer (pick1x2). Fehlt 448, entscheidet darum sie.
    const pos = { "1": 1, X: 2, "2": 3 }[tip], z = Object.values(game.ev["448"] || {}).find((o) => o && o.pos === pos);
    return z && Number(z.coef) > 1 ? { quote: Number(z.coef) } : null;
  } catch (_) { return null; }
}
export async function place(p, stakeEur, ctx) {
  const brand = (ctx && (ctx.venue === "jackbit" || ctx.venue === "mystake")) ? ctx.venue : _brand;
  if (p.mkt === "parlay") return Object.assign(await placeKombi(p, stakeEur, ctx, brand), { seite: true, endgueltig: true });   // Die Sidebar baut den nächsten Schein selbst
  const r = await placeEinzel(p, stakeEur, ctx, brand);
  return r && r.ohneSeite ? r : Object.assign(r || {}, { seite: true }, r && r.status === "failed" ? { endgueltig: true } : {});
}
async function placeEinzel(p, stakeEur, ctx, brand) {
  const gameId = String(p.bookRef.eventId);
  const isCs2 = p.sport === "cs2", live = p.live === true;
  // Live ist nur der Fußball-Sieger gebaut (Markt 602, am echten Schein gemessen). Alles andere nicht auf gut Glück.
  if (live && (p.sport !== "fb" || p.mkt !== "ml")) return { status: "blocked", reason: brand + ": live " + p.sport + "/" + p.mkt + " is not connected", ohneSeite: true };
  const vorab = p.mkt === "ml" && !isCs2 && { home: "1", draw: "X", away: "2" }[p.sel] ? await quoteOhneSeite(brand, gameId, { home: "1", draw: "X", away: "2" }[p.sel], live) : null;
  if (vorab && vorab.fehlt) return { status: "blocked", reason: brand + ": 1X2 market not offered right now.", ohneSeite: true };
  if (vorab && vorab.quote < Number(p.minOdds)) return { status: "blocked", reason: `Odds ${vorab.quote} below min ${p.minOdds}. Not placed.`, ohneSeite: true };
  const opened = await openEvent(gameId, isCs2, ctx, brand, live);
  if (opened.error) return { status: "blocked", reason: brand + ": " + opened.error };
  const tabId = opened.tabId;
  ctx.log(`${brand}: event ${gameId} open, placing ${p.mkt}/${p.scope || "match"} ${p.sel} · ${stakeEur} € @ ≥${p.minOdds}`);

  let msg;
  if (isCs2) {
    const m = /^map([123])$/.exec(String(p.scope || ""));
    msg = { cmd: "msPlaceCs2", gameId, sel: p.sel, mkt: p.mkt, mapN: m ? m[1] : null, amount: stakeEur, minOdds: p.minOdds, amountEur: stakeEur };
  } else if (p.mkt === "ah") {
    msg = { cmd: "msPlaceAh", gameId, side: p.sel, line: p.line, amount: stakeEur, minOdds: p.minOdds };
  } else {
    const tip = { home: "1", draw: "X", away: "2" }[p.sel];
    if (!tip) return { status: "blocked", reason: brand + ": bad selection for 1X2" };
    msg = { cmd: live ? "msPlaceLive1x2" : "msPlace1x2", gameId, tip, amount: stakeEur, minOdds: p.minOdds, amountEur: stakeEur };
  }
  const _t0 = Date.now();
  let r = await sendTab(tabId, msg);
  ctx.log(`${brand}: answer after ${Date.now() - _t0} ms · ${r && r.status ? r.status : "?"}${r && r.ticketId ? " · Ticket " + r.ticketId : ""}${r && r.reason ? " · " + String(r.reason).slice(0, 220) : ""}`);
  if (r && /NOT_?AUTHORIZ/i.test(String(r.reason || ""))) {
    // Widget ohne Session erwischt (Handshake war beim Laden im Hintergrund uebersprungen):
    // Tab ist inzwischen sichtbar -> einmal neu laden, Handshake nachholen, EIN Wiederholungsversuch.
    ctx.log(brand + ": widget reports NOT_AUTHORIZED — reloading the tab, one retry");
    try { await new Promise((rs) => { try { chrome.tabs.reload(tabId, {}, () => rs()); } catch (_) { rs(); } }); } catch (_) {}
    await waitComplete(tabId, 20000);
    await sleep(3000);
    await inject(tabId);
    for (let i = 0; i < 8; i++) { const pg = await sendTab(tabId, { cmd: "msPing" }); if (pg && pg.ok && pg.frame === "sportsbookv4") break; await sleep(700); }
    r = await sendTab(tabId, msg);
  }
  if (r && r.error && !r.status) return { status: "uncertain", reason: brand + ": no answer from the page (" + r.error + ") — check the bet history" };
  if (r && r.ticketId) r.ticket = r.ticketId;
  return r;
}

// ---- Konto lesen (01.11.2026, gelesen am echten Konto 01.11.2026, books/konto-lesen.js) ----------------------------------------
// Kontostand: GET /api/profile/p/getWallets. Wetten: messagetosport „gethistory“ (50 je Seite, neueste zuerst, weiter über fromTicket). language 0 = Englisch (1 und 3 kamen als Georgisch und Türkisch zurück).
// Ticket: Status 5 + Result 0 = offen, Status 10 + Result 2 = gewonnen, Status 10 + Result 3 = verloren (gemessen an 400 Scheinen, WinAmount = ganze Auszahlung). Result 1 kam nur an Beinen vor und ist nicht belegt, darum „unklar“.
const MS_WAEHRUNG = { 202: "EUR" }, MS_ERGEBNIS = { 0: "offen", 2: "gewonnen", 3: "verloren" }, _saldo = {};
export async function balance(venue) {
  const v = venue || _brand, c = _saldo[v];
  if (c && Date.now() - c.t < 60000) return c.w;
  const l = alsJson(await imKonto(SITES[v].origin, "/api/profile/p/getWallets"));
  const w = Array.isArray(l) ? (l.find((x) => x && x.Default) || l[0]) : null;
  const saldo = w ? (w.BalanceDecimal != null ? Number(w.BalanceDecimal) : Number(w.Balance) / 10000) : NaN;
  const wert = isFinite(saldo) ? { saldo: r2(saldo), bonus: 0, hold: r2(Number(w.FrozenBalance) || 0), cur: MS_WAEHRUNG[w.CurrencyId] || "", ts: Date.now() } : null;
  _saldo[v] = { t: Date.now(), w: wert };
  return wert;
}
export function msWetteAus(t) {
  const bein = (i) => {
    const g = i.Game || {}, n = (x) => (x && (x.Name || x.KeyName)) || null, tore = i.Team1Score != null && i.Team2Score != null ? i.Team1Score + ":" + i.Team2Score : null;
    return { spielId: g.ID != null ? String(g.ID) : null, start: g.StartTime || null, heim: n(g.Team1), gast: n(g.Team2), liga: n(i.Champ), sport: (i.Sport && (i.Sport.KeyName || i.Sport.Name)) || null, markt: n(i.Market), tipp: n(i.Position), quote: i.Value != null ? Number(i.Value) : null, ergebnis: MS_ERGEBNIS[i.Result] || "unklar", stand: tore, live: i.ItemType === 1 };
  };
  const items = Array.isArray(t.Items) ? t.Items : [];
  return { id: String(t.ID), ts: t.ActionTime || null, einsatz: t.Amount != null ? Number(t.Amount) : null, quote: t.Koef != null ? Number(t.Koef) : null, status: MS_ERGEBNIS[t.Result] || "unklar", auszahlung: t.WinAmount != null ? Number(t.WinAmount) : null, waehrung: t.CurrencySTR || null, kombi: items.length > 1, bonus: t.IsBonus === true, beine: items.map(bein) };
}
const tagText = (t) => new Date(t).toISOString().slice(0, 10);
export async function kontoLesen(venue, m) {
  const v = venue || _brand, origin = SITES[v].origin, jetzt = Date.now(), voll = !!(m && m.voll), von = jetzt - (voll ? 14 : 400) * 864e5;
  const wetten = []; let zuletzt = null, seiten = 0, ende = false, erste = true;
  while (seiten < (voll ? 4 : 40)) {
    const nachricht = { countOnly: false, language: 0, from: von, to: jetzt };
    if (zuletzt) nachricht.fromTicket = zuletzt;
    const j = alsJson(await imKonto(origin, "/api/game/p/messagetosport", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "gethistory", message: JSON.stringify(nachricht) }) }));
    if (!j || j.Error || !Array.isArray(j.Tickets)) { if (erste) return null; break; }
    erste = false;
    const neu = zuletzt ? j.Tickets.filter((x) => x.ID < zuletzt) : j.Tickets;
    if (!neu.length) { ende = true; break; }
    for (const t of neu) wetten.push(msWetteAus(t));
    zuletzt = Math.min(...neu.map((x) => x.ID));
    seiten++;
    if (j.Tickets.length < 50) { ende = true; break; }
    await sleep(500);
  }
  // Kontobewegungen: die Summen der letzten 30 Tage, Liste und längere Zeiträume sind noch nicht belegt.
  const p = new URLSearchParams({ Count: "5", StartRecord: "1", StartDate: tagText(jetzt - 30 * 864e5) + "T00:00:00", ToDate: tagText(jetzt) + "T23:59:59" });
  const s = alsJson(await imKonto(origin, "/api/profile/p/getTransactions?" + p.toString()));
  const summen = s && !(Number(s.status) < 0) && s.sumBet != null ? { von: tagText(jetzt - 30 * 864e5), bis: tagText(jetzt), einzahlung: Number(s.sumDeposit) || 0, auszahlung: Number(s.sumWithdraw) || 0, einsatz: Number(s.sumBet) || 0, gewinn: Number(s.sumWin) || 0 } : null;
  return { wetten, buchungen: [], summen, voll: voll || ende, merker: {} };
}
