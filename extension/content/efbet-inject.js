// efbet-inject.js — efbet.gr (BetConstruct „Swarm"): Bruecke zum Swarm-Socket der SEITE. Laeuft in der Seiten-Welt
// (world MAIN, document_start) auf https://www.efbet.gr/*. 04.10.2026.
//
// WARUM: efbet setzt nicht ueber einen HTTP-Abruf, sondern ueber den WebSocket der eingeloggten Seite (Befehl create_bets,
// mitgelesen an zwei echten Wetten des Betreibers am 04.10.2026). Die Anmeldung haengt an der SITZUNG dieses einen Sockets, und
// der Partner erlaubt nur eine Anmeldung zugleich (single_login) — ein zweiter Socket mit eigener Anmeldung koennte die Seite
// abmelden. Deshalb geht alles ueber GENAU den Socket der Seite. Die Anmeldung selbst fasst dieses Script nie an: es liest
// weder Token noch Cookie noch Speicher der Seite und meldet nie an.
//
// WAS ES TUT:
//  1. Es merkt sich den Swarm-Socket der Seite. Dafuer wird WebSocket.prototype.send umhuellt (wie die anderen *-inject.js
//     der Erweiterung fetch/XHR umhuellen): der Aufruf der Seite geht unveraendert weiter, nur das Objekt wird notiert.
//  2. Es nimmt Auftraege des Setz-Scripts (efbet-content.js, isolierte Welt) per window.postMessage an, sendet sie mit einer
//     eigenen Anfrage-Nummer (rid) ueber den Socket und reicht die Antwort mit dieser Nummer zurueck. Die Seite selbst
//     verwirft Antworten mit fremder Nummer (Swarm.js der Seite: `let t = this.requests.get(rid); if (!t) return;`).
//  3. Feste Befehlsliste. LESEN: get (nur source betting, nie als Abo), get_max_bet, bet_history, check_bet_status — die
//     Antworten gehen GEKUERZT zurueck (nur die Felder, die das Setz-Script braucht; check_bet_status traegt sonst den
//     Anmeldenamen). KONTO: nur Zahlen und Waehrung. SETZEN: nur create_bets und nur in genau der mitgelesenen Form — eine
//     Einzelwette, eine Auswahl, AcceptTypeId 0 (= keine Quotenaenderung annehmen), kein Superbet.
//     Seit Fassung 2 (05.10.2026, Kombiwetten): derselbe Befehl auch als KOMBIWETTE — Type 2 mit zwei bis zwoelf Auswahlen,
//     sonst Feld fuer Feld wie die Einzelwette (so baut ihn der Wettschein der Seite: useUserData.js, Events = alle Auswahlen,
//     Type = Multiple). VORGABEN: die oeffentlichen Regeln des Partners fuer Steuer und Kombi-Quote (partner.config) — nur
//     diese Felder gehen zurueck.
// Captcha: der Partner verlangt fuers Setzen keins (recaptcha_actions der Sitzung ohne create_bets, 04.10.2026). Verlangt er
// es je, antwortet der Swarm mit Code 27/34 — das geht als Ablehnung zurueck. Ein Captcha wird hier weder ausgeloest noch
// geloest; der Captcha-Weg der Seite (validateViaProtectionServices) wird bewusst NICHT benutzt.
// Dieselbe Datei liegt BYTE-GLEICH in der Manometer Agent der External Bettors (engine/content/efbet-inject.js).
(() => {
  "use strict";
  const MARKE = "__edgeEfbetSeite", V = 2;
  const VON_SEITE = "efbet-inject", VON_SCRIPT = "efbet-place";
  // Swarm-Hosts von BetConstruct (conf.json der Seite: app.swarm.socketUrl = wss://eu-swarm-reverse.betconstruct.com).
  const SWARM = /^wss:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.betconstruct\.com(?::\d+)?(?:[/?#]|$)/i;
  const LESE_FRIST_MAX = 30000, SETZ_FRIST_MAX = 180000;
  // Profil-Felder fuer den Kontostand (nur Zahlen + Waehrung; Namen wie im Profil-Objekt der Seite, useUserData.js).
  const KONTO_FELDER = ["balance", "bonus_balance", "frozen_balance", "bonus_money", "sport_bonus", "casino_balance", "currency_name", "currency"];
  // Regeln des Partners, die der Kombi-Baustein braucht (oeffentlich, ohne Anmeldung lesbar): Gewinnsteuer und Kombi-Quote.
  const VORGABEN_FELDER = ["tax_type", "tax_percent", "tax_amount_ranges", "tax_integration_type", "tax_sportIds", "max_odd_for_multiple_bet", "max_selections_in_multiple_bet", "multiple_price_decimals", "price_round_method", "min_bet_stakes", "max_payout"];
  const KOMBI_MIN = 2, KOMBI_MAX = 12;

  let alt = null;
  try { alt = window[MARKE] || null; } catch (_) {}
  if (alt && Number(alt.v) >= V) return;                         // schon da (Manifest + Nachladen): ein Empfaenger reicht
  const proto = window.WebSocket && window.WebSocket.prototype;
  if (!proto || typeof proto.send !== "function") return;

  const zustand = { v: V, aktiv: true, sock: null, seit: 0, merke: null };
  const offen = new Map();                                       // rid -> { id, art, command, ws, t }
  const RID = "edge" + Math.random().toString(36).slice(2, 10) + "x";
  let nr = 0, setzt = false;

  // ---- 1) Socket der Seite merken ---------------------------------------------------------------------------------------
  function beiSchluss(ev) {
    const ws = ev && ev.target;
    for (const [rid, w] of offen) if (w.ws === ws) fertig(rid, { ok: false, gesendet: true, fehler: "Socket der Seite geschlossen" });
    if (zustand.sock === ws) { zustand.sock = null; zustand.seit = 0; }
  }
  function beiNachricht(ev) {
    if (!offen.size) return;                                      // nur wenn eine eigene Anfrage offen ist, wird ueberhaupt hingesehen
    const s = ev && ev.data;
    if (typeof s !== "string") return;
    for (const rid of offen.keys()) {
      if (s.indexOf(rid) < 0) continue;                           // billig vorsieben: die grossen Abo-Nachrichten der Seite werden nie geparst
      let j = null; try { j = JSON.parse(s); } catch (_) { return; }
      if (!j || String(j.rid) !== rid) continue;
      antwort(rid, j);
      return;
    }
  }
  function merke(ws) {
    if (!zustand.aktiv || !ws || ws === zustand.sock) return;
    let url = ""; try { url = String(ws.url || ""); } catch (_) { return; }
    if (!SWARM.test(url)) return;
    zustand.sock = ws; zustand.seit = Date.now();
    try { ws.addEventListener("message", beiNachricht); ws.addEventListener("close", beiSchluss); } catch (_) {}
  }
  zustand.merke = merke;
  let echtSend = proto.send.__edgeEfbetEcht || null;
  if (!echtSend) {
    echtSend = proto.send;
    const huelle = function send() {
      try { const z = window[MARKE]; if (z && z.merke) z.merke(this); } catch (_) {}
      return echtSend.apply(this, arguments);
    };
    try { Object.defineProperty(huelle, "__edgeEfbetEcht", { value: echtSend }); } catch (_) {}
    proto.send = huelle;
  }
  // Aeltere Fassung (Erweiterung aktualisiert, Seite nicht neu geladen): abschalten und ihren Socket uebernehmen.
  if (alt) { try { alt.aktiv = false; alt.merke = null; } catch (_) {} }
  try { Object.defineProperty(window, MARKE, { value: zustand, configurable: true, writable: true, enumerable: false }); } catch (_) { try { window[MARKE] = zustand; } catch (_e) {} }
  if (alt && alt.sock) merke(alt.sock);

  // ---- 2) Antworten kuerzen (PURE): nur was das Setz-Script braucht ------------------------------------------------------
  const zahl = (x) => (typeof x === "number" && isFinite(x) ? x : (typeof x === "string" && x !== "" && isFinite(Number(x)) ? Number(x) : null));
  function kurzWetten(d) {
    const b = d && d.bets;
    if (Array.isArray(b)) return { bets: b.slice(0, 500).map((w) => ({ id: w && w.id, typ: w && w.type, zeit: w && w.date_time, quote: zahl(w && w.k), einsatz: zahl(w && w.amount), ausgang: w && w.outcome,
      auswahl: (Array.isArray(w && w.events) ? w.events : []).slice(0, 30).map((e) => ({ id: e && e.selection_id, spiel: e && e.game_id, quote: zahl(e && e.coeficient) })) })) };
    if (b && typeof b === "object" && b.count != null) return { bets: { count: zahl(b.count) } };
    return { bets: null };
  }
  function kurzStatus(d) {
    const x = d && d.details;
    if (!x || typeof x !== "object") return { result: d ? d.result : null, result_text: d && d.result_text != null ? String(d.result_text).slice(0, 80) : null, details: null };
    return { result: d.result, result_text: d.result_text != null ? String(d.result_text).slice(0, 80) : null,
      details: { Id: x.Id, StateId: x.StateId, StateName: x.StateName != null ? String(x.StateName).slice(0, 40) : null, TypeId: x.TypeId, Price: zahl(x.Price), Amount: zahl(x.Amount), IsSuperBet: x.IsSuperBet === true, IsLive: x.IsLive === true,
        SelectionList: (Array.isArray(x.SelectionList) ? x.SelectionList : []).slice(0, 30).map((s) => ({ SelectionId: s && s.SelectionId, MatchId: s && s.MatchId, Price: zahl(s && s.Price), State: s && s.State })) } };
  }
  function kurzMax(d) {
    const a = d && d.details && typeof d.details === "object" ? zahl(d.details.amount) : null;
    return { result: d ? d.result : null, result_text: d && d.result_text != null ? String(d.result_text).slice(0, 80) : null, details: a == null ? null : { amount: a } };
  }
  function kurzKonto(d) {
    // Antwort der Form { data: { profile: { <id>: { … } } } } — nur Zahlen und die Waehrung gehen zurueck, nie Name, Mail, Adresse.
    const p = d && d.data && d.data.profile && typeof d.data.profile === "object" ? d.data.profile : null;
    const k = p ? Object.keys(p) : [];
    if (k.length !== 1 || !p[k[0]] || typeof p[k[0]] !== "object") return { konto: null };
    const x = p[k[0]], aus = {};
    for (const f of KONTO_FELDER) { if (f === "currency_name" || f === "currency") { if (typeof x[f] === "string" && /^[A-Za-z]{3}$/.test(x[f])) aus.waehrung = x[f].toUpperCase(); } else { const z = zahl(x[f]); if (z != null) aus[f] = z; } }
    return { konto: aus };
  }
  function kurzVorgaben(d) {
    // Antwort der Form { data: { partner: { <id>: { … } } } } — nur die Regel-Felder gehen zurueck (Zahlen, die Stufen der Steuer).
    const p = d && d.data && d.data.partner && typeof d.data.partner === "object" ? d.data.partner : null;
    const k = p ? Object.keys(p) : [];
    if (k.length !== 1 || !p[k[0]] || typeof p[k[0]] !== "object") return { vorgaben: null };
    const x = p[k[0]], aus = {};
    for (const f of VORGABEN_FELDER) {
      const v = x[f];
      if (typeof v === "number" || typeof v === "boolean" || v === null) aus[f] = v;
      else if (f === "tax_amount_ranges" && Array.isArray(v)) aus[f] = v.slice(0, 20).map((s) => ({ from: zahl(s && s.from), to: zahl(s && s.to), type: zahl(s && s.type), percent: zahl(s && s.percent), entire_amount: !!(s && s.entire_amount) }));
      else if (f === "min_bet_stakes" && v && typeof v === "object") { const e = zahl(v.EUR); aus[f] = e == null ? null : { EUR: e }; }
      else if (f === "tax_sportIds" && Array.isArray(v)) aus[f] = v.slice(0, 50).filter((s) => typeof s === "number" || typeof s === "string");
    }
    return { vorgaben: aus };
  }
  function kurzSetzen(d) {
    if (!d || typeof d !== "object") return null;
    const aus = { StatusCode: d.StatusCode != null ? String(d.StatusCode).slice(0, 80) : null };
    if (Array.isArray(d.Data)) aus.Data = d.Data.slice(0, 5).map((w) => ({ bet_id: w && w.bet_id, k: zahl(w && w.k), amount: zahl(w && w.amount), type: w && w.type, is_superbet: !!(w && w.is_superbet), IsLive: !!(w && w.IsLive),
      events: (Array.isArray(w && w.events) ? w.events : []).slice(0, 30).map((e) => ({ selection_id: e && e.selection_id, game_id: e && e.game_id, k: zahl(e && e.k) })) }));
    else if (typeof d.Data === "string") aus.Data = d.Data.slice(0, 300);
    else if (d.Data && typeof d.Data === "object") {
      // Ablehnung des Wett-Systems: { Key, ErrorData } — nur der Schluessel und flache Zahlen/Texte der Fehlerdaten.
      const fd = d.Data.ErrorData && typeof d.Data.ErrorData === "object" ? d.Data.ErrorData : {}, ed = {};
      for (const k of Object.keys(fd).slice(0, 12)) { const v = fd[k]; if (typeof v === "number" || typeof v === "boolean") ed[k] = v; else if (typeof v === "string") ed[k] = v.slice(0, 80); }
      aus.Data = { Key: d.Data.Key != null ? String(d.Data.Key).slice(0, 80) : null, ErrorData: ed };
    } else aus.Data = null;
    return aus;
  }
  function kuerze(w, j) {
    const code = j.code, msg = j.msg != null ? String(j.msg).slice(0, 120) : null;
    let data = null;
    if (code === 0) {
      if (w.art === "setzen") data = kurzSetzen(j.data);
      else if (w.art === "konto") data = kurzKonto(j.data);
      else if (w.art === "vorgaben") data = kurzVorgaben(j.data);
      else if (w.command === "bet_history") data = kurzWetten(j.data);
      else if (w.command === "check_bet_status") data = kurzStatus(j.data);
      else if (w.command === "get_max_bet") data = kurzMax(j.data);
      else data = j.data && j.data.data !== undefined ? { data: j.data.data } : null;      // get (source betting): oeffentliche Wettdaten
    } else if (typeof j.data === "string") data = j.data.slice(0, 120);                     // z. B. „Not logged in for command_…“
    return { code, msg, data };
  }

  // ---- 3) Auftraege des Setz-Scripts -------------------------------------------------------------------------------------
  function zurueck(o) { try { window.postMessage(Object.assign({ source: VON_SEITE }, o), location.origin); } catch (_) {} }
  function fertig(rid, erg) {
    const w = offen.get(rid);
    if (!w) return;
    offen.delete(rid);
    if (w.t) { try { clearTimeout(w.t); } catch (_) {} }
    if (w.art === "setzen") setzt = false;
    zurueck(Object.assign({ kind: "antwort", id: w.id }, erg));
  }
  function antwort(rid, j) {
    const w = offen.get(rid);
    if (!w) return;
    let erg; try { erg = { ok: true, antwort: kuerze(w, j) }; } catch (e) { erg = { ok: false, gesendet: true, fehler: "Antwort nicht lesbar" }; }
    fertig(rid, erg);
  }
  // PURE: nur die mitgelesene Form eines Scheins darf raus. Text = Grund der Ablehnung, null = in Ordnung.
  function scheinFehler(p) {
    if (!p || typeof p !== "object" || Object.keys(p).length !== 1) return "nur das Feld bets erwartet";
    const b = Array.isArray(p.bets) && p.bets.length === 1 ? p.bets[0] : null;
    if (!b || typeof b !== "object") return "genau eine Wette erwartet";
    // EINE Wette je Schein: Einzelwette (Type 1, genau eine Auswahl) oder Kombiwette (Type 2, zwei bis zwoelf VERSCHIEDENE Auswahlen).
    const liste = Array.isArray(b.Events) ? b.Events : null;
    if (!liste || !liste.length) return "genau eine Auswahl erwartet";
    if (b.Type === 1) { if (liste.length !== 1) return "genau eine Auswahl erwartet"; }
    else if (b.Type === 2) { if (liste.length < KOMBI_MIN || liste.length > KOMBI_MAX) return "Kombiwette braucht " + KOMBI_MIN + " bis " + KOMBI_MAX + " Auswahlen"; }
    else return "nur Einzel- oder Kombiwette";
    const erlaubt = { Source: 1, Type: 1, AcceptTypeId: 1, OddType: 1, EachWay: 1, Events: 1, IsSuperBet: 1, Amount: 1, Tags: 1 };
    for (const k of Object.keys(b)) if (!erlaubt[k]) return "unbekanntes Feld " + k;
    const nummern = {};
    for (const e of liste) {
      if (!e || typeof e !== "object") return "genau eine Auswahl erwartet";
      for (const k of Object.keys(e)) if (k !== "SelectionId" && k !== "Coeficient") return "unbekanntes Feld " + k;
      if (!(Number.isInteger(e.SelectionId) && e.SelectionId > 0)) return "Auswahl-Nummer fehlt";
      if (!(typeof e.Coeficient === "number" && e.Coeficient > 1 && e.Coeficient < 1000)) return "Quote fehlt";
      if (nummern[e.SelectionId]) return "dieselbe Auswahl zweimal";
      nummern[e.SelectionId] = 1;
    }
    if (b.AcceptTypeId !== 0) return "Quotenaenderung annehmen ist nicht erlaubt";
    if (b.IsSuperBet !== false || b.EachWay !== false) return "Sonderform nicht erlaubt";
    if (b.OddType !== 0) return "nur Dezimalquote";
    if (b.Source !== 42 && b.Source !== 6) return "Herkunft unbekannt";               // 42 Desktop, 6 Mobil (Swarm.js der Seite)
    if (b.Tags !== undefined && !(Number.isInteger(b.Tags) && b.Tags >= 0)) return "Marke ungueltig";
    if (!(typeof b.Amount === "number" && b.Amount > 0 && b.Amount <= 1000)) return "Einsatz ausserhalb 0-1000";
    return null;
  }
  // PURE: was gesendet wird (oder der Grund, warum nicht). art: lesen | konto | vorgaben | setzen.
  function anfrage(art, command, params) {
    if (art === "konto") return { command: "get", params: { source: "user", what: { profile: KONTO_FELDER.slice() }, subscribe: false } };
    if (art === "vorgaben") return { command: "get", params: { source: "partner.config", what: { partner: [] }, subscribe: false } };
    if (art === "lesen") {
      if (command === "get") {
        if (!params || typeof params !== "object" || params.source !== "betting") return { fehler: "get nur fuer Wettdaten (source betting)" };
        return { command, params: Object.assign({}, params, { subscribe: false }) };       // nie ein Abo in der Sitzung der Seite anlegen
      }
      if (command === "get_max_bet" || command === "bet_history" || command === "check_bet_status") return { command, params: params && typeof params === "object" ? params : {} };
      return { fehler: "Lese-Befehl nicht erlaubt: " + String(command).slice(0, 40) };
    }
    if (art === "setzen") {
      if (command !== "create_bets") return { fehler: "Setz-Befehl nicht erlaubt: " + String(command).slice(0, 40) };
      const f = scheinFehler(params);
      return f ? { fehler: "Schein abgelehnt (" + f + ")" } : { command, params };
    }
    return { fehler: "Auftragsart unbekannt" };
  }
  function schicke(id, art, command, params, fristMs) {
    const nein = (fehler) => zurueck({ kind: "antwort", id, ok: false, gesendet: false, fehler });
    const a = anfrage(art, command, params);
    if (a.fehler) return nein(a.fehler);
    const ws = zustand.sock;
    if (!ws) return nein("Socket der Seite noch nicht erfasst — efbet-Tab einmal neu laden");
    if (ws.readyState !== 1) return nein("Socket der Seite nicht offen (Zustand " + ws.readyState + ")");
    if (art === "setzen" && setzt) return nein("es laeuft schon ein Setz-Auftrag");
    const rid = RID + (++nr);
    let text; try { text = JSON.stringify({ command: a.command, params: a.params, rid }); } catch (_) { return nein("Anfrage nicht serialisierbar"); }
    const w = { id, art, command: a.command, ws, t: null };
    offen.set(rid, w);
    if (art === "setzen") setzt = true;
    try { echtSend.call(ws, text); }
    catch (e) { offen.delete(rid); if (art === "setzen") setzt = false; return nein("Senden fehlgeschlagen: " + String((e && e.message) || e).slice(0, 80)); }
    const max = art === "setzen" ? SETZ_FRIST_MAX : LESE_FRIST_MAX, frist = Math.max(1000, Math.min(max, Number(fristMs) || (art === "setzen" ? 120000 : 8000)));
    w.t = setTimeout(() => fertig(rid, { ok: false, gesendet: true, fehler: "zeit" }), frist);
    if (art === "setzen") zurueck({ kind: "gesendet", id });      // Quittung: ab hier ist der Schein beim Buch
  }
  window.addEventListener("message", (ev) => {
    try {
      if (!zustand.aktiv || ev.source !== window) return;
      const d = ev.data;
      if (!d || d.source !== VON_SCRIPT || d.kind !== "frage" || typeof d.id !== "string") return;
      if (d.art === "stand") { const ws = zustand.sock; return zurueck({ kind: "antwort", id: d.id, ok: true, stand: { v: V, socket: ws ? ws.readyState : null, seitMs: ws ? Date.now() - zustand.seit : null, offen: offen.size } }); }
      schicke(d.id, String(d.art), String(d.command || ""), d.params, d.fristMs);
    } catch (_) {}
  });
})();
