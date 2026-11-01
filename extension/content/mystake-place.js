// mystake-place.js — PLACEMENT ONLY content script for MyStake (brand 28) and Jackbit (brand 94,
// serves identical CS2/football payloads — verified side-by-side by the operator).
//
// Extracted from the operator extension's production code. DELIBERATELY OMITTED: the whole
// resolution layer (team catalogs, fuzzy matching, AI fallback). The engine never resolves an
// event — the operator supplies bookRef.eventId (= MyStake gameId), and this script only opens
// what it is told to open. That removes the entire "wrong event" failure class from the executor.
//
// Markets supported: 1X2 (448), Asian Handicap (451), CS2 ML (3764) and CS2 map winners
// (3841/3842/3843 — pos ids verified against MyStake's own market definitions).
(() => {
  // Version im Marker (siehe trustdice-place.js): sonst laeuft ein seit dem Update offener Tab
  // ewig mit ALTEM Code weiter, weil die Neu-Injektion am Marker abprallt.
  const SCRIPT_VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return "?"; } })();
  if (window.__engineMsPlace) return;
  window.__engineMsPlace = SCRIPT_VERSION;

  const BRAND = /jack/i.test(location.hostname) ? 94 : 28;
  const DATA = "https://analytics-sp.googleserv.tech/api";
  const MARKET_1X2 = "448", MARKET_AH = "451";
  const MKT_CS2_ML = "3764", CS2_POS_HOME = 70937, CS2_POS_AWAY = 70976;
  const CS2_MAPS = {
    "1": { mkt: "3841", posHome: 70552, posAway: 70541 },
    "2": { mkt: "3842", posHome: 71227, posAway: 70887 },
    "3": { mkt: "3843", posHome: 70507, posAway: 71163 },
  };
  const POS_TO_TIP = { 1: "1", 2: "X", 3: "2" };
  const EPS = 1e-9;
  const IS_TOP = (window.top === window);
  const isSportsbook = () => { try { return /\/sportsbookv4\//.test(location.pathname); } catch (_) { return false; } };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, { timeout = 9000, interval = 200 } = {}) {
    const t0 = Date.now();
    for (;;) { let v; try { v = fn(); } catch (_) { v = null; } if (v) return v; if (Date.now() - t0 > timeout) return null; await sleep(interval); }
  }
  const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");
  const looksLikeOdd = (t) => /^\d{1,4}[.,]\d{1,2}$/.test((t || "").trim());
  const parseOdd = (t) => parseFloat(String(t).trim().replace(",", "."));
  function ownText(el) { let t = ""; for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue; return t.trim(); }
  function deepEls(root) {
    const out = [];
    const walk = (r) => {
      let list; try { list = r.querySelectorAll("*"); } catch (_) { return; }
      for (const e of list) { out.push(e); if (e.shadowRoot) walk(e.shadowRoot); }
    };
    walk(root); return out;
  }
  function isVisible(el) { try { return el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0); } catch (_) { return true; } }
  const oddEls = () => deepEls(document).filter((e) => looksLikeOdd(ownText(e)));
  function clickableAncestor(el) {
    let n = el;
    for (let i = 0; i < 6 && n; i++) {
      if (n.tagName === "BUTTON" || (n.getAttribute && n.getAttribute("role") === "button")) return n;
      try { if (getComputedStyle(n).cursor === "pointer") return n; } catch (_) {}
      n = n.parentElement;
    }
    return el;
  }
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value") || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  // Stake entry WITH read-back verification (operator lesson 28.07.2026, TrustDice): a widget can
  // DISPLAY the value while its internal state stays empty -> "minimum stake" error and a dead click.
  async function enterStakeVerified(input, str) {
    const nz = (v) => String(v == null ? "" : v).replace(",", ".").replace(/\s+/g, "");
    const want = nz(str);
    const taken = () => { const v = nz(input.value); if (!v) return false; const n = Number(v); return v === want || (n > 0 && Math.abs(n - Number(want)) < 1e-9); };
    setNativeValue(input, str); await sleep(350);
    if (taken()) return { ok: true, method: "native" };
    try {
      input.focus();
      if (typeof input.select === "function") input.select();
      document.execCommand("insertText", false, str);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (_) {}
    await sleep(350);
    return taken() ? { ok: true, method: "insertText" } : { ok: false, value: String(input.value == null ? "" : input.value) };
  }
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
  const hasAll = (vals, want) => want.every((w) => vals.some((v) => Math.abs(v - w) < EPS));
  // 1.2.66 — ANZEIGE ≠ QUOTE (Kit 50-fallen.md P16, an der echten Seite nachgemessen 05.10.2026): die Seite schneidet beim
  // Anzeigen ab und verliert dabei bei rund 7 % der zweistelligen Quoten einen Cent (2,55 steht als „2.54“). Die 1X2-Suche
  // verglich die ANGEZEIGTE Zahl auf 1e-9 genau mit der Quote der Daten-API — war die eigene Zelle betroffen, gab es keinen
  // Kandidaten („1X2 button not found“). Eine 1X2-Zelle darf deshalb bis zu einen Cent UNTER der Quote zeigen, nie darueber:
  // dieselben Grenzen wie zelleAufSeite in mystake-kombi.js. (Die CS2-Suchen unten sind unveraendert.)
  const anzeigePasst = (soll, v) => isFinite(soll) && isFinite(v) && soll - v > -0.0006 && soll - v < 0.0106;
  const hasAllAnz = (vals, want) => want.every((w) => vals.some((v) => anzeigePasst(w, v)));
  // 1.2.66 — fuehrt der Schein genau EINE Auswahl, und zwar die mit dieser Nummer (ItemID der Daten-API = die Nummer, die
  // createticketnew sendet)? Gelesen aus dem Speicher der Seite ueber mystake-kombi.js / mystake-kombi-inject.js (liest nur).
  // → true | false | null (Schein-Speicher nicht lesbar — dann entscheidet wie bisher der Text im Schein).
  async function scheinNummerOk(itemId) {
    try {
      if (typeof MSKOMBI === "undefined" || !MSKOMBI || typeof MSKOMBI.slipStand !== "function") return null;
      const st = await MSKOMBI.slipStand();
      if (!st || !st.ok || !Array.isArray(st.prices)) return null;
      return st.prices.length === 1 && st.priceCount === 1 && String(st.prices[0].id) === String(itemId);
    } catch (_) { return null; }
  }

  // ---- ticket hook (from the MAIN-world inject) ----
  let LAST_TICKET = null, LAST_TICKET_SENT = null;
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;   // 31.10.2026: nur die eigene Seite, kein fremder Rahmen darf ein Ergebnis melden
    const d = e && e.data;
    if (!d || d.source !== "ms-inject" || d.kind !== "ticket") return;
    LAST_TICKET = d.result; LAST_TICKET_SENT = d.sent || null;
  });

  // ---- odds (read-only API, same source the site itself uses) ----
  function currentGameId() {
    let p = "";
    try { p = (IS_TOP ? location : window.top.location).pathname; } catch (_) { p = location.pathname; }
    const m = p.match(/\/(?:match|eventview)\/(?:\d+\/)*(\d+)/);   // 01.11.2026: Laufende Spiele stehen unter /live/eventview/<id>
    return m ? m[1] : null;
  }
  async function gameFull(gameId) {
    const res = await fetch(`${DATA}/prematch/getprematchgamefull/${BRAND}/${gameId}`, { credentials: "omit" });
    if (!res.ok) throw new Error("game HTTP " + res.status);
    const obj = await res.json();
    return typeof obj.game === "string" ? JSON.parse(obj.game) : obj.game;
  }
  function pick1x2(ev) {
    if (ev[MARKET_1X2] && Object.keys(ev[MARKET_1X2]).length >= 3) return ev[MARKET_1X2];
    for (const mid in ev) {
      const arr = Object.values(ev[mid]);
      if (arr.length === 3 && arr.every((o) => !("h" in o) && !("pl" in o) && [1, 2, 3].indexOf(o.pos) !== -1) && new Set(arr.map((o) => o.pos)).size === 3) return ev[mid];
    }
    return null;
  }
  async function gameOdds(gameId) {
    const game = await gameFull(gameId);
    if (!game || !game.ev) return null;
    const mk = pick1x2(game.ev); if (!mk) return null;
    const odds = {}, ids = {};
    for (const itemId in mk) { const o = mk[itemId], tip = POS_TO_TIP[o.pos]; if (tip) { odds[tip] = o.coef; ids[tip] = itemId; } }
    if (odds["1"] == null || odds["X"] == null || odds["2"] == null) return null;
    return { odds, ids, start: game.st };
  }
  async function gameOddsCs2(gameId) {
    const game = await gameFull(gameId);
    const mk = game && game.ev && game.ev[MKT_CS2_ML];
    if (!mk) return null;
    const odds = {}, ids = {};
    for (const itemId in mk) {
      const o = mk[itemId];
      if (o.pos === CS2_POS_HOME) { odds.home = o.coef; ids.home = itemId; }
      else if (o.pos === CS2_POS_AWAY) { odds.away = o.coef; ids.away = itemId; }
    }
    if (odds.home == null || odds.away == null) return null;
    const maps = {};
    for (const n in CS2_MAPS) {
      const def = CS2_MAPS[n], mm = game.ev[def.mkt]; if (!mm) continue;
      const entry = { home: null, away: null, ids: {} };
      for (const itemId in mm) {
        const o = mm[itemId];
        if (o.pos === def.posHome) { entry.home = o.coef; entry.ids.home = itemId; }
        else if (o.pos === def.posAway) { entry.away = o.coef; entry.ids.away = itemId; }
      }
      if (entry.home != null && entry.away != null) maps[n] = entry;
    }
    return { odds, ids, maps };
  }

  // ---- betslip controls ----
  function findStakeInput() {
    const inputs = deepEls(document).filter((e) => e.tagName === "INPUT" && isVisible(e));
    for (const i of inputs) {
      const meta = norm(i.name + " " + i.id + " " + (i.placeholder || "") + " " + (i.getAttribute("aria-label") || ""));
      if (/amount|stake|einsatz|bet|wager|betrag/.test(meta)) return i;
    }
    const nums = inputs.filter((i) => i.type === "number" || i.inputMode === "decimal");
    return nums.length === 1 ? nums[0] : null;
  }
  const PLACE_RX = /placebet|betnow|wette(platzieren|setzen|abgeben)|jetztwetten|towin|(place|confirm|submit)(bet|wette|ticket|wager)|^(platzieren|abgeben|confirm|submit|bestatigen)$/;
  function findPlaceButton() {
    let best = null;
    for (const el of deepEls(document)) {
      if (!isVisible(el)) continue;
      const raw = ownText(el);
      if (!raw || raw.length > 40 || looksLikeOdd(raw)) continue;
      if (raw.trim().endsWith(":")) continue;
      const n = norm(raw);
      if (n === "bet" || n === "bets") continue;
      if (PLACE_RX.test(n)) best = el;
    }
    if (!best) {
      for (const b of deepEls(document)) {
        if (!(b.tagName === "BUTTON" || (b.getAttribute && b.getAttribute("role") === "button")) || !isVisible(b)) continue;
        if (looksLikeOdd(b.textContent)) continue;
        if (PLACE_RX.test(norm((b.getAttribute("aria-label") || "") + " " + b.textContent))) best = b;
      }
    }
    return best ? clickableAncestor(best) : null;
  }
  const slipHasContent = () => !!(findStakeInput() || findPlaceButton());
  function slipRegion() {
    const anchor = findStakeInput() || findPlaceButton();
    if (!anchor) return document;
    let n = anchor; for (let i = 0; i < 8 && n.parentElement; i++) n = n.parentElement; return n;
  }
  function slipCurrency() {
    const reg = slipRegion();
    for (const el of deepEls(reg && reg !== document ? reg : document)) {
      if (!isVisible(el)) continue;
      const raw = (ownText(el) || "").trim(); if (!raw || raw.length > 24) continue;
      const up = raw.toUpperCase();
      if (/^(MBTC|BTC|USDT|EUR|USD)$/.test(up)) return up;
      const m = up.match(/\b(MBTC|BTC|USDT|EUR|USD)\b/); if (m) return m[1];
      if (raw === "€") return "EUR"; if (raw === "$") return "USD";
    }
    return null;
  }
  function findRemoveControls(region) {
    const out = [];
    for (const el of deepEls(region || document)) {
      if (!isVisible(el)) continue;
      const own = (ownText(el) || "").replace(/\s/g, "");
      if (own && own.length <= 2 && /^[x×✕✖❌]+$/i.test(own)) { out.push(el); continue; }
      const meta = norm((el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title") || "")) + " " + String(el.className || ""));
      if (/(removeall|clearall|remove|delete|clear|trash|entfernen|loschen)/.test(meta)) out.push(el);
    }
    return out;
  }
  function findClearAllButton() {
    for (const el of deepEls(document)) {
      if (!isVisible(el)) continue;
      const own = norm(ownText(el)); if (own && own.length > 28) continue;
      const meta = norm((el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title") || "")) + " " + String(el.className || ""));
      if (/(clearbetslip|clearall|clearslip|clearcoupon|emptybetslip|removeall|wettscheinleeren|alleentfernen|alleloschen)/.test(own + " " + meta) || own === "clear" || own === "clearbet") return clickableAncestor(el);
    }
    return null;
  }
  async function clearSlip() {
    for (let pass = 0; pass < 6 && slipHasContent(); pass++) {
      // 1.2.66 — zuerst der Knopf „Clear Betslip“ an seinem festen Ort (derselbe wie SEL.leeren in mystake-kombi.js). An der
      // echten MyStake-Seite gemessen 05.10.2026: findClearAllButton() trifft die HUELLE div.clear-betslip — ein Klick darauf
      // bewirkt nichts (weder echt noch nachgebildet), der Empfaenger ist das INNERE div. Fehlt der Ort (andere Seite), geht
      // es weiter wie bisher.
      let fest = null; try { fest = document.querySelector(".betslip .clear-betslip > div"); } catch (_) {}
      if (fest && isVisible(fest)) { try { fest.click(); } catch (_) {} await sleep(300); continue; }
      const all = findClearAllButton();
      if (all) {
        try { all.click(); } catch (_) {}                    // nativ zuerst: jack.com ignoriert synthetische Slip-Klicks
        await sleep(300);
        if (slipHasContent()) { realClick(all); await sleep(300); }
        continue;
      }
      const ctrls = findRemoveControls(slipRegion());
      if (!ctrls.length) break;
      try { ctrls[0].click(); } catch (_) {}
      await sleep(250);
      if (slipHasContent()) { realClick(ctrls[0]); await sleep(250); }
    }
    return !slipHasContent();
  }
  function successToast() {
    for (const el of deepEls(document)) {
      if (!isVisible(el)) continue;
      const t = norm(ownText(el)); if (!t || t.length > 40) continue;
      if (/(betplaced|betaccepted|placedsuccessfully|successfullyplaced|ticketaccepted|betsuccess|wetteangenommen|erfolgreichplatziert)/.test(t)) return true;
    }
    return false;
  }

  // ---- outcome finders ----
  function findOddButton(tip, oddsObj) {
    const want = oddsObj[tip];
    const wantSet = [oddsObj["1"], oddsObj["X"], oddsObj["2"]].filter((v) => isFinite(v));
    if (!(want != null && isFinite(want))) return null;
    const all = oddEls().filter(isVisible);
    const matches = all.filter((e) => anzeigePasst(want, parseOdd(ownText(e))));
    for (const e of matches) {
      let node = e;
      for (let i = 0; i < 8 && node; i++) {
        node = node.parentElement; if (!node) break;
        const vals = all.filter((x) => node.contains(x)).map((x) => parseOdd(ownText(x)));
        if (vals.length >= 3 && hasAllAnz(vals, wantSet)) return clickableAncestor(e);
      }
    }
    // KEIN blinder Erst-Treffer-Fallback mehr: am 30.07. zeigten 1X2-Heim UND AH -0.5 beide 1.48 —
    // der Fallback klickte den AH-Button (Audit: ItemID-Mismatch, Geld war schon unterwegs).
    // Unverankert wird nur akzeptiert, wenn der Wert seitenweit EINDEUTIG ist.
    return matches.length === 1 ? clickableAncestor(matches[0]) : null;
  }
  // Alle Kandidaten fuer den Zielwert, VERANKERTE ZUERST. Der Aufrufer probiert sie durch und laesst
  // die SCHEIN-VERIFIKATION entscheiden — der Anker allein ist zu spröde (exakte Gleichheit aller
  // drei Werte; eine minimale Quotenbewegung zwischen API-Lesen und Anzeige laesst ihn scheitern,
  // genau das blockierte Test 2 am 30.07. komplett).
  function findOddButtonCandidates(tip, oddsObj) {
    const want = oddsObj[tip];
    const wantSet = [oddsObj["1"], oddsObj["X"], oddsObj["2"]].filter((v) => isFinite(v));
    if (!(want != null && isFinite(want))) return [];
    const all = oddEls().filter(isVisible);
    // 1.2.66: Anzeige bis zu einen Cent unter der Quote (anzeigePasst) — sonst gibt es fuer rund 7 % der Quoten keinen Kandidaten
    const matches = all.filter((e) => anzeigePasst(want, parseOdd(ownText(e))));
    const anchored = [], rest = [];
    for (const e of matches) {
      let ok = false, node = e;
      for (let i = 0; i < 8 && node; i++) {
        node = node.parentElement; if (!node) break;
        const vals = all.filter((x) => node.contains(x)).map((x) => parseOdd(ownText(x)));
        if (vals.length >= 3 && hasAllAnz(vals, wantSet)) { ok = true; break; }
      }
      (ok ? anchored : rest).push(e);
    }
    const out = [], seen = new Set();
    for (const e of anchored.concat(rest)) {
      const c = clickableAncestor(e);
      if (c && !seen.has(c)) { seen.add(c); out.push(c); }
    }
    return out;
  }
  function findOddButtonCs2(sel, cs2Odds) {
    const want = cs2Odds[sel];
    const wantSet = [cs2Odds.home, cs2Odds.away].filter((v) => isFinite(v));
    if (!(want != null && isFinite(want))) return null;
    const all = oddEls().filter(isVisible);
    const matches = all.filter((e) => Math.abs(parseOdd(ownText(e)) - want) < EPS);
    for (const e of matches) {
      let node = e;
      for (let i = 0; i < 8 && node; i++) {
        node = node.parentElement; if (!node) break;
        const vals = all.filter((x) => node.contains(x)).map((x) => parseOdd(ownText(x)));
        if (vals.length >= 2 && hasAll(vals, wantSet)) return clickableAncestor(e);
      }
    }
    return matches.length ? clickableAncestor(matches[0]) : null;
  }
  // Map-winner finder: anchored on the market HEADING so a same-valued pair in another market can
  // never be clicked. Fail-closed: no heading container carrying both map odds -> null (no bet).
  const CS2_MAP_HEAD_RX = { "1": /1st\s*map/i, "2": /2nd\s*map/i, "3": /3rd\s*map/i };
  function findOddButtonCs2Map(sel, mapN, pair) {
    const want = pair[sel];
    const wantSet = [pair.home, pair.away].filter((v) => isFinite(v));
    if (!(want != null && isFinite(want))) return null;
    const rx = CS2_MAP_HEAD_RX[String(mapN)]; if (!rx) return null;
    const odds = oddEls().filter(isVisible);
    const heads = deepEls(document).filter((e) => { const t = ownText(e) || ""; return isVisible(e) && t.length < 40 && rx.test(t); });
    for (const h of heads) {
      let node = h;
      for (let i = 0; i < 8 && node; i++) {
        node = node.parentElement; if (!node) break;
        const inside = odds.filter((x) => node.contains(x));
        const vals = inside.map((x) => parseOdd(ownText(x)));
        if (vals.length >= 2 && hasAll(vals, wantSet)) {
          const target = inside.find((x) => Math.abs(parseOdd(ownText(x)) - want) < EPS);
          if (target) return clickableAncestor(target);
          break;
        }
      }
    }
    return null;
  }
  // AH cells read "<side> (<signed line>)<odds>", e.g. "1 (+0.5)2.81". Side 1=home, 2=away; the label
  // line is from THAT side's view -> home line = label for home, -label for away.
  const AH_ROW_RX = /^([12])\(([+-]?\d+(?:\.\d+)?)\)(\d+\.\d+)$/;
  function ahRowText(el) {
    let n = el;
    for (let i = 0; i < 5 && n; i++) { n = n.parentElement; if (!n) break; const t = (n.textContent || "").replace(/\s+/g, "").trim(); if (AH_ROW_RX.test(t)) return t; }
    return "";
  }
  function findAhButton(side, homeLine, wantOdds) {
    const wantDigit = side === "home" ? "1" : "2";
    const all = oddEls().filter(isVisible);
    let cand = null;
    for (const el of all) {
      const rt = ahRowText(el); if (!rt) continue;
      const m = rt.match(AH_ROW_RX); if (!m) continue;
      if (m[1] !== wantDigit) continue;
      const parsedHome = (m[1] === "1") ? parseFloat(m[2]) : -parseFloat(m[2]);
      if (Math.abs(parsedHome - homeLine) > 1e-6) continue;
      const cellOdd = parseFloat(m[3]);
      if (wantOdds != null && isFinite(wantOdds) && Math.abs(cellOdd - wantOdds) > 0.15) continue;
      if (cand) return { ambiguous: true };
      cand = { el: clickableAncestor(el), cellOdd, label: rt };
    }
    return cand;
  }

  // ---- shared betslip run: stake -> place -> confirm -> verdict (+ fail-closed ItemID audit) ----
  async function runSlip({ amount, amountBtc, amountEur, targetItemId, live }) {
    LAST_TICKET = null; LAST_TICKET_SENT = null;
    const stakeInput = await waitFor(findStakeInput, { timeout: 4000 });
    if (!stakeInput) return { status: "blocked", reason: "Stake field not found in the betslip." };
    const cur = slipCurrency();
    let stakeStr = String(amount);
    if (cur === "BTC" || cur === "MBTC") {
      // FAIL-CLOSED (Lehre 30.07.): steht der Schein auf BTC und es wurde KEINE Umrechnung
      // uebergeben, wird NIE der Euro-Betrag eingetragen — "1" in einem BTC-Feld ist 1 BTC.
      if (!(amountBtc != null && Number(amountBtc) > 0)) {
        return { status: "blocked", reason: "Schein steht auf " + cur + ", aber es liegt keine BTC-Umrechnung vor — NICHT gesetzt. Konto auf EUR stellen oder BTC-Kurs im Adapter nachruesten." };
      }
      const btc = Math.round(Number(amountBtc) * 1e8) / 1e8;
      stakeStr = (cur === "MBTC") ? (btc * 1000).toFixed(5) : btc.toFixed(8);
    }
    const st = await enterStakeVerified(stakeInput, stakeStr);
    if (!st.ok) return { status: "blocked", reason: `Stake not accepted by the widget (state "${st.value}", wanted ${stakeStr}) — NOT clicked, no bet sent.` };
    await sleep(400);
    const notAuth = () => {
      for (const el of deepEls(slipRegion())) {
        if (!isVisible(el)) continue;
        const t = ownText(el);
        if (t && /not.?_?authoriz/i.test(t)) return true;
      }
      return false;
    };
    if (notAuth()) return { status: "blocked", reason: "NOT_AUTHORIZED: das Wett-Widget hat keine Session (Login aussen reicht nicht) — Tab sichtbar oeffnen/neu laden und eingeloggt lassen. Es wurde NICHTS gesendet." };
    const hadStake = !!findStakeInput();
    const place = await waitFor(findPlaceButton, { timeout: 4000 });
    if (!place) return { status: "blocked", reason: "Place button not found." };
    // NATIVER Klick wie im Operator (jackbit-content.js:540 / mystake-content.js:684). Der synthetische
    // realClick registriert auf jack.com beim PLATZIEREN-Button nicht (Quoten-Buttons ja, dieser nein):
    // 5/5 Jackbit-Platzierungen endeten "no confirmation" und standen NICHT im Konto — der Klick kam
    // beim Widget schlicht nie an. Der Operator setzt mit .click() taeglich auf genau dieser Seite.
    place.click();
    const slipCleared = () => hadStake && !findStakeInput() && !findPlaceButton();
    const done = () => LAST_TICKET || slipCleared() || successToast();
    // 01.11.2026: Live prüft das Buch die Wette erst nach einer Wartezeit. Ein zweiter Klick oder Enter wäre in dieser Zeit eine zweite Wette, also hier nur warten. Kommt nichts, bleibt es „uncertain“.
    if (live) await waitFor(done, { timeout: 25000 });
    else await waitFor(done, { timeout: 3000 });
    if (!live && !done()) {
      const c2 = findPlaceButton();
      if (c2 && c2 !== place) c2.click();
      await waitFor(done, { timeout: 5000 });
    }
    if (!live && !done()) {
      // Dritter Weg: Enter im Einsatzfeld (Standard-Submit vieler Scheine). Erreicht diesen Punkt
      // nur, wenn beide Klicks nachweislich NICHTS ausgeloest haben — kein Doppel-Risiko.
      try {
        const si = findStakeInput();
        if (si) {
          si.focus();
          for (const t of ["keydown", "keypress", "keyup"]) si.dispatchEvent(new KeyboardEvent(t, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        }
      } catch (_) {}
      await waitFor(done, { timeout: 4000 });
    }
    // FAIL-CLOSED AUDIT: the ItemID actually SENT by the widget must be our target.
    const sent = LAST_TICKET_SENT;
    if (targetItemId && sent && sent.itemId != null && String(sent.itemId) !== String(targetItemId)) {
      return { status: "uncertain", reason: `AUDIT FAILED: placed ItemID ${sent.itemId} != target ${targetItemId}. Check bet history immediately.` };
    }
    const ticket = LAST_TICKET;
    if (ticket && ticket.Status) {
      if (ticket.Status === "accepted" || ticket.Status === "waiting") return { status: "placed", note: ticket.Status, ticketId: ticket.ID != null ? String(ticket.ID) : null };
      const err = (ticket.Errors && ticket.Errors.length) ? JSON.stringify(ticket.Errors) : ("Status " + ticket.Status);
      return { status: "failed", reason: "Book rejected the bet: " + err };
    }
    if (slipCleared() || successToast()) return { status: "placed", note: "betslip cleared — looks accepted; verify in bet history" };
    let diag = "";
    try {
      const pb = findPlaceButton();
      const bd = pb ? [pb.tagName, String(pb.className || "").slice(0, 40), "disabled=" + (pb.disabled === true || pb.getAttribute("aria-disabled") === "true"), "txt=" + ownText(pb).slice(0, 20)].join(",") : "keiner";
      let nBtn = 0, loginHint = "";
      for (const el of deepEls(document)) {
        if (!isVisible(el)) continue;
        const t = ownText(el); if (!t) continue;
        const n2 = norm(t);
        if (t.length <= 40 && PLACE_RX.test(n2)) nBtn++;
        if (!loginHint && t.length <= 30 && /(sign ?in|log ?in|anmelden|registrieren|deposit|einzahlen|insufficient|unzureichend)/i.test(t)) loginHint = t;
      }
      const labels = [];
      for (const el of deepEls(slipRegion())) {
        if (!isVisible(el)) continue;
        const t = ownText(el);
        if (t && t.length <= 30 && !looksLikeOdd(t)) labels.push(t);
        if (labels.length >= 20) break;
      }
      const si = findStakeInput();
      diag = " | DIAG v3: sicht=" + document.visibilityState + " " + window.innerWidth + "x" + window.innerHeight
        + " · placeBtn[" + bd + "] · " + nBtn + " Kandidaten · stakeVal=" + (si ? JSON.stringify(String(si.value)) : "kein Feld")
        + (loginHint ? " · HINWEIS: " + loginHint : "")
        + " · Schein: " + labels.join("·").slice(0, 200);
    } catch (e) { diag = " | DIAG-Fehler: " + String((e && e.message) || e); }
    return { status: "uncertain", reason: "Clicked place but no confirmation signal — POSSIBLY placed. Check bet history." + diag };
  }
  async function prepareSlip() {
    if (!isSportsbook()) return "Placement requires the sportsbook area (iframe).";
    LAST_TICKET = null; LAST_TICKET_SENT = null;
    if (slipHasContent() && !(await clearSlip())) return "Betslip not empty and could not be cleared — aborting to avoid a combined bet.";
    return null;
  }

  // ---- commands (the adapter has already opened the right event page) ----
  async function place1x2({ gameId, tip, amount, minOdds, amountBtc, amountEur }) {
    const pre = await prepareSlip(); if (pre) return { status: "blocked", reason: pre };
    let g; try { g = await gameOdds(gameId); } catch (e) { return { status: "blocked", reason: "Odds not loadable: " + String((e && e.message) || e) }; }
    if (!g) return { status: "blocked", reason: "1X2 market not found." };
    const odds = g.odds[tip];
    if (!isFinite(odds)) return { status: "blocked", reason: "Odds not readable." };
    if (odds < minOdds) return { status: "blocked", reason: `Odds ${odds} below min ${minOdds}. Not placed.` };
    const cands = await waitFor(() => { const c = findOddButtonCandidates(tip, g.odds); return c.length ? c : null; }, { timeout: 6000 });
    if (!cands) return { status: "blocked", reason: "1X2 button not found in the sportsbook." };
    // FAIL-CLOSED-SCHEINPRUEFUNG (Lehre 30.07.): jeder Klick-Kandidat muss sich im Wettschein als
    // 1X2 ("Match result") ausweisen, BEVOR Einsatz und Platzieren laufen. Falscher Markt (Handicap/
    // Total mit zufaellig gleicher Quote) -> Schein leeren, naechsten Kandidaten probieren.
    const slipText = () => {
      const out = [];
      for (const el of deepEls(slipRegion())) {
        if (!isVisible(el)) continue;
        const t = ownText(el);
        if (t && t.length <= 40 && !looksLikeOdd(t)) out.push(t);
      }
      return out.join(" · ");
    };
    let verified = false, lastLbl = "";
    for (const btn of cands.slice(0, 3)) {
      realClick(btn); await sleep(700);
      lastLbl = slipText();
      // "Total Odds"/"Total Stake" sind Standard-Fusszeilen JEDES Scheins — sie duerfen den
      // Totals-Verdacht NICHT ausloesen (genau daran scheiterte Test 3: korrekter 1X2-Schein
      // wurde wegen "Total Odds" verworfen). Verdaechtig sind nur echte Markt-Namen.
      const wrong = /handicap|double\s*chance|both\s*teams|btts|\bover\b|\bunder\b|total\s+(goals|score|points|corners|cards)/i.test(lastLbl);
      const right = /match result|match odds|1x2|match winner|winner/i.test(lastLbl);
      // 1.2.66 — mit der Toleranz von einem Cent zeigen mehr Zellen „die“ Zahl (auch die andere Seite desselben Markts, wenn
      // 1 und 2 gleich stehen: so wurde am 28.07. beim Operator Heim statt Gast gesetzt). Ist der Schein-Speicher der Seite
      // lesbar, entscheidet deshalb die NUMMER: genau EINE Auswahl im Schein, und zwar die Ziel-ItemID. Nur wenn er nicht
      // lesbar ist, entscheidet wie bisher der Text im Schein.
      const nummer = await scheinNummerOk(g.ids[tip]);
      if (nummer === true || (nummer === null && right && !wrong)) { verified = true; break; }
      if (nummer === false) lastLbl = "[selection id ≠ target] " + lastLbl;
      let cleared = false;
      try { cleared = await clearSlip(); } catch (_) {}
      if (!cleared) return { status: "blocked", reason: "Schein liess sich zwischen zwei Kandidaten nicht leeren — abgebrochen, NICHTS gesendet (kein zweiter Klick in einen vollen Schein). Schein zeigte: " + lastLbl.slice(0, 150) };
      await sleep(300);
    }
    if (!verified) return { status: "blocked", reason: "Kein Kandidat wies sich im Schein als 1X2 aus — abgebrochen, BEVOR etwas gesendet wurde. Zuletzt: " + lastLbl.slice(0, 180) };
    const r = await runSlip({ amount, amountBtc, amountEur, targetItemId: g.ids[tip] });
    return Object.assign({ odds }, r);
  }
  // Live hat eine eigene Seite (books/mystake.js), einen eigenen Katalog (Live-Cache, CORS *: Base64 + gzip) und eigene Nummern: Markt 602, pn 1|x|2.
  // Gemessen am echten Schein, nur Auswahl, ohne Einsatz: Die id aus live/gamenew ist die ID im Schein, marketID 602, isLivePrice. Die Quoten laufen zwischen Lesen und Klicken weiter, darum sucht der Klick die Zelle am Markt-Titel und am Zeichen der Zelle, nie an der Zahl.
  const LIVE_CACHE = "https://wss-eu-uk1.ws-amazon.com/api/cache/get?key=", MARKET_LIVE_1X2 = "602", LIVE_TIP = { "1": "1", x: "X", "2": "2" };
  async function liveCache(key) {
    const res = await fetch(LIVE_CACHE + key, { credentials: "omit" });
    if (!res.ok) throw new Error("live HTTP " + res.status);
    const b64 = (await res.text()).trim().replace(/^"|"$/g, ""), bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text());
  }
  async function gameOddsLive(gameId) {
    const full = await liveCache("live/gamenew/" + gameId), odds = {}, ids = {};
    for (const x of (full && full.gmk) || []) {
      if (!x || String(x.mid) !== MARKET_LIVE_1X2 || x.visible === false || !(Number(x.v) > 1) || x.id == null) continue;
      const tip = LIVE_TIP[String(x.pn).toLowerCase()];
      if (tip) { odds[tip] = Number(x.v); ids[tip] = String(x.id); }
    }
    return odds["1"] != null && odds["X"] != null && odds["2"] != null ? { odds, ids } : null;
  }
  // Die Zelle im Markt „Match result“ mit dem Zeichen 1, X oder 2. Null, wenn es nicht genau einen solchen Markt mit genau drei Zellen gibt.
  function findLive1x2Cell(tip) {
    const koepfe = Array.from(document.querySelectorAll(".market .title .name")).filter((e) => /^match result$/i.test(ownText(e)));
    if (koepfe.length !== 1) return null;
    const zellen = Array.from(koepfe[0].closest(".market").querySelectorAll(".odd-rect"));
    if (zellen.length !== 3) return null;
    const treffer = zellen.filter((z) => Array.from(z.querySelectorAll("*")).some((e) => ownText(e) === tip));
    return treffer.length === 1 ? treffer[0] : null;
  }
  async function placeLive1x2({ gameId, tip, amount, minOdds, amountBtc, amountEur }) {
    if (String(currentGameId()) !== String(gameId)) return { status: "blocked", reason: "Live page shows another event." };
    const pre = await prepareSlip(); if (pre) return { status: "blocked", reason: pre };
    let g; try { g = await gameOddsLive(gameId); } catch (e) { return { status: "blocked", reason: "Live odds not loadable: " + String((e && e.message) || e) }; }
    if (!g) return { status: "blocked", reason: "Live 1X2 market not offered right now." };
    if (g.odds[tip] == null) return { status: "blocked", reason: "Live odds not readable." };
    if (g.odds[tip] < minOdds) return { status: "blocked", reason: `Odds ${g.odds[tip]} below min ${minOdds}. Not placed.` };
    const zelle = await waitFor(() => { const z = findLive1x2Cell(tip); return z && isVisible(z) ? z : null; }, { timeout: 6000 });
    if (!zelle) return { status: "blocked", reason: "Live 1X2 cell not found (market suspended?)." };
    realClick(zelle); await sleep(500);
    // FAIL-CLOSED: Der Schein muss genau diese Auswahl zeigen und ihre Quote dort über der Mindestquote liegen. Ist er nicht lesbar, wird nicht gesetzt.
    const abbruch = async (grund) => { let leer = false; try { leer = await clearSlip(); } catch (_) {} return { status: "blocked", reason: grund + (leer ? "" : " Betslip could not be cleared.") + " NOTHING sent." }; };
    let st = null; try { st = await MSKOMBI.slipStand(); } catch (_) {}
    if (!st || !st.ok || !Array.isArray(st.prices)) return abbruch("Betslip not readable.");
    const pr = st.prices.length === 1 && st.priceCount === 1 ? st.prices[0] : null;
    if (!pr || String(pr.id) !== String(g.ids[tip]) || String(pr.matchId) !== String(gameId)) return abbruch("Betslip shows another selection.");
    if (pr.locked || pr.disabled) return abbruch("Selection is suspended.");
    if (!(pr.coef >= minOdds)) return abbruch(`Odds ${pr.coef} below min ${minOdds}.`);
    const r = await runSlip({ amount, amountBtc, amountEur, targetItemId: g.ids[tip], live: true });
    return Object.assign({ odds: pr.coef }, r);
  }
  async function placeCs2({ gameId, sel, mkt, mapN, amount, minOdds, amountBtc, amountEur }) {
    const pre = await prepareSlip(); if (pre) return { status: "blocked", reason: pre };
    if (sel !== "home" && sel !== "away") return { status: "blocked", reason: "CS2 selection must be home/away." };
    const isMap = (mkt === "mapWinner");
    if (isMap && !CS2_MAPS[String(mapN)]) return { status: "blocked", reason: "Invalid CS2 map number (" + mapN + ")." };
    let g; try { g = await gameOddsCs2(gameId); } catch (e) { return { status: "blocked", reason: "CS2 odds not loadable: " + String((e && e.message) || e) }; }
    if (!g) return { status: "blocked", reason: "CS2 ML market (3764) not found." };
    const pair = isMap ? (g.maps || {})[String(mapN)] : null;
    if (isMap && !pair) return { status: "blocked", reason: `CS2 map${mapN} winner market not offered for this event.` };
    const ids = isMap ? pair.ids : g.ids;
    const odds = isMap ? pair[sel] : g.odds[sel];
    if (!isFinite(odds)) return { status: "blocked", reason: "CS2 odds not readable." };
    if (odds < minOdds) return { status: "blocked", reason: `Odds ${odds} below min ${minOdds}. Not placed.` };
    const btn = await waitFor(() => (isMap ? findOddButtonCs2Map(sel, mapN, pair) : findOddButtonCs2(sel, g.odds)), { timeout: 6000 });
    if (!btn) return { status: "blocked", reason: isMap ? `CS2 map${mapN} odds button not found (heading-anchored search).` : "CS2 odds button not found." };
    realClick(btn); await sleep(700);
    const r = await runSlip({ amount, amountBtc, amountEur, targetItemId: ids[sel] });
    return Object.assign({ odds }, r);
  }
  async function placeAh({ gameId, side, line, amount, minOdds }) {
    const pre = await prepareSlip(); if (pre) return { status: "blocked", reason: pre };
    if (side !== "home" && side !== "away") return { status: "blocked", reason: "AH side must be home/away." };
    if (!isFinite(Number(line))) return { status: "blocked", reason: "AH line missing." };
    // Target odds from the API ladder (market 451, home-signed line) — a second, independent check
    // against the DOM cell so a mis-parsed label can never be clicked.
    let want = null, wantId = null;
    try {
      const game = await gameFull(gameId);
      const mk = game && game.ev && game.ev[MARKET_AH];
      if (mk) {
        const poss = [...new Set(Object.values(mk).map((o) => o.pos))].sort((a, b) => a - b);
        const homePos = poss[0];
        for (const itemId in mk) {
          const o = mk[itemId];
          if (Math.abs(Number(o.h) - Number(line)) > 1e-9) continue;
          const isHome = o.pos === homePos;
          if ((side === "home") === isHome) { want = o.coef; wantId = itemId; }
        }
      }
    } catch (_) {}
    if (want == null) return { status: "blocked", reason: `AH line ${line} (${side}) not offered by the book right now.` };
    if (want < minOdds) return { status: "blocked", reason: `AH odds ${want} below min ${minOdds}. Not placed.` };
    const found = await waitFor(() => findAhButton(side, Number(line), want), { timeout: 8000 });
    if (!found) return { status: "blocked", reason: `AH cell not found (side ${side}, line ${line}). Is the Asian Handicap market expanded?` };
    if (found.ambiguous) return { status: "blocked", reason: `AH cell AMBIGUOUS (side ${side}, line ${line}) — refusing to guess.` };
    if (found.cellOdd < minOdds) return { status: "blocked", reason: `AH odds ${found.cellOdd} below min ${minOdds}. Not placed.` };
    realClick(found.el); await sleep(700);
    const r = await runSlip({ amount, targetItemId: wantId });
    return Object.assign({ odds: found.cellOdd }, r);
  }

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    // NUR der Sportsbook-Iframe antwortet. Das Script laeuft in ALLEN Frames; ohne diese Sperre
    // antwortet der Top-Frame zuerst mit "Placement requires the sportsbook area (iframe)" und die
    // echte Antwort aus dem Iframe geht verloren (chrome.tabs.sendMessage nimmt die ERSTE Antwort).
    // Genauso macht es der Operator (mystake-content.js: "Doppelantworten vermeiden").
    if (!msg || !msg.cmd) return false;
    if (!isSportsbook()) return false;
    (async () => {
      try {
        if (msg.cmd === "msPing") return reply({ ok: true, onEvent: !!currentGameId(), eventId: currentGameId(), frame: "sportsbookv4" , version: SCRIPT_VERSION, kombi: (typeof MSKOMBI !== "undefined" && !!MSKOMBI && typeof MSKOMBI.place === "function") });
        // 1.2.65 — KOMBIWETTE: der ganze Ablauf steht in content/mystake-kombi.js (byte-gleich mit mystake-kombi.js des Operators).
        if (msg.cmd === "msPlaceCombo") {
          if (typeof MSKOMBI === "undefined" || !MSKOMBI || typeof MSKOMBI.place !== "function") return reply({ status: "blocked", reason: "combo script not loaded in the page" });
          return reply(await MSKOMBI.place(msg, { brand: BRAND, emit: () => {} }));
        }
        if (msg.cmd === "msPlace1x2") return reply(await place1x2(msg));
        if (msg.cmd === "msPlaceLive1x2") return reply(await placeLive1x2(msg));
        if (msg.cmd === "msPlaceCs2") return reply(await placeCs2(msg));
        if (msg.cmd === "msPlaceAh") return reply(await placeAh(msg));
        reply({ error: "unknown cmd" });
      } catch (e) { reply({ status: "uncertain", reason: "content script exception: " + String((e && e.message) || e) }); }
    })();
    return true;
  });
})();
