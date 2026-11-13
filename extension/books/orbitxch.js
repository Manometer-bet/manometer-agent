// books/orbitxch.js — Orbit Exchange (orbitxch.com, Betfair-Boerse) fuer External Bettors: nur BACK. 31.10.2026.
//
//
// Portiert aus handleOrbitPlace (background.js). Der Operator setzt ueber edge-push und seinen GR-Chrome; der Kontoinhaber hat nur seinen eigenen
// Orbit-Tab. Darum laeuft hier alles aus diesem Tab, im Seitenkontext (content/orbitxch-place.js, world MAIN): dort ist die Sitzung angemeldet.
// Der Tab liest Anmeldung, Markt und Preis selbst und unmittelbar vor dem Senden; der Edge-Dienst wird nicht gebraucht.
// Nur Fussball, Sieger ganzes Spiel (1X2), vor dem Anpfiff und live. Kein Lay, keine Arb-Beine, keine Maker-Orders, keine Kombis.
// — Basketball Drops auch bei Orbit): dazu Basketball (sport basket), Sieger ueber das
// ganze Spiel = Orbits „Match Odds“ mit genau zwei Laeufern Heim / Gast (inklusive Verlaengerung, wie die Pinnacle-Moneyline), nur home / away,
// nur vor dem Anpfiff. Das Seiten-Script (orbit-back-2) prueft Sportart und Laeufer des Markts selbst; eine aeltere Fassung im Tab wird ersetzt.
//
// AUSWAHL: bookRef.outcomeId = "<Markt>:<Auswahl>", z. B. "1.263704802:2426" (Orbits Nummern, Buch-Sicht, aus dem Edge-Dienst des Operators);
// bookRef.eventId = Orbits Spiel-Nummer. p.sel (home/draw/away) ist Buch-Sicht wie bei Interwetten (bettorBuchSel): der Tab prueft, dass die
// Nummer bei Orbit auf genau dieser Seite sitzt, sonst wird nicht gesetzt (Falle bettor-heim-gast-luecke). Die Engine sucht nie selbst.
// MINDESTQUOTE: p.minOdds ist EFFEKTIV nach 3 % Provision wie im Board; Limit der Order = effektiv → roh → aufwaerts auf Orbits Leiter.
// ABLAUF: EIN BACK-Limit zur Mindestquote, warten (vor dem Anpfiff 4 s; live betDelay + 2,5 s, hoechstens 15 s), Stand lesen, Rest stornieren.
// ERGEBNIS: stake = gematchter Betrag, odds = effektiver Schnitt. Nichts gematcht = failed (keine Wette). Antwort, Stand oder Storno unklar = uncertain.
// NACHLESEN (04.11.2026): Storno nicht bestaetigt = bis 20 s weiter lesen; bleibt es unsicher, liest der Status-Takt bis 3 h nach und berichtigt die Quittung.
// AUFTRAGS-NUMMER: fest je Vorschlag (aus proposalId) und VOR dem Senden auf Platte. Die Engine gibt die Sperre nach failed frei und ruft nach
// 45 s erneut: ein Vorschlag, der einmal gesendet wurde, sendet nie wieder und bekommt das erste Ergebnis zurueck. blocked verbraucht die Nummer nicht.
"use strict";

