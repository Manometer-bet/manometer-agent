// books/elabet.js — Engine-Adapter fuer Elabet (elabet.gr, Plattform Altenar), GRIECHENLAND. 03.10.2026.
// Vertrag: engine/README.md "Ein neues Buch hinzufuegen" (id, hosts, arm, status, place). Muster: books/superbet.js —
// das eigentliche Setzen laeuft im eingeloggten Tab (content/elabet-place.js, Befehl elabetPlace), weil nur dort die
// Herkunft der Seite stimmt.
//
// ANMELDUNG: Elabet nutzt kein Cookie, sondern einen 15-Minuten-Schluessel (JWT, an die IP gebunden, Kopfzeile
// Authorization), den die Seite nur im Speicher haelt und selbst erneuert. Die Abrufe des Wett-Moduls tragen ihn —
// aber nur auf der SPORT-Seite (elabet.gr/en/sport); auf der Startseite laeuft das Modul nicht (gemessen 03.10.2026).
// arm() liest ihn rein lesend aus diesen Abrufen mit (webRequest wie Fonbet) und haelt ihn nur im Sitzungsspeicher —
// nie in einer Datei, nie im Protokoll, nie im Status an den Operator. Erneuert wird er hier NIE (die Seite tut das selbst).
//
// AUSWAHL: Der Operator nennt die genaue Quote des Buchs als bookRef.outcomeId (Altenar-oddId). p.sel (home/draw/away)
// ist die Sicht des Operators und wird hier bewusst NICHT in eine Buch-Seite uebersetzt — fuehrt das Buch die
// Mannschaften gedreht, waere das die falsche Mannschaft. Ohne outcomeId wird nicht gesetzt (fail-closed).
//
// Regeln (engine/README.md): nie selbst aufloesen; frisch lesen + minOdds (macht das Tab-Script unmittelbar vor dem
// Senden); Wahrheitstabelle: vor der Uebergabe an den Tab nur "blocked" — ist die Uebergabe raus und die Antwort unklar
// -> "uncertain". Gesetzt wird der Sieger-Markt ueber das ganze Spiel: Fussball 1X2 (p.sport "fb") und — seit 1.2.64,
// 04.10.2026 — Basketball „Winner (incl. OT)" (p.sport "basket": 2-Weg inklusive Verlaengerung, nur home/away). Jede andere
// Sportart wird abgewiesen (auch die Engine prueft das: export sports).
// Vor dem Anpfiff und LIVE (04.10.2026), streng getrennt ueber p.live: ein Live-Vorschlag
// setzt nur, wenn das Buch das Spiel als laufend fuehrt, ein Vorspiel-Vorschlag nur vor dem Anpfiff (prueft das Tab-Script
// an den frischen Spiel-Details).
// LIVE-ANNAHME: das Buch laesst eine Live-Wette erst warten (Verzoegerung/Pruefung). Dann antwortet der Tab mit
// { status:"pending", warteId, nachMs }, und DIESER Adapter wartet und fragt ueber elabetNachfragen nach — Zeitgeber eines
// verdeckten Tabs drosselt Chrome, die des Service Workers nicht. Jede Nachfrage ist im Tab genau ein Abruf. Ein
// Gegenangebot des Buchs (Einsatz gekuerzt / Quote geaendert) lehnt das Tab-Script ab, angenommen wird nie.
"use strict";

