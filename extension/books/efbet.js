// books/efbet.js — Engine-Adapter fuer efbet (efbet.gr, Plattform BetConstruct „Swarm"), GRIECHENLAND. 04.10.2026.
// Vertrag: engine/README.md "Ein neues Buch hinzufuegen" (id, hosts, arm, status, place, balance). Muster: books/elabet.js —
// das eigentliche Setzen laeuft im eingeloggten Tab (content/efbet-place.js, Befehl efbetPlace).
//
// WIE EFBET SETZT: nicht per HTTP-Abruf, sondern mit dem Befehl create_bets ueber den WebSocket der eingeloggten Seite
// (mitgelesen an zwei echten Wetten des Operators, 04.10.2026). Die Anmeldung haengt an der Sitzung dieses Sockets. Den
// Socket erreicht nur die Seiten-Welt: content/efbet-inject.js merkt ihn sich und nimmt Auftraege des Setz-Scripts an
// (feste Befehlsliste). Dieser Adapter liest weder Token noch Cookie und meldet nie an — ist die Seite nicht angemeldet,
// antwortet das Buch mit Code 12 und es wird nicht gesetzt. Ein Captcha wird nie ausgeloest oder geloest.
//
// AUSWAHL: Der Operator nennt die genaue Auswahl des Buchs als bookRef.outcomeId = "<Auswahl-Nummer>:<Seite>" (Seite =
// W1 | X | W2, z. B. "7250151656:W2"). p.sel (home/draw/away) ist die Sicht des Operators und wird hier bewusst NICHT in
// eine Buch-Seite uebersetzt — fuehrt das Buch die Mannschaften gedreht, waere das die falsche Mannschaft. Ohne outcomeId
// wird nicht gesetzt (fail-closed). Das Tab-Script prueft unmittelbar vor dem Senden, dass die Nummer wirklich auf dieser
// Seite des 1x2-Markts dieses Spiels sitzt.
//
// Regeln (engine/README.md): nie selbst aufloesen; frisch lesen + minOdds (macht das Tab-Script unmittelbar vor dem Senden);
// Wahrheitstabelle: vor der Uebergabe an den Tab nur "blocked" — ist die Uebergabe raus und die Antwort unklar -> "uncertain".
// Gesetzt wird der Sieger-Markt ueber das ganze Spiel: Fussball 1X2 (p.sport "fb") und — seit 1.2.64, 04.10.2026 — Basketball
// „Match Winner" (p.sport "basket": 2-Weg inklusive Verlaengerung, nur home/away, Seite W1 | W2). Vor dem Anpfiff und LIVE,
// streng getrennt ueber p.live. Jede andere Sportart wird abgewiesen (auch die Engine prueft das: export sports).
// LIVE-ANNAHME: das Buch haelt die Antwort zurueck, bis es entschieden hat (mitgelesen 13,4 s). Der Tab antwortet dann
// { status:"pending", warteId, nachMs }, und DIESER Adapter wartet und fragt ueber efbetNachfragen nach — Zeitgeber eines
// verdeckten Tabs drosselt Chrome, die des Service Workers nicht.
"use strict";

const BUCH = "efbet";
const SEITE = "https://www.efbet.gr";
const TAB_MUSTER = ["https://www.efbet.gr/*", "https://efbet.gr/*"];
const INHALT = "content/efbet-place.js";
const BRUECKE = "content/efbet-inject.js";                      // Seiten-Welt (world MAIN)
const MIN_EINSATZ = 0.1, MAX_EINSATZ = 1000;                    // Sicherheitsgrenzen (EUR), nicht die Limits des Buchs
const AUSWAHL_FORM = /^(\d{1,15}):(W1|X|W2)$/;                  // bookRef.outcomeId des Operators
// Sportart des Vorschlags (Feed-API v1) -> Sportart beim Tab-Script, erlaubte Auswahlen (Sicht des Operators) und Seiten des
// Sieger-Markts. Was hier fehlt, setzt dieser Adapter nicht.
const SPORT = {
  fb: { tab: "soccer", sel: { home: 1, draw: 1, away: 1 }, arten: { W1: 1, X: 1, W2: 1 } },
  basket: { tab: "basketball", sel: { home: 1, away: 1 }, arten: { W1: 1, W2: 1 } },
};
const HINWEIS = "sign in at efbet.gr and keep the tab open";
const NACHFRAGEN_MAX = 70;                                      // Obergrenze der Nachfragen; die Frist selbst haelt das Tab-Script (75 s)
const STAND_TTL_MS = 60000;                                     // so lange gilt ein gelesener Zustand (der Heartbeat fragt oefter)
const STAND_ZEIGEN_MS = 5 * 60000;                              // so lange nennt der Status den letzten Kontostand
const STAND_FRIST_MS = 9000;                                    // laenger wartet der Heartbeat nicht auf den Tab
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _stand = null;                                              // { bereit, grund, at } — zuletzt gelesener Zustand des Tabs
let _saldo = null;                                              // { wert, at } — zuletzt gelesener Kontostand (nur Anzeige)
let _frageAt = 0;                                               // letzter Leseversuch — auch ein gescheiterter zaehlt

