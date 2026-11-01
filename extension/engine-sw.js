// engine-sw.js — service worker: transport + orchestration. Holds NO betting logic and NO model:
// pull signed proposals, verify, apply the operator's settings, hand to the book adapter, report back.
//
// Der Betreiber dieser Engine stellt NICHTS ein außer: an/aus und welche seiner Buchmacher-Konten
// aktiv sind. Alle Vorgaben (EV-Schwelle, Einsatz, Bänder) kommen signiert vom Operator und werden
// hier nur angezeigt. Fail-closed: ohne gültige, frische Konfiguration wird nicht gesetzt.
//
// Adding a book later = drop books/<id>.js in and add one line to ADAPTERS.
"use strict";
import * as CORE from "./engine-core.js";
import * as fonbet from "./books/fonbet.js";
import * as mystake from "./books/mystake.js";
import * as trustdice from "./books/trustdice.js";
import * as fonbetgr from "./books/fonbet-gr.js";
import * as stoiximan from "./books/stoiximan.js";
import * as superbet from "./books/superbet.js";
import * as elabet from "./books/elabet.js";
import * as efbet from "./books/efbet.js";
// 1.2.76 (18.10.2026): pamestoixima.gr — Einzelwette + Kombi aus dem Tab der Seite (griechische Adresse noetig).
import * as pamestoixima from "./books/pamestoixima.js";
// 1.2.78 (21.10.2026): interwetten.gr — Einzelwette Sieger (Fussball/Basketball, vor dem Anpfiff und live) aus dem Tab der Seite.
import * as interwetten from "./books/interwetten.js";
// 1.2.83 (31.10.2026): Foxtipp, BetOnline (je Einzelwette Sieger Fussball vor dem Anpfiff) und Orbit (BACK Sieger Fussball, vor dem Anpfiff und live), je aus dem Tab des Kontoinhabers.
import * as foxtipp from "./books/foxtipp.js";
import * as betonline from "./books/betonline.js";
import * as orbitxch from "./books/orbitxch.js";
// 1.2.72: Kombiwette bei Fonbet — der Baustein (FBKOMBI, byte-gleich mit fonbet-kombi.js des Operators) laeuft HIER im Service
// Worker, weil die Engine bei Fonbet von hier aus setzt (books/fonbet.js kombiSetzen ruft ihn auf).
import "./content/fonbet-kombi.js";
import "./content/trustdice-kombi.js";   // 31.10.2026: nur die Adresse des Scheins; die Abgabe laeuft im Tab

const ADAPTERS = { fonbet, mystake, trustdice, jackbit: mystake, fonbetgr, stoiximan, superbet, elabet, efbet, pamestoixima, interwetten, foxtipp, betonline, orbitxch };
// Manche Buecher sind dasselbe Angebot auf einer anderen Laenderseite. Fonbet GR fuehrt NACHWEISLICH
// dieselben Event-IDs wie fonbet001.com (2620 gemeinsame IDs, 99 % identische Paarungen, geprueft
// 29.07.2026) — ein Proposal fuer "fonbet" kann deshalb unveraendert dort ausgefuehrt werden.
// Der Operator muss davon nichts wissen; der Bettor hakt einfach die Seite an, bei der er ein Konto hat.
const VENUES = { fonbet: ["fonbet", "fonbetgr"] };
function venuesFor(book) { return VENUES[book] || [book]; }
// Version IMMER aus dem Manifest lesen — eine zweite, handgepflegte Zahl driftet sonst ab und die
// Statusanzeige luegt (genau das ist am 29.07. passiert: Paket 1.0.1, gemeldet wurde 1.0.0).
const ENGINE_VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return "?"; } })();
const POLL_ALARM = "engine-poll";
const LOG_MAX = 800;   // reicht fuer eine komplette Fehlersuche zum Kopieren
const CFG_MAX_AGE_MS = 6 * 3600 * 1000;     // Vorgaben älter als 6 h = Operator schweigt → nicht setzen

const store = {
  get: (k, d) => new Promise((rs) => { try { chrome.storage.local.get(k, (c) => rs(c && c[k] !== undefined ? c[k] : d)); } catch (_) { rs(d); } }),
  set: (k, v) => new Promise((rs) => { try { const o = {}; o[k] = v; chrome.storage.local.set(o, () => rs()); } catch (_) { rs(); } }),
};
// SERIALISIERT: lesen-anhaengen-schreiben ist nicht atomar. Zwei Aufrufe kurz hintereinander lasen
// beide denselben Stand, und der zweite ueberschrieb den ersten — Eintraege gingen still verloren
// (30.07.: die beiden DIAGNOSE-Zeilen wurden von der direkt folgenden Zeile geschluckt).
let _logChain = Promise.resolve();
function log(msg) {
  const entry = { t: new Date().toISOString(), msg: String(msg) };
  _logChain = _logChain.then(async () => {
    const l = (await store.get("engineLog", [])) || [];
    l.push(entry);
    while (l.length > LOG_MAX) l.shift();
    await store.set("engineLog", l);
  }).catch(() => {});
  return _logChain;
}
const ctx = { log, storageGet: (k) => store.get(k), storageSet: (k, v) => store.set(k, v) };

