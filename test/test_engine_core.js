// throwaway node test — engine-core (v0.1.0). Loads the REAL functions from engine-core.js and
// books/fonbet.js (regex-extracted, ESM-free eval) and checks the gates that protect real money.
// Run: node test_engine_core.js   (or via the JXA driver when node is unavailable)
"use strict";
const assert = require("assert");
const fs = require("fs");

function loadModule(file, names) {
  const src = fs.readFileSync(__dirname + "/../extension/" + file, "utf8")
    .replace(/^\s*import[^\n]*\n/gm, "")
    .replace(/^export\s+/gm, "");
  return eval("(function(){ " + src + "; return {" + names.map((n) => n + ":" + n).join(",") + "}; })()");
}
const C = loadModule("engine-core.js", ["canonicalJson", "proposalSigningPayload", "validateProposal", "policyDefaults", "resolveStake", "policyBlock", "receiptStatus", "buildReceipt"]);
const F = loadModule("books/fonbet.js", ["couponOutcome", "selectTarget"]);

const NOW = 1785000000000;
const base = () => ({
  proposalId: "op-1", book: "fonbet", sport: "cs2", mkt: "mapWinner", scope: "map2", sel: "away",
  bookRef: { eventId: "66811567" }, minOdds: 1.93, stakeEur: 5.46,
  tsCreated: NOW - 5000, ttlMs: 60000, startsTs: NOW - 600000, live: true,
});

// ---- canonical JSON is stable regardless of key order (signature depends on it) ----
assert.strictEqual(C.canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }), '{"a":[2,{"c":3,"d":4}],"b":1}');
assert.strictEqual(C.proposalSigningPayload({ x: 1, sig: "deadbeef" }), '{"x":1}', "sig excluded from payload");

// ---- validation ----
assert(C.validateProposal(base(), NOW, { book: "fonbet" }).ok, "valid live proposal passes");
{ const p = base(); p.tsCreated = NOW - 90000;                       // older than ttl
  assert(!C.validateProposal(p, NOW, {}).ok, "expired must fail"); }
{ const p = base(); p.startsTs = NOW + 60000;                        // live but not started
  assert(!C.validateProposal(p, NOW, {}).ok, "live before kickoff must fail"); }
{ const p = base(); p.live = false; p.startsTs = NOW - 1;            // prematch after kickoff
  assert(!C.validateProposal(p, NOW, {}).ok, "prematch after kickoff must fail"); }
{ const p = base(); delete p.startsTs;
  assert(!C.validateProposal(p, NOW, {}).ok, "unknown kickoff must fail"); }
{ const p = base(); delete p.bookRef;
  assert(!C.validateProposal(p, NOW, {}).ok, "missing exec ref must fail (engine never resolves)"); }
{ const p = base(); p.book = "mystake";
  assert(!C.validateProposal(p, NOW, { book: "fonbet" }).ok, "foreign book must fail"); }
{ const p = base(); p.scope = "map4";
  assert(!C.validateProposal(p, NOW, {}).ok, "bad scope must fail"); }
{ const p = base(); p.sel = "draw";                                   // cs2 has no draw
  assert(!C.validateProposal(p, NOW, {}).ok, "bad sel must fail"); }
{ const p = base(); p.mkt = "ah"; p.sport = "fb"; p.scope = "match"; p.sel = "home";
  assert(!C.validateProposal(p, NOW, {}).ok, "ah without line must fail");
  p.line = -0.5; assert(C.validateProposal(p, NOW, {}).ok, "ah with line passes"); }

