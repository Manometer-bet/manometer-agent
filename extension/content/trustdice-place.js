// trustdice-place.js — PLACEMENT ONLY content script for TrustDice (engine: BetBy / sptpub).
//
// Extracted from the operator extension's production code. Unlike MyStake, BetBy needs NO widget
// hash: placement is a plain JSON POST to /v2/coupon/brand/<brand>/bet/place, authorised by the
// live x-session-id header set (captured by trustdice-inject.js from the logged-in page). That
// makes this the safest of the three paths — no DOM clicking at all.
//
// DELIBERATELY OMITTED: the whole search/resolve layer. The operator supplies bookRef.eventId (a
// BetBy event id) and, for CS2, the verified market descriptor — the engine never guesses an event.
//
// Encodings (HAR-verified by the operator):
//   football 1X2 : market "1",  specifiers ""        , outcome "1"=home "2"=draw "3"=away
//   football AH  : market "16", specifiers "hcp=…"   , outcomes from the event's own ladder
//   CS2 ML       : market "186"                       (descriptor supplied by the operator)
//   CS2 map win. : market "330", specifiers "mapnr=N", outcome "4"=home "5"=away
(() => {
  "use strict";
  // Version im Marker: ein Tab, der seit einem Extension-Update offen ist, laeuft sonst ewig mit
  // ALTEM Code weiter — die Neu-Injektion prallt am Marker ab (Fund 30.07., kostete mehrere Runden).
  const SCRIPT_VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return "?"; } })();
  if (window.__engineTdPlace) return;
  window.__engineTdPlace = SCRIPT_VERSION;
  // Beim Start den letzten Erfassungs-Stand vom Inject anfordern (Nachfrage-Bruecke): so ist es
  // egal, ob dieses Skript vor oder nach dem Anfangs-Schwall der Widget-Anfragen geladen wurde.
  const askInject = () => { try { window.postMessage({ source: "td-place", kind: "need" }, "*"); } catch (_) {} };
  setTimeout(askInject, 0); setTimeout(askInject, 1000); setTimeout(askInject, 3000);

  let API_HOST = "api-a-c7818b61-600.sptpub.com";
  let HOST_SRC = "DEFAULT (nie erfasst!)";          // Diagnose: benutzen wir den fest verdrahteten Wert?
  let SEEN = {};
  let BRAND = "2548727380772532233";
  let SESSION = null, EXTRA = {}, MINBET = "0.0001";

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== "td-inject") return;
    if (d.apiHost && /^api-[a-z0-9-]+\.sptpub\.com$/i.test(d.apiHost)) { API_HOST = d.apiHost; HOST_SRC = "erfasst"; }   // zweite Sperre: nie ein Theme-/Start-Host
    if (d.seen) SEEN = d.seen;
    if (d.brand && /^\d{6,30}$/.test(String(d.brand))) BRAND = String(d.brand);
    if (d.minBet) MINBET = d.minBet;
    if (d.headers) { EXTRA = Object.assign(EXTRA, d.headers); const s = EXTRA["x-session-id"]; if (s) SESSION = s; }
  });

  const api = () => `https://${API_HOST}/api`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, { timeout = 8000, interval = 200 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { let v; try { v = fn(); } catch (_) { v = null; } if (v) return v; await sleep(interval); }
    return null;
  }
  function cookieMap() {
    const out = {};
    try { (document.cookie || "").split(";").forEach((p) => { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }); } catch (_) {}
    return out;
  }
  // bet/place checks the session TOGETHER with the GA4 ids (else HTTP 401 "Authorization missing").
  function gaHeaders() {
    const out = {}, c = cookieMap();
    try {
      if (c["_ga"]) { const v = c["_ga"].replace(/^GA\d+\.\d+\./, ""); if (v) out["x-ga-client-id"] = v; }
      const gk = Object.keys(c).find((k) => /^_ga_/.test(k));
      if (gk && c[gk]) { const s = c[gk].replace(/^GS\d+\.\d+\./, "").split(".")[0]; if (s) out["x-ga-session-id"] = s; }
    } catch (_) {}
    return out;
  }

  // preJson: vom Service Worker vorgeholte Event-Daten. Hintergrund (30.07.): Aus dem Isolated World
  // des Content-Skripts scheitert der sptpub-Abruf mit "Failed to fetch" (CORS), waehrend derselbe
  // Aufruf aus der Seite 200 liefert — im Service Worker greift die host_permission, dort ist es
  // unkritisch. Eigener Abruf bleibt als Rueckfallebene erhalten.
  // Wie im Operator (produktionsbewaehrt): direkter Abruf aus dem Content-Skript. Die
  // host_permission auf *.sptpub.com deckt das ab — der Operator liest so seit Monaten.
  async function eventData(eventId) {
    const url = `${api()}/v4/prematch/brand/${BRAND}/event/de/${eventId}`;
    let res;
    // Netzwerk-/CORS-Fehler und HTTP-Fehler unterscheiden UND die URL mitgeben — sonst steht im
    // Protokoll nur "Failed to fetch" und man weiss nicht, welcher Host/Brand gemeint war.
    try { res = await fetch(url, { credentials: "omit" }); }
    catch (e) { throw new Error("Netzwerk/CORS bei " + url + " -> " + String((e && e.message) || e)); }
    if (!res.ok) throw new Error("HTTP " + res.status + " bei " + url);
    const j = await res.json();
    const ev = j.events && j.events[String(eventId)];
    if (!ev) return null;
    const mk = ev.markets || {};
    // Event-Seiten-URL aus den Lookup-Maps bauen — 1:1 wie im Operator (Muster verifiziert):
    // /de/sports/<sportSlug>-<id>/<catSlug>-<id>/<tournSlug>-<id>/<eventSlug>-<eventId>
    const desc = ev.desc || {};
    let urlPath = null;
    try {
      const sp = j.sports && j.sports[String(desc.sport)];
      const ca = j.categories && j.categories[String(desc.category)];
      const to = j.tournaments && j.tournaments[String(desc.tournament)];
      if (sp && sp.slug && ca && ca.slug && to && to.slug && desc.slug) {
        urlPath = `/de/sports/${sp.slug}-${desc.sport}/${ca.slug}-${desc.category}/${to.slug}-${desc.tournament}/${desc.slug}-${eventId}`;
      }
    } catch (_) {}
    const comp = (desc.competitors) || [];
    const odds = {};
    const m1 = mk["1"] && mk["1"][""];
    if (m1) {
      const g = (oid) => (m1[oid] && m1[oid].k != null && !m1[oid].b) ? parseFloat(m1[oid].k) : null;
      const o1 = g("1"), oX = g("2"), o2 = g("3");
      if (o1) odds["1"] = o1; if (oX) odds["X"] = oX; if (o2) odds["2"] = o2;
    }
    // AH ladder (market 16): specifiers "hcp=<line>", home-signed. Outcome ids come from the feed.
    const byLine = {};
    const m16 = mk["16"] || {};
    for (const spec in m16) {
      const mm = m16[spec] || {};
      const hm = /hcp=(-?\d+(?:\.\d+)?)/.exec(spec); if (!hm) continue;
      const line = String(parseFloat(hm[1]));
      const ids = Object.keys(mm);
      if (ids.length < 2) continue;
      const sorted = ids.sort((a, b) => Number(a) - Number(b));
      const hOc = sorted[0], aOc = sorted[1];
      const hv = mm[hOc] && !mm[hOc].b && mm[hOc].k != null ? parseFloat(mm[hOc].k) : null;
      const av = mm[aOc] && !mm[aOc].b && mm[aOc].k != null ? parseFloat(mm[aOc].k) : null;
      if (hv && av) byLine[line] = { spec, homeOc: hOc, awayOc: aOc, home: hv, away: av };
    }
    return { odds, ah: { byLine }, markets: mk, urlPath, home: (comp[0] && comp[0].name) || "", away: (comp[1] && comp[1].name) || "" };
  }
  // Odds for an arbitrary descriptor (used for the CS2 path, where the operator supplies it).
  function oddsFor(markets, marketId, specifiers, outcomeId) {
    const m = markets && markets[String(marketId)];
    const bucket = m && m[String(specifiers || "")];
    const o = bucket && bucket[String(outcomeId)];
    return (o && o.k != null && !o.b) ? parseFloat(o.k) : null;
  }

  // Session-Härtung: die BetBy-Server-Session stirbt, wenn der Tab kalt war (kein auth_side-Poll mehr) → 401.
  // Wir frischen sie AKTIV auf: (1) TrustDice-JWT ziehen (autorisiert BetBy), (2) BetBy `identify` mit der
  // x-session-id aufrufen (hält/erneuert die Server-Session). Wird proaktiv vor dem Setzen + im Keepalive
  // gerufen und einmal nach einem 401. Nur Lesen/Auth, setzt nichts.
  // Konto-Währung (EUR oder BTC): der BetBy-JWT MUSS für die richtige Währung geholt werden,
  // sonst autorisiert `identify` die Session nicht → bet/place bleibt bei HTTP 401 (per HAR 05.09. bewiesen:
  // currency=EUR → identify → 200 accepted). Früher hart „BTC" → für ein EUR-Konto immer 401. Aus der
  // Wallet-API erkannt (fiat vor krypto, größter Saldo), 1x gecacht.
  let ACCT_CUR = null;
  async function detectCurrency() {
    if (ACCT_CUR) return ACCT_CUR;
    try {
      const r = await fetch("https://api.trustdice.win/account/wallet/", { method: "POST", credentials: "include", cache: "no-store", headers: { "content-type": "application/json" } });
      const j = await r.json().catch(() => null);
      const w = j && j.wallets;
      if (w) {
        const pref = ["EUR", "USD", "USDT"];   // Fiat mit Saldo hat Vorrang; sonst die Währung mit dem größten Saldo
        let best = null, bestScore = -1;
        for (const c of Object.keys(w)) {
          const v = Number(w[c]) || 0;
          const score = v * (pref.indexOf(c) >= 0 ? 1e6 : 1);   // Fiat massiv bevorzugen, wenn überhaupt Saldo
          if (v > 0 && score > bestScore) { bestScore = score; best = c; }
        }
        ACCT_CUR = best || "EUR";
      }
    } catch (_) {}
    return ACCT_CUR || "EUR";
  }
  async function refreshSession(curOverride) {
    try {
      const cur = curOverride || await detectCurrency();
      try { await fetch("https://api.trustdice.win/sportsbook/jwt/?currency=" + encodeURIComponent(cur) + "&lang_code=de", { credentials: "include", cache: "no-store" }); } catch (_) {}
      if (!SESSION) SESSION = await waitFor(() => SESSION, { timeout: 4000 });
      if (!SESSION) return false;
      const h = Object.assign({}, gaHeaders(), EXTRA, { "x-session-id": SESSION });
      const r = await fetch(`${api()}/v2/auth/brand/${BRAND}/identify`, { credentials: "omit", headers: h, cache: "no-store" });
      return !!(r && r.ok);
    } catch (_) { return false; }
  }

  // One shared sender: builds the payload, POSTs, audits the accepted bet_request_id (fail-closed).
  async function send({ eventId, marketId, specifiers, outcomeId, odds, amountBtc, amountEur, minOdds, rate }) {
    if (!SESSION) SESSION = await waitFor(() => SESSION, { timeout: 6000 });
    if (!SESSION) return { status: "blocked", reason: "BetBy session not captured — open/reload the sportsbook on trustdice.win and retry." };
    // Währungsbewusst: EUR/USD/USDT-Konto → Betrag DIREKT als sum (kein BTC). Sonst BTC (+ BTC-Minimum).
    const cur = slipCurrency();
    let sum, isFiat = /^(EUR|USD|USDT)$/i.test(cur || "") && Number(amountEur) > 0;
    if (isFiat) {
      sum = Number(amountEur).toFixed(2);
    } else {
      const minBtc = parseFloat(MINBET) || 0.0001;
      const betBtc = Math.round(Number(amountBtc) * 1e8) / 1e8;
      if (!(betBtc > 0)) return { status: "blocked", reason: "no valid BTC stake (rate missing?) — Konto evtl. Fiat, aber Slip-Währung nicht erkannt" };
      if (betBtc < minBtc) {
        const minEur = (rate > 0) ? ` (≈ ${(minBtc * rate).toFixed(2)} €)` : "";
        return { status: "blocked", reason: `stake ${amountEur} € ≈ ${betBtc.toFixed(8)} BTC is below TrustDice's minimum ${minBtc} BTC${minEur}` };
      }
      sum = betBtc.toFixed(8);
    }
    const k = String(minOdds);   // floor; odds_change "higher" fills only at floor-or-better
    const spec = String(specifiers || "");
    const reqId = `${eventId}_${marketId}_${spec}_${outcomeId}`;
    const payload = [{
      type: "1/1", sum, k, global_id: null, bonus_id: null, bet_request_id: reqId, odds_change: "higher",
      selections: [{
        event_id: String(eventId), market_id: String(marketId), specifiers: spec, outcome_id: String(outcomeId), k,
        source: { layout: "tile", page: "/:sportSlug/:categorySlug/:tournamentSlug/:eventSlugAndId", section: "", extra: { market: "Main", timeFilter: "", banner_type: "", tab: "" } },
        promo_id: null, bonus_id: null, timestamp: Date.now(),
      }],
    }];
    await refreshSession();   // Session VOR dem Setzen proaktiv auffrischen (Kern der Härtung gegen 401)
    for (let attempt = 0; attempt < 3; attempt++) {
      const headers = Object.assign({ "content-type": "application/json" }, gaHeaders(), EXTRA, (SESSION && !EXTRA["x-session-id"]) ? { "x-session-id": SESSION } : {});
      let res, txt;
      try {
        res = await fetch(`${api()}/v2/coupon/brand/${BRAND}/bet/place`, { method: "POST", credentials: "omit", headers, body: JSON.stringify(payload) });
        txt = await res.text();
      } catch (e) { return { status: "uncertain", odds, reason: "network error — POSSIBLY placed, check bet history: " + String((e && e.message) || e) }; }
      let j = null; try { j = JSON.parse(txt); } catch (_) {}
      if (j && Array.isArray(j.accepted) && j.accepted.length) {
        const acc = j.accepted[0];
        if (acc.bet_request_id && String(acc.bet_request_id) !== reqId) {
          return { status: "uncertain", odds, reason: `AUDIT: accepted ${acc.bet_request_id} != target ${reqId}. Check bet history.` };
        }
        return { status: "placed", odds, ticket: acc.bet_id || null, betBtc: isFiat ? null : sum, stake: sum, cur: cur || "BTC", note: "BetBy accepted (" + (cur || "BTC") + (attempt ? ", nach Session-Refresh" : "") + ")" };
      }
      const err = (j && j.error && j.error[0] && j.error[0].message) || ("HTTP " + res.status);
      if (j && Array.isArray(j.error) && j.error.length) return { status: "blocked", odds, reason: "TrustDice rejected: " + err };
      // HTTP 401 = Session-Autorisierung abgelaufen. 1) mit erkannter Konto-Währung auffrischen; 2) falls
      // immer noch 401, EINMAL mit der ANDEREN Währung (EUR↔BTC) — deckt eine falsche Auto-Erkennung ab
      // (genau der Fall EUR-Konto vs. hart-BTC). Erst danach blocked.
      if (res.status === 401) {
        if (attempt === 0) { await refreshSession(); await new Promise(function (r) { setTimeout(r, 900); }); continue; }
        if (attempt === 1) { const alt = (ACCT_CUR && /btc/i.test(ACCT_CUR)) ? "EUR" : "BTC"; await refreshSession(alt); await new Promise(function (r) { setTimeout(r, 900); }); continue; }
        return { status: "blocked", odds, reason: "BetBy 401 auch nach Session-Refresh (EUR+BTC probiert) — nichts gesetzt. trustdice.win offen & eingeloggt halten." };
      }
      return { status: "uncertain", odds, reason: "no clear accept/error from BetBy (" + err + ") — check bet history" };
    }
  }


  // ================= BetBy-WIDGET-PLATZIERUNG (1:1 aus dem Operator, trustdice-content.js) =========
  // Warum das der EIGENTLICHE Weg ist (Operator-Kommentar, hier woertlich bestaetigt am 30.07.):
  //   "Der reine API-POST scheitert nach Stunden mit 401, weil die serverseitige Wett-Autorisierung
  //    der (persistenten) Session ablaeuft und sich per Reload NICHT erneuern laesst. Setzen wir
  //    dagegen ueber das Widget (Outcome -> Einsatz -> Platzieren), erzeugt das SDK die
  //    Autorisierung selbst — derselbe Weg, der bei MyStake/Jackbit funktioniert."
  // Das BetBy-Widget rendert INLINE im Shadow-DOM des Top-Frames — deshalb die deepEls-Tiefensuche.
  // Beim Portieren wurde emit() zu console.debug — damit landete ALLES, was placeViaDom tut, nur in
  // der Browser-Konsole und nie im Engine-Protokoll (30.07.). Jetzt geht es an den Service Worker.
  function dbg() {
    const a = [].slice.call(arguments);
    try { console.debug.apply(console, ["[engine/trustdice]"].concat(a)); } catch (_) {}
    try {
      const txt = a.map((x) => (typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch (_) { return String(x); } })())).join(" ");
      chrome.runtime.sendMessage({ cmd: "engineNote", src: "trustdice-dom", msg: txt.slice(0, 400) });
    } catch (_) {}
  }
  function deepEls(root) {
    const out = []; const stack = [root];
    while (stack.length) {
      const r = stack.pop(); let els; try { els = r.querySelectorAll("*"); } catch (_) { els = []; }
      for (const e of els) { out.push(e); if (e.shadowRoot) stack.push(e.shadowRoot); }
    }
    return out;
  }
  function ownText(el) { let t = ""; for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue; return t.trim(); }
  // 1:1 aus dem Operator. NICHT umbenennen — der portierte Code ruft genau diese Namen auf.
  const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "");
  const EPS_TD = 1e-9;
  function hasAll(vals, want) { return want.every((w) => vals.some((v) => Math.abs(v - w) < EPS_TD)); }
  const looksLikeOdd = (t) => /^\d{1,4}[.,]\d{1,2}$/.test((t || "").trim());
  const parseOdd = (t) => parseFloat(String(t).trim().replace(",", "."));
  // Absende-Button des BetBy-Wettscheins. TrustDice DE beschriftet ihn "BUCHEN" (live verifiziert 05.09.);
  // dazu die üblichen Varianten für andere Sprachen/Änderungen. FEHLTE komplett → findPlaceButton warf
  // ReferenceError (PLACE_RX undefined) → Wettschein wurde nie abgesendet ("wählt aus, sendet aber nicht ab").
  // "WETTEN" ist der echte Setz-Button. "BUCHEN"/"book" ist NUR ein Buchungscode/Merkzettel (kein Geld,
  // keine echte Wette) — BEWUSST NICHT hier drin und in findPlaceButton hart ausgeschlossen. (06.09.: genau
  // das war der Bug — die Engine klickte BUCHEN statt WETTEN → nie Geld gesetzt, Auswahl blieb im Schein.)
  const PLACE_RX = /^wetten$|jetztwetten|platzieren|placebet|betnow|(place|confirm|submit)(bet|wette|ticket|wager)|^(setzen|abgeben|bestatigen|confirm|submit)$/;

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value") || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function isVisible(el) { try { return el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0); } catch (_) { return true; } }
  function clickableAncestor(el) {
    let n = el;
    for (let i = 0; i < 6 && n; i++) {
      if (n.tagName === "BUTTON" || (n.getAttribute && n.getAttribute("role") === "button") || n.onclick || (typeof n.tabIndex === "number" && n.tabIndex >= 0 && n.tagName !== "BODY")) return n;
      try { if (getComputedStyle(n).cursor === "pointer") return n; } catch (_) {}
      n = n.parentElement;
    }
    return el;
  }
  function describeEl(el) {
    if (!(el && el.tagName)) return null;
    const cls = (el.className && el.className.toString && el.className.toString()) || "";
    return { tag: el.tagName.toLowerCase(), cls: cls.slice(0, 50) || undefined, text: (ownText(el) || "").slice(0, 30) || undefined };
  }
  function oddEls() { return deepEls(document).filter((e) => looksLikeOdd(ownText(e)) && isVisible(e)); }
  function realClick(el) {
    try {
      const r = el.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      for (const t of ["pointerover", "pointerenter", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        const E = (t.indexOf("pointer") === 0 && window.PointerEvent) ? PointerEvent : MouseEvent;
        el.dispatchEvent(new E(t, o));
      }
    } catch (_) { try { el.click(); } catch (__) {} }
  }
  async function enterStakeVerified(input, str) {
    const nrm = (v) => String(v == null ? "" : v).replace(",", ".").replace(/\s+/g, "");
    const want = nrm(str);
    const taken = () => { const v = nrm(input.value); if (!v) return false; const n = Number(v); return v === want || (n > 0 && Math.abs(n - Number(want)) < 1e-9); };
    setNativeValue(input, str);
    await sleep(350);
    if (taken()) return { ok: true, method: "native" };
    try {
      input.focus();
      if (typeof input.select === "function") input.select();
      else if (typeof input.setSelectionRange === "function") input.setSelectionRange(0, String(input.value || "").length);
      document.execCommand("insertText", false, str);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (_) {}
    await sleep(350);
    if (taken()) return { ok: true, method: "insertText" };
    return { ok: false, value: String(input.value == null ? "" : input.value) };
  }
  function findOddButton(want, oddsObj) {
    if (!(want != null && isFinite(want))) return null;
    const wantSet = ["1", "X", "2"].map((k) => oddsObj[k]).filter((v) => isFinite(v));
    const all = oddEls();
    if (!all.length) return null;
    // 1) EXACT, preferring the element whose ancestor group carries all three 1X2 values.
    const exact = all.filter((e) => Math.abs(parseOdd(ownText(e)) - want) < 1e-9);
    for (const e of exact) {
      let node = e;
      for (let i = 0; i < 8 && node; i++) {
        node = node.parentElement; if (!node) break;
        const vals = all.filter((x) => node.contains(x)).map((x) => parseOdd(ownText(x)));
        if (vals.length >= 3 && hasAll(vals, wantSet)) return clickableAncestor(e);
      }
    }
    if (exact.length) return clickableAncestor(exact[0]);
    // 2) TOLERANT: BetBy odds drift between the read and the render (1.84→1.85) → exact misses. Find the
    // market GROUP whose 3 values best match [1,X,2] (each within ~6%), then click the outcome nearest `want`.
    if (wantSet.length >= 3) {
      let bestGroup = null, bestErr = Infinity;
      for (const e of all) {
        let node = e;
        for (let i = 0; i < 6 && node; i++) {
          node = node.parentElement; if (!node) break;
          const members = all.filter((x) => node.contains(x));
          if (members.length < 3 || members.length > 6) continue;
          const vals = members.map((x) => parseOdd(ownText(x)));
          let err = 0, ok = true;
          for (const w of wantSet) { let m = Infinity; for (const v of vals) m = Math.min(m, Math.abs(v - w) / w); err += m; if (m > 0.06) ok = false; }
          if (ok && err < bestErr) { bestErr = err; bestGroup = members; }
        }
      }
      if (bestGroup) {
        let pick = null, pd = Infinity;
        for (const x of bestGroup) { const d = Math.abs(parseOdd(ownText(x)) - want) / want; if (d < pd) { pd = d; pick = x; } }
        if (pick && pd <= 0.06) return clickableAncestor(pick);
      }
    }
    return null;
  }
  function findStakeInput() {
    const inputs = deepEls(document).filter((e) => e.tagName === "INPUT" && isVisible(e));
    for (const i of inputs) {
      const meta = norm(i.name + " " + i.id + " " + (i.placeholder || "") + " " + (i.getAttribute("aria-label") || ""));
      if (/amount|stake|einsatz|bet|wager|betrag/.test(meta)) return i;
    }
    const nums = inputs.filter((i) => i.type === "number" || i.inputMode === "decimal");
    return nums.length === 1 ? nums[0] : null;
  }
  function findPlaceButton() {
    let best = null, wetten = null;
    for (const el of deepEls(document)) {
      if (!isVisible(el)) continue;
      const raw = ownText(el);
      if (!raw || raw.length > 40 || looksLikeOdd(raw)) continue;
      if (raw.trim().endsWith(":")) continue;
      const n = norm(raw);
      if (n === "bet" || n === "bets") continue;
      if (/buchen|buchungscode|booking|^book$/.test(n)) continue;   // "BUCHEN" = Buchungscode/Merkzettel (kein Geld) → NIE klicken
      if (n === "wetten") { wetten = el; continue; }                // primärer Setz-Button (DE) → hat Vorrang, egal wo im DOM
      if (PLACE_RX.test(n)) best = el;                              // Fallback (andere Sprachen/Varianten), last match wins
    }
    var pick = wetten || best;
    return pick ? clickableAncestor(pick) : null;
  }
  function findClearAllButton() {
    for (const el of deepEls(document)) {
      if (!isVisible(el)) continue;
      const own = norm(ownText(el)); if (own && own.length > 28) continue;
      const meta = norm((el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title") || "")) + " " + String(el.className || ""));
      if (/(clearbetslip|clearall|clearslip|clearcoupon|emptybetslip|removeall|wettscheinleeren|alleentfernen|alleloschen)/.test(own + " " + meta) || own === "clear" || own === "clearbet" || own === "klar") return clickableAncestor(el);
    }
    return null;
  }
  function findRemoveControls() {
    const out = [];
    for (const el of deepEls(document)) {
      if (!isVisible(el)) continue;
      const own = (ownText(el) || "").replace(/\s/g, "");
      if (own && own.length <= 2 && /^[x\u00d7\u2715\u2716\u274c]+$/i.test(own)) { out.push(el); continue; }
      const meta = norm((el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title") || "")) + " " + String(el.className || ""));
      if (/(removeall|clearall|remove|delete|clear|trash|entfernen|loschen)/.test(meta)) out.push(el);
    }
    return out;
  }
  function slipHasContent() { return !!findStakeInput(); }
  // Einsatz-Text fuer das Feld im Schein. Bisher kam ohne BTC-Kurs der Euro-Betrag ins Feld, auch auf einem BTC-Schein: „5.00“ waeren dort 5 BTC.
  // Euro nur auf einem Schein, der sichtbar Fiat oder Stablecoin fuehrt; sonst der umgerechnete Betrag, und ohne Kurs nichts.
  function einsatzText(cur, b, eur) {
    if (/^(EUR|USD|USDT)$/i.test(cur || "")) return eur > 0 ? eur.toFixed(2) : null;
    if (b == null) return null;
    return cur === "MBTC" ? (b * 1000).toFixed(5) : b.toFixed(8);
  }
  // 31.10.2026: zuerst im Schein selbst suchen. Die Seite drumherum zeigt auch andere Waehrungen (Kopfzeile, Spiele), und die erste beste bestimmte hier die Einheit des Einsatzes.
  function slipCurrency() {
    const schein = deepEls(document).find((e) => e.getAttribute && e.getAttribute("data-editor-id") === "betslipContent");
    for (const el of (schein ? deepEls(schein) : deepEls(document))) {
      if (!isVisible(el)) continue;
      const raw = (ownText(el) || "").trim(); if (!raw || raw.length > 24) continue;
      const up = raw.toUpperCase();
      if (/^(MBTC|BTC|USDT|EUR|USD)$/.test(up)) return up;
      const m = up.match(/\b(MBTC|BTC|USDT|EUR|USD)\b/); if (m) return m[1];
      if (raw === "€") return "EUR"; if (raw === "$") return "USD";
    }
    return null;
  }
  function slipErrorText() {
    for (const el of deepEls(document)) {
      if (!isVisible(el)) continue;
      const raw = (ownText(el) || "").trim(); if (!raw || raw.length > 90) continue;
      const t = norm(raw);
      if (/(minimum|mindest|minstake|mineinsatz|maxstake|maximaleinsatz|stakelimit|oddshavechanged|quotegeandert|quotehatsichgeandert|suspended|gesperrt|notavailable|nichtverfugbar|insufficient|unzureichend|guthaben|balance)/.test(t)) return raw;
    }
    return null;
  }
  function successToast() {
    for (const el of deepEls(document)) {
      if (!isVisible(el)) continue;
      const t = norm(ownText(el)); if (!t || t.length > 40) continue;
      if (/(betplaced|betaccepted|placedsuccessfully|successfullyplaced|ticketaccepted|betsuccess|wetteangenommen|erfolgreichplatziert)/.test(t)) return true;
    }
    return false;
  }
  async function clearSlip() {
    for (let pass = 0; pass < 6 && slipHasContent(); pass++) {
      const all = findClearAllButton();
      if (all) { realClick(all); await sleep(450); continue; }
      const ctrls = findRemoveControls();
      if (!ctrls.length) break;
      realClick(ctrls[0]); await sleep(350);
    }
    return !slipHasContent();
  }
  function dumpDomDiagnostics(oddsObj) {
    const all = deepEls(document);
    const oddAny = all.filter((e) => looksLikeOdd(ownText(e)));
    const shadowHosts = all.filter((e) => e.shadowRoot).length;
    const clickable = []; const seen = new Set();
    for (const e of all) {
      if (!isVisible(e)) continue;
      const t = ownText(e); if (!t || t.length > 24 || looksLikeOdd(t)) continue;
      let cur = false; try { cur = getComputedStyle(e).cursor === "pointer"; } catch (_) {}
      if (!(e.tagName === "BUTTON" || (e.getAttribute && e.getAttribute("role") === "button") || cur)) continue;
      if (seen.has(t)) continue; seen.add(t);
      clickable.push({ tag: e.tagName.toLowerCase(), txt: t.slice(0, 24) });
      if (clickable.length >= 30) break;
    }
    dbg("BetBy widget DOM diagnostics", {
      url: location.href, totalEls: all.length, shadowHosts, oddTagCount: oddAny.length,
      clickableLabels: clickable, ziel: oddsObj || null,
      stakeInput: describeEl(findStakeInput()), placeButton: describeEl(findPlaceButton())
    });
  }
  async function placeViaDom(msg, d) {
    const tip = msg.tip, want = d.odds[tip];
    const btn = await waitFor(() => findOddButton(want, d.odds), { timeout: 6000 });
    if (!btn) { dumpDomDiagnostics(d.odds); return { domUnavailable: true }; }
    if (slipHasContent()) {
      dbg("BetBy DOM: betslip not empty — clearing", {});
      if (!(await clearSlip())) { dumpDomDiagnostics(d.odds); return { status: "blocked", reason: "Betslip not empty and could not be cleared — aborting to avoid a combined bet. Please clear the TrustDice betslip and retry." }; }
    }
    dbg("BetBy DOM: clicking outcome", { tip, odds: want });
    realClick(btn); await sleep(800);
    const stakeInput = await waitFor(findStakeInput, { timeout: 5000 });
    if (!stakeInput) { dumpDomDiagnostics(d.odds); return { status: "uncertain", odds: want, reason: "Clicked the outcome but no stake field appeared — please check the TrustDice betslip. Locked (no re-bet)." }; }
    const cur = slipCurrency();
    const b = (msg.amountBtc != null && Number(msg.amountBtc) > 0) ? Math.round(Number(msg.amountBtc) * 1e8) / 1e8 : null;
    const eur = (msg.amountEur != null ? Number(msg.amountEur) : Number(msg.amount));
    const stakeStr = einsatzText(cur, b, eur);
    if (!stakeStr) {
      try { await clearSlip(); } catch (_) {}
      return { status: "blocked", reason: "Schein steht auf " + (cur || "unbekannter Waehrung") + ", aber es liegt kein BTC-Kurs vor — NICHT gesetzt." };
    }
    const st = await enterStakeVerified(stakeInput, stakeStr);
    if (!st.ok) {
      dumpDomDiagnostics(d.odds);
      // Es wurde NICHT auf "Wetten" geklickt -> definitiv keine Wette gesendet, blocked ist sicher
      // (Lock wird upstream sauber gelöst; kein uncertain-Manuell-Check nötig).
      return { status: "blocked", reason: `Stake konnte nicht ins Widget übernommen werden (State blieb "${st.value}", gewollt ${stakeStr}) — NICHT geklickt, keine Wette gesendet. BetBy-Widget vermutlich geändert.` };
    }
    dbg("BetBy DOM: stake entered", { amount_btc: stakeStr, currency: cur || "BTC?", amount_eur: msg.amountEur != null ? msg.amountEur : msg.amount, rate: msg.rate || null, method: st.method });
    await sleep(500);
    const place = await waitFor(findPlaceButton, { timeout: 4000 });
    if (!place) { dumpDomDiagnostics(d.odds); return { status: "uncertain", odds: want, reason: "Stake entered but no place button found — please confirm in the TrustDice betslip. Locked (no re-bet)." }; }
    const hadStake = !!findStakeInput();
    dbg("BetBy DOM: clicking place", describeEl(place));
    realClick(place);
    const slipCleared = () => hadStake && !findStakeInput();
    const done = () => slipCleared() || successToast();
    await waitFor(done, { timeout: 4000 });
    if (!done()) {
      const c2 = findPlaceButton();
      if (c2 && c2 !== place) { dbg("BetBy DOM: clicking confirmation (step 2)", describeEl(c2)); realClick(c2); await waitFor(done, { timeout: 5000 }); }
    }
    if (done()) {
      dbg("Bet confirmed (BetBy DOM)", {});
      // ECHTE Fill-Quote: BetBy-Quote kann zwischen Lesen und Klick (~30 s) driften. Live neu abrufen und
      // DIE als Fill loggen (statt der evtl. stale gelesenen `want`), mit Plausibilitäts-Band. Behebt den
      // Fall "3.90 gelesen / 3.85 gefüllt" → Betslip + Betlog zeigen die wirklich akzeptierte Quote.
      let fill = want;
      try { const d2 = await eventData(msg.eventId); const o2 = d2 && d2.odds && Number(d2.odds[tip]); if (o2 > 1 && o2 >= (msg.minOdds || 0) && Math.abs(o2 - want) / want <= 0.25) fill = o2; } catch (_) {}
      dbg("BetBy fill odds", { clicked: want, fill: fill });
      const note = `Placed via the TrustDice betslip${b != null ? ` (${stakeStr} BTC)` : ""}. Please verify in your bet history.`;
      return { status: "placed", odds: fill, oddsClicked: want, betBtc: b != null ? stakeStr : null, rate: msg.rate || null, eurStake: msg.amountEur != null ? msg.amountEur : msg.amount, eurActual: (msg.rate > 0 && b != null) ? +(b * msg.rate).toFixed(2) : null, note };
    }
    const errTxt = slipErrorText();
    dumpDomDiagnostics(d.odds);
    return { status: "uncertain", odds: want, reason: (errTxt ? `Betslip meldet: "${errTxt}" — ` : "") + "Clicked place but no confirmation signal — POSSIBLY placed. Locked (no re-bet). Please check your bet history." };
  }

  async function place(msg) {
    const eventId = String(msg.eventId || "");
    if (!eventId) return { status: "blocked", reason: "no BetBy event id" };
    // NOTWEG (30.07.): Scheitert der Quotenabruf (auf einem Testrechner blockt etwas genau diese
    // URL, waehrend das Widget selbst 14x mit demselben Host spricht), kann 1X2 trotzdem gesetzt
    // werden: der Descriptor ist fest (market "1", outcome 1/2/3) und die Quote liefert der
    // Operator im Proposal mit. BetBy prueft die Quote serverseitig — stimmt sie nicht mehr,
    // lehnt der Buchmacher sauber ab. Fuer AH/CS2 gilt der Notweg NICHT (dort braucht es die Leiter).
    let d = null, dErr = null;
    try { d = await eventData(eventId); } catch (e) { dErr = String((e && e.message) || e); }
    const is1x2 = !msg.market || msg.market === "ml";   // Adapter sendet bei 1X2 market:"ml"
    const canFallback = !d && is1x2 && Number(msg.oddsHint) > 1;
    if (!d && !canFallback) return { status: "blocked", reason: "odds not loadable: " + (dErr || "event not found at TrustDice") };

    let marketId, specifiers, outcomeId, odds;
    if (msg.market === "cs2") {
      // Operator-supplied verified descriptor (market/specifiers/outcome).
      marketId = msg.marketId; specifiers = msg.specifiers || ""; outcomeId = msg.outcomeId;
      if (!marketId || outcomeId == null) return { status: "blocked", reason: "missing CS2 descriptor (market/outcome)" };
      odds = oddsFor(d.markets, marketId, specifiers, outcomeId);
    } else if (msg.market === "ah") {
      const bl = d.ah.byLine[String(msg.line)] || d.ah.byLine[String(Number(msg.line))];
      if (!bl) return { status: "blocked", reason: `AH line ${msg.line} not offered by TrustDice` };
      marketId = "16"; specifiers = bl.spec;
      outcomeId = msg.side === "home" ? bl.homeOc : bl.awayOc;
      odds = msg.side === "home" ? bl.home : bl.away;
    } else {
      const tip = msg.tip;
      const oc = { "1": "1", "X": "2", "2": "3" }[tip];
      if (!oc) return { status: "blocked", reason: "bad 1X2 selection" };
      marketId = "1"; specifiers = ""; outcomeId = oc;
      odds = d ? d.odds[tip] : Number(msg.oddsHint);
      if (!d) { try { console.warn("[engine] TrustDice: Quotenabruf blockiert (" + dErr + ") — setze mit der Operator-Quote " + odds); } catch (_) {} }
    }
    if (!(odds > 1)) return { status: "blocked", reason: "outcome not offered / no price" };
    if (odds < msg.minOdds) return { status: "blocked", reason: `odds ${odds} below min ${msg.minOdds}. Not placed.` };

    // 1X2 WIDGET-FIRST: die Autorisierung lebt IM eingeloggten Widget der Session — ein von uns
    // gebauter Standalone-POST bekommt sie NICHT (deshalb 401, per HAR bewiesen: die 200 kam aus dem Widget:
    // Handklick im Widget). Also klickt die Engine im Widget (Quote→Einsatz→„Buchen"), das Widget setzt
    // selbst. Der API-POST bleibt nur ALLERLETZTER Notnagel, falls der Quoten-Button gar nicht auffindbar ist.
    if (is1x2) {
      const dd = d || { odds: { [msg.tip]: odds }, hasMarket: true };
      let r = null;
      try { r = await placeViaDom({ tip: msg.tip, amount: msg.amount, minOdds: msg.minOdds, amountBtc: msg.amountBtc, amountEur: msg.amount, rate: msg.rate, eventId }, dd); }
      catch (e) { dbg("placeViaDom Ausnahme", e); r = null; }
      if (r && !r.domUnavailable) return r;   // placed / uncertain / blocked vom Widget → so zurückgeben
      dbg("Widget-Button nicht auffindbar — letzter Versuch über den API-POST");
      return await send({ eventId, marketId, specifiers, outcomeId, odds, amountBtc: msg.amountBtc, amountEur: msg.amount, minOdds: msg.minOdds, rate: msg.rate });
    }
    return await send({ eventId, marketId, specifiers, outcomeId, odds, amountBtc: msg.amountBtc, amountEur: msg.amount, minOdds: msg.minOdds, rate: msg.rate });
  }

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    // NUR der Top-Frame antwortet. Sonst wuerde JEDER Frame den bet/place-POST absetzen — bei
    // gleichem bet_request_id ein echtes Doppel-Bet-Risiko. Der Operator injiziert TrustDice
    // deshalb ebenfalls nur in den Top-Frame (manifest: all_frames false).
    if (!msg || !msg.cmd) return false;
    if (window.top !== window) return false;
    (async () => {
      try {
        if (msg.cmd === "tdKeepalive") {
          // 1:1 aus dem Operator (trustdice-content.js). Prueft, ob die TrustDice-Session lebt und
          // erkennt eine aktive Cloudflare-Challenge — genau die laesst jeden sptpub-Abruf mit
          // "Failed to fetch" scheitern, ohne dass man den Grund sieht.
          (async () => {
            let state = "alive";
            try {
              const r = await fetch("https://api.trustdice.win/sportsbook/jwt/?currency=" + encodeURIComponent(await detectCurrency()) + "&lang_code=de", { credentials: "include", cache: "no-store" });
              const ct = r.headers.get("content-type") || "";
              if (/json/i.test(ct) && r.status >= 200 && r.status < 300) {
                const j = await r.json().catch(() => null);
                state = (j && j.jwt) ? "alive" : "dead";
              } else {
                const txt = await r.text().catch(() => "");
                state = /challenge-platform|cf-chl|turnstile|just a moment|cf-mitigated/i.test(txt) ? "challenge" : "dead";
              }
            } catch (e) { return reply({ ok: false, state: "error", error: String((e && e.message) || e) }); }
            // BetBy-Server-Session proaktiv warmhalten (identify), damit sie nicht zwischen Wetten stirbt.
            if (state === "alive") { try { await refreshSession(); } catch (_) {} }
            reply({ ok: true, state });
          })();
          return true;
        }
        if (msg.cmd === "tdBalance") {
          // Kontostand aus TrustDices EIGENER Konto-API (Cookie-Auth): /account/wallet/ → wallets{EUR,BTC,…}.
          // Anzeige-Währung via slipCurrency() (Fallback EUR); MBTC→BTC fürs Wallet-Feld. 401 = Session tot.
          (async () => {
            try {
              const r = await fetch("https://api.trustdice.win/account/wallet/", { method: "POST", credentials: "include", cache: "no-store", headers: { "content-type": "application/json" } });
              if (r.status === 401 || r.status === 403) return reply({ ok: false, state: "dead", status: r.status });
              const j = await r.json().catch(() => null);
              const w = j && j.wallets;
              if (!w) return reply({ ok: false, reason: "no wallets in response" });
              let cur = slipCurrency() || "EUR"; if (cur === "MBTC") cur = "BTC";
              const saldo = (w[cur] != null) ? Number(w[cur]) : null;
              reply({ ok: saldo != null, saldo: saldo, cur: cur, wallets: w });
            } catch (e) { reply({ ok: false, reason: String((e && e.message) || e) }); }
          })();
          return true;
        }
        if (msg.cmd === "tdEventUrl") {
          // Wie im Operator: die Event-Seiten-URL liefern, damit der Adapter dorthin navigieren kann.
          (async () => {
            try {
              const d = await eventData(String(msg.eventId));
              if (!d || !d.urlPath) return reply({ error: "Event-URL nicht baubar" });
              reply({ ok: true, url: "https://trustdice.win" + d.urlPath, teams: `${d.home} – ${d.away}` });
            } catch (e) { reply({ error: String((e && e.message) || e) }); }
          })();
          return true;
        }
        if (msg.cmd === "tdPing") return reply({ ok: true, hasSession: !!SESSION, apiHost: API_HOST, hostSrc: HOST_SRC, seen: SEEN, brand: BRAND, minBet: MINBET, version: SCRIPT_VERSION, kombi: !!self.TDKOMBI });
        // 31.10.2026: Kombi (trustdice-kombi.js). Ein Schritt je Aufruf, gewartet wird im Service Worker.
        if (msg.cmd === "tdPlaceCombo") return reply(self.TDKOMBI ? await self.TDKOMBI.place(msg) : { status: "blocked", reason: "trustdice: parlay module missing in the tab — nothing sent" });
        if (msg.cmd === "tdKombiNachfragen") return reply(self.TDKOMBI ? await self.TDKOMBI.nachfragen(msg.warteId) : { status: "uncertain", reason: "trustdice: parlay module gone from the tab — check the bet history" });
        if (msg.cmd === "tdPlace") return reply(await place(msg));
        reply({ error: "unknown cmd" });
      } catch (e) { reply({ status: "uncertain", reason: "content script exception: " + String((e && e.message) || e) }); }
    })();
    return true;
  });
})();