// ---- Verbindungs-Überwachung + Log-Push + deutliche Hinweise (v1.2.52) --------------------------
// Vorgabe: (1) den KOMPLETTEN Engine-Log 1:1 an den Operator pushen — bei Verbindungs-
// verlust sammelt er sich lokal (LOG_MAX=800) und wird beim Reconnect AUTOMATISCH nachgeliefert; (2) fetch
// mit Timeout, damit ein hängender Request den Burst nicht blockiert + „zuletzt-verbunden"-Tracking; (3)
// UNÜBERSEHBARE Hinweise, wenn eine Buch-Session ODER die Bridge weg ist: rotes Icon-Badge + Titel +
// requireInteraction-Notification, alle 5 Min wiederholt bis behoben. KEINE Setz-Logik berührt.
let _lastBridgeOkTs = 0;
async function _fetchT(url, opts, ms) {
  const ac = new AbortController(); const to = setTimeout(() => { try { ac.abort(); } catch (_) {} }, ms || 12000);
  try { return await fetch(url, Object.assign({ signal: ac.signal }, opts || {})); } finally { clearTimeout(to); }
}
const BOOK_LABEL = { fonbet: "Fonbet", fonbetgr: "Fonbet.gr", mystake: "MyStake", jackbit: "Jackbit", trustdice: "TrustDice", stoiximan: "Stoiximan", superbet: "Superbet", elabet: "Elabet", efbet: "efbet", pamestoixima: "pamestoixima", interwetten: "Interwetten", foxtipp: "Foxtipp", betonline: "BetOnline", orbitxch: "Orbit" };
function bmLabel(k) { return BOOK_LABEL[k] || k; }
// 64×64-Icon (Notifications brauchen eine gültige iconUrl; das Manifest hat keine) — farbiger Punkt + „!".
async function _notifIcon(color) {
  try {
    const c = new OffscreenCanvas(64, 64), x = c.getContext("2d");
    x.fillStyle = color; x.beginPath(); x.arc(32, 32, 30, 0, Math.PI * 2); x.fill();
    x.fillStyle = "#fff"; x.font = "bold 46px sans-serif"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText("!", 32, 35);
    const blob = await c.convertToBlob({ type: "image/png" });
    return await new Promise((rs) => { const fr = new FileReader(); fr.onload = () => rs(fr.result); fr.onerror = () => rs(null); fr.readAsDataURL(blob); });
  } catch (_) { return null; }
}
let _conn = { lastKey: "", lastNotifyTs: 0, wasDown: false };
async function connWatch(bookStatus, activeBooks) {
  const bridgeOk = (Date.now() - _lastBridgeOkTs) < 90000;   // 90 s ohne erfolgreichen Bridge-Call = getrennt
  const down = [];
  if (!bridgeOk) down.push("Operator/Bridge");
  for (const k of (activeBooks || [])) { const s = bookStatus && bookStatus[k]; if (!s || s.ready !== true) down.push(bmLabel(k)); }
  const anyDown = down.length > 0, key = down.join(", ");
  try { chrome.action.setBadgeText({ text: anyDown ? "!" : "" }); chrome.action.setBadgeBackgroundColor({ color: anyDown ? "#dc2626" : "#16a34a" }); } catch (_) {}
  try { chrome.action.setTitle({ title: anyDown ? ("⚠ Manometer Agent — not connected: " + key) : "Manometer Agent — connected ✓" }); } catch (_) {}
  if (anyDown) {
    if (key !== _conn.lastKey || (Date.now() - _conn.lastNotifyTs) > 300000) {   // neues Problem sofort, sonst alle 5 Min erneut
      _conn.lastKey = key; _conn.lastNotifyTs = Date.now(); _conn.wasDown = true;
      const icon = await _notifIcon("#dc2626");
      if (icon) { try { chrome.notifications.create("conn-down-" + Date.now(), { type: "basic", iconUrl: icon, title: "⚠ Manometer Agent: connection lost", message: "Not connected or signed in: " + key + ".\nBitte neu einloggen — sonst werden Wetten NICHT gesetzt.", priority: 2, requireInteraction: true }); } catch (_) {} }
      await log("⚠ NOT CONNECTED: " + key + " — notice shown");
    }
  } else if (_conn.wasDown) {
    _conn = { lastKey: "", lastNotifyTs: 0, wasDown: false };
    const icon = await _notifIcon("#16a34a");
    if (icon) { try { chrome.notifications.create("conn-ok-" + Date.now(), { type: "basic", iconUrl: icon, title: "✓ Manometer Agent: connected again", message: "All connections ok.", priority: 1 }); } catch (_) {} }
    await log("✓ connected again — all connections ok");
  }
}
// Kompletten Engine-Log an die Bridge spiegeln (enginelog-<channel>). Sammelt bei Disconnect lokal → beim
// nächsten erfolgreichen Push automatisch nachgeliefert (1:1-Sicht für den Operator, auch rückwirkend).
async function pushEngineLog(b) {
  try { const lg = (await store.get("engineLog", [])) || []; await bridgePostDoc(b, "enginelog-" + b.channel, { ts: Date.now(), executorId: b.executorId, instanz: await instanzId(), name: b.name || "", engineVersion: ENGINE_VERSION, n: lg.length, log: lg }); } catch (_) {}
}