// ---- local caps always win ----
const pol = Object.assign(C.policyDefaults(), { enabled: true, allowLive: true, maxStakeEur: 3, dayExposureEur: 10, maxOpenBets: 2 });
assert.strictEqual(C.resolveStake(5.46, pol), 3, "stake capped to local max");
assert.strictEqual(C.resolveStake(5.46, Object.assign({}, pol, { stakeMode: "fixed", fixedEur: 2 })), 2, "fixed mode");
assert.strictEqual(C.resolveStake(5.46, Object.assign({}, pol, { stakeMode: "scale", stakePct: 50 })), 2.73, "scale mode");
assert.strictEqual(C.resolveStake(999, pol), 3, "huge operator stake still capped");
assert.strictEqual(C.policyBlock(base(), pol, { dayExposureEur: 0, openBets: 0 }), null, "clean proposal allowed");
assert(/disabled/.test(C.policyBlock(base(), Object.assign({}, pol, { enabled: false }), {})), "disabled blocks");
assert(/kill/.test(C.policyBlock(base(), Object.assign({}, pol, { killed: true }), {})), "kill switch blocks");
assert(/live/.test(C.policyBlock(base(), Object.assign({}, pol, { allowLive: false }), {})), "live opt-in enforced");
assert(/day exposure/.test(C.policyBlock(base(), pol, { dayExposureEur: 9, openBets: 0 })), "day cap enforced");
assert(/open bets/.test(C.policyBlock(base(), pol, { dayExposureEur: 0, openBets: 2 })), "open-bet cap enforced");
assert(/floor/.test(C.policyBlock(Object.assign(base(), { minOdds: 1.05 }), pol, {})), "odds floor enforced");

// ---- truth table: only explicit no-bet releases ----
assert.strictEqual(C.receiptStatus({ status: "placed" }), "placed");
assert.strictEqual(C.receiptStatus({ status: "blocked" }), "blocked");
assert.strictEqual(C.receiptStatus({ status: "failed" }), "failed");
assert.strictEqual(C.receiptStatus({ status: "uncertain" }), "uncertain");
assert.strictEqual(C.receiptStatus(null), "uncertain", "no response = uncertain");
assert.strictEqual(C.receiptStatus({}), "uncertain", "empty = uncertain");
assert.strictEqual(C.receiptStatus({ status: "placed" }, true), "uncertain", "exception always uncertain");

// ---- receipt shape ----
{ const r = C.buildReceipt(base(), { status: "placed", odds: 1.97, ticket: "123" }, { now: NOW, executorId: "e1", engineVersion: "0.1.0", stakeEur: 3 });
  assert(r.proposalId === "op-1" && r.status === "placed" && r.fillOdds === 1.97 && r.ticket === "123" && r.stakeEur === 3 && r.bookEventId === "66811567"); }