const BUCH = "elabet";
const SEITE = "https://elabet.gr";
const HERKUNFT = /^https:\/\/(www\.)?elabet\.gr$/;              // Abrufe, die von der Elabet-Seite ausgehen
const TAB_MUSTER = ["https://elabet.gr/*", "https://www.elabet.gr/*"];
const INHALT = "content/elabet-place.js";
const AUTH_ABRUFE = ["https://*.biahosted.com/*"];             // Abrufe des Wett-Moduls (Altenar)
const AUTH_SCHLUESSEL = "elabetAuth";                          // chrome.storage.session
const AUTH_REST_MS = 30000;                                    // die Anmeldung muss noch mindestens so lange gelten
const MIN_EINSATZ = 0.5, MAX_EINSATZ = 1000;                   // Sicherheitsgrenzen (EUR), nicht die Limits des Buchs
// Sportart des Vorschlags (Feed-API v1) -> Sportart beim Tab-Script und erlaubte Auswahlen (Sicht des Operators).
// Was hier fehlt, setzt dieser Adapter nicht.
const SPORT = {
  fb: { tab: "soccer", sel: { home: 1, draw: 1, away: 1 } },
  basket: { tab: "basketball", sel: { home: 1, away: 1 } },
};
const HINWEIS = "sign in at elabet.gr and keep the sport page (elabet.gr/en/sport) open in a tab";
const NACHFRAGEN_MAX = 40;                                     // Obergrenze der Nachfragen; die Frist selbst haelt das Tab-Script (60 s)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _auth = null;                                              // { kopf, exp } — nur im Speicher + Sitzungsspeicher

function tabsQuery(q) { return new Promise((rs) => { try { chrome.tabs.query(q, (t) => rs(t || [])); } catch (_) { rs([]); } }); }
function sendTab(tabId, msg) {
  return new Promise((rs) => {
    try { chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, (r) => { const e = chrome.runtime.lastError; rs(e ? { error: e.message } : (r || { error: "keine Antwort" })); }); }
    catch (e) { rs({ error: String((e && e.message) || e) }); }
  });
}
async function inject(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, files: [INHALT] }); return null; }
  catch (e) { return String((e && e.message) || e); }
}