const ORIGIN = "https://orbitxch.com", ORIGIN_WWW = "https://www.orbitxch.com";
const TAB_MUSTER = [ORIGIN + "/*", ORIGIN_WWW + "/*"];
const SCRIPT = "content/orbitxch-place.js", KERN = "orbit-back-2";    // KERN wie im Script (1.2.88: -2 = Fussball und Basketball)
const PROVISION = 0.03;                                                // Orbit: 3 % auf den Netto-Gewinn (wie ORBIT_PROVISION im Operator)
const MIN_EINSATZ = 7, MAX_EINSATZ = 200;                              // Orbit minBetSize 7 €; 200 € = Grenze des Auftragswegs beim Operator
const BACK_FRIST_MS = 4000, LIVE_PUFFER_MS = 2500, LIVE_WARTEN_MAX_MS = 15000;   // so lange darf die Order matchen (ORBIT_BACK_FRIST_MS usw.)
const PING_MS = 5000, OFFEN_MS = 12000, STORNO_MS = 30000, SETZEN_MS = 40000, PROBE_ALLE_MS = 60000, STAND_GILT_MS = 180000;
// 04.11.2026: Nachlesen. Storno nicht bestaetigt: noch hoechstens 20 s alle 2 s lesen; danach liest der Status-Takt (nachlesen unten) bis 3 h nach dem Senden.
const NACHLESEN_MS = 20000, NACHLESEN_TAKT_MS = 2000, SPAETER_BIS_MS = 3 * 3600e3, KORREKTUR_GILT_MS = 24 * 3600e3;
const MERKER = "orbitAuftraege", MERKER_MAX = 300, MERKER_TAGE_MS = 7 * 24 * 3600e3;

export const id = "orbitxch";
export const sports = { fb: true, basket: true };   // 1.2.88: Basketball dazu (nur vor dem Anpfiff, siehe vorschlagLesen)
export const hosts = { orbit: { origin: ORIGIN, www: ORIGIN_WWW } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
const effektiv = (roh, nk) => (roh > 1 ? Math.round((1 + (roh - 1) * (1 - PROVISION)) * (nk || 1000)) / (nk || 1000) : null);
function tabsQuery(q) { return new Promise((rs) => { try { chrome.tabs.query(q, (t) => rs(t || [])); } catch (_) { rs([]); } }); }
function tabCreate(props) { return new Promise((rs) => { try { chrome.tabs.create(props, (t) => rs(t)); } catch (_) { rs(null); } }); }
function tabGet(tabId) { return new Promise((rs) => { try { chrome.tabs.get(tabId, (x) => rs(chrome.runtime.lastError ? null : x)); } catch (_) { rs(null); } }); }
async function waitComplete(tabId, ms) {
  const t0 = Date.now();
  for (;;) {
    const t = await tabGet(tabId);
    if (!t) return false;
    if (t.status === "complete") return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(300);
  }
}
// Auftrag im Seitenkontext des Tabs. Keine Nachricht, kein Inhaltsskript: executeScript gibt das Ergebnis (auch eines Promise) direkt zurueck.
// Ohne Antwort innerhalb der Frist: { error } — was das heisst, entscheidet der Aufrufer (vor dem Senden blocked, danach uncertain).
async function imTab(tabId, auftrag, fristMs) {
  let t = null;
  const frist = new Promise((rs) => { t = setTimeout(() => rs({ error: "no answer from the tab within " + Math.round(fristMs / 1000) + " s" }), fristMs); });
  const lauf = (async () => {
    const res = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: (a) => (window.__engineOrbit ? window.__engineOrbit.auftrag(a) : { gesendet: false, fehltKern: true }), args: [auftrag] });
    return (res && res[0] && res[0].result) || { error: "empty answer from the tab" };
  })().catch((e) => ({ error: String((e && e.message) || e).slice(0, 120) }));
  try { return await Promise.race([lauf, frist]); } finally { clearTimeout(t); }
}
// Script im Tab und passende Fassung? Eine andere Fassung wird durch das Einspritzen ersetzt. Rueckgabe null oder der Grund.
async function kernBereit(tabId) {
  let p = await imTab(tabId, { art: "ping" }, PING_MS);
  if (p && p.ok && p.kern === KERN) return null;
  try { await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: [SCRIPT] }); }
  catch (e) { return "script injection failed: " + String((e && e.message) || e).slice(0, 80); }
  p = await imTab(tabId, { art: "ping" }, PING_MS);
  return p && p.ok && p.kern === KERN ? null : "page script did not answer" + (p && p.error ? " (" + p.error + ")" : "");
}
async function offeneTabs() {
  const tabs = (await tabsQuery({ url: TAB_MUSTER })).filter((t) => t && t.id != null && !t.discarded);
  return tabs.sort((a, b) => (String(b.url || "").indexOf(ORIGIN + "/") === 0 ? 1 : 0) - (String(a.url || "").indexOf(ORIGIN + "/") === 0 ? 1 : 0));   // orbitxch.com vor www (HAR, Sitzung)
}
// Jeder offene Orbit-Tab genuegt (die Abrufe brauchen kein Spiel auf dem Schirm); ist keiner offen, wird einer im Hintergrund geoeffnet.
async function seitenTab(ctx) {
  let tab = (await offeneTabs())[0] || null, neu = false;
  if (!tab) {
    tab = await tabCreate({ url: ORIGIN + "/customer/sport/1", active: false });
    if (!tab || tab.id == null) return { error: "could not open a tab for " + ORIGIN };
    neu = true; ctx.log("orbitxch: kein Orbit-Tab offen — im Hintergrund geoeffnet");
  }
  if (neu || tab.status !== "complete") { await waitComplete(tab.id, 25000); if (neu) await sleep(1500); }
  const grund = await kernBereit(tab.id);
  return grund ? { error: grund } : { tabId: tab.id };
}

