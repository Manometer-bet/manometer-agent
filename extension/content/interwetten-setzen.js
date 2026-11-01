// interwetten-setzen.js — 21.10.2026. Setz-Kern fuer interwetten.gr (Wettschein /bettingslip/*). BYTE-GLEICH an drei Orten:
//   Edge-GR-Sink (eigenes Konto, Auftrag ueber edge-push), Manometer Agent content/interwetten-setzen.js (External Bettors),
//   Kit/Tests.
//
// Ablauf wie Interwettens eigener Wettschein (bettingslip-13 / -platform-1, gelesen 21.10.2026; Reihenfolge an einer Hand-Wette
// des Betreibers belegt: addbets → setsingleamount → requestlivesubmit → dolivesubmit → removebets):
//   POST /bettingslip/<befehl>, Kopf Accept + Content-Type application/json + X-Requested-With: XMLHttpRequest, Inhalt
//   { command, …, bettingSlipType: 1, sendCount, reset: false, clear: false }; Antwort { main: { global, settings, singleBets, … } }.
//   AddBets(3) {outcomeId, marketId, eventId, amount, isLive, isBetbuilder} · SetSingleAmount(7) {outcomeId, amount, freebetbonusId}
//   RequestLiveSubmit(0) {liveDelay} · nach (0,5 + global.liveDelay) s DoLiveSubmit(1) {liveDelay: 1000}; settings.submissionState
//   2 = laeuft noch (nach 1 s erneut), 3 = gespeichert, 9 = fehlgeschlagen; global.isSaved = gespeichert. RemoveBets(2) {outcomeId}.
// setzenKombi — AddBets je Bein, SetCombiAmount(9), dann wie oben
//   (Befehle und Antwortform aus dem Bundle bettingslip-13, 25.10.2026 im GR-Chrome gelesen; Einzelheiten unten am Kern).
// Regeln: placed NUR bei isSaved / Zustand 3. failed nur, solange sicher nichts gespeichert ist (vor dem Absenden oder ausdrueckliche
// Absage). Alles Unklare NACH dem Absenden = uncertain. Liegen schon andere Tipps im Schein: nichts absenden (der Betreiber koennte
// sie gerade selbst zusammenstellen). Kontostand und Sitzungsdaten verlassen diesen Kern nie.
(function (root) {
  "use strict";
  var VERSION = "2";   // 2 = mit setzenKombi (25.10.2026)
  var BEFEHL = { RequestLiveSubmit: 0, DoLiveSubmit: 1, RemoveBets: 2, AddBets: 3, SetSingleAmount: 7, SetCombiAmount: 9 };
  var NACHFRAGEN_MAX = 25;

  function ganz(x) { var n = Number(x); return Number.isInteger(n) && n > 0 && n < 1e13 ? n : null; }
  function r2(x) { return Math.round(Number(x) * 100) / 100; }
  function fehlerText(g, mine) {
    var e = (g && g.error) || {};
    var t = String(e.message || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
    if (!t && e.type && e.type !== "OK") t = String(e.type);
    if (!t && mine && mine.error && mine.error !== "OK") t = String(mine.error);
    if (e.limitMax) t = "stake above the account limit" + (mine && Number(mine.maxLimit) > 0 ? " (max " + mine.maxLimit + " €)" : "") + (t ? " — " + t : "");
    if (e.limitMin) t = "stake below the minimum" + (mine && Number(mine.minLimit) > 0 ? " (min " + mine.minLimit + " €)" : "") + (t ? " — " + t : "");
    return t || "refused";
  }

  // a = { outcomeId, marketId, eventId, isLive, amount, minOdds }; env = { post(pfad, inhalt) → Promise<JSON>, warte(ms) → Promise }
  async function setzen(a, env) {
    var t0 = Date.now();
    var oid = ganz(a && a.outcomeId), mid = ganz(a && a.marketId), eid = ganz(a && a.eventId), betrag = r2(a && a.amount), mind = Number(a && a.minOdds);
    if (!oid || !mid || !eid) return { status: "failed", reason: "interwetten: selection numbers missing — nothing sent" };
    if (!(betrag > 0) || betrag > 10000) return { status: "failed", reason: "interwetten: stake " + (a && a.amount) + " not valid — nothing sent" };
    if (!(mind > 1)) return { status: "failed", reason: "interwetten: minimum odds missing — nothing sent" };
    var seq = Date.now() % 100000000 + 1000, abgesendet = false, gespeichert = false, quote = null;
    async function befehl(name, inhalt) {
      var key = name.charAt(0).toUpperCase() + name.slice(1);
      var body = Object.assign({ command: BEFEHL[key] }, inhalt, { bettingSlipType: 1, sendCount: ++seq, reset: false, clear: false });
      var r = await env.post("/bettingslip/" + name.toLowerCase(), body);
      return r && r.main ? r.main : null;
    }
    var meins = function (m) { return ((m && m.singleBets) || []).filter(function (b) { return String(b && b.id) === String(oid); })[0] || null; };
    async function aufraeumen() { try { await befehl("RemoveBets", { outcomeId: oid }); } catch (_) {} }
    var fertig = function (o) { o.ms = Date.now() - t0; return o; };
    var m;
    // 1) Tipp in den Schein — noch ohne Einsatz
    try { m = await befehl("AddBets", { outcomeId: oid, marketId: mid, eventId: eid, amount: 0, isLive: a.isLive === true, isBetbuilder: false }); }
    catch (e) { return fertig({ status: "failed", reason: "interwetten: betting slip not reachable (" + String((e && e.message) || e).slice(0, 80) + ") — nothing placed" }); }
    if (!m || !m.global) { await aufraeumen(); return fertig({ status: "failed", reason: "interwetten: unreadable answer when adding the selection — nothing placed" }); }
    if (m.global.isLoggedIn === false || (m.global.error && m.global.error.isLoggedOut)) { await aufraeumen(); return fertig({ status: "failed", reason: "interwetten: not signed in — nothing placed" }); }
    var b = meins(m);
    if (!b) { await aufraeumen(); return fertig({ status: "failed", reason: "interwetten: the book did not accept selection " + oid + " — nothing placed" }); }
    if ((m.singleBets || []).length !== 1 || ((m.systemBets || []).length > 0)) { await aufraeumen(); return fertig({ status: "failed", reason: "interwetten: the betting slip already holds other selections — nothing placed (empty it first)" }); }
    if (b.isLocked || b.isExpired || (b.error && b.error !== "OK") || (m.global.error && m.global.error.has)) { await aufraeumen(); return fertig({ status: "failed", reason: "interwetten: selection locked or unavailable (" + fehlerText(m.global, b) + ") — nothing placed" }); }
    quote = Number(b.quote);
    if (!(quote >= mind - 1e-9)) { await aufraeumen(); return fertig({ status: "failed", reason: "interwetten: odds " + quote + " below min " + mind + " — nothing placed", odds: quote > 1 ? quote : undefined }); }
    // 2) Einsatz
    try { m = await befehl("SetSingleAmount", { outcomeId: oid, amount: betrag, freebetbonusId: -1 }); }
    catch (e) { await aufraeumen(); return fertig({ status: "failed", reason: "interwetten: stake not accepted (" + String((e && e.message) || e).slice(0, 80) + ") — nothing placed" }); }
    b = meins(m);
    if (!m || !m.global || !b) { await aufraeumen(); return fertig({ status: "failed", reason: "interwetten: unreadable answer when setting the stake — nothing placed" }); }
    if ((m.global.error && m.global.error.has) || (b.error && b.error !== "OK") || Math.abs(Number(b.amount) - betrag) > 0.001 || (Number(b.maxLimit) > 0 && betrag > Number(b.maxLimit) + 1e-9)) {
      await aufraeumen(); return fertig({ status: "failed", reason: "interwetten: " + fehlerText(m.global, b) + " — nothing placed", maxLimit: Number(b.maxLimit) > 0 ? Number(b.maxLimit) : undefined });
    }
    quote = Number(b.quote);
    if (!(quote >= mind - 1e-9)) { await aufraeumen(); return fertig({ status: "failed", reason: "interwetten: odds " + quote + " below min " + mind + " — nothing placed", odds: quote > 1 ? quote : undefined }); }
    // 3) Absenden anfragen; die Annahme-Verzoegerung (live) nennt das Buch
    var verz = Number(m.global.liveDelay) || 0;
    try { m = await befehl("RequestLiveSubmit", { liveDelay: verz }); }
    catch (e) { await aufraeumen(); return fertig({ status: "failed", reason: "interwetten: submit request not answered (" + String((e && e.message) || e).slice(0, 80) + ") — nothing placed" }); }
    if (!m || !m.global) { await aufraeumen(); return fertig({ status: "failed", reason: "interwetten: unreadable answer to the submit request — nothing placed" }); }
    if (m.global.isSaved) gespeichert = true;
    else if ((m.global.error && m.global.error.has) || m.global.quoteHasChanged || m.global.hasLockedBets || (m.global.expiredBets || []).length) {
      await aufraeumen(); return fertig({ status: "failed", reason: "interwetten: " + (m.global.quoteHasChanged ? "odds changed" : fehlerText(m.global, meins(m))) + " — nothing placed" });
    }
    verz = Number(m.global.liveDelay) || verz;
    // 4) Absenden (ab hier ist eine fehlende Antwort UNKLAR, nie „failed“)
    var n = 0, zustand = null;
    if (!gespeichert) {
      await env.warte((0.5 + Math.max(0, Math.min(30, verz))) * 1000);
      for (; n < NACHFRAGEN_MAX; n++) {
        abgesendet = true;
        try { m = await befehl("DoLiveSubmit", { liveDelay: 1000 }); }
        catch (e) { return fertig({ status: "uncertain", reason: "interwetten: no readable answer after submitting (" + String((e && e.message) || e).slice(0, 80) + ") — check the bet history", odds: quote }); }
        if (!m || !m.global || !m.settings) return fertig({ status: "uncertain", reason: "interwetten: unreadable answer after submitting — check the bet history", odds: quote });
        zustand = Number(m.settings.submissionState);
        var bb = meins(m); if (bb && Number(bb.quote) > 1) quote = Number(bb.quote);
        if (m.global.isSaved || zustand === 3) { gespeichert = true; break; }
        if (zustand === 2) { await env.warte(1000); continue; }
        if (zustand === 9 || (m.global.error && m.global.error.has) || m.global.quoteHasChanged) {
          await aufraeumen(); return fertig({ status: "failed", reason: "interwetten: " + (m.global.quoteHasChanged ? "odds changed" : fehlerText(m.global, bb)) + " — not placed (state " + zustand + ")", odds: quote });
        }
        return fertig({ status: "uncertain", reason: "interwetten: unexpected submit state " + zustand + " — check the bet history", odds: quote });
      }
    }
    if (!gespeichert) return fertig({ status: "uncertain", reason: "interwetten: the book is still deciding after " + n + " follow-ups — check the bet history", odds: quote });
    var sum = m && m.global && m.global.summary, ticket = null;
    try { var x = sum && (sum.bets ? sum.bets[0] : sum); if (x) ticket = x.betId || x.ticketId || x.betslipId || x.id || null; } catch (_) {}
    await aufraeumen();                                       // wie die Seite: Schein nach dem Speichern leeren
    return fertig({ status: "placed", odds: quote, stake: betrag, ticket: ticket != null ? String(ticket) : undefined, verified: true, nachfragen: n, liveDelay: verz });
  }

  // ---- -------------------------------------------------
  // Aus Interwettens Bundle bettingslip-13 (25.10.2026 im GR-Chrome gelesen, nichts gesetzt): RequestCommands SetBank 6, SetSingleAmount 7,
  // SetSysAmount 8 (Systemwette — hier nie), SetCombiAmount 9 { amount, freebetbonusId }, Load 13, SetGlobalSingleAmount 14 …; jede gueltige
  // Antwort traegt main.combiBet { error: "OK" | Name aus ResultType (CombinationNotValid, LongTermCombination, MultiBetCombination,
  // StakeLimitMaximum, AccountBalanceLimit …), amount, maxLimit } und main.systemBets. Die KOMBI-QUOTE rechnet Interwettens Seite selbst als
  // Produkt der Einzelquoten aller angehakten Tipps (CombiBet.calculateWithNewQuote, je Tipp isChecked) — so auch hier. NICHT gemessen: die
  // Antwort auf SetCombiAmount (eine Null-Einsatz-Probe im Konto war am 25.10. nicht freigegeben) → jede Pruefung fail-closed.
  // Ablauf: AddBets je Bein (amount 0, isLive false — Kombis nur vor dem Anpfiff) → nach JEDEM Bein: angemeldet, der Schein traegt NUR diese
  // Tipps (fremde Tipps = der Betreiber baut gerade selbst → unsere wieder raus, nichts gesendet), der neue Tipp frei und angehakt, Quote ≥
  // Mindestquote des Beins; nach dem letzten: combiBet.error "OK", Produkt ≥ Mindest-Gesamtquote → SetCombiAmount(Einsatz) → combiBet.amount =
  // Einsatz, Grenze, KEIN Einsatz auf einer Einzelwette, Quoten halten → armed false: RemoveBets, „staged“ · armed true: RequestLiveSubmit →
  // DoLiveSubmit (Zustaende wie die Einzelwette) → RemoveBets. Kontostand und Sitzungsdaten verlassen den Kern nie.
  // a = { legs:[{ outcomeId, marketId, eventId, minOdds }], amount, minTotalOdds, armed }; env = { post, warte } wie setzen().
  // Antwort: { status: placed | failed | uncertain | staged, odds (Gesamtquote = Produkt), stake, legs:[{ outcomeId, odds, minOdds }], ticket?,
  //           verified?, nachfragen?, liveDelay?, maxLimit?, reason?, note?, slipLeft?, ms }
  var KOMBI_MIN = 2, KOMBI_MAX = 12;
  function produkt(liste) { var p = 1; for (var i = 0; i < liste.length; i++) p = p * Number(liste[i].odds); return Math.round(p * 1e6) / 1e6; }
  async function setzenKombi(a, env) {
    var t0 = Date.now();
    var fertig = function (o) { o.ms = Date.now() - t0; return o; };
    var legs = (a && Array.isArray(a.legs)) ? a.legs : [], armed = !!(a && a.armed === true);
    var betrag = r2(a && a.amount), mindGesamt = Number(a && a.minTotalOdds);
    if (legs.length < KOMBI_MIN || legs.length > KOMBI_MAX) return fertig({ status: "failed", reason: "interwetten combo: needs " + KOMBI_MIN + " to " + KOMBI_MAX + " legs — nothing sent", legs: [] });
    var beine = [], spiele = {}, nummern = {}, i;
    for (i = 0; i < legs.length; i++) {
      var L = legs[i] || {}, oid = ganz(L.outcomeId), mid = ganz(L.marketId), eid = ganz(L.eventId), mind = Number(L.minOdds);
      if (!oid || !mid || !eid) return fertig({ status: "failed", reason: "interwetten combo: leg " + (i + 1) + " — selection numbers missing — nothing sent", legs: [] });
      if (!(mind > 1)) return fertig({ status: "failed", reason: "interwetten combo: leg " + (i + 1) + " — minimum odds missing — nothing sent", legs: [] });
      if (spiele[eid] || nummern[oid]) return fertig({ status: "failed", reason: "interwetten combo: leg " + (i + 1) + " — same game or selection twice — nothing sent", legs: [] });
      spiele[eid] = true; nummern[oid] = true;
      beine.push({ outcomeId: oid, marketId: mid, eventId: eid, minOdds: mind });
    }
    if (!(betrag > 0) || betrag > 10000) return fertig({ status: "failed", reason: "interwetten combo: stake " + (a && a.amount) + " not valid — nothing sent", legs: [] });
    if (!(mindGesamt > 1)) return fertig({ status: "failed", reason: "interwetten combo: minimum total odds missing — nothing sent", legs: [] });
    var seq = Date.now() % 100000000 + 1000, gespeichert = false, gelegt = [];
    async function befehl(name, inhalt) {
      var key = name.charAt(0).toUpperCase() + name.slice(1);
      var body = Object.assign({ command: BEFEHL[key] }, inhalt, { bettingSlipType: 1, sendCount: ++seq, reset: false, clear: false });
      var r = await env.post("/bettingslip/" + name.toLowerCase(), body);
      return r && r.main ? r.main : null;
    }
    var meine = function (m) { var out = {}; ((m && m.singleBets) || []).forEach(function (b) { if (b && nummern[String(b.id)]) out[String(b.id)] = b; }); return out; };
    var fremde = function (m) { return ((m && m.singleBets) || []).filter(function (b) { return !(b && nummern[String(b.id)]); }); };
    // Nur UNSERE Tipps wieder entfernen — fremde bleiben (der Betreiber koennte sie gerade selbst zusammenstellen).
    async function aufraeumen() { for (var k = 0; k < beine.length; k++) { try { await befehl("RemoveBets", { outcomeId: beine[k].outcomeId }); } catch (_) {} } }
    var nein = async function (reason, extra) { await aufraeumen(); return fertig(Object.assign({ status: "failed", reason: "interwetten combo: " + reason + " — nothing placed", legs: gelegt }, extra || {})); };
    // Der Schein gegen den Auftrag: angemeldet, keine fremden Tipps, jedes gelegte Bein da, frei, angehakt, Quote ≥ Mindestquote. null = gut.
    var scheinFehler = function (m, wo) {
      if (!m || !m.global) return "unreadable answer " + wo;
      if (m.global.isLoggedIn === false || (m.global.error && m.global.error.isLoggedOut)) return "not signed in";
      if (fremde(m).length) return "the betting slip already holds other selections (empty it first)";
      var mb = meine(m);
      for (var k = 0; k < gelegt.length; k++) {
        var b = mb[String(gelegt[k].outcomeId)];
        if (!b) return "selection " + gelegt[k].outcomeId + " is no longer in the betting slip " + wo;
        if (b.isLocked || b.isExpired || (b.error && b.error !== "OK")) return "selection " + gelegt[k].outcomeId + " locked or unavailable (" + fehlerText(m.global, b) + ")";
        if (b.isChecked === false) return "selection " + gelegt[k].outcomeId + " is not included in the combination";
        var q = Number(b.quote);
        if (!(q >= gelegt[k].minOdds - 1e-9)) return "odds " + q + " of selection " + gelegt[k].outcomeId + " below min " + gelegt[k].minOdds;
        gelegt[k].odds = q;
      }
      return null;
    };
    // Die Kombi des Scheins: genau combiBet mit error "OK", Gesamtquote = Produkt ≥ Mindest-Gesamtquote. null = gut.
    var kombiFehler = function (m) {
      var cb = m && m.combiBet;
      if (!cb || typeof cb.error !== "string") return "the betting slip names no combined bet";
      if (cb.error !== "OK") return "the book does not combine these selections (" + cb.error + ")";
      if (m.global && m.global.error && m.global.error.has) return fehlerText(m.global, cb);
      var q = produkt(gelegt);
      if (!(q >= mindGesamt - 1e-9)) return "total odds " + q.toFixed(3) + " below min " + mindGesamt;
      return null;
    };
    var m, f;
    // 1) Beine nacheinander in den Schein — ohne Einsatz
    for (i = 0; i < beine.length; i++) {
      var B = beine[i];
      try { m = await befehl("AddBets", { outcomeId: B.outcomeId, marketId: B.marketId, eventId: B.eventId, amount: 0, isLive: false, isBetbuilder: false }); }
      catch (e) { return await nein("betting slip not reachable (" + String((e && e.message) || e).slice(0, 80) + ")"); }
      if (!m || !m.global) return await nein("unreadable answer when adding leg " + (i + 1));
      if (m.global.isLoggedIn === false || (m.global.error && m.global.error.isLoggedOut)) return await nein("not signed in");
      var b1 = meine(m)[String(B.outcomeId)];
      if (!b1) return await nein("the book did not accept selection " + B.outcomeId + " (leg " + (i + 1) + ")");
      gelegt.push({ outcomeId: B.outcomeId, odds: Number(b1.quote), minOdds: B.minOdds });
      f = scheinFehler(m, "after leg " + (i + 1)); if (f) return await nein(f);
      if ((m.singleBets || []).length !== i + 1) return await nein("the betting slip holds " + (m.singleBets || []).length + " selections after leg " + (i + 1));
    }
    // 2) genau EINE Kombi ueber diese Beine, Gesamtquote = Produkt ≥ Mindest-Gesamtquote
    f = kombiFehler(m); if (f) return await nein(f);
    // 3) Einsatz auf die Kombi
    try { m = await befehl("SetCombiAmount", { amount: betrag, freebetbonusId: -1 }); }
    catch (e) { return await nein("stake not accepted (" + String((e && e.message) || e).slice(0, 80) + ")"); }
    f = scheinFehler(m, "after setting the stake"); if (f) return await nein(f);
    var cb = m.combiBet || {};
    if (m.global.error && m.global.error.has) return await nein(fehlerText(m.global, cb), { maxLimit: Number(cb.maxLimit) > 0 ? Number(cb.maxLimit) : undefined });
    f = kombiFehler(m); if (f) return await nein(f);
    if (Math.abs(Number(cb.amount) - betrag) > 0.001) return await nein("the book did not take over the stake (" + cb.amount + " instead of " + betrag + ")");
    if (Number(cb.maxLimit) > 0 && betrag > Number(cb.maxLimit) + 1e-9) return await nein("stake above the combo limit (max " + cb.maxLimit + " €)", { maxLimit: Number(cb.maxLimit) });
    var mitEinsatz = (m.singleBets || []).filter(function (x) { return x && Number(x.amount) > 0.001; });
    if (mitEinsatz.length) return await nein("a single selection carries a stake (" + mitEinsatz.map(function (x) { return x.id; }).join(", ") + ")");
    var quote = produkt(gelegt);
    // Sicherheits-Halt: nur abgeben, wenn ausdruecklich scharf. Der Schein wird wieder geleert — im Tab bleibt nichts stehen.
    if (!armed) { await aufraeumen(); return fertig({ status: "staged", slipLeft: false, odds: quote, stake: betrag, legs: gelegt, note: "Combo built and priced in the Interwetten betting slip — NOT placed (armed=false). Selections removed again." }); }
    // 4) Absenden anfragen (wie die Einzelwette; die Annahme-Verzoegerung nennt das Buch)
    var verz = Number(m.global.liveDelay) || 0;
    try { m = await befehl("RequestLiveSubmit", { liveDelay: verz }); }
    catch (e) { return await nein("submit request not answered (" + String((e && e.message) || e).slice(0, 80) + ")"); }
    if (!m || !m.global) return await nein("unreadable answer to the submit request");
    if (m.global.isSaved) gespeichert = true;
    else if ((m.global.error && m.global.error.has) || m.global.quoteHasChanged || m.global.hasLockedBets || (m.global.expiredBets || []).length) {
      return await nein(m.global.quoteHasChanged ? "odds changed" : fehlerText(m.global, m.combiBet));
    }
    verz = Number(m.global.liveDelay) || verz;
    // 5) Absenden (ab hier ist eine fehlende Antwort UNKLAR, nie „failed“)
    var n = 0, zustand = null;
    if (!gespeichert) {
      await env.warte((0.5 + Math.max(0, Math.min(30, verz))) * 1000);
      for (; n < NACHFRAGEN_MAX; n++) {
        try { m = await befehl("DoLiveSubmit", { liveDelay: 1000 }); }
        catch (e) { return fertig({ status: "uncertain", reason: "interwetten combo: no readable answer after submitting (" + String((e && e.message) || e).slice(0, 80) + ") — check the bet history", odds: quote, legs: gelegt }); }
        if (!m || !m.global || !m.settings) return fertig({ status: "uncertain", reason: "interwetten combo: unreadable answer after submitting — check the bet history", odds: quote, legs: gelegt });
        zustand = Number(m.settings.submissionState);
        var mb2 = meine(m); gelegt.forEach(function (g) { var x = mb2[String(g.outcomeId)]; if (x && Number(x.quote) > 1) g.odds = Number(x.quote); }); quote = produkt(gelegt);
        if (m.global.isSaved || zustand === 3) { gespeichert = true; break; }
        if (zustand === 2) { await env.warte(1000); continue; }
        if (zustand === 9 || (m.global.error && m.global.error.has) || m.global.quoteHasChanged) {
          await aufraeumen(); return fertig({ status: "failed", reason: "interwetten combo: " + (m.global.quoteHasChanged ? "odds changed" : fehlerText(m.global, m.combiBet)) + " — not placed (state " + zustand + ")", odds: quote, legs: gelegt });
        }
        return fertig({ status: "uncertain", reason: "interwetten combo: unexpected submit state " + zustand + " — check the bet history", odds: quote, legs: gelegt });
      }
    }
    if (!gespeichert) return fertig({ status: "uncertain", reason: "interwetten combo: the book is still deciding after " + n + " follow-ups — check the bet history", odds: quote, legs: gelegt });
    var sum = m && m.global && m.global.summary, ticket = null;
    try { var x2 = sum && (sum.bets ? sum.bets[0] : sum); if (x2) ticket = x2.betId || x2.ticketId || x2.betslipId || x2.id || null; } catch (_) {}
    await aufraeumen();                                       // wie die Seite: Schein nach dem Speichern leeren
    return fertig({ status: "placed", odds: quote, stake: betrag, legs: gelegt, ticket: ticket != null ? String(ticket) : undefined, verified: true, nachfragen: n, liveDelay: verz });
  }

  var API = { VERSION: VERSION, BEFEHL: BEFEHL, setzen: setzen, setzenKombi: setzenKombi, fehlerText: fehlerText, KOMBI_MIN: KOMBI_MIN, KOMBI_MAX: KOMBI_MAX, produkt: produkt };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  if (root) root.IWSETZEN = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
