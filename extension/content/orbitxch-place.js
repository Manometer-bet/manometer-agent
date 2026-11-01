// content/orbitxch-place.js — Manometer Agent (31.10.2026). Orbit Exchange (orbitxch.com, Betfair-Boerse) fuer External Bettors: nur BACK.
//
//
// Laeuft im SEITENKONTEXT des Orbit-Tabs (world MAIN, eingespritzt von books/orbitxch.js; aufgerufen per executeScript): dort ist die
// Sitzung des Kontoinhabers angemeldet, gemessen 26.09. (ein Socket aus dem Service Worker oder dem isolierten Inhaltsskript gilt bei Orbit
// als nicht angemeldet). Hier gibt es kein chrome.*: das Script kennt nur Orbit und antwortet nur dem Aufrufer. Geheimnisse der Engine
// kommen hier nie an, Sitzungs-Keks und CSRF-Wert gehen hier nie hinaus (zurueck gehen nur die genannten Felder).
//
// Gegenstueck beim Operator: edge-gr-sink/orbit-ws-main.js (placeBets / currentBets / cancelBets, Form aus der HAR „orbitxch.com real bet.har“)
// und der Lese-Teil von collectors/orbitxch.js (event/details, Preis-Socket). Der Operator liest den Preis aus seinem Edge-Dienst; den hat der
// Kontoinhaber nicht, also liest dieser Tab Markt und Preis selbst und unmittelbar vor dem Senden.
//
// art „setzen“ = pruefen und genau EIN placeBets. Vor dem Senden ist jeder Zweifel { gesendet:false, status:"blocked" }. Danach gilt
// gesendet:true; eine fehlende oder unlesbare Antwort ist unklar:true (der Service Worker macht daraus uncertain), nur eine ausdrueckliche
// Absage des Buchs ist abgelehnt:true. Jeder Auftrag traegt eine Nummer (auftragId): dieselbe Nummer sendet im Tab nie zweimal.
// Warten und Nachfragen macht der Service Worker: Zeitgeber eines Hintergrund-Tabs drosselt Chrome.
(() => {
  "use strict";
  const KERN = "orbit-back-1";            // Fassung dieses Scripts, muss zu books/orbitxch.js passen; eine neue Fassung ersetzt die alte im Tab
  if (window.__engineOrbit && window.__engineOrbit.kern === KERN) return;

  // Wie handleOrbitPlace (background.js): 3 % Provision auf den Netto-Gewinn, Grenzen des Auftragswegs, Orbits Preisleiter.
  const PROVISION = 0.03, MIN_EINSATZ = 7, MAX_EINSATZ = 200;
  const LEITER = [[2, 0.01], [3, 0.02], [4, 0.05], [6, 0.1], [10, 0.2], [20, 0.5], [30, 1], [50, 2], [100, 5], [1000, 10]];
  const LESEN_MS = 8000, SENDEN_MS = 15000, BILD_MS = 5000;
  // Kleinster Preis auf der Leiter ≥ p (fuer den Backer: mindestens diese Quote)
  function leiterAuf(p) {
    if (!(p > 1)) return 1.01; if (p > 1000) return null;
    let unten = 1.01;
    for (const [bis, st] of LEITER) {
      if (p <= bis + 1e-9) { const n = Math.ceil((p - unten) / st - 1e-9); return Math.round((unten + Math.max(0, n) * st) * 100) / 100; }
      unten = bis;
    }
    return 1000;
  }
  function aufLeiter(p) { if (!(p >= 1.01 && p <= 1000)) return false; let u = 1.01; for (const [bis, st] of LEITER) { if (p <= bis + 1e-9) { const n = (p - u) / st; return Math.abs(n - Math.round(n)) < 1e-6; } u = bis; } return false; }
  const eff = (roh) => (roh > 1 ? Math.round((1 + (roh - 1) * (1 - PROVISION)) * 1000) / 1000 : null);
  const rohMin = (e) => 1 + (Number(e) - 1) / (1 - PROVISION);
  const warte = (ms) => new Promise((r) => setTimeout(r, ms));

  function csrf() {
    const m = document.cookie.match(/(?:^|;\s*)CSRF-TOKEN=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
    const tok = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
    document.cookie = "CSRF-TOKEN=" + tok + "; path=/";                      // Double-Submit: Keks und Kopf gleich
    return tok;
  }
  function kopf(json) { const h = { accept: "application/json, text/plain, */*", "x-csrf-token": csrf(), "x-device": "DESKTOP" }; if (json) h["content-type"] = "application/json"; return h; }
  async function api(pfad, opts, fristMs) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), fristMs || LESEN_MS);
    try {
      const r = await fetch("/customer/api/" + pfad, Object.assign({ credentials: "include", cache: "no-store", signal: ctl.signal }, opts || {}));
      const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (_) {}
      return { status: r.status, ok: r.ok, j };
    } finally { clearTimeout(t); }
  }
  const lies = (pfad) => api(pfad, { method: "GET", headers: kopf(false) });
  const hinweisFehler = (e) => String((e && e.message) || e).slice(0, 80);

  // Anmeldung, Waehrung, Mindesteinsatz. account/info traegt auch den Kontonamen: gelesen wird nur die Waehrung.
  async function kontoLesen() {
    const [an, info, wg] = await Promise.all([lies("account/login/status"), lies("account/info"), lies("currency")]);
    if (an.status === 403) return { fehler: "Orbit: the site refuses this address (HTTP 403) — this tab needs a network exit Orbit allows" };
    if (!an.ok || an.j !== true) return { fehler: "Orbit: not signed in (sign in at orbitxch.com)" };
    const wKonto = info.ok && info.j && typeof info.j.currency === "string" ? info.j.currency.toUpperCase() : null;
    const wStufe = wg.ok && wg.j && typeof wg.j.currencyCode === "string" ? wg.j.currencyCode.toUpperCase() : null;
    if (!wKonto || !wStufe) return { fehler: "Orbit: account currency not readable" };
    if (wKonto !== "EUR" || wStufe !== "EUR") return { fehler: "Orbit: account currency " + wKonto + " — only EUR accounts are connected", cur: wKonto };
    const min = Number(wg.j.minBetSize), max = Number(wg.j.maxBetSize);
    if (!(min > 0)) return { fehler: "Orbit: minimum stake not readable" };
    return { min, max: max > 0 ? max : Infinity };
  }

  // Sieger-Markt des Spiels (Form wie parseDetails in collectors/orbitxch.js): Reihenfolge der Laeufer = Buch-Sicht, 0 Heim, 1 Gast, 2 Remis.
  async function marktLesen(a) {
    const r = await lies("event/details/" + encodeURIComponent(a.eventId));
    if (!r.ok || !r.j || !Array.isArray(r.j.marketCatalogues)) return { fehler: "Orbit: game " + a.eventId + " not readable (HTTP " + r.status + ")" };
    const liste = r.j.marketCatalogues.filter((m) => m && m.description && m.description.marketType === "MATCH_ODDS");
    if (liste.length !== 1) return { fehler: "Orbit: no unique match odds market for game " + a.eventId };
    const m = liste[0];
    if (String(m.marketId) !== a.marketId) return { fehler: "Orbit: market " + a.marketId + " is not the match odds market of game " + a.eventId };
    if (!m.event || String(m.event.id) !== a.eventId) return { fehler: "Orbit: market belongs to another game" };
    if (!m.eventType || String(m.eventType.name).toLowerCase() !== "soccer") return { fehler: "Orbit: game is not football" };
    const c = Number(m.commission);
    if (!(c >= 0) || m.commission == null) return { fehler: "Orbit: commission not readable" };
    // 31.10.2026: Die Zahl hängt am Konto. Gemessen: als Gast commission 2 (36 von 36 Märkten), im angemeldeten Konto des Betreibers 3, marketBaseRate beide Male 2. Gerechnet wird mit 3 %. Wer weniger zahlt, bekommt nie weniger, als der Vorschlag annimmt. Darüber wird nicht gesetzt.
    if (c > PROVISION * 100 + 1e-9) return { fehler: "Orbit: commission " + c + " % is above the " + (PROVISION * 100) + " % this Agent calculates with — effective odds would be wrong" };
    const rs = Array.isArray(m.runners) ? m.runners : [];
    if (rs.length !== 3 || !/^(the )?draw$/i.test(String(rs[2] && rs[2].runnerName)) || /^(the )?draw$/i.test(String(rs[0] && rs[0].runnerName)) || /^(the )?draw$/i.test(String(rs[1] && rs[1].runnerName))) return { fehler: "Orbit: runners are not home / away / draw" };
    const seite = { home: rs[0], away: rs[1], draw: rs[2] }[a.sel];
    if (!seite) return { fehler: "Orbit: selection side " + String(a.sel).slice(0, 8) + " unknown" };
    // Die Nummer des Operators muss in Buch-Sicht auf derselben Seite sitzen wie sel (Falle Heim/Gast: bettor-heim-gast-luecke).
    if (String(seite.selectionId) !== a.selectionId) return { fehler: "Orbit: selection " + a.selectionId + " is not " + a.sel + " at Orbit (" + String(seite.runnerName).slice(0, 40) + ") — wrong side" };
    const start = Number(m.marketStartTime) || Number(m.event.openDate) || 0;
    if (a.live !== true && start > 0 && start <= Date.now()) return { fehler: "Orbit: game has started — this is a pre-match order" };
    return { name: String(seite.runnerName) };
  }

  // Preisbild EINES Markts aus dem Socket (wie der Sammler: o → applicationType → Abo; erster Rahmen je Markt = marketDefinition + rc, Beleg HAR).
  // Das Anfangsbild kommt in Zehntelsekunden und stimmt mit einer laufenden Verbindung ueberein (Gegenprobe 16.09.). Nur lesen, danach zu.
  function bildLesen(a) {
    return new Promise((fertig) => {
      let ws = null, ende = false, def = null; const rc = {};
      const aus = (r) => { if (ende) return; ende = true; clearTimeout(t); try { if (ws) { ws.onmessage = ws.onclose = ws.onerror = null; ws.close(); } } catch (_) {} fertig(r); };
      const t = setTimeout(() => aus(def ? { def, rc } : { fehler: "no price picture within " + BILD_MS / 1000 + " s" }), BILD_MS);
      const srv = String(Math.floor(Math.random() * 1000)).padStart(3, "0"), sess = Array.from(crypto.getRandomValues(new Uint8Array(8))).map((b) => b.toString(16).padStart(2, "0")).join("");
      try { ws = new WebSocket("wss://" + location.host + "/customer/ws/multiple-market-prices/" + srv + "/" + sess + "/websocket"); }
      catch (e) { aus({ fehler: hinweisFehler(e) }); return; }
      ws.onmessage = (ev) => {
        const s = typeof ev.data === "string" ? ev.data : "";
        if (s === "o") {
          ws.send(JSON.stringify([JSON.stringify([{ applicationType: "WEB" }])]));
          ws.send(JSON.stringify([JSON.stringify([{ marketId: a.marketId, eventId: a.eventId, applicationType: "WEB" }])]));
          return;
        }
        if (s[0] !== "a") return;
        let arr; try { arr = JSON.parse(s.slice(1)); } catch (_) { return; }
        for (const str of arr) {
          let m; try { m = JSON.parse(str); } catch (_) { continue; }
          if (!m || String(m.id) !== a.marketId) continue;
          if (m.marketDefinition) def = m.marketDefinition;
          if (Array.isArray(m.rc)) for (const x of m.rc) if (x && x.id != null) rc[String(x.id)] = x;
        }
        if (def && (def.status !== "OPEN" || Object.keys(rc).length)) aus({ def, rc });
      };
      ws.onclose = () => aus({ fehler: "price socket closed" });
      ws.onerror = () => aus({ fehler: "price socket failed" });
    });
  }

  // Alles vor dem Senden. Rueckgabe { grenze, roh } oder { fehler, odds?, cur? }.
  // MINDESTQUOTE: p.minOdds ist EFFEKTIV (nach 3 % Provision), wie in handleOrbitPlace und im Board. Geprueft und gesetzt wird der ROHE Preis:
  // effektiv → roh → aufwaerts auf die Leiter = Limit der Order. Der beste Back-Preis muss mindestens dieses Limit sein; die Boerse fuellt zu den
  // besten Preisen ≥ Limit.
  async function pruefen(a) {
    const einsatz = Math.round(Number(a.amount) * 100) / 100, minEff = Number(a.minOdds);
    if (!(einsatz >= MIN_EINSATZ)) return { fehler: "Orbit: stake " + einsatz + " € below the Orbit minimum " + MIN_EINSATZ + " €" };
    if (einsatz > MAX_EINSATZ) return { fehler: "Orbit: stake " + einsatz + " € above " + MAX_EINSATZ + " €" };
    if (!(minEff > 1)) return { fehler: "Orbit: minimum odds missing" };
    const grenze = leiterAuf(rohMin(minEff));
    if (!(grenze >= 1.01) || !aufLeiter(grenze)) return { fehler: "Orbit: no price for min " + minEff };
    let konto, markt, bild;
    try { [konto, markt] = await Promise.all([kontoLesen(), marktLesen(a)]); }
    catch (e) { return { fehler: "Orbit: account or game not readable (" + hinweisFehler(e) + ")" }; }
    if (konto.fehler) return konto;
    if (markt.fehler) return markt;
    if (einsatz < konto.min) return { fehler: "Orbit: stake " + einsatz + " € below the account minimum " + konto.min + " €" };
    if (einsatz > konto.max) return { fehler: "Orbit: stake " + einsatz + " € above the account maximum " + konto.max + " €" };
    try { bild = await bildLesen(a); } catch (e) { return { fehler: "Orbit: price not readable (" + hinweisFehler(e) + ")" }; }
    if (bild.fehler) return { fehler: "Orbit: price not readable (" + bild.fehler + ")" };
    const d = bild.def;
    if (d.marketType !== "MATCH_ODDS" || String(d.eventId) !== a.eventId) return { fehler: "Orbit: price picture belongs to another market" };
    if (d.status !== "OPEN") return { fehler: "Orbit: market suspended (" + String(d.status).slice(0, 12) + ")" };
    if (typeof d.inPlay !== "boolean") return { fehler: "Orbit: in-play state not readable" };
    if (a.live === true && d.inPlay !== true) return { fehler: "Orbit: game is not in-play at Orbit — no live bet" };
    if (a.live !== true && d.inPlay === true) return { fehler: "Orbit: game is live — this is a pre-match order" };
    const lauf = Array.isArray(d.runners) ? d.runners.find((x) => x && String(x.id != null ? x.id : x.selectionId) === a.selectionId) : null;
    if (!lauf || lauf.status !== "ACTIVE") return { fehler: "Orbit: selection " + a.selectionId + " is not active" };
    const zeile = bild.rc[a.selectionId], beste = zeile && Array.isArray(zeile.bdatb) ? zeile.bdatb[0] : null, roh = beste ? Number(beste.odds) : 0;
    if (!zeile || zeile.locked === true) return { fehler: "Orbit: outcome not offered (" + a.sel + ")" };
    if (!(roh > 1)) return { fehler: "Orbit: no back price for " + a.sel };
    if (roh < grenze - 1e-9) return { fehler: "Orbit back " + roh + " (" + eff(roh) + " after commission) below min " + minEff.toFixed(2), odds: eff(roh) };
    return { grenze, roh, einsatz };
  }

  async function setzen(a) {
    if (a.armed !== true) return { gesendet: false, status: "blocked", reason: "Orbit: order not armed — nothing sent" };
    const g = await pruefen(a);
    if (g.fehler) return { gesendet: false, status: "blocked", reason: g.fehler + " — nothing sent", odds: g.odds, cur: g.cur };
    const betUuid = Date.now() + "-" + Math.random().toString(36).slice(2, 7);
    // Seite fest BACK: dieses Script kennt keinen anderen Auftrag. persistenceType LAPSE: was beim Anpfiff nicht gefuellt ist, verfaellt bei Orbit von selbst.
    const wette = { selectionId: Number(a.selectionId), handicap: 0, price: g.grenze, size: g.einsatz, side: "BACK", betUuid, betType: "EXCHANGE", netPLBetslipEnabled: false, netPLMarketPageEnabled: true,
      quickStakesEnabled: true, confirmBetsEnabled: false, applicationType: "WEB", mobile: false, isEachWay: false, eachWayData: {}, page: "multi-market", persistenceType: "LAPSE", placedUsingEnterKey: false };
    const auch = { gesendet: true, grenze: g.grenze, roh: g.roh, einsatz: g.einsatz };
    let r;
    try { r = await api("placeBets", { method: "POST", headers: kopf(true), body: JSON.stringify({ [a.marketId]: [wette] }) }, SENDEN_MS); }
    catch (e) { return Object.assign(auch, { unklar: true, grund: "no answer while sending (" + hinweisFehler(e) + ")" }); }
    // Ausdrueckliche Absage: 4xx (gemessen 405 {"code":405} = nicht angemeldet; 403 = Leitung) und status FAIL (gemessen WALLET_NOT_ENOUGH_MONEY_EXCEPTION).
    if (r.status >= 400 && r.status < 500) return Object.assign(auch, { abgelehnt: true, grund: r.status === 405 ? "not signed in (HTTP 405)" : "HTTP " + r.status });
    const x = r.j && r.j[a.marketId];
    if (!r.ok || !x || typeof x !== "object") return Object.assign(auch, { unklar: true, grund: "unreadable answer (HTTP " + r.status + ")" });
    if (x.status === "FAIL") return Object.assign(auch, { abgelehnt: true, grund: String(x.error || "FAIL").slice(0, 80) });
    if (x.status !== "OK") return Object.assign(auch, { unklar: true, grund: "answer status " + String(x.status).slice(0, 24) });
    const ids = x.offerIds && typeof x.offerIds === "object" ? Object.values(x.offerIds) : [];
    if (ids.length !== 1 || !/^\d{5,15}$/.test(String(ids[0]))) return Object.assign(auch, { unklar: true, grund: "order accepted without one order number" });
    return Object.assign(auch, { ok: true, offerId: String(ids[0]), betDelay: Number(x.betDelay) || 0 });
  }

  // Nur diese Felder einer Wette verlassen den Tab (die rohe Zeile traegt u. a. betUuid und Spielnamen).
  function kurz(b) {
    return { offerId: b.offerId != null ? String(b.offerId) : null, marketId: b.marketId, selectionId: b.selectionId, side: b.side, price: Number(b.price), averagePrice: Number(b.averagePrice) || null,
      sizePlaced: Number(b.sizePlaced) || 0, sizeMatched: Number(b.sizeMatched) || 0, sizeRemaining: Number(b.sizeRemaining) || 0, sizeCancelled: Number(b.sizeCancelled) || 0,
      sizeLapsed: Number(b.sizeLapsed) || 0, offerState: b.offerState || null, currency: typeof b.currency === "string" ? b.currency : null };
  }
  async function wetteLesen(marketId, offerId) {
    let r; try { r = await lies("currentBets"); } catch (e) { return { ok: false, grund: "currentBets: " + hinweisFehler(e) }; }
    if (!r.ok || !Array.isArray(r.j)) return { ok: false, grund: "currentBets HTTP " + r.status };
    return { ok: true, roh: r.j.filter((b) => b && String(b.marketId) === String(marketId) && String(b.offerId) === String(offerId)) };
  }
  async function offen(a) { const o = await wetteLesen(a.marketId, a.offerId); return o.ok ? { ok: true, wetten: o.roh.map(kurz) } : o; }
  // Rest stornieren: Wette aus currentBets, betType dazu (Form aus Orbits Seiten-Code, in orbit-auftraege.ndjson 162-mal bestaetigt). Nur diese eine Order.
  async function storno(a) {
    const o = await wetteLesen(a.marketId, a.offerId);
    if (!o.ok) return o;
    if (o.roh.length !== 1) return { ok: false, grund: "order " + a.offerId + " not uniquely among the current bets" };
    const b = o.roh[0], davor = kurz(b);
    if (!(davor.sizeRemaining > 0)) return { ok: true, nichtsOffen: true, danach: davor };
    let r; try { r = await api("cancelBets", { method: "POST", headers: kopf(true), body: JSON.stringify({ [a.marketId]: [Object.assign({}, b, { betType: "EXCHANGE" })] }) }, SENDEN_MS); }
    catch (e) { return { ok: false, davor, grund: "no answer to the cancel (" + hinweisFehler(e) + ")" }; }
    const x = r.j && r.j[a.marketId], angenommen = r.ok && !(x && x.status && x.status !== "OK");
    if (!angenommen) return { ok: false, davor, grund: "cancel refused (HTTP " + r.status + (x && x.status ? " " + String(x.status).slice(0, 12) : "") + ")" };
    await warte(1200);
    const n = await wetteLesen(a.marketId, a.offerId);
    const d = n.ok && n.roh.length === 1 ? kurz(n.roh[0]) : null;
    if (d && !(d.sizeRemaining > 0)) return { ok: true, angenommen, danach: d };
    // Ganz aus currentBets verschwunden: weg, solange nichts gefuellt war. War etwas gefuellt, bliebe die Zeile stehen — dann ist der Stand unklar.
    if (n.ok && n.roh.length === 0 && !(davor.sizeMatched > 0)) return { ok: true, angenommen, danach: Object.assign(davor, { sizeRemaining: 0, sizeCancelled: davor.sizeRemaining, offerState: "GONE" }) };
    return { ok: false, angenommen, davor, danach: d, grund: "cancel not confirmed (rest " + (d ? d.sizeRemaining : "?") + " €)" };
  }
  async function anmeldung() {
    try { const r = await lies("account/login/status"); return { ok: true, http: r.status, angemeldet: r.ok && r.j === true }; }
    catch (e) { return { ok: false, grund: hinweisFehler(e) }; }
  }

  let laeuft = false;
  const _laeufe = new Map();          // Auftrags-Nr. → Promise des Ergebnisses (dieselbe Nummer sendet nie zweimal)
  function einmal(a) {
    const nr = String(a.auftragId);
    if (_laeufe.has(nr)) return _laeufe.get(nr);
    if (laeuft) return Promise.resolve({ gesendet: false, status: "blocked", reason: "Orbit: another order is running in this tab — nothing sent" });
    laeuft = true;
    const p = setzen(a).then((r) => { if (r && r.gesendet === false) _laeufe.delete(nr); return r; }, (e) => ({ gesendet: true, unklar: true, grund: hinweisFehler(e) })).finally(() => { laeuft = false; });
    _laeufe.set(nr, p);
    while (_laeufe.size > 40) _laeufe.delete(_laeufe.keys().next().value);
    return p;
  }
  // Nachrichten-Weg gibt es hier nicht: books/orbitxch.js ruft auftrag() per executeScript und bekommt das Ergebnis direkt zurueck.
  function auftrag(a) {
    if (!a || typeof a !== "object") return Promise.resolve({ ok: false, grund: "no order" });
    if (a.art === "ping") return Promise.resolve({ ok: true, kern: KERN });
    if (a.art === "anmeldung") return anmeldung();
    if (!/^1\.\d{5,12}$/.test(String(a.marketId || ""))) return Promise.resolve(a.art === "setzen" ? { gesendet: false, status: "blocked", reason: "Orbit: market number unreadable — nothing sent" } : { ok: false, grund: "market number unreadable" });
    if (a.art === "offen" && /^\d{5,15}$/.test(String(a.offerId || ""))) return offen(a);
    if (a.art === "storno" && /^\d{5,15}$/.test(String(a.offerId || ""))) return storno(a);
    if (a.art !== "setzen") return Promise.resolve({ ok: false, grund: "order type or number unknown" });
    if (!/^[A-Za-z0-9_.:-]{6,140}$/.test(String(a.auftragId == null ? "" : a.auftragId))) return Promise.resolve({ gesendet: false, status: "blocked", reason: "Orbit: order number missing — nothing sent" });
    if (!/^\d{5,15}$/.test(String(a.eventId || "")) || !/^\d{1,12}$/.test(String(a.selectionId || ""))) return Promise.resolve({ gesendet: false, status: "blocked", reason: "Orbit: game or selection number unreadable — nothing sent" });
    return einmal(a);
  }
  window.__engineOrbit = { kern: KERN, auftrag };
})();