function tabsQuery(q) { return new Promise((rs) => { try { chrome.tabs.query(q, (t) => rs(t || [])); } catch (_) { rs([]); } }); }
function sendTab(tabId, msg) {
  return new Promise((rs) => {
    try { chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, (r) => { const e = chrome.runtime.lastError; rs(e ? { error: e.message } : (r || { error: "keine Antwort" })); }); }
    catch (e) { rs({ error: String((e && e.message) || e) }); }
  });
}
async function inject(tabId) {
  // Erst die Bruecke in der Seiten-Welt (idempotent; eine neuere Fassung uebernimmt den Socket der alten), dann das Setz-Script.
  try { await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: [BRUECKE] }); } catch (_) {}
  try { await chrome.scripting.executeScript({ target: { tabId }, files: [INHALT] }); return null; }
  catch (e) { return String((e && e.message) || e); }
}
async function efbetTab() {
  const tabs = await tabsQuery({ url: TAB_MUSTER });
  return tabs.find((t) => t && t.status === "complete" && !t.discarded) || tabs[0] || null;
}
// Der Tab muss GENAU unser Setz-Script tragen: erst nachladen (doppelt ist unschaedlich, beide Scripts schuetzen sich selbst),
// dann fragen. Erst wenn es antwortet, geht ein Auftrag raus — eine unklare Antwort danach ist dann wirklich "ungewiss".
async function tabBereit(tabId) {
  const ierr = await inject(tabId);
  if (ierr) return "Injektion fehlgeschlagen: " + ierr;
  const r = await sendTab(tabId, { cmd: "ping" });
  return (r && r.ok && r.bm === BUCH) ? null : "Setz-Script im Tab antwortet nicht";
}

// PURE: bookRef.outcomeId des Operators -> { outcomeId, art } | null.
export function auswahlAus(ref) {
  const m = AUSWAHL_FORM.exec(String(ref == null ? "" : ref));
  return m ? { outcomeId: m[1], art: m[2] } : null;
}
// PURE: Kontostand des Tab-Scripts (nur Zahlen + Waehrung) -> Format der Engine { saldo, bonus, hold, cur, ts } | null.
// saldo = Guthaben (balance). bonus = das groesste der Bonus-Felder (sie ueberschneiden sich je nach Konto — nie addieren).
// Reine Anzeige: der Kontostand ist nie ein Riegel und bestimmt keinen Einsatz (Operator 03.10.2026).
export function balanceAus(k, jetzt) {
  if (!k || typeof k !== "object") return null;
  const z = (x) => (typeof x === "number" && isFinite(x) && x >= 0 ? x : null);
  const saldo = z(k.balance);
  if (saldo == null) return null;
  const bonus = Math.max(z(k.bonus_balance) || 0, z(k.sport_bonus) || 0, z(k.bonus_money) || 0);
  const cur = /^[A-Z]{3}$/.test(String(k.waehrung == null ? "" : k.waehrung)) ? String(k.waehrung) : "EUR";
  return { saldo: Math.round(saldo * 100) / 100, bonus: Math.round(bonus * 100) / 100, hold: Math.round((z(k.frozen_balance) || 0) * 100) / 100, cur, ts: jetzt || Date.now() };
}

