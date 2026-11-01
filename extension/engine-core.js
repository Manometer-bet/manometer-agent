// engine-core.js — BOOK-AGNOSTIC core of the Manometer Agent. Pure functions only: no chrome.*, no fetch,
// no DOM. Everything here is node-testable and shared by every book adapter (fonbet today; mystake,
// trustdice, jackbit next). Adapters live in books/<id>.js and never duplicate this logic.
//
// Contract mirrors the operator side (feed-core.js Feed API v1) so proposals are
// interchangeable. Fail-closed everywhere: anything unclear rejects rather than places.
"use strict";

export const ENGINE_MARKETS = {
  fb:   { ml: { scopes: ["match"], sels: ["home", "draw", "away"] },
          ah: { scopes: ["match"], sels: ["home", "away"], needsLine: true },
          // 04.10.2026 (1.2.65): KOMBIWETTE — EIN Schein mit mehreren Spielen (je Bein der Sieger 1X2). sel ist immer "combo";
          // die Beine stehen in p.legs (Reihenfolge und Namen des BUCHS — die Engine uebersetzt home/away nie selbst),
          // minOdds ist die Mindest-GESAMTquote. Nur vor dem Anpfiff. Nur Adapter mit export const kombi = true.
          parlay: { scopes: ["match"], sels: ["combo"], legs: true } },
  cs2:  { ml: { scopes: ["match"], sels: ["home", "away"] },
          mapWinner: { scopes: ["map1", "map2", "map3"], sels: ["home", "away"] } },
  // 04.10.2026 (1.2.64): Basketball — Sieger ueber das ganze Spiel INKLUSIVE Verlaengerung (2-Weg, kein draw). Schluessel wie
  // in der Feed-API des Operators (feed-core.js: fb | basket | tennis | cs2).
  basket: { ml: { scopes: ["match"], sels: ["home", "away"] } },
};

// Setzt dieser Buch-Adapter die Sportart des Vorschlags? Ein Adapter nennt seine Sportarten selbst (export const sports =
// { fb:true, basket:true }). Nennt er keine, gilt der Stand von vor 1.2.64: Fussball und CS2 — eine NEUE Sportart landet so
// nie bei einem Adapter, der fuer sie nicht gebaut ist (er wuerde sie wie Fussball behandeln und koennte auf dem falschen
// Markt setzen).
export function adapterSetzt(adapter, sport) {
  const s = adapter && adapter.sports;
  if (s && typeof s === "object") return s[String(sport)] === true;
  return sport === "fb" || sport === "cs2";
}
// Setzt dieser Adapter Kombiwetten (mkt "parlay")? Nur, wer es selbst sagt (export const kombi = true).
export function adapterKombi(adapter) { return !!(adapter && adapter.kombi === true); }
// Beine eines Kombi-Vorschlags pruefen: 2 bis 12, je Bein Spiel-Nummer des Buchs, Tipp 1 / X / 2, Mindestquote > 1 und die
// Mannschaftsnamen des Buchs; kein Spiel zweimal; kein Bein schon angepfiffen. → Liste der Fehler (leer = in Ordnung).
// 1.2.67 (05.10.2026): ein Bein darf seine SPORTART nennen (legs[].sport, Feed-Name; ohne Angabe fb = Fussball). Basketball
// (basket) = Sieger inklusive Verlaengerung, nur Tipp 1 oder 2. Ein Schein darf Sportarten mischen; der Vorschlag selbst
// bleibt sport "fb" / mkt "parlay". Eine unbekannte Sportart ist ein Fehler (kein Raten, welcher Markt gemeint ist).
// 1.2.68 (05.10.2026): ein Bein darf die GENAUE AUSWAHL-NUMMER des Buchs tragen (legs[].outcomeId) — Buecher, deren Schein ueber
// Auswahl-Nummern gebaut wird (Stoiximan), setzen ohne sie nicht; ob sie Pflicht ist, entscheidet der Adapter des Buchs.
export const KOMBI_BEIN_SPORT = { fb: { tips: ["1", "X", "2"] }, basket: { tips: ["1", "2"] } };
export function kombiBeineFehler(p, nowTs) {
  const errs = [], legs = p && p.legs, now = _num(nowTs) != null ? nowTs : 0;
  if (!Array.isArray(legs) || legs.length < 2 || legs.length > 12) return ["legs must be a list of 2 to 12"];
  const seen = {};
  for (let i = 0; i < legs.length; i++) {
    const L = legs[i], nr = "leg " + (i + 1);
    if (!L || typeof L !== "object") { errs.push(nr + " missing"); continue; }
    if (!/^\d{4,22}$/.test(String(L.eventId))) errs.push(nr + ": eventId missing");   // 31.10.2026: TrustDice fuehrt 19-stellige Spiel-Nummern
    else if (seen[String(L.eventId)]) errs.push(nr + ": same game twice");
    else seen[String(L.eventId)] = true;
    const sp = (L.sport == null || L.sport === "") ? "fb" : String(L.sport), spDef = Object.prototype.hasOwnProperty.call(KOMBI_BEIN_SPORT, sp) ? KOMBI_BEIN_SPORT[sp] : null;
    if (!spDef) errs.push(nr + ": sport " + sp + " is not connected for parlays");
    else if (spDef.tips.indexOf(L.tip) < 0) errs.push(nr + ": tip must be " + (spDef.tips.length === 3 ? "1, X or 2" : "1 or 2 (" + sp + " has no draw)"));
    const mo = _num(L.minOdds); if (mo == null || mo <= 1) errs.push(nr + ": minOdds must be a number > 1");
    if (typeof L.team1 !== "string" || !L.team1 || typeof L.team2 !== "string" || !L.team2) errs.push(nr + ": team names of the book missing");
    const st = _num(L.startsTs); if (st != null && now >= st) errs.push(nr + ": game already started");
    if (L.outcomeId != null && !/^[0-9A-Za-z_:.-]{1,40}$/.test(String(L.outcomeId))) errs.push(nr + ": outcomeId unreadable");
  }
  return errs;
}