// ---- Stand fuer die Anzeige und den Heartbeat ------------------------------------------------------------------------------------------------
let _auth = { ready: false, ts: 0, why: "" };
function standMerken(ready, why) { _auth = { ready, ts: Date.now(), why }; }
async function probeAuth() {
  const tab = (await offeneTabs())[0];
  if (!tab) { standMerken(false, "Orbit tab not open — open orbitxch.com and sign in"); return _auth; }
  const grund = await kernBereit(tab.id);
  if (grund) { standMerken(false, "Orbit: " + grund); return _auth; }
  const a = await imTab(tab.id, { art: "anmeldung" }, OFFEN_MS);
  if (!a || !a.ok) standMerken(false, "Orbit: sign-in state not readable" + (a && (a.grund || a.error) ? " (" + (a.grund || a.error) + ")" : ""));
  else if (a.http === 403) standMerken(false, "Orbit refuses this network exit (HTTP 403)");
  else standMerken(a.angemeldet === true, a.angemeldet === true ? "signed in" : "signed out — sign in at orbitxch.com");
  return _auth;
}
export function arm() { /* nichts vorzuwaermen — die Sitzung lebt in der Seite */ }
export function status() {
  if (!_auth.ts || Date.now() - _auth.ts > STAND_GILT_MS) return { ready: false, detail: "sign-in not checked yet (keep orbitxch.com open and signed in)" };
  return { ready: !!_auth.ready, detail: _auth.why || (_auth.ready ? "signed in" : "not signed in") };
}
// Der Heartbeat ruft balance() fuer aktive Buecher: hier nur als Anmelde-Probe (wie Superbet). Den Kontostand fuehrt Orbit nur im General-Socket → null.
export async function balance() {
  if (Date.now() - _auth.ts >= PROBE_ALLE_MS) await probeAuth();
  return null;
}

