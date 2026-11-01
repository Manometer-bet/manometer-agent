// books/betonline.js — BetOnline (betonline.ag) fuer External Bettors. 31.10.2026.
//
//
// Uebernommen vom Setzweg des Operators (background.js handleBoPlace, betonline-content.js boPlace; dort laut Protokollen 07.08.–28.10.
// 50 echte Tickets). Tab-based wie pamestoixima.js: gelesen, geprueft und gesetzt wird AUS DER SEITE www.betonline.ag
// (content/betonline-place.js) — die Anmeldung haengt am Cookie der Seite (/get-token), api-betslip und api-offering erlauben per
// CORS nur diese Herkunft. Dieser Adapter ruft das Buch nie selbst ab.
//
// UMFANG = was der Operator setzt, nicht mehr: Einzelwette, Fussball, Sieger-Markt (Moneyline 1X2, Spiel ganz), nur vor dem Anpfiff
// (handleBoCheck findet nur Ligen unter sportsbook/soccer, boOfferGames nur das Vorspiel; wie eine Live-Wette bei BetOnline aussieht, ist
// nicht mitgeschnitten). Keine Kombi: ihre Form ist nie belegt (betonline-kombi-erkundung), deshalb kein export kombi.
//
// WAS DER VORSCHLAG TRAGEN MUSS (die Engine sucht nie selbst, fehlt etwas: blocked):
//   bookRef.eventId    = GameId des Buchs (feid der Board-Zeile)
//   bookRef.outcomeId  = Rotation der gewaehlten Seite in BUCH-Sicht (HomeRotation / AwayRotation / DrawRotaion)
//   bookRef.url        = https://www.betonline.ag/sportsbook/soccer/<league>[/<scheduleText>] — Adresse aus dem Menue des Buchs. Das Angebot
//                        wird je Liga abgerufen, die GameId allein reicht dafuer nicht (auch die Seite fragt get-event nur mit sport + league).
//   sel                = Seite in BUCH-Sicht (bettorBuchSel; betonline steht NICHT in BETTOR_SEL_OPERATOR_SICHT).
// RICHTUNG: hier wird nichts gedreht und nichts uebersetzt. Das Setz-Script prueft, dass die Rotation in DIESEM Spiel genau die Seite
// sel ist, und dass das Buch beim add-line genau diese Mannschaft nennt. Widerspruch = falsche Seite = blocked (bettor-heim-gast-luecke).
//
// EINSATZ: Das Buch rechnet in Dollar, der Operator traegt die Euro-ZAHL unveraendert als toRisk ein (keine Umrechnung, background.js
// handleBoPlace). Hier genauso, mit einer Abweichung: nach unten auf ganze Zahlen statt Math.round + Math.max(1, …) — ein Einsatz darf nie
// ueber dem liegen, was die Engine genehmigt hat (cfg.maxStakeEur, eigene Grenze des Kontoinhabers). Unter 1: nicht setzen. res.cur = "USD":
// echterEinsatz (engine-core.js) nimmt res.stake dann nicht als Euro.
//
// AUFTRAGS-NUMMER: fest je Vorschlag (nicht je Versuch). Hat der Tab einmal gesendet, fuehrt er dieselbe Nummer nie wieder aus, jede
// Wiederholung bekommt dasselbe Ergebnis. Nur was nachweislich nichts gesendet hat, darf die Engine spaeter neu versuchen.
// Wahrheitstabelle: vor der Uebergabe nur blocked; ist die Uebergabe raus und die Antwort unklar: uncertain, nie blocked.
// Die Anmeldung kommt nie hierher: sie bleibt im Tab, steht in keiner Antwort und keinem Protokoll.
"use strict";

const BUCH = "betonline";
const SEITE = "https://www.betonline.ag";
const TAB_MUSTER = SEITE + "/*";
const START = SEITE + "/sportsbook";                           // wie searchPage des Operators
const INHALT = "content/betonline-place.js";
const MIN_EINSATZ = 1, MAX_EINSATZ = 1000;                     // Sicherheitsgrenzen, nicht die Limits des Buchs; toRisk ist ganzzahlig (Mitschnitt, Operator)
const STAND_MS = 180000;                                       // so lange gilt ein gelesener Login-Stand (balance frischt ihn im Heartbeat)
const KONTO_FRIST_MS = 6000;                                   // laenger wartet der Heartbeat nicht auf den Tab
const SEITEN = { home: 1, draw: 1, away: 1 };