const _num = (x) => (typeof x === "number" && isFinite(x)) ? x : (typeof x === "string" && x.trim() !== "" && isFinite(Number(x)) ? Number(x) : null);

// ---- signature (HMAC-SHA256 over the canonical proposal JSON) --------------------------------
// Canonical form = the proposal WITHOUT `sig`, keys sorted, no whitespace. The operator signs with
// the shared partner secret; the engine recomputes and compares. The transport store is world-
// readable (CORS *), so the signature — not the transport — is what makes a proposal trustworthy.
export function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined)
    .map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
}
export function proposalSigningPayload(p) {
  const c = Object.assign({}, p); delete c.sig; return canonicalJson(c);
}

// ---- validation ------------------------------------------------------------------------------
// Structural + temporal gates. Deliberately a SUBSET of the operator's validator: the engine only
// needs what it must execute (identity, market, side, price floor, freshness, kickoff). The
// operator's model fields (fairOdds/ev/devigMethod) are optional here — the engine never re-models.
const TTL_MAX_MS = 6 * 3600e3, UHR_SPIEL_MS = 10 * 60e3;
export function validateProposal(p, nowTs, opts) {
  const errs = [];
  const now = _num(nowTs) != null ? nowTs : 0;
  const o = opts || {};
  if (!p || typeof p !== "object") return { ok: false, errors: ["no payload"] };
  if (!p.proposalId || typeof p.proposalId !== "string") errs.push("proposalId missing (idempotency key)");
  if (!p.book || typeof p.book !== "string") errs.push("book missing (which adapter must place this)");
  if (o.book && p.book && String(p.book) !== String(o.book)) errs.push("book '" + p.book + "' is not this engine's book");
  const mkts = ENGINE_MARKETS[p.sport];
  if (!mkts) errs.push("sport '" + String(p.sport) + "' not supported");
  else {
    const mdef = mkts[p.mkt];
    if (!mdef) errs.push("mkt '" + String(p.mkt) + "' not allowed for sport '" + p.sport + "'");
    else {
      const scope = p.scope || "match";
      if (mdef.scopes.indexOf(scope) < 0) errs.push("scope '" + scope + "' invalid for " + p.sport + "/" + p.mkt);
      if (mdef.sels.indexOf(p.sel) < 0) errs.push("sel must be one of " + mdef.sels.join("|"));
      if (mdef.needsLine && _num(p.line) == null) errs.push("line required for " + p.mkt);
      if (!mdef.needsLine && p.line != null) errs.push("line not allowed for " + p.mkt);
      // Kombiwette: Beine pruefen, nur vor dem Anpfiff, und die Ausfuehrungs-Referenz ist das erste Bein.
      if (mdef.legs) {
        kombiBeineFehler(p, now).forEach((x) => errs.push(x));
        if (p.live === true) errs.push("parlay proposals are pre-match only");
        if (Array.isArray(p.legs) && p.legs[0] && p.bookRef && String(p.bookRef.eventId) !== String(p.legs[0].eventId)) errs.push("bookRef.eventId must be the first leg");
      } else if (p.legs != null) errs.push("legs not allowed for " + p.mkt);
    }
  }
  // Execution reference: the operator resolved the event at the book, so the engine never guesses.
  const ref = p.bookRef || {};
  if (!ref.eventId) errs.push("bookRef.eventId missing (engine never resolves events itself)");
  const mo = _num(p.minOdds);
  if (mo == null || mo <= 1) errs.push("minOdds must be a number > 1");
  const st = _num(p.stakeEur);
  if (st == null || st <= 0) errs.push("stakeEur must be a number > 0");
  const ts = _num(p.tsCreated); if (ts == null) errs.push("tsCreated missing");
  const ttl = _num(p.ttlMs); if (ttl == null || ttl <= 0) errs.push("ttlMs missing or invalid");
  // 31.10.2026: Ein Vorschlag lebt Sekunden bis Minuten. Lange Laufzeit oder ein Datum in der Zukunft hieße: Er ließe sich noch Tage später einspielen. 10 min Spielraum für falsch gehende Uhren.
  if (ttl != null && ttl > TTL_MAX_MS) errs.push("ttlMs too long");
  if (ts != null && now > 0 && ts > now + UHR_SPIEL_MS) errs.push("tsCreated in the future");
  if (!errs.length && now > ts + ttl) errs.push("expired (age " + Math.round((now - ts) / 1000) + "s > ttl " + Math.round(ttl / 1000) + "s)");
  // Kickoff gate (same rule as the operator): prematch must be BEFORE start; live must be after
  // start and before an optional endsTs. Unknown start time = block (never bet blind).
  const starts = _num(p.startsTs);
  if (!errs.length) {
    if (starts == null) errs.push("startsTs missing (unknown kickoff = blocked)");
    else if (p.live === true) {
      if (now < starts) errs.push("live:true but event has not started yet");
      const ends = _num(p.endsTs);
      if (ends != null && now >= ends) errs.push("live signal but event already finished");
    } else if (now >= starts) errs.push("event already started (kickoff gate) — prematch proposal");
  }
  return errs.length ? { ok: false, errors: errs } : { ok: true, errors: [] };
}