// ---- Auftrags-Nummer, auf Platte ---------------------------------------------------------------------------------------------------------------
function auftragNr(p) {
  const s = String(p && p.proposalId != null ? p.proposalId : "").replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 130);
  return s.length >= 4 ? "o-" + s : null;
}
let _kette = Promise.resolve();
function merkerAendern(ctx, f) {
  const lauf = _kette.then(async () => {
    const m = Object.assign({}, (await ctx.storageGet(MERKER)) || {});
    f(m);
    const jetzt = Date.now(), alle = Object.keys(m).sort((a, b) => (Number(m[a] && m[a].ts) || 0) - (Number(m[b] && m[b].ts) || 0));
    for (let i = 0; i < alle.length; i++) if (alle.length - i > MERKER_MAX || jetzt - (Number(m[alle[i]] && m[alle[i]].ts) || 0) > MERKER_TAGE_MS) delete m[alle[i]];
    await ctx.storageSet(MERKER, m);
  });
  _kette = lauf.catch(() => {});
  return lauf;
}
// Steht die Nummer wirklich auf Platte? store.set der Engine schluckt Fehler, also wird zurueckgelesen. Ohne Beleg wird nicht gesendet.
async function merkeSenden(ctx, nr) {
  try {
    await merkerAendern(ctx, (m) => { m[nr] = { stand: "senden", ts: Date.now() }; });
    const v = await ctx.storageGet(MERKER);
    return !!(v && v[nr] && v[nr].stand === "senden");
  } catch (_) { return false; }
}
async function merkeFertig(ctx, nr, res) { try { await merkerAendern(ctx, (m) => { m[nr] = { stand: "fertig", ts: Date.now(), res }; }); } catch (_) { ctx.log("orbitxch: Ergebnis zur Auftrags-Nummer nicht gespeichert"); } }
async function vergiss(ctx, nr) { try { await merkerAendern(ctx, (m) => { delete m[nr]; }); } catch (_) {} }

// ---- Vorschlag pruefen (vor jedem Tab-Zugriff) ---------------------------------------------------------------------------------------------------
const AUSWAHL_FORM = /^(1\.\d{5,12}):(\d{1,12})$/;
function vorschlagLesen(p, stakeEur) {
  const nein = (fehler) => ({ fehler });
  const feed = (p.sport == null || p.sport === "") ? "fb" : String(p.sport);
  if (!sports[feed]) return nein("Orbit: sport " + feed + " is not connected (football and basketball only)");
  const live = p.live === true || !!(p.eventIdentity && p.eventIdentity.live === true);
  if (feed === "basket" && live) return nein("Orbit: basketball is connected before tip-off only");
  if ((p.mkt || "ml") !== "ml") return nein("Orbit: market " + String(p.mkt) + " is not connected (match winner only)");
  if ((p.scope || "match") !== "match") return nein("Orbit: scope " + String(p.scope) + " is not connected (whole match only)");
  if (p.line != null || p.legs != null) return nein("Orbit: lines and parlays are not connected");
  if (p.side != null && String(p.side).toUpperCase() !== "BACK") return nein("Orbit: only BACK is connected");
  if (!(p.sel === "home" || p.sel === "draw" || p.sel === "away")) return nein("Orbit: selection side " + String(p.sel).slice(0, 8) + " unknown");
  if (feed === "basket" && p.sel === "draw") return nein("Orbit: basketball has no draw (home or away only)");
  const eventId = String((p.bookRef && p.bookRef.eventId) == null ? "" : p.bookRef.eventId);
  if (!/^\d{5,15}$/.test(eventId)) return nein("Orbit: bookRef.eventId missing");
  const m = AUSWAHL_FORM.exec(String((p.bookRef && p.bookRef.outcomeId) == null ? "" : p.bookRef.outcomeId));
  if (!m) return nein("Orbit: bookRef.outcomeId missing or not <market>:<selection> (without the exact selection of the operator nothing is placed)");
  if (!(Number(p.minOdds) > 1)) return nein("Orbit: minimum odds missing");
  const einsatz = r2(stakeEur);
  if (!(einsatz >= MIN_EINSATZ)) return nein("Orbit: stake " + einsatz + " € below the Orbit minimum " + MIN_EINSATZ + " €");
  if (einsatz > MAX_EINSATZ) return nein("Orbit: stake " + einsatz + " € above " + MAX_EINSATZ + " €");
  return { eventId, marketId: m[1], selectionId: m[2], sel: p.sel, sport: feed, einsatz, minOdds: Number(p.minOdds), live };
}