export const id = BUCH;
export const sports = { fb: true };                            // engine-sw.js prueft das vor place; Fussball wie background.js boMenu
export const hosts = { site: SEITE, offering: "https://api-offering.betonline.ag", betslip: "https://api-betslip.betonline.ag" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tabsQuery(q) { return new Promise((rs) => { try { chrome.tabs.query(q, (t) => rs(t || [])); } catch (_) { rs([]); } }); }
function tabCreate(props) { return new Promise((rs) => { try { chrome.tabs.create(props, (t) => rs(t)); } catch (_) { rs(null); } }); }
function sendTab(tabId, msg) {
  return new Promise((rs) => {
    try { chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, (r) => { const e = chrome.runtime.lastError; rs(e ? { error: e.message } : (r || { error: "no response" })); }); }
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
  try { await chrome.scripting.executeScript({ target: { tabId }, files: [INHALT] }); return null; }
  catch (e) { return String((e && e.message) || e); }
}

// Stand der letzten Begegnung mit der Seite (angemeldet?) — fuer die Anzeige und den Heartbeat. Nie „bereit“ ohne Beleg: bis zur ersten
// Probe sagt status() die Wahrheit, und die Sidebar leitet nichts an einen Bettor um, der nicht bereit ist.
let _stand = { ready: false, ts: 0, detail: "" };
function standSetzen(ready, detail) { _stand = { ready: !!ready, ts: Date.now(), detail: String(detail || "") }; }
function standAus(grund) {
  if (grund && /not logged in/i.test(grund)) standSetzen(false, "betonline: signed out — sign in at " + SEITE);
  else if (grund && /Cloudflare/i.test(grund)) standSetzen(false, "betonline: open the tab and confirm the Cloudflare check once");
}
export function arm() { /* nichts vorzuwaermen — die Sitzung lebt in der Seite */ }
export function status() {
  if (!_stand.ts || Date.now() - _stand.ts > STAND_MS) return { ready: false, detail: "betonline: login not checked yet — keep " + SEITE + " open and signed in" };
  return { ready: _stand.ready, detail: _stand.detail };
}

// balance() laeuft im Heartbeat fuer aktive Buecher und ist zugleich die Login-Probe (wie superbet.js). Oeffnet nie einen Tab; ohne Tab,
// Anmeldung oder Antwort: null (Heartbeat laeuft weiter). Nur Anzeige: der Kontostand ist nie ein Riegel und bestimmt keinen Einsatz.
// cur "USD" ist eine Annahme, keine Angabe des Buchs: die Konto-Antwort nennt keine Waehrung (die Seite schreibt selbst fest "USD").
export async function balance() {
  const tab = (await tabsQuery({ url: TAB_MUSTER })).find((t) => t && !t.discarded) || null;
  if (!tab) { standSetzen(false, "betonline: no " + SEITE + " tab open — open it and sign in"); return null; }
  const ierr = await inject(tab.id);
  if (ierr) { standSetzen(false, "betonline: script injection failed"); return null; }
  const r = await new Promise((fertig) => {
    const frist = setTimeout(() => fertig({ error: "tab did not answer in time" }), KONTO_FRIST_MS);
    sendTab(tab.id, { cmd: "boAuth" }).then((v) => { clearTimeout(frist); fertig(v); });
  });
  if (!r || r.ok !== true || r.loggedIn !== true) { standSetzen(false, /not logged in/i.test(String(r && r.fehler)) ? "betonline: signed out — sign in at " + SEITE : "betonline: login check failed"); return null; }
  const zahl = (x) => (typeof x === "number" && isFinite(x) ? x : null), saldo = zahl(r.saldo);
  standSetzen(true, "signed in" + (saldo != null ? " · " + saldo.toFixed(2) + " USD (assumed)" : ""));
  if (saldo == null) return null;
  return { saldo, bonus: zahl(r.bonus) || 0, hold: zahl(r.hold) || 0, cur: "USD", ts: Date.now() };
}

// PURE: bookRef.url → { sport, league, scheduleText|null } | null. Nur die Form der Menue-Adressen des Buchs, nur Fussball
// (background.js boMenu: parts[1] === "soccer"). Die Teile gehen als Felder in den Abruf des Angebots, nie in eine Adresse.
export function slugAus(url) {
  const m = /^https:\/\/www\.betonline\.ag\/sportsbook\/([^/?#]+)\/([^/?#]+)(?:\/([^/?#]+))?\/?$/.exec(String(url == null ? "" : url));
  if (!m) return null;
  const teil = /^[a-z0-9][a-z0-9'._-]{0,100}$/i;
  if (m[1] !== "soccer" || !teil.test(m[2]) || (m[3] != null && !teil.test(m[3]))) return null;
  return { sport: m[1], league: m[2], scheduleText: m[3] || null };
}
// Nummer je Vorschlag (fest, siehe Kopf). Das Ende der proposalId traegt Auswahl und Zeit und unterscheidet zwei Vorschlaege auch bei langer Kennung.
const auftragNr = (p) => "bo-" + String(p.proposalId == null ? "" : p.proposalId).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(-76);

// Jeder offene Tab der Seite genuegt (die Abrufe brauchen kein bestimmtes Spiel auf dem Schirm); ist keiner offen, wird einer im Hintergrund
// geoeffnet (Auto-Open wie beim Operator). Antwortet im Tab ein Script einer anderen Version, wird er EINMAL neu geladen.
async function seitenTab(ctx) {
  const MYVER = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return "?"; } })();
  let tab = (await tabsQuery({ url: TAB_MUSTER })).find((t) => t && !t.discarded) || null, neu = false;
  if (!tab) {
    tab = await tabCreate({ url: START, active: false });
    if (!tab) return { error: "could not open a tab for " + SEITE };
    neu = true; await waitComplete(tab.id, 25000); await sleep(1500);
  }
  for (let lauf = 0; lauf < 2; lauf++) {
    const err = await inject(tab.id);
    if (err) return { error: "script injection failed: " + err };
    const a = await sendTab(tab.id, { cmd: "boPing" });
    if (a && a.ok && a.abfrage) { standAus("Cloudflare"); return { error: "Cloudflare check open in the BetOnline tab — confirm it once" }; }
    if (a && a.ok && a.bm === BUCH && a.version === MYVER) return { tabId: tab.id, warm: !neu && lauf === 0 };
    if (lauf === 0) {
      ctx.log(`betonline: im Tab antwortet ${a && a.ok ? "Skript " + (a.version || "(alt)") : "kein Skript"} statt ${MYVER} — Tab neu laden`);
      try { await new Promise((rs) => { try { chrome.tabs.reload(tab.id, {}, () => rs()); } catch (_) { rs(); } }); } catch (_) {}
      await waitComplete(tab.id, 25000); await sleep(1500);
    }
  }
  return { error: "BetOnline page script did not answer" };
}

export async function place(p, stakeEur, ctx) {
  // ---- alles hier: nichts gesendet, kein Tab angefasst ----
  if (!p || typeof p !== "object") return { status: "blocked", reason: "betonline: no proposal" };
  if (p.mkt === "parlay") return { status: "blocked", reason: "betonline: parlays are not connected (single bets only)" };
  const feed = (p.sport == null || p.sport === "") ? "fb" : String(p.sport);
  if (!Object.prototype.hasOwnProperty.call(sports, feed)) return { status: "blocked", reason: "betonline: sport " + feed + " is not connected (football only)" };
  if ((p.mkt || "ml") !== "ml" || (p.scope || "match") !== "match" || p.line != null) return { status: "blocked", reason: "betonline: market " + String(p.mkt) + " is not connected (match winner only)" };
  if (p.live === true || (p.eventIdentity && p.eventIdentity.live === true)) return { status: "blocked", reason: "betonline: live bets are not connected — pre-match only" };
  if (!Object.prototype.hasOwnProperty.call(SEITEN, String(p.sel))) return { status: "blocked", reason: "betonline: invalid selection " + String(p.sel) };
  const ref = p.bookRef || {}, eventId = String(ref.eventId == null ? "" : ref.eventId), rotation = String(ref.outcomeId == null ? "" : ref.outcomeId);
  if (!/^\d{4,12}$/.test(eventId)) return { status: "blocked", reason: "betonline: bookRef.eventId missing (GameId of the book)" };
  if (!/^\d{1,12}$/.test(rotation)) return { status: "blocked", reason: "betonline: bookRef.outcomeId missing (without the exact rotation number of the operator nothing is placed)" };
  const slug = slugAus(ref.url);
  if (!slug) return { status: "blocked", reason: "betonline: bookRef.url missing or not a football league address of the book (the fresh price cannot be read without it)" };
  if (!p.proposalId || typeof p.proposalId !== "string") return { status: "blocked", reason: "betonline: proposalId missing (order number)" };
  const minOdds = Number(p.minOdds);
  if (!(minOdds > 1) || !isFinite(minOdds)) return { status: "blocked", reason: "betonline: minOdds missing" };
  const toRisk = Math.floor(Number(stakeEur) + 1e-9);          // nie nach oben (siehe Kopf)
  if (!(toRisk >= MIN_EINSATZ) || toRisk > MAX_EINSATZ) return { status: "blocked", reason: "betonline: stake " + String(stakeEur) + " outside " + MIN_EINSATZ + "-" + MAX_EINSATZ + " (whole units only, never rounded up)" };

  const t0 = Date.now();
  const offen = await seitenTab(ctx);
  if (offen.error) return { status: "blocked", reason: "betonline: " + offen.error + " — nothing sent" };
  ctx.log(`betonline: Spiel ${eventId} · Rotation ${rotation} (${String(p.sel)} in Buch-Sicht) · toRisk ${toRisk} aus ${stakeEur} EUR-Zahl @ ≥${minOdds}` + (offen.warm ? " · tab ready" : " · tab opened or reloaded"));
  const r = await sendTab(offen.tabId, { cmd: "boPlace", auftragId: auftragNr(p), armed: true, eventId, rotation, sel: String(p.sel), slug, toRisk, minOdds });
  // „kein Empfaenger“ gleich nach dem beantworteten Ping: der Auftrag kam im Tab nie an — nachweislich nichts gesendet. Alles andere ohne Status kann NACH dem Senden liegen.
  if (r && r.error && !r.status && /Receiving end does not exist|Could not establish connection/i.test(String(r.error))) return { status: "blocked", reason: "betonline: the tab went away before the order was delivered — nothing sent" };
  ctx.log(`betonline: Antwort nach ${Date.now() - t0} ms · ${r && r.status ? r.status : "?"}${r && r.ticket ? " · Ticket " + r.ticket : ""}${r && r.reason ? " · " + String(r.reason).slice(0, 220) : ""}${r && r.note ? " · " + String(r.note).slice(0, 220) : ""}`);
  if (!r || !r.status) return { status: "uncertain", reason: "betonline: no answer from the page (" + String((r && r.error) || "empty").slice(0, 120) + ") — check the bet history" };
  if (r.status === "placed") standSetzen(true, "signed in"); else standAus(r.reason);
  const stand = r.status === "placed" && r.ticket == null ? "uncertain" : r.status;
  if (stand !== "placed" && stand !== "blocked" && stand !== "uncertain") return { status: "uncertain", reason: "betonline: unknown answer from the page — check the bet history" };
  return { status: stand, odds: r.odds, stake: r.stake, cur: r.cur, ticket: r.ticket != null ? String(r.ticket) : undefined, reason: stand === r.status ? r.reason : "betonline: placed without a ticket number — check the bet history", note: r.note };
}

// ---- Konto lesen -------------------------
// Abfrage aus dem Mitschnitt des Betreibers vom 01.11., Felder der Zeilen aus dem Code der Seite (BetHistoryService). Das Konto hatte im Mitschnitt keine Wette: Eine echte Zeile ist noch nicht gelesen, die
// erste echte Wette gegen den Betlog pruefen. Was nicht passt, bleibt „unklar“. Die Anmeldung bleibt im Tab (siehe Kopf), zurueck kommen nur die Felder aus FELDER. Einzahlungen und Auszahlungen: Schnittstelle nicht im Mitschnitt, darum keine Buchungen.
// Waehrung: Die Antwort nennt keine, darum leer. Die Quote ist aus Risk und ToWin gerechnet, die Seite nennt sie in der Zeile nicht. Kombis nur als Summe, die Beine stehen in get-bet-history-detail und sind nicht gebaut.
const BO_BERICHT = "https://api.betonline.ag/report/api/report/get-bet-history", BO_GSETTING = "bolnasite";
const BO_FENSTER_MS = 89 * 864e5, BO_FENSTER_ERST = 8, BO_JE_SEITE = 100, BO_SEITEN_MAX = 20;   // 89 Tage wie die Seite selbst; beim ersten Mal 8 Fenster, gut zwei Jahre
const BO_STATUS = { won: "gewonnen", lost: "verloren", pending: "offen", open: "offen", cancelled: "void", void: "void", push: "void", "cashed-out": "cashout", cashout: "cashout" };
export function boWetteAus(z) {
  const zahl = (x) => (typeof x === "number" && isFinite(x) ? x : typeof x === "string" && x.trim() !== "" && isFinite(Number(x)) ? Number(x) : null), c2 = (x) => Math.round(x * 100) / 100;
  const einsatz = zahl(z.Risk), gewinn = zahl(z.ToWin), zurueck = zahl(z.ToReturn), status = BO_STATUS[String(z.WagerStatus == null ? "" : z.WagerStatus).trim().toLowerCase().replace(/\s+/g, "-")] || "unklar";
  const auszahlung = status === "verloren" ? 0 : status === "gewonnen" ? (zurueck != null && zurueck > 0 ? zurueck : einsatz != null && gewinn != null ? c2(einsatz + gewinn) : null) : status === "void" ? einsatz : status === "cashout" ? zurueck : null;
  const n = zahl(z.NumEvents), kombi = (n != null && n > 1) || /parlay|teaser|reverse|if.?bet|round/i.test(String(z.WagerType || "")), quote = einsatz > 0 && gewinn != null ? Math.round((1 + gewinn / einsatz) * 1000) / 1000 : null, ts = Date.parse(String(z.Date || ""));
  return { id: String(z.TicketNumber) + (z.WagerNumber != null ? "-" + z.WagerNumber : ""), ts: isFinite(ts) ? ts : null, einsatz, quote, status, auszahlung, waehrung: null, kombi, bonus: z.FreePlayFlag === "Y" || z.FreePlayFlag === true,
    beine: [{ spielId: null, start: null, heim: null, gast: null, liga: null, sport: null, markt: z.WagerTypeDetail || z.WagerType || null, tipp: z.ShortDescription || null, quote: kombi ? null : quote, ergebnis: kombi ? "unklar" : status, stand: null, live: /live/i.test(String(z.Product || "")) }] };
}
// Laeuft im Tab (chrome.scripting): nur die Argumente und Browser-Globale, nichts aus dieser Datei.
export async function boKontoImTab(url, gsetting, fenster, jeSeite, seitenMax) {
  const FELDER = ["TicketNumber", "WagerNumber", "Date", "GradeDateTime", "Risk", "ToWin", "ToReturn", "WagerStatus", "WagerType", "WagerTypeCode", "WagerTypeDetail", "ShortDescription", "NumEvents", "Product", "FreePlayFlag"];
  let token = "";
  try { const r = await fetch("/api/auth/get-token", { credentials: "same-origin", cache: "no-store" }); if (r.ok) token = String((await r.json()).token || ""); } catch (_) {}
  if (!token) return { ok: false, fehler: "not logged in" };
  const versatz = new Date().getTimezoneOffset(), kopf = { "Content-Type": "application/json", contests: "na", gmtOffset: String(versatz * -1 / 60), utcOffset: String(Math.abs(versatz)), gsetting, "X-Version": "2.0", Authorization: "Bearer " + token };
  const zeilen = []; let voll = true, gelesen = 0;
  for (const f of fenster) {
    for (let seite = 0, pos = 0; seite < seitenMax; seite++) {
      let j = null;
      try { const r = await fetch(url, { method: "POST", credentials: "omit", cache: "no-store", headers: kopf, body: JSON.stringify({ Id: null, StartDate: f.von, EndDate: f.bis, Status: f.status, Product: null, WagerType: null, FreePlayFlag: null, StartPosition: pos, TotalPerPage: jeSeite, IsDailyFigureReport: false }) }); if (r.ok) j = await r.json(); } catch (_) {}
      if (!j || !Array.isArray(j.Data)) { if (!gelesen) return { ok: false, fehler: "report not readable" }; voll = false; break; }
      gelesen++;
      for (const z of j.Data) { const o = {}; for (const k of FELDER) if (z && z[k] !== undefined) o[k] = z[k]; zeilen.push(o); }
      pos += j.Data.length;
      if (!j.Data.length || pos >= (Number(j.TotalRows) || 0)) break;
      if (seite === seitenMax - 1) voll = false;
    }
  }
  return { ok: true, zeilen, voll };
}
export async function kontoLesen(venue, m) {
  const tab = (await tabsQuery({ url: TAB_MUSTER })).find((t) => t && !t.discarded) || null;
  if (!tab) return null;
  const jetzt = Date.now(), iso = (t) => new Date(t).toISOString(), fenster = [{ von: iso(jetzt - BO_FENSTER_MS), bis: iso(jetzt), status: "P,O" }], anzahl = m && m.voll ? 1 : BO_FENSTER_ERST;
  for (let i = 0; i < anzahl; i++) fenster.push({ von: iso(jetzt - (i + 1) * BO_FENSTER_MS), bis: iso(jetzt - i * BO_FENSTER_MS), status: "W,L,X,K" });
  let r = null;
  try { const a = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: boKontoImTab, args: [BO_BERICHT, BO_GSETTING, fenster, BO_JE_SEITE, BO_SEITEN_MAX] }); r = a && a[0] && a[0].result; } catch (_) {}
  if (!r || r.ok !== true) return null;
  const je = new Map();   // Offene zuerst, dieselbe Wette aus den abgerechneten ueberschreibt sie
  for (const z of r.zeilen) if (z && z.TicketNumber != null) { const w = boWetteAus(z); je.set(w.id, w); }
  return { wetten: [...je.values()], buchungen: [], summen: null, voll: r.voll === true, merker: {} };
}