// ---- fonbet adapter: outcome classification + target selection ----
assert.strictEqual(F.couponOutcome({ coupon: { resultCode: 0, regId: 1 } }).kind, "placed");
assert.strictEqual(F.couponOutcome({ betDelay: 5000 }).kind, "delay");
assert.strictEqual(F.couponOutcome({ coupon: { resultCode: 4 } }).kind, "rejected");
assert.strictEqual(F.couponOutcome({}).kind, "unknown", "unknown never rejected (double-bet guard)");
const rec = { eventId: "66811137", ml: { home: 1.08, draw: 0, away: 6.5 }, maps: { 2: { eventId: "66811567", home: 1.43, away: 2.65 } } };
{ const t = F.selectTarget(rec, base());
  assert(t.eventId === "66811567" && t.factor === 923 && t.odds === 2.65, "map2 away -> child event, factor 923"); }
{ const t = F.selectTarget(rec, Object.assign(base(), { sel: "home" }));
  assert(t.factor === 921 && t.odds === 1.43, "map2 home -> factor 921"); }
{ const t = F.selectTarget(rec, Object.assign(base(), { mkt: "ml", scope: "match", sel: "away" }));
  assert(t.eventId === "66811137" && t.factor === 923 && t.odds === 6.5, "ml -> root event"); }
{ const t = F.selectTarget(rec, Object.assign(base(), { scope: "map3" }));
  assert(t.error, "missing map must error, never guess"); }
{ const t = F.selectTarget(null, base()); assert(t.error, "missing event must error"); }
// ---- Elabet (03.10.2026): der Operator nennt die genaue Quoten-Nummer des Buchs (bookRef.outcomeId) ----
// Sie ist Teil des signierten Vorschlags; die Engine uebersetzt sel (home/draw/away) bei Elabet nie selbst.
{ const E = loadModule("books/elabet.js", ["authInfo", "id", "balanceAus"]);
  assert.strictEqual(E.id, "elabet");
  const p = { proposalId: "op-2", book: "elabet", sport: "fb", mkt: "ml", scope: "match", sel: "home",
    bookRef: { eventId: "17664158", outcomeId: "4571972913" }, minOdds: 1.9, stakeEur: 5,
    tsCreated: NOW - 5000, ttlMs: 180000, startsTs: NOW + 3600000, live: false };
  assert(C.validateProposal(p, NOW, {}).ok, "elabet: prematch 1X2 proposal with outcomeId passes");
  assert(C.proposalSigningPayload(Object.assign({ sig: "x" }, p)).indexOf('"outcomeId":"4571972913"') > 0, "outcomeId is covered by the signature");
  const q = JSON.parse(JSON.stringify(p)); q.bookRef.outcomeId = "4571972915";
  assert.notStrictEqual(C.proposalSigningPayload(p), C.proposalSigningPayload(q), "changing the outcomeId changes the signed payload");
  assert(!C.validateProposal(Object.assign({}, p, { startsTs: NOW - 1 }), NOW, {}).ok, "elabet: kickoff gate holds");
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const jwt = "Bearer " + b64u({ alg: "HS256" }) + "." + b64u({ exp: 1800000000, Integration: "elabet" }) + ".c2ln";   // erfunden, kein echter Schluessel
  const i = E.authInfo(jwt);
  assert(i && i.exp === 1800000000000 && i.integration === "elabet", "authInfo reads only expiry and brand");
  assert.strictEqual(E.authInfo("Bearer not-a-jwt"), null, "no three-part token -> null");
  // Kontostand (seit 1.2.59): getOwnBalance { amount, currency } -> { saldo, bonus, hold, cur, ts }; saldo = Betrag laut Wett-Modul
  const k = E.balanceAus({ amount: 88.2, currency: "EUR" }, 42);
  assert(k && k.saldo === 88.2 && k.bonus === 0 && k.hold === 0 && k.cur === "EUR" && k.ts === 42, "elabet: balance in the engine format");
  assert.strictEqual(E.balanceAus({ amount: null, currency: "EUR" }), null, "no amount -> null (never an invented number)");
  assert.strictEqual(E.balanceAus({ amount: -5 }), null, "negative amount -> null"); }
// ---- Interwetten (21.10.2026, Engine 1.2.78): genaue Auswahl des Operators „Ausgang.Markt.Spiel“ (Interwettens Nummern, Buch-Sicht) ----
{ const p = { proposalId: "op-3", book: "interwetten", sport: "fb", mkt: "ml", scope: "match", sel: "home",
    bookRef: { eventId: "18937711", outcomeId: "1363503082.489130454.18937711" }, minOdds: 1.12, stakeEur: 5,
    tsCreated: NOW - 5000, ttlMs: 180000, startsTs: NOW + 3600000, live: false };
  assert(C.validateProposal(p, NOW, {}).ok, "interwetten: prematch 1X2 proposal with outcomeId passes");
  assert(C.proposalSigningPayload(Object.assign({ sig: "x" }, p)).indexOf('"outcomeId":"1363503082.489130454.18937711"') > 0, "interwetten: outcomeId is covered by the signature");
  const q = JSON.parse(JSON.stringify(p)); q.bookRef.outcomeId = "1363503080.489130454.18937711";
  assert.notStrictEqual(C.proposalSigningPayload(p), C.proposalSigningPayload(q), "interwetten: another selection changes the signed payload");
  assert(!C.validateProposal(Object.assign({}, p, { startsTs: NOW - 1 }), NOW, {}).ok, "interwetten: kickoff gate holds"); }
console.log("ENGINE-CORE TESTS PASSED (real core + fonbet adapter + elabet + interwetten proposal)");