async function setzenEinmal(p, stakeEur, ctx, nr) {
  const nein = (reason, extra) => Object.assign({ status: "blocked", reason: /nothing sent/.test(reason) ? reason : reason + " — nothing sent" }, extra || {});
  if (!ctx || typeof ctx.storageGet !== "function" || typeof ctx.storageSet !== "function") return nein("Orbit: no storage for the order number");
  let alt; try { alt = await ctx.storageGet(MERKER); } catch (_) { return nein("Orbit: order numbers not readable"); }
  const frueher = alt && alt[nr];
  if (frueher) {
    ctx.log("orbitxch: Auftrags-Nummer " + nr + " schon gesendet — nichts Neues gesendet");
    return frueher.res || { status: "uncertain", reason: "Orbit: this order was already sent and its result is unknown — check Orbit, nothing sent again" };
  }
  const v = vorschlagLesen(p, stakeEur);
  if (v.fehler) return nein(v.fehler);
  const offenTab = await seitenTab(ctx);
  if (offenTab.error) { standMerken(false, "Orbit: " + offenTab.error); return nein("Orbit: " + offenTab.error); }
  const tabId = offenTab.tabId;
  ctx.log(`orbitxch: Auswahl ${v.selectionId} · Markt ${v.marketId} · Spiel ${v.eventId} (${v.sel}, Buch-Sicht) · ${v.live ? "live" : "vor dem Anpfiff"} · BACK ${v.einsatz} € @ ≥${v.minOdds} effektiv`);
  if (!(await merkeSenden(ctx, nr))) return nein("Orbit: order number could not be saved");

  // AB HIER kann die Order bei Orbit sein: nur eine Antwort des Tabs mit gesendet:false ist noch ein sicheres „nicht gesendet“.
  const fertig = async (res) => { await merkeFertig(ctx, nr, res); return res; };
  // Merker fuer das spaetere Nachlesen einer unsicheren Order mit Ticket: nur Nummern und Betraege, nichts vom Konto.
  const spaeter = (ticket, grenze) => ({ pid: String(p.proposalId), marketId: v.marketId, selectionId: v.selectionId, ticket: String(ticket), wunsch: v.einsatz, grenze: Number(grenze) || null, bis: Date.now() + SPAETER_BIS_MS });
  const t0 = Date.now();
  const a = await imTab(tabId, { art: "setzen", auftragId: nr, armed: true, sport: v.sport, eventId: v.eventId, marketId: v.marketId, selectionId: v.selectionId, sel: v.sel, live: v.live, amount: v.einsatz, minOdds: v.minOdds }, SETZEN_MS);
  if (a && a.gesendet === false && !a.error) {
    await vergiss(ctx, nr);
    const reason = a.fehltKern ? "Orbit: the page was reloaded before the order — nothing sent" : String(a.reason || "Orbit: not sent — nothing sent");
    if (/not signed in/.test(reason)) standMerken(false, "signed out — sign in at orbitxch.com");
    else if (/HTTP 403/.test(reason)) standMerken(false, "Orbit refuses this network exit (HTTP 403)");
    ctx.log("orbitxch: nicht gesendet · " + reason.slice(0, 200));
    return nein(reason, { odds: a.odds, cur: a.cur });
  }
  if (!a || a.error || a.gesendet !== true) return await fertig({ status: "uncertain", reason: "Orbit: no answer from the page while sending (" + String((a && a.error) || "empty") + ") — check Orbit" });
  const roh = Number(a.roh), grenze = Number(a.grenze), oddsMarkt = effektiv(roh);
  if (a.unklar) return await fertig({ status: "uncertain", reason: "Orbit: order UNCLEAR (" + String(a.grund || "?").slice(0, 100) + ") — check Orbit", odds: oddsMarkt });
  if (a.abgelehnt) {
    if (/not signed in/.test(String(a.grund))) standMerken(false, "signed out — sign in at orbitxch.com");
    return await fertig({ status: "failed", reason: "Orbit refused the order: " + String(a.grund || "?").slice(0, 140) });
  }
  if (a.ok !== true || !a.offerId) return await fertig({ status: "uncertain", reason: "Orbit: order accepted without an order number — check Orbit", odds: oddsMarkt });
  const ticket = String(a.offerId);
  standMerken(true, "signed in");
  try {
    // Live: Orbit nimmt die Order erst nach der Annahme-Verzoegerung an (betDelay s) — vorher steht sie nicht im Buch
    const verz = Math.max(0, Number(a.betDelay) || 0) * 1000, warten = Math.min(LIVE_WARTEN_MAX_MS, Math.max(BACK_FRIST_MS, verz > 0 ? verz + LIVE_PUFFER_MS : 0));
    ctx.log(`orbitxch: Order ${ticket} gesendet · Limit ${grenze} · Markt ${roh} · Annahme-Verzoegerung ${verz / 1000} s · lese nach ${warten / 1000} s`);
    await sleep(warten);
    const lies = async () => {
      const o = await imTab(tabId, { art: "offen", marketId: v.marketId, offerId: ticket }, OFFEN_MS);
      if (!o || !o.ok || !Array.isArray(o.wetten)) return { lesbar: false, grund: (o && (o.grund || o.error)) || "empty" };
      const z = o.wetten.filter((x) => x && String(x.offerId) === ticket);
      return { lesbar: true, anzahl: z.length, wette: z.length === 1 ? z[0] : null };
    };
    let l = await lies();
    for (let i = 0; !l.wette && i < 2; i++) { await sleep(2000); l = await lies(); }
    let wt = l.wette, nachgelesen = false;
    if (!wt) return await fertig({ status: "uncertain", reason: "Orbit: state of order " + ticket + " not readable (" + String(l.lesbar ? (l.anzahl ? "several rows" : "not among the current bets") : l.grund).slice(0, 80) + ") — check Orbit (a rest may still be open)", ticket, odds: oddsMarkt, nachlesen: spaeter(ticket, grenze) });
    if (String(wt.side) !== "BACK" || String(wt.selectionId) !== v.selectionId) return await fertig({ status: "uncertain", reason: "Orbit: order " + ticket + " does not match the order sent — check Orbit", ticket, odds: oddsMarkt });
    if (Number(wt.sizeRemaining) > 0) {
      const s = await imTab(tabId, { art: "storno", marketId: v.marketId, offerId: ticket }, STORNO_MS);
      let bestaetigt = !!(s && s.ok === true), stand = (s && s.danach) || (s && s.davor) || wt;
      // Storno angenommen, Rest aber noch im Buch: nur noch einmal LESEN, kein zweiter Storno. In orbit-auftraege.ndjson zeigte das Lesen nach 1,2 s
      // bei 30 von 170 BACK-Stornos noch PLACED; zwei spaetere Lesungen (58 s) zeigten CANCELLED.
      if (!bestaetigt && s && s.angenommen === true) {
        for (let i = 0; !bestaetigt && i < 3; i++) {
          await sleep(2000);
          const n = await lies();
          if (n.wette) { stand = n.wette; bestaetigt = !(Number(n.wette.sizeRemaining) > 0); }
          else if (n.lesbar && !n.anzahl && !(Number(stand.sizeMatched) > 0)) { stand = Object.assign({}, stand, { sizeRemaining: 0, offerState: "GONE" }); bestaetigt = true; }
        }
      }
      // Pohang–Gamba, Unentschieden live: Orbit lehnte den Storno ab (HTTP 400), gemeldet
      // wurden 0,27 statt 10 €, der Rest wurde danach doch angenommen. Darum weiter LESEN, kein zweiter Storno, bis kein Rest mehr im Buch steht
      // (angenommen, gestrichen oder verfallen). Fehlt die Zeile, wird nichts geraten. Bleibt der Rest, liest der Status-Takt spaeter nach.
      if (!bestaetigt) {
        ctx.log(`orbitxch: Storno nicht bestaetigt · Order ${ticket} · lese bis ${NACHLESEN_MS / 1000} s nach`);
        for (let i = 0; i < NACHLESEN_MS / NACHLESEN_TAKT_MS && Number(stand.sizeRemaining) > 0; i++) {
          await sleep(NACHLESEN_TAKT_MS);
          const n = await lies();
          if (n.wette) stand = n.wette;
          else if (n.lesbar && !n.anzahl) break;
        }
        bestaetigt = !(Number(stand.sizeRemaining) > 0) && String(stand.offerId) === ticket && String(stand.side) === "BACK" && String(stand.selectionId) === v.selectionId;
        nachgelesen = bestaetigt;
      }
      if (!bestaetigt) {
        const m = r2(stand.sizeMatched);
        return await fertig({ status: "uncertain", reason: "Orbit: cancelling the unmatched rest NOT confirmed (" + String((s && (s.grund || s.error)) || "?").slice(0, 80) + ") — check Orbit, a resting order may still match", ticket,
          odds: m > 0 && Number(stand.averagePrice) > 1 ? effektiv(Number(stand.averagePrice), 10000) : oddsMarkt, stake: m > 0 ? m : undefined, cur: fremdWaehrung(stand), note: m > 0 ? "Orbit matched " + m + " of " + v.einsatz + " € so far" : undefined,
          nachlesen: spaeter(ticket, grenze) });
      }
      if (stand && String(stand.offerId) === ticket) wt = stand;
    }
    const gematcht = r2(wt.sizeMatched), schnitt = Number(wt.averagePrice) > 1 ? Number(wt.averagePrice) : grenze;
    if (!(gematcht > 0)) {
      ctx.log(`orbitxch: nichts gematcht · Order ${ticket} · Limit ${grenze} · nach ${Date.now() - t0} ms`);
      return await fertig({ status: "failed", reason: "Orbit: nothing matched at ≥ " + grenze + " within " + Math.round(warten / 1000) + " s — order cancelled, no bet", ticket });
    }
    if (schnitt < grenze - 1e-6) return await fertig({ status: "uncertain", reason: "Orbit: order " + ticket + " shows an average " + schnitt + " below its limit " + grenze + " — check Orbit", ticket, stake: gematcht, odds: effektiv(schnitt, 10000), cur: fremdWaehrung(wt) });
    ctx.log(`orbitxch: gesetzt · Order ${ticket} · ${gematcht} von ${v.einsatz} € · Schnitt ${schnitt} roh · nach ${Date.now() - t0} ms${nachgelesen ? " · nachgelesen" : ""}`);
    const teil = gematcht < v.einsatz - 0.01;
    return await fertig({ status: "placed", stake: gematcht, odds: effektiv(schnitt, 10000), ticket, verified: true, rawOdds: schnitt, cur: fremdWaehrung(wt),
      note: nachgelesen ? (teil ? "Orbit matched " + gematcht + " of " + v.einsatz + " € @ " + schnitt + " (cancel not confirmed, no rest left when read again)" : "Orbit: cancel not confirmed, the rest matched afterwards (read again)")
        : (teil ? "Orbit matched " + gematcht + " of " + v.einsatz + " € @ " + schnitt + " (rest cancelled)" : undefined) });
  } catch (e) {
    return await fertig({ status: "uncertain", reason: "Orbit: " + String((e && e.message) || e).slice(0, 100) + " — check Orbit (order " + ticket + ")", ticket, odds: oddsMarkt, nachlesen: spaeter(ticket, grenze) });
  }
}