// Zustand des Tabs lesen (nur lesen): Bruecke da? Socket der Seite erfasst? angemeldet? Kontostand. Oeffnet NIE einen Tab.
// Hoechstens ein Leseversuch je Minute: der Heartbeat ruft oefter, und ein haengender Tab darf ihn nicht jedes Mal bremsen.
async function standLesen(erzwingen) {
  if (!erzwingen && Date.now() - _frageAt < STAND_TTL_MS) return _stand;
  _frageAt = Date.now();
  const tab = await efbetTab();
  if (!tab) { _stand = { bereit: false, grund: "kein efbet.gr-Tab offen — " + HINWEIS, at: Date.now() }; _saldo = null; return _stand; }
  const r = await new Promise((fertig) => {
    const frist = setTimeout(() => fertig({ grund: "Tab antwortet nicht (Zeitueberschreitung) — efbet.gr-Tab neu laden" }), STAND_FRIST_MS);
    (async () => {
      const nichtBereit = await tabBereit(tab.id);
      if (nichtBereit) return { grund: nichtBereit + " — efbet.gr-Tab neu laden" };
      return await sendTab(tab.id, { cmd: "efbetStand" });
    })().then((x) => { clearTimeout(frist); fertig(x); }, (e) => { clearTimeout(frist); fertig({ grund: String((e && e.message) || e).slice(0, 100) }); });
  });
  const bereit = !!(r && r.bruecke === true && r.socket === 1 && r.angemeldet === true);
  _stand = { bereit, grund: bereit ? "" : String((r && (r.grund || r.error)) || "Zustand nicht lesbar").slice(0, 140), at: Date.now() };
  const wert = bereit ? balanceAus(r.konto) : null;
  _saldo = wert ? { wert, at: Date.now() } : null;
  return _stand;
}
function saldoText() {
  if (!_saldo || Date.now() - _saldo.at > STAND_ZEIGEN_MS) return "";
  const w = _saldo.wert;
  return " · balance " + w.saldo.toFixed(2) + " " + w.cur + (w.bonus > 0 ? " · Bonus " + w.bonus.toFixed(2) : "");
}

export const id = "efbet";
export const sports = { fb: true, basket: true };                // Sportarten, die dieser Adapter setzt (engine-sw.js prueft das vor place)
// 1.2.69 (05.10.2026): dieser Adapter setzt Kombiwetten (mkt "parlay") — engine-core.js adapterKombi.
export const kombi = true;
export const hosts = { site: SEITE, api: "wss://eu-swarm-reverse.betconstruct.com (nur ueber den Socket der Seite)" };

export function arm(_ctx) { standLesen(true).catch(() => {}); }

// Bereit = der Tab ist offen, die Bruecke hat den Socket der Seite und die Seite ist angemeldet (zuletzt gelesener Zustand,
// hoechstens ~1 min alt; place() prueft unmittelbar vor dem Setzen ohnehin selbst).
export function status() {
  if (_stand && _stand.bereit && Date.now() - _stand.at < 3 * STAND_TTL_MS) return { ready: true, detail: "signed in" + saldoText() };
  if (_stand && !_stand.bereit) return { ready: false, detail: _stand.grund || HINWEIS };
  return { ready: false, detail: "state not read yet — " + HINWEIS };
}

export async function balance() {
  try { await standLesen(false); } catch (_) {}
  return (_saldo && Date.now() - _saldo.at < 2 * STAND_TTL_MS) ? _saldo.wert : null;
}