// ---- local operator policy (the engine owner's OWN risk limits) -------------------------------
// The proposal's stakeEur is a RECOMMENDATION. The engine owner's caps always win — an operator can
// never push a bigger stake than the local settings allow.
export function policyDefaults() {
  return { enabled: false, stakeMode: "cap", stakePct: 100, fixedEur: 2,
           maxStakeEur: 5, dayExposureEur: 25, maxOpenBets: 5, minOddsFloor: 1.2, maxOddsCeil: 8, allowLive: false };
}
export function resolveStake(proposalStake, pol) {
  const p = Object.assign(policyDefaults(), pol || {});
  const want = _num(proposalStake) || 0;
  let s = want;
  if (p.stakeMode === "fixed") s = _num(p.fixedEur) || 0;
  else if (p.stakeMode === "scale") s = want * ((_num(p.stakePct) || 0) / 100);
  s = Math.min(s, _num(p.maxStakeEur) || 0);
  s = Math.floor(s * 100) / 100;                       // never round UP into a bigger bet
  return s > 0 ? s : 0;
}
// Returns null when allowed, else a human-readable reason.
export function policyBlock(p, pol, state) {
  const q = Object.assign(policyDefaults(), pol || {});
  const s = state || {};
  if (!q.enabled) return "engine disabled (enable it in the options page)";
  if (q.killed === true) return "kill switch active";
  if (p.live === true && q.allowLive !== true) return "live betting not enabled locally";
  const mo = _num(p.minOdds) || 0;
  if (mo < (_num(q.minOddsFloor) || 0)) return "minOdds " + mo + " below local floor " + q.minOddsFloor;
  if (mo > (_num(q.maxOddsCeil) || 0)) return "minOdds " + mo + " above local ceiling " + q.maxOddsCeil;
  const stake = resolveStake(p.stakeEur, q);
  if (!(stake > 0)) return "local stake resolves to 0";
  if ((_num(s.dayExposureEur) || 0) + stake > (_num(q.dayExposureEur) || 0)) return "day exposure cap reached (" + q.dayExposureEur + " €)";
  if ((_num(s.openBets) || 0) >= (_num(q.maxOpenBets) || 0)) return "max open bets reached (" + q.maxOpenBets + ")";
  return null;
}