// PURE: Kopfzeile "Bearer <JWT>" -> { exp (ms), integration } | null. Liest nur Ablaufzeit und Marke aus der Nutzlast.
export function authInfo(kopf) {
  const m = /^(?:Bearer\s+)?([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(kopf == null ? "" : kopf));
  if (!m) return null;
  try {
    const b = m[2].replace(/-/g, "+").replace(/_/g, "/");
    const j = JSON.parse(atob(b + "===".slice((b.length + 3) % 4)));
    const exp = Number(j && j.exp) * 1000;
    if (!(exp > 0)) return null;
    return { exp, integration: j.Integration != null ? String(j.Integration).toLowerCase() : null };
  } catch (_) { return null; }
}
// Mitgelesene Kopfzeile uebernehmen — nur wenn sie zu DIESER Marke gehoert, noch gilt und nicht aelter ist als die bekannte.
function authMerken(kopf) {
  if (_auth && _auth.kopf === kopf) return;
  const i = authInfo(kopf);
  if (!i || i.integration !== BUCH || !(i.exp > Date.now())) return;
  if (_auth && _auth.exp >= i.exp) return;
  _auth = { kopf, exp: i.exp };
  try { chrome.storage.session.set({ [AUTH_SCHLUESSEL]: _auth }); } catch (_) {}
}
// Nach einem Neustart des Service Workers ist der Speicher leer — dann aus dem Sitzungsspeicher nachladen.
async function authLesen() {
  if (!_auth) {
    try {
      const c = await new Promise((rs) => { try { chrome.storage.session.get(AUTH_SCHLUESSEL, (x) => rs(x || {})); } catch (_) { rs({}); } });
      const a = c[AUTH_SCHLUESSEL];
      if (a && a.kopf && Number(a.exp) > 0) _auth = { kopf: String(a.kopf), exp: Number(a.exp) };
    } catch (_) {}
  }
  return _auth;
}

export const id = "elabet";
export const sports = { fb: true, basket: true };              // Sportarten, die dieser Adapter setzt (engine-sw.js prueft das vor place)
// 1.2.70 (05.10.2026): dieser Adapter setzt Kombiwetten (mkt "parlay") — engine-core.js adapterKombi.
export const kombi = true;
export const hosts = { site: SEITE, api: "https://*.biahosted.com" };

export function arm(_ctx) {
  authLesen();
  try {
    chrome.webRequest.onBeforeSendHeaders.addListener((d) => {
      try {
        if (!d || !HERKUNFT.test(String(d.initiator || ""))) return;   // nur Abrufe, die von elabet.gr ausgehen
        const h = (d.requestHeaders || []).find((x) => x && /^authorization$/i.test(String(x.name)));
        if (h && h.value) authMerken(String(h.value));
      } catch (_) {}
    }, { urls: AUTH_ABRUFE }, ["requestHeaders", "extraHeaders"]);
  } catch (_) {}
}

// Bereit = ein mitgelesener Schluessel gilt noch. Der Text nennt nie den Schluessel.
export function status() {
  if (_auth && _auth.exp - Date.now() > AUTH_REST_MS) return { ready: true, detail: "signed in" + saldoText() };
  return { ready: false, detail: (_auth ? "sign-in expired — " : "no sign-in seen — ") + HINWEIS };
}

// Der Tab muss GENAU unser Setz-Script tragen: erst nachladen (doppelt ist unschaedlich, das Script schuetzt sich selbst),
// dann fragen. Erst wenn es antwortet, geht der Auftrag raus — eine unklare Antwort danach ist dann wirklich "ungewiss".
async function tabBereit(tabId) {
  const ierr = await inject(tabId);
  if (ierr) return "Injektion fehlgeschlagen: " + ierr;
  const r = await sendTab(tabId, { cmd: "ping" });
  return (r && r.ok && r.bm === BUCH) ? null : "Setz-Script im Tab antwortet nicht";
}

export async function place(p, stakeEur, ctx) {
  if (p && p.mkt === "parlay") return await placeKombi(p, stakeEur, ctx);
  const sel = p && p.sel;
  const sp = p && Object.prototype.hasOwnProperty.call(SPORT, String(p.sport)) ? SPORT[String(p.sport)] : null;
  if (!sp) return { status: "blocked", reason: BUCH + ": Sportart " + String(p && p.sport) + " nicht unterstuetzt" };
  if (!Object.prototype.hasOwnProperty.call(sp.sel, String(sel))) return { status: "blocked", reason: BUCH + ": ungueltige Auswahl " + String(sel) };
  if ((p.mkt || "ml") !== "ml") return { status: "blocked", reason: BUCH + ": Markt " + String(p.mkt) + " nicht unterstuetzt" };
  const eventId = p.bookRef && p.bookRef.eventId, outcomeId = p.bookRef && p.bookRef.outcomeId;
  if (!eventId) return { status: "blocked", reason: BUCH + ": bookRef.eventId fehlt (Engine loest nie selbst auf)" };
  if (!outcomeId) return { status: "blocked", reason: BUCH + ": bookRef.outcomeId fehlt (ohne genaue Auswahl des Operators wird nicht gesetzt)" };
  const einsatz = Math.round(Number(stakeEur) * 100) / 100;
  if (!(einsatz >= MIN_EINSATZ) || einsatz > MAX_EINSATZ) return { status: "blocked", reason: BUCH + ": Einsatz " + einsatz + " ausserhalb " + MIN_EINSATZ + "-" + MAX_EINSATZ };
  if (!(Number(p.minOdds) > 1)) return { status: "blocked", reason: BUCH + ": minOdds fehlt" };

  const auth = await authLesen();
  if (!auth) return { status: "blocked", reason: BUCH + ": no sign-in seen — " + HINWEIS };
  if (!(auth.exp - Date.now() > AUTH_REST_MS)) return { status: "blocked", reason: BUCH + ": sign-in expired — " + HINWEIS };

  // Kein Auto-Open: ohne offenen, eingeloggten Tab wird nicht gesetzt.
  const tabs = await tabsQuery({ url: TAB_MUSTER });
  const tab = tabs.find((t) => t && t.status === "complete" && !t.discarded) || tabs[0];
  if (!tab) return { status: "blocked", reason: BUCH + ": no elabet.gr tab open — " + HINWEIS };
  const nichtBereit = await tabBereit(tab.id);
  if (nichtBereit) return { status: "blocked", reason: BUCH + ": " + nichtBereit + " — elabet.gr-Tab neu laden" };

  const live = p.live === true;
  const auswahl = { eventId: String(eventId), outcomeId: String(outcomeId), sel, live, sport: sp.tab };
  ctx.log(BUCH + ": uebergebe Auswahl " + auswahl.outcomeId + " (" + sel + " aus Operator-Sicht) auf Spiel " + auswahl.eventId + (live ? " · LIVE" : "") + (sp.tab !== "soccer" ? " · " + sp.tab : "") + " · " + einsatz + " EUR, Floor " + Number(p.minOdds));
  const t0 = Date.now();
  let r = await sendTab(tab.id, { cmd: "elabetPlace", auswahl, einsatz, minOdds: Number(p.minOdds), kopf: { Authorization: auth.kopf }, kopfExp: auth.exp });
  // Das Buch wartet (Live-Verzoegerung, Pruefung): HIER warten und nachfragen. Der Schein ist dann schon beim Buch — reisst
  // der Tab ab, ist der Ausgang offen (uncertain mit Wett-Nr.), nie "nicht gesetzt". Die Anmeldung wird je Nachfrage frisch
  // mitgegeben (die Seite erneuert sie laufend).
  let nachfragen = 0;
  while (r && r.status === "pending" && r.warteId && nachfragen < NACHFRAGEN_MAX) {
    nachfragen++;
    const wartet = r;
    await sleep(Math.max(250, Math.min(10000, Number(r.nachMs) || 0)));
    const a2 = await authLesen();
    r = await sendTab(tab.id, { cmd: "elabetNachfragen", warteId: wartet.warteId, kopf: a2 ? { Authorization: a2.kopf } : null, kopfExp: a2 ? a2.exp : 0 });
    if (!r || !r.status) r = { status: "uncertain", ticket: wartet.ticket, odds: wartet.odds, buchSel: wartet.buchSel, reason: BUCH + ": Tab antwortet beim Nachfragen nicht (" + String(r && r.error).slice(0, 100) + ") — Wette wartete beim Buch, im Konto pruefen" };
    else if (!r.ticket && wartet.ticket) r.ticket = wartet.ticket;
  }
  if (r && r.status === "pending") r = { status: "uncertain", ticket: r.ticket, odds: r.odds, buchSel: r.buchSel, reason: BUCH + ": das Buch wartet nach " + nachfragen + " Nachfragen noch — im Konto pruefen" };
  ctx.log(BUCH + ": answer after " + (Date.now() - t0) + " ms" + (nachfragen ? " (" + nachfragen + " follow-ups)" : "") + " · " + (r && r.status ? r.status : "?") + (r && r.ticket ? " · Bet no. " + r.ticket : "") + (r && r.reason ? " · " + String(r.reason).slice(0, 260) : "") + (r && r.note ? " · " + String(r.note).slice(0, 200) : ""));
  _saldo = null; _saldoFrageAt = 0;                              // nach einem Auftrag den Kontostand neu lesen
  if (r && r.status === "failed" && /insufficient_funds/i.test(String(r.reason || ""))) {
    // Das Buch sagt nur "zu wenig Guthaben". Den Betrag dazuschreiben, den das Wett-Modul als Kontostand liest (die Seite
    // kann oben mehr anzeigen). Nur Anzeige: der Kontostand ist nie ein Riegel und bestimmt keinen Einsatz (Betreiber 03.10.).
    let k = null; try { k = await balance(); } catch (_) {}
    r.reason = String(r.reason) + (k ? " (balance per betting module: " + k.saldo.toFixed(2) + " " + k.cur + ", Einsatz " + einsatz.toFixed(2) + ")" : " (Guthaben reicht laut Buch nicht fuer " + einsatz.toFixed(2) + " EUR)");
  }
  if (!r || !r.status) {
    // "Receiving end does not exist" = der Auftrag kam im Tab nie an -> nachweislich nichts gesendet. Jeder andere Abriss
    // kann NACH dem Absenden liegen: uncertain (Wahrheitstabelle), nie blocked.
    if (r && /Receiving end does not exist|Could not establish connection/i.test(String(r.error))) return { status: "blocked", reason: BUCH + ": Tab nicht erreichbar (Auftrag kam nicht an)" };
    return { status: "uncertain", reason: BUCH + ": keine Antwort vom Tab (" + String(r && r.error) + ") — im Konto pruefen" };
  }
  return r;
}

// ---- 1.2.70 — KOMBIWETTE ---------------------------------------------------------------------------------------------------
// EIN Schein mit mehreren Spielen: derselbe Abruf placeWidget wie die Einzelwette, betType 1 mit je Spiel einem Eintrag. Der
// Ablauf steht im Seiten-Baustein content/elabet-kombi.js (byte-gleich mit elabet-kombi.js des Operators): Anmelde-Probe und
// Zaehler des Kontos, Regeln des Kontos (Rundung, Gewinnsteuer), frische Spiel-Details JEDES Beins durch dieselbe Pruefung wie
// bei der Einzelwette, Doppel-Schutz, dann EIN Auftrag an die Absende-Funktion des Setz-Scripts. Jedes Bein braucht die GENAUE
// Quoten-Nummer des Operators (legs[].outcomeId) und den Tipp in der Reihenfolge des BUCHS — die Engine sucht nie selbst eine
// Auswahl. Die Anmeldung geht je Auftrag und je Nachfrage frisch mit; sie steht nie im Protokoll.
const KOMBI_BAUSTEIN = "content/elabet-kombi.js";
const KOMBI_SPORT = { fb: "soccer", basket: "basketball" };     // Feed-Name der Sportart eines Beins → Name im Baustein
const KOMBI_NACHFRAGEN_MAX = 40;                               // der Baustein wartet selbst hoechstens 60 s
let _kombiNr = 0;
// Wie tabBereit, zusaetzlich muss das Setz-Script den Kombi-Baustein kennen (er wird nachgeladen, wenn er fehlt).
async function kombiBereit(tabId) {
  const nicht = await tabBereit(tabId);
  if (nicht) return nicht;
  let r = await sendTab(tabId, { cmd: "ping" });
  if (!(r && r.ok && r.kombi === true)) {
    try { await chrome.scripting.executeScript({ target: { tabId }, files: [KOMBI_BAUSTEIN] }); } catch (e) { return "Kombi-Baustein nicht ladbar: " + String((e && e.message) || e).slice(0, 80); }
    r = await sendTab(tabId, { cmd: "ping" });
  }
  return (r && r.ok && r.bm === BUCH && r.kombi === true) ? null : "Setz-Script im Tab kennt die Kombiwette nicht (alte Fassung)";
}
async function placeKombi(p, stakeEur, ctx) {
  const legs = [];
  for (let i = 0; i < (Array.isArray(p.legs) ? p.legs.length : 0); i++) {
    const L = p.legs[i] || {}, feed = (L.sport == null || L.sport === "") ? "fb" : String(L.sport);
    const sport = Object.prototype.hasOwnProperty.call(KOMBI_SPORT, feed) ? KOMBI_SPORT[feed] : null;
    if (!sport) return { status: "blocked", reason: BUCH + ": leg " + (i + 1) + " — sport " + feed + " is not connected for parlays" };
    if (!/^\d{1,15}$/.test(String(L.eventId == null ? "" : L.eventId))) return { status: "blocked", reason: BUCH + ": leg " + (i + 1) + " — game number unreadable" };
    if (!/^\d{1,15}$/.test(String(L.outcomeId == null ? "" : L.outcomeId))) return { status: "blocked", reason: BUCH + ": leg " + (i + 1) + " without the exact selection number of the operator (outcomeId) — nothing sent" };
    legs.push({ eventId: String(L.eventId), outcomeId: String(L.outcomeId), tip: L.tip, minOdds: Number(L.minOdds), sport });
  }
  if (legs.length < 2) return { status: "blocked", reason: BUCH + ": a parlay needs at least two legs" };
  const einsatz = Math.round(Number(stakeEur) * 100) / 100;
  if (!(einsatz >= MIN_EINSATZ) || einsatz > MAX_EINSATZ) return { status: "blocked", reason: BUCH + ": Einsatz " + einsatz + " ausserhalb " + MIN_EINSATZ + "-" + MAX_EINSATZ };
  if (!(Number(p.minOdds) > 1)) return { status: "blocked", reason: BUCH + ": minOdds fehlt" };
  const auth = await authLesen();
  if (!auth) return { status: "blocked", reason: BUCH + ": no sign-in seen — " + HINWEIS };
  if (!(auth.exp - Date.now() > AUTH_REST_MS)) return { status: "blocked", reason: BUCH + ": sign-in expired — " + HINWEIS };
  // Kein Auto-Open: ohne offenen, eingeloggten Tab wird nicht gesetzt.
  const tabs = await tabsQuery({ url: TAB_MUSTER });
  const tab = tabs.find((t) => t && t.status === "complete" && !t.discarded) || tabs[0];
  if (!tab) return { status: "blocked", reason: BUCH + ": no elabet.gr tab open — " + HINWEIS };
  const nichtBereit = await kombiBereit(tab.id);
  if (nichtBereit) return { status: "blocked", reason: BUCH + ": " + nichtBereit + " — elabet.gr-Tab neu laden" };
  // Auftrags-Nummer JE VERSUCH: der Baustein fuehrt dieselbe Nummer nie zweimal aus.
  const auftragId = ("p-" + String(p.proposalId == null ? "" : p.proposalId).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 48) + "-" + Date.now().toString(36) + "-" + (++_kombiNr)).slice(0, 80);
  ctx.log(BUCH + ": parlay · " + legs.length + " legs · " + einsatz + " EUR @ ≥" + Number(p.minOdds));
  const t0 = Date.now();
  let r = await sendTab(tab.id, { cmd: "elabetPlaceCombo", auftragId, armed: true, amount: einsatz, minTotalOdds: Number(p.minOdds), legs, kopf: { Authorization: auth.kopf }, kopfExp: auth.exp });
  // „kein Empfaenger“ gleich nach dem beantworteten Ping: der Auftrag kam im Tab nie an — nachweislich nichts gesendet.
  if (r && r.error && !r.status && /Receiving end does not exist|Could not establish connection/i.test(String(r.error))) return { status: "blocked", reason: BUCH + ": Tab nicht erreichbar (Auftrag kam nicht an)" };
  // Meldet der Baustein „pending“, ist der Schein beim Buch: HIER warten und nachfragen (Zeitgeber des Service Workers). Die
  // Anmeldung wird je Nachfrage frisch mitgegeben (die Seite erneuert sie laufend).
  let nachfragen = 0;
  while (r && r.status === "pending" && r.warteId && nachfragen < KOMBI_NACHFRAGEN_MAX) {
    nachfragen++;
    const wartet = r;
    await sleep(Math.max(250, Math.min(10000, Number(r.nachMs) || 0)));
    const a2 = await authLesen();
    r = await sendTab(tab.id, { cmd: "elabetKombiNachfragen", warteId: wartet.warteId, kopf: a2 ? { Authorization: a2.kopf } : null, kopfExp: a2 ? a2.exp : 0 });
    if (!r || !r.status) r = { status: "uncertain", ticket: wartet.ticket, odds: wartet.odds, reason: BUCH + ": Tab antwortet beim Nachfragen nicht (" + String(r && r.error).slice(0, 100) + ") — der Schein war beim Buch, im Konto pruefen" };
    else if (!r.ticket && wartet.ticket) r.ticket = wartet.ticket;
  }
  if (r && r.status === "pending") r = { status: "uncertain", ticket: r.ticket, odds: r.odds, reason: BUCH + ": nach " + nachfragen + " Nachfragen noch kein Ergebnis — im Konto pruefen" };
  ctx.log(BUCH + ": parlay answer after " + (Date.now() - t0) + " ms" + (nachfragen ? " (" + nachfragen + " follow-ups)" : "") + " · " + (r && r.status ? r.status : "?") + (r && r.ticket ? " · bet " + r.ticket : "") + (r && r.reason ? " · " + String(r.reason).slice(0, 260) : "") + (r && r.note ? " · " + String(r.note).slice(0, 200) : "") + (r && r.info ? " · " + String(r.info).slice(0, 200) : ""));
  _saldo = null; _saldoFrageAt = 0;                              // nach einem Auftrag den Kontostand neu lesen
  if (!r || !r.status) return { status: "uncertain", reason: BUCH + ": keine Antwort vom Tab (" + String(r && r.error) + ") — im Konto pruefen" };
  return { status: r.status, odds: r.odds, stake: r.stake, reason: r.reason, note: r.note, ticket: r.ticket != null ? String(r.ticket) : undefined, verified: r.verified, legs: r.legs, ms: r.ms, tax: r.tax, netOdds: r.netOdds, bonus: r.bonus, info: r.info };
}