// ---- 1.2.69 — KOMBIWETTE ---------------------------------------------------------------------------------------------------
// EIN Schein mit mehreren Spielen: derselbe Befehl create_bets wie die Einzelwette, Type 2 mit allen Auswahlen. Der Ablauf steht
// im Seiten-Baustein content/efbet-kombi.js (byte-gleich mit efbet-kombi.js des Operators): Anmeldung, Doppel-Schutz, Regeln des
// Buchs (Steuer, Kombi-Quote), frische Quoten aller Beine in einer Anfrage, Hoechsteinsatz, dann EIN Auftrag an die
// Absende-Funktion des Setz-Scripts. Jedes Bein braucht die GENAUE Auswahl-Nummer des Operators (legs[].outcomeId) und den Tipp
// in der Reihenfolge des BUCHS (1 = W1, X, 2 = W2) — die Engine sucht nie selbst eine Auswahl.
const KOMBI_BAUSTEIN = "content/efbet-kombi.js";
const KOMBI_SPORT = { fb: "soccer", basket: "basketball" };       // Feed-Name der Sportart eines Beins → Name im Baustein
const KOMBI_NACHFRAGEN_MAX = 200;                                // der Baustein fragt alle 0,4 s und wartet selbst hoechstens 75 s
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
  // Kein Auto-Open: ohne offenen, eingeloggten Tab wird nicht gesetzt.
  const tab = await efbetTab();
  if (!tab) return { status: "blocked", reason: BUCH + ": kein efbet.gr-Tab offen — " + HINWEIS };
  const nichtBereit = await kombiBereit(tab.id);
  if (nichtBereit) return { status: "blocked", reason: BUCH + ": " + nichtBereit + " — efbet.gr-Tab neu laden" };
  // Auftrags-Nummer JE VERSUCH: der Baustein fuehrt dieselbe Nummer nie zweimal aus.
  const auftragId = ("p-" + String(p.proposalId == null ? "" : p.proposalId).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 48) + "-" + Date.now().toString(36) + "-" + (++_kombiNr)).slice(0, 80);
  ctx.log(BUCH + ": parlay · " + legs.length + " legs · " + einsatz + " EUR @ ≥" + Number(p.minOdds));
  const t0 = Date.now();
  let r = await sendTab(tab.id, { cmd: "efbetPlaceCombo", auftragId, armed: true, amount: einsatz, minTotalOdds: Number(p.minOdds), legs });
  // „kein Empfaenger“ gleich nach dem beantworteten Ping: der Auftrag kam im Tab nie an — nachweislich nichts gesendet.
  if (r && r.error && !r.status && /Receiving end does not exist|Could not establish connection/i.test(String(r.error))) return { status: "blocked", reason: BUCH + ": Tab nicht erreichbar (Auftrag kam nicht an)" };
  // Der Schein ist beim Buch, sobald der Baustein „pending“ meldet: HIER warten und nachfragen (Zeitgeber des Service Workers).
  let nachfragen = 0;
  while (r && r.status === "pending" && r.warteId && nachfragen < KOMBI_NACHFRAGEN_MAX) {
    nachfragen++;
    const wartet = r;
    await sleep(Math.max(250, Math.min(10000, Number(r.nachMs) || 0)));
    r = await sendTab(tab.id, { cmd: "efKombiNachfragen", warteId: wartet.warteId });
    if (!r || !r.status) r = { status: "uncertain", odds: wartet.odds, reason: BUCH + ": Tab antwortet beim Nachfragen nicht (" + String(r && r.error).slice(0, 100) + ") — der Schein war beim Buch, im Konto pruefen" };
  }
  if (r && r.status === "pending") r = { status: "uncertain", odds: r.odds, reason: BUCH + ": nach " + nachfragen + " Nachfragen noch keine Antwort des Buchs — im Konto pruefen" };
  ctx.log(BUCH + ": parlay answer after " + (Date.now() - t0) + " ms" + (nachfragen ? " (" + nachfragen + " follow-ups)" : "") + " · " + (r && r.status ? r.status : "?") + (r && r.ticket ? " · bet " + r.ticket : "") + (r && r.reason ? " · " + String(r.reason).slice(0, 260) : "") + (r && r.note ? " · " + String(r.note).slice(0, 200) : ""));
  _frageAt = 0;                                                  // nach einem Auftrag Zustand und Kontostand neu lesen
  if (!r || !r.status) return { status: "uncertain", reason: BUCH + ": keine Antwort vom Tab (" + String(r && r.error) + ") — im Konto pruefen" };
  return { status: r.status, odds: r.odds, stake: r.stake, reason: r.reason, note: r.note, ticket: r.ticket != null ? String(r.ticket) : undefined, verified: r.verified, legs: r.legs, ms: r.ms, tax: r.tax, netOdds: r.netOdds };
}