// ---- Was der Kontoinhaber selbst festlegt ----
// wahlPruefen: seine Wahl aus dem Konto, signiert in den Vorgaben (cfg.wahl = { agents: { <slug>: { on, eur } }, standard, buecher }). Vorschläge ohne Agent-Namen (von Hand) und Vorgaben ohne Wahl bleiben, wie sie sind.
// 01.11.2026: buecher = { <buch>: { pre|live|parlay: false } }; Einsatz fix, leiter oder kelly (setzwahl-core.js). Gerechnet hat der Operator, hier gilt die höchste Summe, die diese Einstellung ergeben kann.
export function wahlDeckel(wahl, w) {
  const s = w && w.modus === "standard" ? wahl && wahl.standard : w;
  if (!s) return 0;
  if (s.modus === "leiter") return (_num(s.einheit) || 0) * (_num(s.maxE) || 0);
  if (s.modus === "kelly") return (_num(s.bank) || 0) * (_num(s.anteil) || 0);
  return _num(s.eur) || 0;
}
export function wahlPruefen(p, wahl, stake) {
  const slug = p && typeof p.agent === "string" ? p.agent : null;
  if (!slug || !wahl) return { stake };
  const phase = p.mkt === "parlay" ? "parlay" : p.live ? "live" : "pre", buch = wahl.buecher && Object.prototype.hasOwnProperty.call(wahl.buecher, String(p.book)) ? wahl.buecher[String(p.book)] : null;
  if (buch && buch[phase] === false) return { fehler: (phase === "pre" ? "pre-match" : phase === "live" ? "live" : "parlays") + " at " + p.book + " is switched off in your account" };
  if (!wahl.agents) return { stake };
  const w = Object.prototype.hasOwnProperty.call(wahl.agents, slug) ? wahl.agents[slug] : null;
  if (!w || w.on !== true) return { fehler: "agent " + slug + " is not selected in your account" };
  const eur = wahlDeckel(wahl, w);
  return { stake: eur > 0 && stake > eur ? eur : stake };
}
// Wartezeit je Buch, wie setzwahl-core.js pauseFuer. letzteTs = Ende des letzten Versuchs bei diesem Buch.
// Von Hand gesetzte Wetten (kein Agent-Name) warten nie, zählen aber: Das Buch hat sie gesehen. Ein Bein einer Arbitrage kann nicht warten. → Millisekunden, die noch fehlen.
export const PAUSE_STANDARD_S = 90;
export function pauseSekunden(wahl, buch) {
  const z = (v) => (typeof v === "number" && isFinite(v) && v >= 0 ? v : null), b = wahl && wahl.buecher && Object.prototype.hasOwnProperty.call(wahl.buecher, String(buch)) ? z(wahl.buecher[String(buch)] && wahl.buecher[String(buch)].pauseS) : null;
  if (b != null) return b;
  const k = z(wahl && wahl.pauseS);
  return k != null ? k : PAUSE_STANDARD_S;
}
export function pauseRest(p, wahl, letzteTs, nowTs) {
  if (!p || typeof p.agent !== "string" || !p.agent || p.agent === "arbitrage-exchange") return 0;
  const t = _num(letzteTs), s = pauseSekunden(wahl, p.book);
  if (t == null || !(s > 0)) return 0;
  return Math.max(0, t + s * 1000 - nowTs);
}
// eigeneGrenze: Zwei Zahlen, die nur auf diesem Rechner stehen. Niemand sonst kann sie ändern; leer = keine Grenze.
export function limitsNorm(l) {
  const z = (x) => { const n = Number(x); return n > 0 && isFinite(n) ? Math.round(n * 100) / 100 : null; };
  return { maxBet: z(l && l.maxBet), maxDay: z(l && l.maxDay) };
}
export function eigeneGrenze(stake, limits, heute) {
  const l = limitsNorm(limits);
  const s = l.maxBet != null && stake > l.maxBet ? l.maxBet : stake;
  if (l.maxDay != null && (Number(heute) || 0) + s > l.maxDay + 1e-9) return { fehler: "your own daily limit (" + l.maxDay + " €) would be exceeded" };
  return { stake: s };
}
export function heuteGesetzt(receipts, nowTs) {
  const tag = new Date(nowTs).toISOString().slice(0, 10);
  return (receipts || []).reduce((s, r) => s + ((r && (r.status === "placed" || r.status === "uncertain") && r.ts && new Date(r.ts).toISOString().slice(0, 10) === tag) ? (Number(r.stakeEur) || 0) : 0), 0);
}
// ---- placement result -> receipt status (truth table, identical to the operator side) ---------
// blocked/failed = definitive no-bet (safe to release the lock). Everything else — including an
// exception, a timeout or an empty response — stays "uncertain": the bet MAY exist, so the lock is
// kept and a human verifies. Never invent a definitive no-bet.
export function receiptStatus(res, threw) {
  if (threw) return "uncertain";
  const st = res && res.status;
  if (st === "placed") return "placed";
  if (st === "blocked" || st === "failed") return String(st);
  return "uncertain";
}
// 30.10.2026 (Betreiber: „nur die Beträge, die tatsächlich gesetzt wurden"): Der Adapter kennt den echten Einsatz, z. B. auf den Höchsteinsatz des Buchs gekappt
// (res.stake, ging hier bisher verloren). Er gilt, wenn er in Euro ist und nicht über dem Wunsch liegt; sonst bleibt der Wunsch (Bücher ohne Angabe, Konto in
// BTC oder Dollar: res.cur, res.stake ist dann kein Euro-Betrag). Gleiche Regel wie smkFillInfo im Operator.
export function echterEinsatz(wunsch, res) {
  const want = Number(wunsch) || 0;
  const cur = res && res.cur != null ? String(res.cur).toUpperCase() : "EUR";
  const got = Number(res && res.stake);
  if (cur !== "EUR" || !(got >= 0.01) || got > want + 0.01) return { stake: want, wantStake: want, partial: false };
  const stake = Math.round(got * 100) / 100;
  return { stake, wantStake: want, partial: stake < want - 0.01 };
}
export function buildReceipt(p, res, meta) {
  const m = meta || {};
  const status = m.status || receiptStatus(res, m.threw);
  const echt = m.stakeEur != null && (status === "placed" || status === "uncertain") ? echterEinsatz(m.stakeEur, res) : null;
  return {
    ts: m.now || 0, proposalId: p.proposalId, executorId: m.executorId || "", engineVersion: m.engineVersion || "",
    book: p.book, sport: p.sport, mkt: p.mkt, scope: p.scope || "match", sel: p.sel, line: p.line != null ? p.line : null,
    bookEventId: (p.bookRef && p.bookRef.eventId) != null ? String(p.bookRef.eventId) : null,
    status,
    stakeEur: echt ? echt.stake : (m.stakeEur != null ? m.stakeEur : null),   // der wirklich gesetzte Betrag
    ...(echt && echt.partial ? { wantStake: echt.wantStake, partial: true } : {}),
    minOdds: p.minOdds,
    fillOdds: (res && (res.odds != null ? res.odds : null)),
    ticket: (res && (res.ticket || res.orderId)) || null,
    // Read-back-Bestätigung: true = per Konto/Ticket-Liste gegengeprüft, false = platziert aber nicht
    // bestätigt, null = kein Read-back gelaufen. (pame verifyBet, superbet readback, trustdice/fonbet je Buch.)
    verified: (res && (res.verified != null ? !!res.verified : (res.readback === true ? true : null))),
    note: (res && res.note) || null,
    cur: (res && res.cur) || null,
    reason: (res && (res.reason || res.error)) || m.reason || null,
    latencyMs: m.latencyMs != null ? m.latencyMs : null,
  };
}