// ---- Spaeter nachlesen (04.11.2026) ------------------------------------------------------------------------------------------------------------
// Die Engine ruft das im Status-Takt hoechstens einmal je Minute (engine-sw.js nachlesenAlle). Unsichere Orders mit Merker werden bis 3 h nach dem
// Senden in der Liste der laufenden Wetten gesucht. Endgueltig ist nur eine Zeile ohne Rest, BACK, dieselbe Auswahl: gematcht > 0 = placed mit dem
// echten Betrag, sonst failed. Fehlt die Zeile, bleibt es unsicher (abgerechnet oder gestrichen ist von hier nicht zu unterscheiden), ebenso ein
// Schnitt unter dem Limit. Benutzt nur einen schon offenen Orbit-Tab. Rueckgabe [{ proposalId, res }]: alle Klaerungen der letzten 24 h, nicht nur
// die neuen — die Engine berichtigt nur Quittungen, die noch uncertain sind; ging ein Schreiben verloren, klappt es beim naechsten Takt.
export async function nachlesen(ctx) {
  if (!ctx || typeof ctx.storageGet !== "function") return [];
  let m; try { m = (await ctx.storageGet(MERKER)) || {}; } catch (_) { return []; }
  const jetzt = Date.now(), aus = [], offen = [];
  for (const nr of Object.keys(m)) {
    const e = m[nr], res = e && e.res;
    if (!e || e.stand !== "fertig" || !res) continue;
    if (res.nachgelesen === true && res.pid && jetzt - (Number(e.ts) || 0) < KORREKTUR_GILT_MS) aus.push({ proposalId: res.pid, res });
    else if (res.status === "uncertain" && res.nachlesen && res.nachlesen.ticket && jetzt < Number(res.nachlesen.bis)) offen.push(nr);
  }
  if (!offen.length) return aus;
  const tab = (await offeneTabs())[0];
  if (!tab || (await kernBereit(tab.id))) return aus;
  for (const nr of offen) {
    const n = m[nr].res.nachlesen, ticket = String(n.ticket);
    const o = await imTab(tab.id, { art: "offen", marketId: n.marketId, offerId: ticket }, OFFEN_MS);
    if (!o || !o.ok || !Array.isArray(o.wetten)) continue;
    const z = o.wetten.filter((x) => x && String(x.offerId) === ticket);
    if (z.length !== 1) continue;
    const w = z[0];
    if (String(w.side) !== "BACK" || String(w.selectionId) !== String(n.selectionId) || Number(w.sizeRemaining) > 0) continue;
    const gematcht = r2(w.sizeMatched), schnitt = Number(w.averagePrice) > 1 ? Number(w.averagePrice) : Number(n.grenze);
    if (gematcht > 0 && !(schnitt >= Number(n.grenze) - 1e-6)) continue;
    const res = gematcht > 0
      ? { status: "placed", stake: gematcht, odds: effektiv(schnitt, 10000), ticket, verified: true, rawOdds: schnitt, cur: fremdWaehrung(w), note: "read again later: Orbit matched " + gematcht + " of " + n.wunsch + " € @ " + schnitt, nachgelesen: true, pid: n.pid }
      : { status: "failed", reason: "Orbit: read again later — nothing matched and the order is no longer open, no bet", ticket, nachgelesen: true, pid: n.pid };
    await merkeFertig(ctx, nr, res);
    ctx.log(`orbitxch: nachgelesen · Order ${ticket} · ${gematcht > 0 ? gematcht + " von " + n.wunsch + " € gematcht" : "nichts gematcht"}`);
    aus.push({ proposalId: n.pid, res });
  }
  return aus;
}
// res.cur nur, wenn die Wette NICHT in Euro lief (engine-core echterEinsatz): vor dem Senden geprueft, die Zeile der Wette hat das letzte Wort.
function fremdWaehrung(w) { const c = w && typeof w.currency === "string" ? w.currency.toUpperCase() : ""; return c && c !== "EUR" ? c : undefined; }

const _laufend = new Map();    // Auftrags-Nr. → laufendes Ergebnis (derselbe Vorschlag zweimal zugleich: ein Lauf, ein Ergebnis)
export function place(p, stakeEur, ctx) {
  const nr = auftragNr(p);
  if (!nr) return Promise.resolve({ status: "blocked", reason: "Orbit: proposalId missing — nothing sent" });
  if (_laufend.has(nr)) return _laufend.get(nr);
  const lauf = setzenEinmal(p, stakeEur, ctx, nr).finally(() => { _laufend.delete(nr); });
  _laufend.set(nr, lauf);
  return lauf;
}