// ---- Kontostand (03.10.2026; Betreiber: "Kontostand einbauen" — die erste Bettor-Wette lehnte das Buch mit
// bets.insufficient_funds ab). GET platformOperations/WidgetPlatform/getOwnBalance -> { amount, currency }: der Betrag, den
// das WETT-MODUL liest (es fragt dieselbe Adresse selbst alle 30 s). ACHTUNG: die Seite kann oben MEHR anzeigen (gemessen
// 03.10. im Konto des Operators). Was der Unterschied bedeutet, ist NICHT geklaert
// (Betreiber: wettbar sind sicher mehr) — der Wert ist reine Anzeige, nie Riegel, nie Einsatz-Grundlage.
// Der Abruf laeuft IM TAB (chrome.scripting, isolierte Welt), damit er wie die Abrufe der Seite die Herkunft elabet.gr
// traegt — nur GET, ohne Cookies. Oeffnet NIE einen Tab; ohne Tab, Anmeldung oder Antwort -> null (Heartbeat laeuft weiter).
const KONTO = "https://sb2platformoperations-altenar2.biahosted.com/api/WidgetPlatform/getOwnBalance";
const SALDO_TTL_MS = 60000;                                    // so lange gilt ein gelesener Stand (der Heartbeat fragt oefter)
const SALDO_ZEIGEN_MS = 5 * 60000;                             // so lange nennt der Status den letzten Stand
let _saldo = null;                                             // { wert, at } — zuletzt gelesener Kontostand
let _saldoZuletzt = null;                                      // derselbe, bleibt fuer den Status-Text stehen
let _saldoHinweis = "";                                        // warum er zuletzt nicht lesbar war (ohne Kontodaten)
let _saldoFrageAt = 0;                                         // letzter Leseversuch — auch ein gescheiterter zaehlt (hoechstens einer je Minute)
const SALDO_FRIST_MS = 6000;                                   // laenger wartet der Heartbeat nicht auf den Tab