// ---- Boot: der Zugang steckt im Paket (engine-boot.json), der Betreiber tippt nichts --------------
// 31.10.2026: Zugang und Schlüssel liegen in storage.local. Skripte auf den Buchmacher-Seiten sollen dort nicht hinkommen.
try { chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }); } catch (_) {}
let _boot = null;
async function boot() {
  if (_boot) return _boot;
  // 31.10.2026: Die Datei im Paket geht vor. Sonst bliebe nach einem Update über denselben Ordner der alte Zugang aus dem Speicher stehen, und der Agent zöge nie auf eine neue Bridge um.
  const saved = await store.get("engineBoot", null);
  try {
    const r = await fetch(chrome.runtime.getURL("engine-boot.json"));
    if (r.ok) {
      const datei = await r.json();
      if (datei && datei.bridgeUrl) {
        if (JSON.stringify(datei) !== JSON.stringify(saved)) await store.set("engineBoot", datei);
        _boot = datei;
        return _boot;
      }
    }
  } catch (_) {}
  if (saved && saved.bridgeUrl) { _boot = saved; return _boot; }
  return {};
}
// Lokale Wahl des Betreibers: an/aus + seine Bücher. Mehr gibt es hier nicht.
//
// HALTBARKEIT (29.07.2026): chrome.storage.local wird beim ENTFERNEN der Erweiterung gelöscht — und
// genau das passiert bei jedem Paket-Update. Deshalb dreifach gesichert:
//   1. storage.local  — schnell, der Normalfall
//   2. storage.sync   — überlebt Neuinstallation, wenn der Betreiber in Chrome angemeldet ist
//   3. Bridge (st-<channel>) — überlebt IMMER, weil der Kanal im Paket steckt; wird beim ersten
//      Start ohne lokale Einstellung zurückgeholt (siehe restoreLocal).
const syncStore = {
  get: (k, d) => new Promise((rs) => { try { chrome.storage.sync.get(k, (c) => rs(c && c[k] !== undefined ? c[k] : d)); } catch (_) { rs(d); } }),
  set: (k, v) => new Promise((rs) => { try { const o = {}; o[k] = v; chrome.storage.sync.set(o, () => rs()); } catch (_) { rs(); } }),
};
function normLocal(l) { return { on: !!(l && l.on === true), books: Array.isArray(l && l.books) ? l.books : [] }; }
async function local() {
  const l = await store.get("engineLocal", null);
  if (l) return normLocal(l);
  // 31.10.2026: Ein Paket kann die Bücher dieser Kopie vorgeben (zwei Browser an einem Konto). Nur beim ersten Start, der Schalter bleibt aus: Einschalten tut der Kontoinhaber selbst.
  const vorwahl = (await boot()).buecher;
  if (Array.isArray(vorwahl) && vorwahl.length) { const v = normLocal({ on: false, books: vorwahl }); await setLocal(v); return v; }
  const sy = await syncStore.get("engineLocal", null);          // Neuinstallation: aus dem Chrome-Sync
  if (sy) { await store.set("engineLocal", sy); await log("Settings restored from Chrome sync"); return normLocal(sy); }
  return { on: false, books: [], missing: true };               // noch nichts da -> Bridge fragen
}
async function setLocal(l) {
  const v = normLocal(l);
  await store.set("engineLocal", v);
  await syncStore.set("engineLocal", v);
}
// Letzte bekannte Einstellung von der Bridge zurückholen (nur wenn lokal NICHTS vorhanden ist).
async function restoreLocal(b) {
  try {
    const st = await bridgeGet(b, "/api/doc/st-" + b.channel);
    if (!st || typeof st !== "object") return null;
    if (String(st.executorId || "") !== String(b.executorId)) return null;
    // 31.10.2026: Das Dokument ist nicht signiert, also darf es den Agent nicht einschalten: Bücher zurück, Schalter bleibt aus.
    const v = normLocal({ on: false, books: st.booksActive });
    if (!v.books.length) return null;
    await setLocal(v);
    await log("Bookmakers restored after reinstall: " + v.books.join(", ") + " · switch on by hand");
    return v;
  } catch (_) { return null; }
}