export async function place(p, stakeEur, ctx) {
  if (p && p.mkt === "parlay") return await placeKombi(p, stakeEur, ctx);
  const sel = p && p.sel;
  const sp = p && Object.prototype.hasOwnProperty.call(SPORT, String(p.sport)) ? SPORT[String(p.sport)] : null;
  if (!sp) return { status: "blocked", reason: BUCH + ": Sportart " + String(p && p.sport) + " nicht unterstuetzt" };
  if (!Object.prototype.hasOwnProperty.call(sp.sel, String(sel))) return { status: "blocked", reason: BUCH + ": ungueltige Auswahl " + String(sel) };
  if ((p.mkt || "ml") !== "ml") return { status: "blocked", reason: BUCH + ": Markt " + String(p.mkt) + " nicht unterstuetzt" };
  const eventId = p.bookRef && p.bookRef.eventId;
  if (!eventId) return { status: "blocked", reason: BUCH + ": bookRef.eventId fehlt (Engine loest nie selbst auf)" };
  if (!/^\d{1,15}$/.test(String(eventId))) return { status: "blocked", reason: BUCH + ": bookRef.eventId unlesbar" };
  const aw = auswahlAus(p.bookRef && p.bookRef.outcomeId);
  if (!aw) return { status: "blocked", reason: BUCH + ": bookRef.outcomeId fehlt oder hat nicht die Form <Nummer>:<W1|X|W2> (ohne genaue Auswahl des Operators wird nicht gesetzt)" };
  if (!Object.prototype.hasOwnProperty.call(sp.arten, aw.art)) return { status: "blocked", reason: BUCH + ": Seite " + aw.art + " gibt es im Sieger-Markt dieser Sportart nicht" };
  const einsatz = Math.round(Number(stakeEur) * 100) / 100;
  if (!(einsatz >= MIN_EINSATZ) || einsatz > MAX_EINSATZ) return { status: "blocked", reason: BUCH + ": Einsatz " + einsatz + " ausserhalb " + MIN_EINSATZ + "-" + MAX_EINSATZ };
  if (!(Number(p.minOdds) > 1)) return { status: "blocked", reason: BUCH + ": minOdds fehlt" };

  // Kein Auto-Open: ohne offenen, eingeloggten Tab wird nicht gesetzt.
  const tab = await efbetTab();
  if (!tab) return { status: "blocked", reason: BUCH + ": kein efbet.gr-Tab offen — " + HINWEIS };
  const nichtBereit = await tabBereit(tab.id);
  if (nichtBereit) return { status: "blocked", reason: BUCH + ": " + nichtBereit + " — efbet.gr-Tab neu laden" };

  const live = p.live === true;
  const auswahl = { eventId: String(eventId), outcomeId: aw.outcomeId, art: aw.art, sel, live, sport: sp.tab };
  ctx.log(BUCH + ": uebergebe Auswahl " + auswahl.outcomeId + " (" + aw.art + "; " + sel + " aus Operator-Sicht) auf Spiel " + auswahl.eventId + (live ? " · LIVE" : "") + (sp.tab !== "soccer" ? " · " + sp.tab : "") + " · " + einsatz + " EUR, Floor " + Number(p.minOdds));
  const t0 = Date.now();
  let r = await sendTab(tab.id, { cmd: "efbetPlace", auswahl, einsatz, minOdds: Number(p.minOdds) });
  // Das Buch haelt die Antwort zurueck (live): HIER warten und nachfragen. Der Schein ist dann schon beim Buch — reisst der
  // Tab ab, ist der Ausgang offen (uncertain), nie "nicht gesetzt".
  let nachfragen = 0;
  while (r && r.status === "pending" && r.warteId && nachfragen < NACHFRAGEN_MAX) {
    nachfragen++;
    const wartet = r;
    await sleep(Math.max(250, Math.min(10000, Number(r.nachMs) || 0)));
    r = await sendTab(tab.id, { cmd: "efbetNachfragen", warteId: wartet.warteId });
    if (!r || !r.status) r = { status: "uncertain", odds: wartet.odds, buchSel: wartet.buchSel, reason: BUCH + ": Tab antwortet beim Nachfragen nicht (" + String(r && r.error).slice(0, 100) + ") — der Schein war beim Buch, im Konto pruefen" };
  }
  if (r && r.status === "pending") r = { status: "uncertain", odds: r.odds, buchSel: r.buchSel, reason: BUCH + ": nach " + nachfragen + " Nachfragen noch keine Antwort des Buchs — im Konto pruefen" };
  ctx.log(BUCH + ": answer after " + (Date.now() - t0) + " ms" + (nachfragen ? " (" + nachfragen + " follow-ups)" : "") + " · " + (r && r.status ? r.status : "?") + (r && r.ticket ? " · Bet no. " + r.ticket : "") + (r && r.reason ? " · " + String(r.reason).slice(0, 260) : "") + (r && r.note ? " · " + String(r.note).slice(0, 200) : ""));
  _frageAt = 0;                                                  // nach einem Auftrag Zustand und Kontostand neu lesen
  if (!r || !r.status) {
    // "Receiving end does not exist" = der Auftrag kam im Tab nie an -> nachweislich nichts gesendet. Jeder andere Abriss
    // kann NACH dem Absenden liegen: uncertain (Wahrheitstabelle), nie blocked.
    if (r && /Receiving end does not exist|Could not establish connection/i.test(String(r.error))) return { status: "blocked", reason: BUCH + ": Tab nicht erreichbar (Auftrag kam nicht an)" };
    return { status: "uncertain", reason: BUCH + ": keine Antwort vom Tab (" + String(r && r.error) + ") — im Konto pruefen" };
  }
  return r;
}