// Laeuft IM TAB und muss deshalb fuer sich allein stehen (kein Zugriff auf dieses Modul). Zurueck gehen nur Betrag,
// Waehrung und Feldnamen — nie die Anmeldung.
async function kontostandImTab(basis, kopf) {
  try {
    const q = "culture=en-GB&timezoneOffset=" + encodeURIComponent(new Date().getTimezoneOffset()) + "&integration=elabet&deviceType=1&numFormat=en-GB&countryCode=GR";
    const ctl = new AbortController(), frist = setTimeout(() => ctl.abort(), 5000);
    let r;
    try { r = await fetch(basis + "?" + q, { headers: { Authorization: kopf }, credentials: "omit", cache: "no-store", signal: ctl.signal }); }
    finally { clearTimeout(frist); }
    if (!r.ok) return { ok: false, http: r.status };
    const j = await r.json().catch(() => null);
    if (!j || typeof j !== "object") return { ok: false, form: "kein JSON" };
    return { ok: true, amount: j.amount, currency: j.currency, felder: Object.keys(j).slice(0, 12) };
  } catch (e) { return { ok: false, fehler: String((e && e.message) || e).slice(0, 80) }; }
}

// PURE: Antwort von getOwnBalance -> Kontostand im Format der Engine { saldo, bonus, hold, cur, ts } | null.
export function balanceAus(j, jetzt) {
  if (!j || typeof j !== "object") return null;
  const n = (j.amount === null || j.amount === undefined || j.amount === "" || typeof j.amount === "boolean") ? NaN : Number(j.amount);
  if (!isFinite(n) || n < 0) return null;
  const cur = /^[A-Z]{3}$/.test(String(j.currency == null ? "" : j.currency)) ? String(j.currency) : "EUR";
  return { saldo: Math.round(n * 100) / 100, bonus: 0, hold: 0, cur, ts: jetzt || Date.now() };
}