// ---- HMAC ---------------------------------------------------------------------------------------
async function hmacHex(payload, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function sameHex(a, b) {
  a = String(a || "").toLowerCase(); b = String(b || "").toLowerCase();
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function verifySigned(obj, secret) {
  try { return !!(obj && obj.sig && secret) && sameHex(obj.sig, await hmacHex(CORE.proposalSigningPayload(obj), secret)); }
  catch (_) { return false; }
}

// ---- Bridge -------------------------------------------------------------------------------------
async function bridgeGet(b, path, fristMs) {
  // 31.10.2026: Die eigene Bridge verlangt auch zum Lesen den Schlüssel dieses Agents (bridgeKey aus dem Paket). Ein Paket für die alte Bridge hat keinen und liest wie bisher.
  const r = await _fetchT(b.bridgeUrl.replace(/\/$/, "") + path, b.bridgeKey ? { cache: "no-store", headers: { "X-Read-Key": b.bridgeKey, "X-Executor": b.executorId } } : { cache: "no-store" }, fristMs || 12000);
  if (!r.ok) throw new Error("HTTP " + r.status);
  _lastBridgeOkTs = Date.now();
  return await r.json();
}
async function instanzId() {
  let i = await store.get("engineInstanz", null);
  if (!i) { i = crypto.randomUUID(); await store.set("engineInstanz", i); }
  return i;
}
async function bridgeAnspruch(b, proposalId) {
  if (!b.bridgeKey) return { ok: true };   // die alte Bridge kennt das nicht
  try {
    const r = await _fetchT(b.bridgeUrl.replace(/\/$/, "") + "/api/claim", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", "X-Write-Key": b.bridgeKey, "X-Executor": b.executorId }, body: JSON.stringify({ proposalId, instanz: await instanzId() }) }, 8000);
    return r.ok ? { ok: true } : { ok: false, andere: r.status === 409 };
  } catch (_) { return { ok: false }; }
}
async function bridgePostDoc(b, name, body) {
  const r = await _fetchT(b.bridgeUrl.replace(/\/$/, "") + "/api/doc/" + name, {
    method: "POST", cache: "no-store",
    headers: b.bridgeKey ? { "Content-Type": "application/json", "X-Write-Key": b.bridgeKey, "X-Executor": b.executorId } : { "Content-Type": "application/json", "X-Write-Key": b.docKey || "" },
    body: JSON.stringify(body),
  }, 12000);
  if (!r.ok) throw new Error("HTTP " + r.status);
  _lastBridgeOkTs = Date.now();
}

// ---- Vorgaben des Operators (signiert, fail-closed) ---------------------------------------------
async function fetchConfig(b) {
  const doc = await bridgeGet(b, "/api/doc/cfg-" + b.channel);
  if (!doc || typeof doc !== "object") return { ok: false, reason: "no settings available yet" };
  if (!(await verifySigned(doc, b.secret))) return { ok: false, reason: "settings signature invalid" };
  if (String(doc.executorId || "") !== String(b.executorId)) return { ok: false, reason: "settings belong to another account" };
  if (!doc.ts || Date.now() - doc.ts > CFG_MAX_AGE_MS) return { ok: false, reason: "settings out of date (the operator is not reporting)" };
  // 31.10.2026: Eine ältere Fassung darf eine neuere nicht ersetzen (sonst ließe sich eine Sperre 6 h lang mit der Fassung davor aushebeln).
  const hoechste = Number(await store.get("engineCfgTs", 0)) || 0;
  if (Number(doc.ts) < hoechste) return { ok: false, reason: "settings older than the last valid ones" };
  if (Number(doc.ts) > hoechste) await store.set("engineCfgTs", Number(doc.ts));
  if (doc.killed) return { ok: false, reason: "blocked by the operator", cfg: doc };
  if (!doc.enabled) return { ok: false, reason: "disabled by the operator", cfg: doc };
  return { ok: true, cfg: doc };
}

// ---- Dedup-Lock (Truth-Table wie beim Operator) --------------------------------------------------
async function lockState() { return (await store.get("engineFired", {})) || {}; }
async function lockSet(id, state, extra) { const f = await lockState(); f[id] = Object.assign({ ts: Date.now(), state }, extra || {}); await store.set("engineFired", f); }
async function lockRelease(id, reason) { const f = await lockState(); if (f[id]) { delete f[id]; await store.set("engineFired", f); await log("lock released for " + id + " (" + reason + ")"); } }

// ---- Status/Receipts nach oben --------------------------------------------------------------------
let _lastStPush = 0;
async function pushStatus(b, cfgState, force) {
  // Beim 5-s-Burst-Polling nicht 12x/min den Status-Doc schreiben: ungezwungen max. alle 20 s,
  // nach einer Platzierung (force) immer sofort.
  if (!force && Date.now() - _lastStPush < 20000) return;
  _lastStPush = Date.now();
  const loc = await local();
  // bookStatus VOR dem try berechnen → connWatch kann es auch nutzen, wenn der Bridge-Push scheitert.
  const bookStatus = Object.keys(ADAPTERS).reduce((o, k) => { try { o[k] = ADAPTERS[k].status(k); } catch (_) { o[k] = { ready: false }; } return o; }, {});
  try {
    // Kontostände je AKTIVEM Buch, wenn der Adapter balance() anbietet (fonbet/fonbetgr). Best effort:
    // ein Fehler/kein-Login liefert null und blockiert den Heartbeat NICHT.
    const balances = {};
    for (const k of (loc.books || [])) {
      try { if (ADAPTERS[k] && typeof ADAPTERS[k].balance === "function") { const bal = await ADAPTERS[k].balance(k); if (bal) balances[k] = bal; } } catch (_) {}
    }
    const st = {
      ts: Date.now(), executorId: b.executorId, engineVersion: ENGINE_VERSION, zweiteKopie: Number(await store.get("engineZweiteKopie", 0)) || 0,
      instanz: await instanzId(), on: loc.on, booksActive: loc.books,   // instanz: 31.10.2026, zwei Browser an einem Konto (bridge.js mischeStaende)
      bookStatus: bookStatus,
      balances: balances,
      cfgOk: !!(cfgState && cfgState.ok), cfgReason: (cfgState && cfgState.reason) || null,
      receipts: (await store.get("engineReceipts", [])) || [],
    };
    await bridgePostDoc(b, "st-" + b.channel, st);
    await pushEngineLog(b);                                // Log 1:1 nach oben — backfillt bei Reconnect (lokal gesammelt)
  } catch (e) { await log("Status senden fehlgeschlagen: " + String((e && e.message) || e)); }
  // Verbindungs-Hinweise IMMER prüfen — auch wenn der Push oben scheiterte (dann meldet's genau die Bridge weg).
  try { await connWatch(bookStatus, loc.books); } catch (_) {}
}

// ---- Haupt-Tick ------------------------------------------------------------------------------------
let _busy = false;
const _retryAt = {};                 // proposalId -> fruehester naechster Versuch (ms)
const _rejected = {};                // proposalId -> schon einmal als ungueltig gemeldet
const RETRY_COOLDOWN_MS = 45000;
const _gehalten = {};                // proposalId -> Pause schon einmal gemeldet
// Ein Live-Vorschlag gilt 20 s. Gemessen 12:22–16:24 UTC: 9 von 27 sah der Agent erst nach 20–35 s. Der Takt hat das verursacht: Vor der Abfrage der
// Vorschläge kamen nacheinander Vorgaben, Keepalive, Kontostände, Status und Protokoll, je Anfrage rund 1,2 s, und jede konnte 12 s hängen. Ein Fehler bei den Vorgaben ließ den ganzen Durchlauf aus.
// Jetzt läuft das alles nebenher; der Takt wartet nur noch auf die Vorschläge. Bei einem Netzfehler gelten die letzten gültigen Vorgaben höchstens 60 s weiter. Sagt die Antwort selbst nein (gesperrt, aus, Signatur), gilt das sofort.
const VORGABEN_TAKT_MS = 10000, VORGABEN_GNADE_MS = 60000, VORSCHLAG_FRIST_MS = 6000;
let _cfgState = null, _cfgOkTs = 0, _cfgHolTs = 0, _cfgHolt = false;
async function vorgabenHolen(b) {
  if (_cfgHolt) return;
  _cfgHolt = true; _cfgHolTs = Date.now();
  try {
    let st, netz = false;
    try { st = await fetchConfig(b); } catch (e) { netz = true; st = { ok: false, reason: "bridge not reachable: " + String((e && e.message) || e) }; }
    if (st.ok) _cfgOkTs = Date.now();
    if (!(netz && _cfgState && _cfgState.ok && Date.now() - _cfgOkTs < VORGABEN_GNADE_MS)) _cfgState = st;
    await store.set("engineCfgState", _cfgState);
  } finally { _cfgHolt = false; }
}
let _stLauf = false, _stNochmal = false;
function statusNebenbei(b, force) {
  if (_stLauf) { if (force) _stNochmal = true; return; }
  _stLauf = true;
  pushStatus(b, _cfgState, force).catch(() => {}).finally(() => { _stLauf = false; if (_stNochmal) { _stNochmal = false; statusNebenbei(b, true); } });
}
let _nebenTs = 0;
// 01.11.2026: Konto lesen (books/konto-lesen.js). Nur nach Zustimmung des Kontoinhabers in den Einstellungen, alle 10 min, nur angehakte Bücher, nur mit der eigenen Bridge. Scheitert ein Buch, laufen die anderen weiter.
const KONTO_TAKT_MS = 600000, KONTO_PAKET = 150, KONTO_BUCHUNGEN = 1000;
let _kontoLauf = false, _kontoTs = 0;
async function kontoSenden(b, buch, teil) {
  const r = await _fetchT(b.bridgeUrl.replace(/\/$/, "") + "/api/konto", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", "X-Write-Key": b.bridgeKey, "X-Executor": b.executorId }, body: JSON.stringify(Object.assign({ buch }, teil)) }, 20000);
  if (!r.ok) throw new Error("HTTP " + r.status);
}
async function kontoLesenAlle(b, loc, sofort) {
  if (_kontoLauf || !b.bridgeKey || (!sofort && Date.now() - _kontoTs < KONTO_TAKT_MS)) return;
  if ((await store.get("engineKontoFreigabe", false)) !== true) return;
  _kontoLauf = true; _kontoTs = Date.now();
  try {
    const stand = (await store.get("engineKontoStand", {})) || {};
    for (const k of (loc.books || [])) {
      const ad = ADAPTERS[k];
      if (!ad || typeof ad.kontoLesen !== "function") continue;
      try {
        const m = stand[k] || {}, r = await ad.kontoLesen(k, m);
        if (!r) { stand[k] = Object.assign({}, m, { fehler: "not readable", ts: Date.now() }); continue; }
        const wetten = r.wetten || [], buchungen = (r.buchungen || []).slice(0, KONTO_BUCHUNGEN);
        for (let i = 0; i < wetten.length || i === 0; i += KONTO_PAKET) await kontoSenden(b, k, { wetten: wetten.slice(i, i + KONTO_PAKET), buchungen: i === 0 ? buchungen : [], summen: i === 0 ? r.summen : null, voll: r.voll === true && i + KONTO_PAKET >= wetten.length });
        stand[k] = Object.assign({}, m, r.merker || {}, { voll: m.voll === true || r.voll === true, ts: Date.now(), fehler: null, n: (m.n || 0) + wetten.length });
      } catch (e) { stand[k] = Object.assign({}, stand[k], { fehler: String((e && e.message) || e).slice(0, 120), ts: Date.now() }); }
    }
    await store.set("engineKontoStand", stand);
  } finally { _kontoLauf = false; }
}
function nebenarbeit(b, loc) {
  kontoLesenAlle(b, loc).catch(() => {});
  if (Date.now() - _cfgHolTs >= VORGABEN_TAKT_MS) vorgabenHolen(b).catch(() => {});
  // TrustDice-Keepalive (Operator-Parität): haelt die Session warm, unabhaengig von Proposals.
  if (Date.now() - _nebenTs >= VORGABEN_TAKT_MS) {
    _nebenTs = Date.now();
    try { if (ADAPTERS.trustdice && ADAPTERS.trustdice.keepalive && (loc.books || []).indexOf("trustdice") >= 0) Promise.resolve(ADAPTERS.trustdice.keepalive(ctx)).catch(() => {}); } catch (_) {}
  }
  statusNebenbei(b);
}
// Dieselbe Meldung nicht bei jedem Takt: Bei 3 s wären das 20 Zeilen in der Minute, und sie verdrängten das Nützliche aus dem Protokoll.
let _meldung = "", _meldungTs = 0;
async function einmalMelden(text) { if (text === _meldung && Date.now() - _meldungTs < 60000) return; _meldung = text; _meldungTs = Date.now(); await log(text); }
// Abgelaufen, bevor der Agent ihn gesehen hat: Der Betreiber erfährt es jetzt per Quittung. Sonst bliebe bei ihm alles gebucht und die Auswahl 36 h gesperrt, obwohl nie gesetzt wurde.
async function abgelaufenMelden(b, p, grund) {
  const hist = (await store.get("engineReceipts", [])) || [];
  if (hist.some((r) => r && r.proposalId === p.proposalId)) return;
  hist.push(CORE.buildReceipt(p, { reason: "not picked up in time: " + grund }, { now: Date.now(), executorId: b.executorId, engineVersion: ENGINE_VERSION, status: "failed", stakeEur: null, latencyMs: 0, threw: false }));
  while (hist.length > 300) hist.shift();
  await store.set("engineReceipts", hist);
  statusNebenbei(b, true);
}
async function tick() {
  if (_busy) return; _busy = true;
  try {
    const b = await boot();
    if (!b || !b.bridgeUrl || !b.channel || !b.secret) return;
    let loc = await local();
    if (loc.missing) { const r = await restoreLocal(b); if (r) loc = r; }
    if (!_cfgState) await vorgabenHolen(b);                // erster Takt nach dem Start des Service Workers
    nebenarbeit(b, loc);
    const cfgState = _cfgState || { ok: false, reason: "not checked yet" };
    if (!loc.on) return;                                   // der Betreiber hat die App aus
    if (!cfgState.ok) { await einmalMelden("no bets: " + cfgState.reason); return; }
    if (!loc.books.length) { await einmalMelden("no bets: no bookmaker ticked"); return; }
    const cfg = cfgState.cfg;

    let list = [];
    try { list = await bridgeGet(b, "/api/proposals", VORSCHLAG_FRIST_MS); } catch (e) { await einmalMelden("fetch failed: " + String((e && e.message) || e)); return; }
    if (!Array.isArray(list)) return;
    const fired = await lockState();
    const now = Date.now();

    for (const p of list) {
      if (!p || !p.proposalId) continue;
      if (String(p.executorId || "") !== String(b.executorId)) continue;      // für jemand anderen
      if (fired[p.proposalId]) continue;                                      // schon behandelt
      // Wiederholungs-Bremse (30.07.): Mit dem 5-s-Burst wurde ein blockiertes Proposal bis zu
      // 180x je TTL erneut versucht — bei Buechern mit Tab-Vordergrund (Jackbit) war der Browser
      // dadurch nicht mehr bedienbar. Erstversuch bleibt sofort, Wiederholungen fruehestens nach 45 s.
      if (_retryAt[p.proposalId] && now < _retryAt[p.proposalId]) continue;
      if ((cfg.books || []).indexOf(p.book) < 0) continue;                    // Buch vom Operator nicht erlaubt
      // Ausfuehrungsort waehlen: bevorzugt die im Proposal genannte Seite, sonst eine gleichwertige
      // Laenderseite, die der Bettor aktiviert hat (z. B. Fonbet GR statt Fonbet .com).
      const venue = venuesFor(p.book).find((v) => loc.books.indexOf(v) >= 0);
      if (!venue) continue;                                                   // keine passende Seite aktiv
      const adapter = ADAPTERS[venue];
      if (!adapter) continue;

      if (!(await verifySigned(p, b.secret))) { await log("ABGELEHNT (Signatur): " + p.proposalId); continue; }
      const v = CORE.validateProposal(p, now, {});
      if (!v.ok) {
        // NUR EINMAL protokollieren: ein abgelaufenes Proposal bleibt bis zum naechsten Publish im
        // Kanal und wurde bisher alle paar Sekunden erneut gemeldet — hunderte Zeilen, die alles
        // Nuetzliche aus dem Protokoll draengten (30.07.).
        if (!_rejected[p.proposalId]) {
          _rejected[p.proposalId] = true;
          await log("refused " + p.proposalId + ": " + v.errors.join("; "));
          // 01.11.2026: Auch ein Vorschlag, den die Pause je Buch bis zum Anpfiff hielt, braucht die Quittung, sonst bliebe er beim Betreiber gebucht.
          if (v.errors.some((x) => /^expired|already started/.test(x))) await abgelaufenMelden(b, p, v.errors.join("; "));
        }
        continue;
      }
      // Sportart (1.2.64): nur an einen Adapter geben, der sie setzt (CORE.adapterSetzt). Sonst wuerde z. B. ein Basketball-
      // Vorschlag bei einem reinen Fussball-Adapter wie Fussball behandelt. Nichts gesendet, nur einmal protokolliert.
      if (!CORE.adapterSetzt(adapter, p.sport)) {
        if (!_rejected[p.proposalId]) {
          _rejected[p.proposalId] = true;
          await log("refused " + p.proposalId + ": this version does not place " + String(p.sport) + " at " + venue);
        }
        continue;
      }

      // Kombiwette (1.2.65): nur an einen Adapter, der Kombis setzt (CORE.adapterKombi). Nichts gesendet, einmal protokolliert.
      if (p.mkt === "parlay" && !CORE.adapterKombi(adapter)) {
        if (!_rejected[p.proposalId]) {
          _rejected[p.proposalId] = true;
          await log("refused " + p.proposalId + ": this version does not place parlays at " + venue);
        }
        continue;
      }

      // Der Operator hat den Einsatz bereits nach SEINEN Vorgaben gerechnet; hier gilt nur noch der
      // vom Operator gesetzte Deckel als Sicherheitsnetz (der Betreiber kann nichts hochdrehen).
      let stake = Math.min(Number(p.stakeEur) || 0, Number(cfg.maxStakeEur) || Number(p.stakeEur) || 0);
      if (!(stake > 0)) { await log("refused " + p.proposalId + ": stake 0"); continue; }
      // zweite Prüfung der Wahl im Konto (signiert in den Vorgaben), dann die Grenzen, die nur auf diesem Rechner stehen.
      const wahl = CORE.wahlPruefen(p, cfg.wahl, stake);
      if (wahl.fehler) { if (!_rejected[p.proposalId]) { _rejected[p.proposalId] = true; await log("refused " + p.proposalId + ": " + wahl.fehler); } continue; }
      const grenze = CORE.eigeneGrenze(wahl.stake, await store.get("engineLimits", null), CORE.heuteGesetzt((await store.get("engineReceipts", [])) || [], now));
      if (grenze.fehler) { if (!_rejected[p.proposalId]) { _rejected[p.proposalId] = true; await log("refused " + p.proposalId + ": " + grenze.fehler); } continue; }
      stake = grenze.stake;
      // Pause je Buch aus dem Konto. Der Vorschlag bleibt liegen und kommt im nächsten Takt wieder; gesetzt wird er nur, solange er gilt, und nur über seiner Mindestquote.
      const versuche = (await store.get("engineLetzterVersuch", {})) || {};
      const pauseRest = CORE.pauseRest(p, cfg.wahl, versuche[venue], Date.now());
      if (pauseRest > 0) { if (!_gehalten[p.proposalId]) { _gehalten[p.proposalId] = true; await log("waiting " + p.proposalId + ": pause at " + venue + ", " + Math.ceil(pauseRest / 1000) + " s left"); } continue; }

      // 31.10.2026: Laufen zwei Kopien dieses Agents, setzt nur die erste (bridge.js /api/claim). Ohne Antwort wird nicht gesetzt: Der Vorschlag kommt beim nächsten Takt wieder.
      const anspruch = await bridgeAnspruch(b, p.proposalId);
      if (!anspruch.ok) {
        if (anspruch.andere) { await store.set("engineZweiteKopie", Date.now()); if (!_rejected[p.proposalId]) { _rejected[p.proposalId] = true; await log("NOT placed " + p.proposalId + ": a second copy of this Agent took the bet. Please remove the other copy."); } }
        continue;
      }
      await lockSet(p.proposalId, "fired", { book: venue, eventId: String(p.bookRef.eventId), stake });
      const versuchVorher = versuche[venue];
      versuche[venue] = Date.now(); await store.set("engineLetzterVersuch", versuche);   // vor dem Senden: Bricht der Worker mitten im Setzen ab, gilt die Pause trotzdem
      const t0 = Date.now();
      let res = null, threw = false;
      // Venue EXPLIZIT mitgeben: mystake/jackbit teilen sich ein Modul, dessen interne _brand-Variable
      // sonst dauerhaft "mystake" bleibt — jede Jackbit-Platzierung lief auf mystake.com (Fund 30.07.).
      try { res = await adapter.place(p, stake, Object.assign({}, ctx, { venue })); }
      catch (e) { threw = true; res = { reason: String((e && e.message) || e) }; await log("exception while placing (stays locked): " + res.reason); }

      const status = CORE.receiptStatus(res, threw);
      // Die Pause läuft ab dem Ende des Versuchs. „blocked“ hat das Buch nicht erreicht und zählt nicht, außer der Adapter hat dafür die Seite geöffnet (res.seite).
      if (status !== "blocked" || (res && res.seite === true)) versuche[venue] = Date.now(); else if (versuchVorher != null) versuche[venue] = versuchVorher; else delete versuche[venue];
      await store.set("engineLetzterVersuch", versuche);
      _retryAt[p.proposalId] = Date.now() + RETRY_COOLDOWN_MS;   // egal wie es ausging: nicht sofort wieder
      // 01.11.2026: res.endgueltig: Das Buch hat abgelehnt, ein neuer Versuch mit demselben Vorschlag brächte nur den nächsten Seitenwechsel.
      if ((status === "blocked" || status === "failed") && !(res && res.endgueltig === true)) await lockRelease(p.proposalId, status);
      else await lockSet(p.proposalId, status, { book: venue, eventId: String(p.bookRef.eventId), stake });

      const receipt = CORE.buildReceipt(p, res, { now: Date.now(), executorId: b.executorId, engineVersion: ENGINE_VERSION, status, stakeEur: stake, latencyMs: Date.now() - t0, threw });
      const hist = (await store.get("engineReceipts", [])) || [];
      hist.push(receipt); while (hist.length > 300) hist.shift();
      await store.set("engineReceipts", hist);
      await log(`${status}: ${p.mkt}${p.line != null ? " " + p.line : ""} ${p.sel} @ ${p.book} · ${receipt.stakeEur != null ? receipt.stakeEur : stake} €${receipt.partial ? " statt " + receipt.wantStake + " €" : ""} (Floor ${p.minOdds})` + (receipt.fillOdds ? ` · Fill ${receipt.fillOdds}` : "") + (receipt.reason ? ` · ${receipt.reason}` : ""));
      statusNebenbei(b, true);                              // Ergebnis sofort nach oben melden
    }
  } finally { _busy = false; }
}

// ---- Bet-Log des Betreibers (kommt fertig gesettlet vom Operator) --------------------------------------
async function fetchMyBetlog() {
  const b = await boot();
  if (!b || !b.bridgeUrl || !b.channel) return [];
  try {
    const doc = await bridgeGet(b, "/api/doc/log-" + b.channel);
    return Array.isArray(doc) ? doc : [];
  } catch (_) { return []; }
}

// ---- Verdrahtung ------------------------------------------------------------------------------------
for (const k of Object.keys(ADAPTERS)) { try { ADAPTERS[k].arm(ctx); } catch (e) { log("arm " + k + " fehlgeschlagen: " + String((e && e.message) || e)); } }
chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
// BURST-POLLING (30.07.): Chrome erlaubt keine Alarme unter 30 s — aber INNERHALB eines Alarm-
// Fensters darf eine Schleife alle ~5 s abrufen; die laufende Event-Verarbeitung haelt den Service
// Worker wach. Latenz Proposal->Abholung sinkt von 0-30 s auf 0-3 s (31.10.2026: Takt 3 s statt 5 s). Ein Guard verhindert
// ueberlappende Buersts (Alarm feuert waehrend der vorige Burst noch laeuft).
let _burstBusy = false;
async function tickBurst() {
  if (_burstBusy) return;
  _burstBusy = true;
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < 28000) {
      try { await tick(); } catch (_) {}
      await new Promise((rs) => setTimeout(rs, 3000));
    }
  } finally { _burstBusy = false; }
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === POLL_ALARM) tickBurst(); });
chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  // Notizen aus den Content-Skripten (DOM-Platzierung) ins Protokoll durchreichen.
  if (msg && msg.cmd === "engineNote") { try { log("[" + (msg.src || "content") + "] " + String(msg.msg || "")); } catch (_) {} return false; }
  // 31.10.2026: Alles andere nur von den eigenen Seiten der Erweiterung. Skripte auf den Buchmacher-Seiten schalten hier nichts um und lesen nichts aus.
  // Am Tab allein lässt sich das nicht erkennen: Auch die eigene Seite kann als Tab offen sein (Optionen, Bet-Log), also zählt die Adresse des Absenders.
  if (_s && _s.tab && String(_s.url || "").indexOf(chrome.runtime.getURL("")) !== 0) { reply({ ok: false }); return false; }
  (async () => {
    if (msg && msg.cmd === "engineStatus") {
      const b = await boot(), loc = await local();
      reply({
        version: ENGINE_VERSION, boot: { ok: !!(b && b.bridgeUrl), name: (b && b.name) || "", executorId: (b && b.executorId) || "", boardUrl: (b && b.boardUrl) || "" },
        local: loc, zweiteKopie: Number(await store.get("engineZweiteKopie", 0)) || 0, limits: CORE.limitsNorm(await store.get("engineLimits", null)), cfgState: await store.get("engineCfgState", null),
        books: Object.keys(ADAPTERS).reduce((o, k) => { try { o[k] = ADAPTERS[k].status(k); } catch (_) { o[k] = { ready: false, detail: "—" }; } return o; }, {}),
        log: (await store.get("engineLog", [])) || [], receipts: (await store.get("engineReceipts", [])) || [],
        fired: await lockState(),
      });
    } else if (msg && msg.cmd === "engineSetLimits") { const v = CORE.limitsNorm(msg.limits); await store.set("engineLimits", v); await log("Own limits changed: per bet " + (v.maxBet || "—") + " · per day " + (v.maxDay || "—")); reply({ ok: true, limits: v }); }
    else if (msg && msg.cmd === "engineSetKonto") { await store.set("engineKontoFreigabe", msg.on === true); await log("Account reading " + (msg.on === true ? "switched on" : "switched off") + " by the account holder"); if (msg.on === true) _kontoTs = 0; reply({ ok: true }); }
    else if (msg && msg.cmd === "engineKontoStatus") { const st = (await store.get("engineKontoStand", {})) || {}, kurz = {}; for (const k of Object.keys(st)) kurz[k] = { ts: st[k].ts, voll: !!st[k].voll, fehler: st[k].fehler || null, n: st[k].n || 0 }; reply({ on: (await store.get("engineKontoFreigabe", false)) === true, stand: kurz }); }
    else if (msg && msg.cmd === "engineSetLocal") { await setLocal({ on: !!msg.on, books: msg.books }); await log("Settings changed: " + (msg.on ? "ON" : "OFF") + " · bookmakers: " + ((msg.books || []).join(", ") || "keine")); await tick(); reply({ ok: true }); }
    else if (msg && msg.cmd === "engineTick") { await tick(); reply({ ok: true }); }
    else if (msg && msg.cmd === "engineBetlog") { reply({ rows: await fetchMyBetlog() }); }
    else reply({ ok: false });
  })();
  return true;
});