function saldoText() {
  if (_saldoZuletzt && Date.now() - _saldoZuletzt.at < SALDO_ZEIGEN_MS) return " · balance per betting module " + _saldoZuletzt.wert.saldo.toFixed(2) + " " + _saldoZuletzt.wert.cur;
  return _saldoHinweis ? " · balance not readable (" + _saldoHinweis + ")" : "";
}

export async function balance() {
  // Hoechstens ein Leseversuch je Minute: der Heartbeat ruft oefter, und ein haengender Tab darf ihn nicht jedes Mal bremsen.
  if (Date.now() - _saldoFrageAt < SALDO_TTL_MS) return (_saldo && Date.now() - _saldo.at < SALDO_TTL_MS) ? _saldo.wert : null;
  const auth = await authLesen();
  if (!auth || !(auth.exp - Date.now() > 5000)) { _saldoHinweis = ""; return null; }     // ohne Anmeldung sagt status() schon, was fehlt
  const tabs = await tabsQuery({ url: TAB_MUSTER });
  const tab = tabs.find((t) => t && t.status === "complete" && !t.discarded) || tabs[0];
  if (!tab) { _saldoHinweis = "no elabet.gr tab open"; return null; }
  _saldoFrageAt = Date.now();
  const r = await new Promise((fertig) => {
    const frist = setTimeout(() => fertig({ ok: false, fehler: "Tab antwortet nicht (Zeitueberschreitung)" }), SALDO_FRIST_MS);
    const ende = (v) => { clearTimeout(frist); fertig(v); };
    try {
      Promise.resolve(chrome.scripting.executeScript({ target: { tabId: tab.id }, func: kontostandImTab, args: [KONTO, auth.kopf] }))
        .then((e) => ende((e && e[0] && e[0].result) || null), (e) => ende({ ok: false, fehler: String((e && e.message) || e).slice(0, 80) }));
    } catch (e) { ende({ ok: false, fehler: String((e && e.message) || e).slice(0, 80) }); }
  });
  const wert = (r && r.ok) ? balanceAus(r) : null;
  if (wert) { _saldo = _saldoZuletzt = { wert, at: Date.now() }; _saldoHinweis = ""; return wert; }
  _saldo = null;
  _saldoHinweis = !r ? "keine Antwort vom Tab" : r.ok ? ("unbekannte Form, Felder: " + (Array.isArray(r.felder) ? r.felder.join(",") : "—")).slice(0, 110) : r.http ? "Antwort " + r.http : String(r.form || r.fehler || "nicht lesbar").slice(0, 110);
  return null;
}
