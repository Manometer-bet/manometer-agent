// mystake-kombi.js — KOMBIWETTE im Sportsbook von MyStake (und baugleichen Marken). 04.10.2026.
// Geteilt und BYTE-GLEICH: Erweiterung (mystake-kombi.js, vor mystake-content.js geladen) und Manometer Agent der External
// Bettors (engine/content/mystake-kombi.js, vor mystake-place.js eingespritzt). Gegenstueck in der Seite (MAIN-World):
// mystake-kombi-inject.js. Stellt MSKOMBI.place(msg, env) bereit; die Befehls-Verdrahtung macht das jeweilige Content-Script.
//
// Betreiber: „baue bitte noch einen Parlay-Builder. Werden bei einem Buch mehr als 3 Value-Bet erkannt … wird daraus eine
// Kombiwette gemacht. Zum testen … nur den Anbieter MyStake.“ — „was dann nacheinander passieren muss (oder auf einmal?)“ —
// „Optimiere bei der Kombiwetten-Geschichte gleich die Setzzeit. Das muss fix gehen.“ — „Auch bei den External Bettors.“
//
// GELERNT am echten Wettschein (04.10., /sportsbookv4/, Vue 3 + Pinia; nichts gesetzt):
//   * Der Schein lebt nur im Speicher der Seite — ein Neuladen leert ihn. Die Beine muessen NACHEINANDER in EINER Sitzung
//     eingelegt werden: je Spiel die Spielseite ueber die Hash-Route #/prematch/match/<Spiel-Nr.> oeffnen (der Schein bleibt
//     dabei stehen) und die Quote anklicken. Der Klick legt die Auswahl sofort in den Schein (gemessen: 0 ms).
//   * Ab der zweiten Auswahl aus einem anderen Spiel steht der Reiter von selbst auf „Multiple“; EIN Einsatzfeld fuer den
//     ganzen Schein; Gesamtquote = Produkt der Quoten (Anzeige auf zwei Stellen abgeschnitten).
//   * Zwei Auswahlen aus DEMSELBEN Spiel: Zeile mit Klasse with-warning („This pick can not be combined“), chains false.
//   * Abgegeben wird EIN createticketnew mit Items [{ ItemType 0, ItemID, Odd, Amount null }, …]; den Sicherheits-hash
//     erzeugt die Seite — deshalb der Klick auf „Place Bet“ statt eines eigenen Abrufs.
// TEMPO (gemessen 04.10.): ein Tab im Hintergrund drosselt Zeitgeber auf 1 je Sekunde (nach 5 min sogar 1 je Minute) — mit
//   Warteschleifen aus setTimeout kostete jedes Bein rund 1 s. Hier wird deshalb NICHT mit Zeitgebern gewartet, sondern auf
//   Ereignisse: ein MutationObserver meldet, wenn die Spielseite steht (gemessen 30–80 ms je Spiel, auch im versteckten
//   Tab), der Stand des Scheins kommt per Nachricht aus der Seite, das Ergebnis des Abgebens ebenso. Zeitgeber sind nur noch
//   die Frist fuer den Fehlerfall. Die Quoten ALLER Beine kommen aus EINEM Sammelabruf (wenige kB) statt je Bein 700 kB.
// SICHERUNGEN (fail-closed — bei jedem Zweifel wird der Schein geleert und nichts abgegeben):
//   vor jedem Bein: die Sportart des Auftrags, ihr Sieger-Markt mit genau den erwarteten offenen Ausgaengen (Fussball 448 „Match
//   result“ mit drei, Basketball 103 „Match winner (incl. overtime)“ mit zwei — Tabelle SPORT_CFG), Spiel nicht angepfiffen, Mannschaften
//   beim Buch = die des Auftrags, Quote ≥ Mindestquote des Beins; geklickt wird nur auf der Spielseite DIESES Spiels (Kopf
//   zeigt seine Mannschaften, der Markt-Block seine Quoten und — wo die Seite ihn kennt — seinen Titel); nach jedem Klick fuehrt der Schein genau diese ItemID und genau so
//   viele Auswahlen wie Beine; am Ende: Inhalt = Auftrag (ItemID, Spiel, Markt, Ausgang), alles kombinierbar und offen, Reiter
//   „Multiple“, Gesamtquote = Produkt ≥ Mindest-Gesamtquote, Einsatz im Schein = Auftrag.
//   armed:false baut und prueft den Schein und laesst ihn STEHEN (Sicht-Pruefung) — abgegeben wird dann nichts.
//   Abgeben: EIN Klick, nie ein zweiter; danach Abgleich „gesendete ItemIDs = Auftrag“.
(() => {
  "use strict";
  if (self.MSKOMBI) return;
  const DATA = "https://analytics-sp.googleserv.tech/api";
  const SEL = { zeile: ".betslip .betslip-odd-row", warnung: "with-warning", reiter: ".betslip .betslip-tabs li", einsatz: ".betslip .betslip-footer input",
    setzen: ".betslip .betslip-actions .btn.bet", leeren: ".betslip .clear-betslip > div", waehrung: ".betslip .betslip-footer .potential-returns",
    kopfNamen: ".prematch-match-page .prematch-match-header .match-name > p", markt: ".prematch-match-page .market", zelle: ".market-odds .odd-rect",
    marktTitel: ":scope > .title .name" };
  // SIEGER-MARKT JE SPORTART (Vorspiel). je Sportart die
  // Sportart-Nr. des Buchs, die Markt-Nr. der Daten-API, die Tipps in SPALTENFOLGE des Markt-Blocks, die Position je Tipp und der
  // Titel des Blocks je Sprache der Seite. Gemessen am echten Sportsbook (05.10., ohne Konto):
  //   Fussball   Sportart 1, Markt 448 „Match result“ / „Endergebnis“, drei Zellen 1 · X · 2 (Position 1 / 2 / 3)
  //   Basketball Sportart 2, Markt 103 „Match winner (incl. overtime)“ / „Gewinner (inkl. OT)“, zwei Zellen 1 · 2 (Position 697 / 698 —
  //              bei allen 50 Spielen des Tages gleich). NICHT Markt 120 „Match result“ / „1X2 (exkl. OT)“: das ist die regulaere
  //              Spielzeit mit Remis, ein anderer Markt als der der Fair (Sieger inklusive Verlaengerung).
  // Ein gemischter Schein (Basketball + Fussball) ist kombinierbar (chains true, Reiter Multiple, Gesamtquote = Produkt).
  // Eine weitere Sportart = eine Zeile hier — nach derselben Messung (Markt-Nr., Positionen, Titel, Zellenzahl).
  const SPORT_CFG = {
    soccer:     { id: 1, markt: "448", name: "match result", tips: ["1", "X", "2"], pos: { "1": 1, "X": 2, "2": 3 }, titel: { en: "Match result", de: "Endergebnis" } },
    basketball: { id: 2, markt: "103", name: "match winner", tips: ["1", "2"],      pos: { "1": 697, "2": 698 },      titel: { en: "Match winner (incl. overtime)", de: "Gewinner (inkl. OT)" } }
  };
  const MARKT = SPORT_CFG.soccer.markt, MIN = 2, MAX = 12, TIPS_3WEG = SPORT_CFG.soccer.tips;
  const cfgVon = (sport) => { const k = String(sport == null || sport === "" ? "soccer" : sport); return Object.prototype.hasOwnProperty.call(SPORT_CFG, k) ? SPORT_CFG[k] : null; };
  // Sprache der Seite: der Rahmen des Sportsbooks traegt sie in seiner Adresse (…&lang=de…), sonst der Pfad der Hauptseite (/en/…).
  function sprache() {
    try { const m = /[?&]lang=([a-z]{2})/i.exec(String(location.search || "")); if (m) return m[1].toLowerCase(); } catch (_) {}
    try { const m2 = /^\/([a-z]{2,3})\//i.exec(String((window.top || window).location.pathname || "")); if (m2) return m2[1].toLowerCase() === "eng" ? "en" : m2[1].toLowerCase(); } catch (_) {}
    return "";
  }
  const FRIST = { stand: 1500, seite: 3000, seiteNeu: 2000, ticket: 15000 };
  let laeuft = false, frage = 0, ticketWarter = null;
  const wartend = new Map();
  const jetztMs = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  const zahl = (t) => parseFloat(String(t == null ? "" : t).trim().replace(",", "."));

  window.addEventListener("message", (e) => {
    try {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.source !== "ms-kombi-inject") return;
      if (d.kind === "slipStand" && wartend.has(d.id)) { const f = wartend.get(d.id); wartend.delete(d.id); f(d.stand); }
      else if (d.kind === "ticket" && ticketWarter) { const f = ticketWarter; ticketWarter = null; f(d); }
    } catch (_) {}
  });
  // Stand des Wettscheins aus der Seite (nur lesen): { ok, activeTab, tabMultiple, priceCount, totalCoef, betAmount, status,
  // waiting, prices:[{ id, matchId, marketId, pos, coef, chains, disabled, locked, live, matchName }] } oder { fehler }.
  function slipStand(fristMs) {
    return new Promise((res) => {
      const id = ++frage;
      const t = setTimeout(() => { if (wartend.delete(id)) res({ fehler: "no answer from the page" }); }, fristMs || FRIST.stand);
      wartend.set(id, (st) => { clearTimeout(t); res(st && typeof st === "object" ? st : { fehler: "empty answer" }); });
      try { window.postMessage({ source: "ms-kombi", kind: "slipStand", id }, "*"); } catch (e) { clearTimeout(t); wartend.delete(id); res({ fehler: String((e && e.message) || e) }); }
    });
  }
  // Warten OHNE Zeitgeber-Schleife: pruef() bei jeder Aenderung der Seite; Ergebnis sobald es etwas liefert, sonst null nach
  // der Frist (die Frist prueft auch der Beobachter — ein gedrosselter Zeitgeber allein kaeme im Hintergrund zu spaet).
  function bisDa(pruef, maxMs) {
    return new Promise((res) => {
      const t0 = jetztMs(); let fertig = false, mo = null, zeit = null;
      const ende = (v) => { if (fertig) return; fertig = true; try { if (mo) mo.disconnect(); } catch (_) {} try { clearTimeout(zeit); } catch (_) {} res(v); };
      const lauf = () => { let v = null; try { v = pruef(); } catch (_) { v = null; } if (v) ende(v); else if (jetztMs() - t0 > maxMs) ende(null); };
      try { mo = new MutationObserver(lauf); mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true }); } catch (_) {}
      zeit = setTimeout(() => { let v = null; try { v = pruef(); } catch (_) {} ende(v || null); }, maxMs + 250);
      lauf();
    });
  }
  function ticketErwarten(fristMs) {
    return new Promise((res) => {
      const t = setTimeout(() => { if (ticketWarter) { ticketWarter = null; res(null); } }, fristMs || FRIST.ticket);
      ticketWarter = (d) => { clearTimeout(t); res(d); };
    });
  }
  // EIN Sammelabruf fuer alle Beine: je Spiel Sportart, Anstoss, Mannschaften (Namen) und der Sieger-Markt seiner Sportart mit
  // genau den erwarteten Ausgaengen. sportJeSpiel (optional): Spiel-Nr. → Sportart des Auftrags (ohne Angabe Fussball).
  // → Map Spiel-Nr. → { odds, ids, team1, team2, start, sport, tips, markt, pos, titel (je Sprache) } | { fehler }.
  async function quotenAlle(brand, spielIds, sportJeSpiel) {
    const res = await fetch(DATA + "/prematch/getprematchgameall/en/" + brand + "/?games=," + spielIds.join(","), { credentials: "omit" });
    if (!res.ok) throw new Error("odds HTTP " + res.status);
    let j = await res.json(); if (typeof j === "string") j = JSON.parse(j);
    let spiele = j && j.game, teams = j && j.teams;
    if (typeof spiele === "string") spiele = JSON.parse(spiele);
    if (typeof teams === "string") teams = JSON.parse(teams);
    const name = new Map(); for (const t of (Array.isArray(teams) ? teams : [])) if (t && t.ID != null) name.set(String(t.ID), String(t.Name == null ? "" : t.Name));
    const out = new Map();
    for (const g of (Array.isArray(spiele) ? spiele : [])) {
      if (!g || g.id == null) continue;
      const lies = () => {
        const sport = String((sportJeSpiel && sportJeSpiel[String(g.id)]) || "soccer"), cfg = cfgVon(sport);
        if (!cfg) return { fehler: "sport " + sport + " is not connected for combos" };
        if (Number(g.sport) !== cfg.id) return { fehler: "not a " + sport + " match at the book" };
        const mk = g.ev && g.ev[cfg.markt];
        if (!mk || typeof mk !== "object") return { fehler: cfg.name + " market not offered" };
        const tipVonPos = {}; for (const t of cfg.tips) tipVonPos[cfg.pos[t]] = t;
        const odds = {}, ids = {}; let n = 0;
        for (const itemId in mk) {
          const o = mk[itemId], tip = o && tipVonPos[o.pos]; n++;
          if (!tip || odds[tip] != null) return { fehler: "unexpected " + cfg.name + " market" };
          if (o.lock) return { fehler: cfg.name + " market is locked" };
          if (!(Number(o.coef) > 1)) return { fehler: "outcome without a price" };
          odds[tip] = Number(o.coef); ids[tip] = String(itemId);
        }
        if (n !== cfg.tips.length || cfg.tips.some((t) => odds[t] == null)) return { fehler: "unexpected " + cfg.name + " market" };
        const team1 = name.get(String(g.t1)), team2 = name.get(String(g.t2));
        if (!team1 || !team2) return { fehler: "team names missing" };
        return { odds, ids, team1, team2, start: Number(g.stunix) > 0 ? Number(g.stunix) * 1000 : null, sport, tips: cfg.tips, markt: cfg.markt, pos: cfg.pos, titelJeSprache: cfg.titel };
      };
      out.set(String(g.id), lies());
    }
    return out;
  }
  // Die Zelle des Ausgangs auf der Spielseite DIESES Spiels: der Kopf zeigt seine Mannschaften (nur gepruefbar, wenn die Seite
  // englisch laeuft — die Namen der Daten-API sind englisch), und es gibt genau EINEN Markt-Block, dessen Quoten-Zellen die
  // Sieger-Quoten der Daten-API sind (in Spaltenfolge g.tips; ohne Angabe 1 · X · 2). Sonst null.
  // TITEL (05.10.2026, g.titel): traegt auf der Seite irgendein Markt-Block den erwarteten Titel, zaehlen nur Bloecke MIT diesem
  // Titel. Grund: beim Basketball zeigen „Match winner (incl. overtime)“ und „Draw no bet“ je zwei Zellen mit nahen Quoten
  // (gemessen 1,29 / 3,37 gegen 1,28 / 3,46), und auf der Basketball-Seite steht auch ein „Match result“ (regulaere Spielzeit).
  // Kennt die Seite den Titel nicht (andere Sprache, umbenannt), gilt wie bisher allein „genau ein Block mit diesen Quoten“.
  // ANZEIGE ≠ QUOTE (gemessen 04.10. im echten Schein): die Seite schneidet beim Anzeigen ab und verliert dabei durch die
  // Gleitkomma-Rechnung manchmal einen Cent — Inter Milan 1,15 steht als „1.14" in der Zelle (1,15 × 100 = 114,999…), eine
  // Gesamtquote 9,54 als „9.53". Im Speicher des Scheins und im gesendeten Schein steht die echte Quote. Die Zelle darf
  // deshalb bis zu einen Cent UNTER der Quote der Daten-API zeigen; die Mindestquoten werden nie an der Anzeige gemessen,
  // sondern an der Quote im Schein.
  function zelleAufSeite(tip, g, mitKopf) {
    if (mitKopf) {
      const ps = document.querySelectorAll(SEL.kopfNamen);
      if (!(ps.length >= 2 && String(ps[0].textContent).trim() === g.team1 && String(ps[ps.length - 1].textContent).trim() === g.team2)) return null;
    }
    const tips = (g && Array.isArray(g.tips) && g.tips.length) ? g.tips : TIPS_3WEG, spalte = tips.indexOf(tip);
    if (spalte < 0) return null;
    const soll = tips.map((t) => g.odds[t]), bloecke = Array.from(document.querySelectorAll(SEL.markt));
    const hatTitel = (m) => { try { const t = m.querySelector(SEL.marktTitel); return !!t && String(t.textContent).trim() === g.titel; } catch (_) { return false; } };
    const nurTitel = !!(g && g.titel) && bloecke.some(hatTitel);
    let treffer = null, n = 0;
    for (const m of bloecke) {
      if (nurTitel && !hatTitel(m)) continue;
      const z = m.querySelectorAll(SEL.zelle);
      if (z.length !== soll.length) continue;
      let gleich = true;
      for (let i = 0; i < soll.length; i++) { const sp = z[i].querySelectorAll("span"); const v = zahl(sp.length ? sp[sp.length - 1].textContent : z[i].textContent); if (!(isFinite(v) && soll[i] - v > -0.0006 && soll[i] - v < 0.0106)) { gleich = false; break; } }
      if (gleich) { n++; if (!treffer) treffer = z[spalte]; }
    }
    return n === 1 ? treffer : null;
  }
  function zeilenZahl() { return document.querySelectorAll(SEL.zeile).length; }
  // Schein leeren und pruefen, dass er leer IST (Seite: keine Zeile; Speicher: 0 Auswahlen). Ohne Zeitgeber-Warten.
  async function leeren(F) {
    const f = F || FRIST;
    for (let i = 0; i < 3; i++) {
      const st = await slipStand(f.stand);
      if (st && st.ok && st.priceCount === 0 && !zeilenZahl()) return true;
      const knopf = document.querySelector(SEL.leeren);
      if (!knopf) break;
      knopf.click();
      await bisDa(() => (zeilenZahl() === 0 ? true : null), Math.min(1500, f.seite));
    }
    const st = await slipStand(f.stand);
    return !!(st && st.ok && st.priceCount === 0 && !zeilenZahl());
  }
  function waehrung() {
    try { const el = document.querySelector(SEL.waehrung); const m = String(el ? el.textContent : "").toUpperCase().match(/\b(MBTC|BTC|USDT|EUR|USD)\b/); return m ? m[1] : null; } catch (_) { return null; }
  }
  function feldSetzen(el, wert) {
    const proto = Object.getPrototypeOf(el), desc = Object.getOwnPropertyDescriptor(proto, "value") || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (desc && desc.set) desc.set.call(el, wert); else el.value = wert;
    el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function fehlerText(ticket) {
    try { const e = ticket && ticket.Errors; if (Array.isArray(e) && e.length) return e.map((x) => (x && (x.Message || x.ErrorMessage || x.Code || x.ErrorCode)) != null ? String(x.Message || x.ErrorMessage || x.Code || x.ErrorCode) : JSON.stringify(x)).join("; ").slice(0, 200); return String((ticket && ticket.Status) || "unknown").slice(0, 80); } catch (_) { return "unknown"; }
  }

  // msg: { legs:[{ eventId, tip ("1"|"X"|"2" in der Reihenfolge des BUCHS), minOdds, team1, team2, sport? ("soccer" ohne Angabe ·
  //        "basketball": nur "1"|"2") }], amount (€), minTotalOdds,
  //        armed (true = abgeben; sonst nur bauen und pruefen), amountBtc?, rate?, amountEur? }
  // env: { brand (28 MyStake · 94 Jackbit), emit(text, daten), frist? (Fristen in ms ueberschreiben — nur fuer die Tests) }
  // Antwort: { status: placed | failed | blocked | uncertain | staged, odds (Gesamtquote), legs:[{ eventId, tip, itemId, odds,
  //            teams }], ms:{ gesamt, lesen, beine:[…], abgeben }, reason?, note?, ticket? }
  async function place(msg, env) {
    const legs = msg && msg.legs, armed = !!(msg && msg.armed === true), brand = Number(env && env.brand);
    const emit = (t, d) => { try { if (env && typeof env.emit === "function") env.emit(t, d); } catch (_) {} };
    const T0 = jetztMs(), ms = { gesamt: 0, lesen: 0, beine: [], abgeben: null }, gelegt = [];
    const F = Object.assign({}, FRIST, (env && env.frist && typeof env.frist === "object") ? env.frist : {});
    const mit = (o) => { ms.gesamt = Math.round(jetztMs() - T0); return Object.assign(o, { ms }); };
    const nein = (reason, extra) => mit(Object.assign({ status: "blocked", reason: "MyStake combo: " + reason }, extra || {}));
    let sportsbook = false; try { sportsbook = /\/sportsbookv4\//.test(location.pathname); } catch (_) {}
    if (!sportsbook) return nein("needs the sportsbook area (iframe)");
    if (!(brand > 0)) return nein("brand missing");
    if (!Array.isArray(legs) || legs.length < MIN || legs.length > MAX) return nein("needs " + MIN + " to " + MAX + " legs");
    const gesehen = new Set();
    for (const L of legs) {
      const cfgL = L ? cfgVon(L.sport) : null;
      if (L && !cfgL) return nein("sport " + String(L.sport) + " is not connected for combos");
      if (!L || !/^\d{4,12}$/.test(String(L.eventId)) || cfgL.tips.indexOf(L.tip) < 0 || !(Number(L.minOdds) > 1) || !L.team1 || !L.team2 || gesehen.has(String(L.eventId))) return nein("invalid or duplicate leg");
      gesehen.add(String(L.eventId));
    }
    const amount = Number(msg.amount), minTotal = Number(msg.minTotalOdds);
    if (!(amount > 0)) return nein("stake missing");
    if (!(minTotal > 1)) return nein("minimum total odds missing");
    if (laeuft) return nein("another combo is being built right now");
    laeuft = true;
    let geklicktAbgeben = false;
    const abbruch = async (reason) => {
      let leer = false; try { leer = await leeren(F); } catch (_) {}
      emit("Combo aborted — nothing placed", { reason, slipCleared: leer, legsDone: gelegt.length });
      return nein(reason + (leer ? "" : " — the betslip could NOT be cleared, please check it"), { legs: gelegt });
    };
    try {
      // 0) Bruecke da, Seite wartet auf nichts; Quoten aller Beine in EINEM Abruf (laeuft waehrenddessen)
      const sportJeSpiel = {}; for (const L of legs) sportJeSpiel[String(L.eventId)] = String(L.sport || "soccer");
      const lesen = quotenAlle(brand, legs.map((L) => String(L.eventId)), sportJeSpiel);
      lesen.catch(() => {});
      let st = await slipStand(F.stand);
      if (!st || !st.ok) return nein("betslip state not readable (" + String((st && st.fehler) || "no answer") + ") — nothing touched");
      if (st.waiting) return nein("the page is still waiting for a bet result — nothing touched");
      if (st.priceCount > 0 || zeilenZahl()) {
        emit("Combo: betslip not empty — clearing old selections", { selections: st.priceCount });
        if (!(await leeren(F))) return nein("betslip not empty and could not be cleared — nothing added");
      }
      let quoten;
      try { quoten = await lesen; } catch (e) { return nein("odds not loadable (" + String((e && e.message) || e) + ") — nothing touched"); }
      ms.lesen = Math.round(jetztMs() - T0);
      const spr = sprache(), englisch = spr === "en";
      const mitTitel = (g) => { if (g && !g.fehler && g.titelJeSprache) g.titel = g.titelJeSprache[spr] || null; return g; };
      // 1) Beine nacheinander einlegen
      for (let i = 0; i < legs.length; i++) {
        const L = legs[i], nr = "leg " + (i + 1), eid = String(L.eventId), tb = jetztMs();
        const pruefe = (g) => {
          if (!g) return "game not offered";
          if (g.fehler) return g.fehler;
          if (!(g.start > Date.now())) return "the game has started or its kick-off is unknown";
          if (g.team1 !== String(L.team1) || g.team2 !== String(L.team2)) return "teams at the book (" + g.team1 + " – " + g.team2 + ") differ from the order";
          if (g.odds[L.tip] < Number(L.minOdds)) return g.odds[L.tip] + " is below the min odds " + Number(L.minOdds);
          return null;
        };
        let g = mitTitel(quoten.get(eid)), grund = pruefe(g);
        if (grund) return await abbruch(nr + ": " + grund);
        try { location.hash = "#/prematch/match/" + eid; } catch (_) {}
        let zelle = await bisDa(() => zelleAufSeite(L.tip, g, englisch), F.seite);
        if (!zelle) {
          // Quote zwischen Abruf und Seite gewandert? EINMAL neu lesen und noch einmal warten.
          try { g = mitTitel((await quotenAlle(brand, [eid], sportJeSpiel)).get(eid)); } catch (e) { return await abbruch(nr + ": odds not loadable (" + String((e && e.message) || e) + ")"); }
          grund = pruefe(g);
          if (grund) return await abbruch(nr + ": " + grund);
          zelle = await bisDa(() => zelleAufSeite(L.tip, g, englisch), F.seiteNeu);
        }
        if (!zelle) return await abbruch(nr + ": odds cell not found on the match page (" + L.team1 + " – " + L.team2 + ")");
        const itemId = String(g.ids[L.tip]), odds = g.odds[L.tip];
        zelle.click();
        let nach = await slipStand(F.stand);
        if (!(nach && nach.ok && nach.prices.some((p) => p.id === itemId))) { await bisDa(() => (zeilenZahl() === i + 1 ? true : null), Math.min(2500, F.seite)); nach = await slipStand(F.stand); }
        if (!(nach && nach.ok && nach.prices.some((p) => p.id === itemId))) return await abbruch(nr + ": the selection did not arrive in the betslip");
        if (nach.priceCount !== i + 1 || nach.prices.length !== i + 1) return await abbruch("the betslip holds " + nach.prices.length + " selections after " + nr);
        gelegt.push({ eventId: eid, tip: L.tip, itemId, odds, minOdds: Number(L.minOdds), teams: g.team1 + " – " + g.team2, sport: g.sport, markt: g.markt, pos: g.pos[L.tip] });
        ms.beine.push(Math.round(jetztMs() - tb));
      }
      // 2) Inhalt des Scheins = Auftrag
      st = await slipStand(F.stand);
      if (!st || !st.ok) return await abbruch("betslip state not readable after building");
      if (st.prices.map((p) => p.id).sort().join(",") !== gelegt.map((x) => x.itemId).sort().join(",")) return await abbruch("the betslip content differs from the order");
      for (const p of st.prices) {
        const b = gelegt.find((x) => x.itemId === p.id);
        if (p.matchId !== b.eventId || p.marketId !== b.markt || p.pos !== b.pos) return await abbruch("a selection sits on another game, market or outcome (" + p.matchName + ")");
        if (p.live || !p.chains || p.disabled || p.locked) return await abbruch("a selection cannot be combined or is locked (" + p.matchName + ")");
        if (!(p.coef >= b.minOdds)) return await abbruch("a selection is now below its min odds (" + p.matchName + " " + p.coef + ")");
      }
      if (document.querySelectorAll(SEL.zeile + "." + SEL.warnung).length) return await abbruch("the betslip shows a warning on a selection");
      if (zeilenZahl() !== gelegt.length) return await abbruch("the betslip shows " + zeilenZahl() + " rows for " + gelegt.length + " legs");
      // 3) Reiter „Multiple“ (steht dort normalerweise von selbst)
      if (st.tabMultiple == null) return await abbruch("the betslip does not name a Multiple tab");
      if (st.activeTab !== st.tabMultiple) {
        const li = document.querySelectorAll(SEL.reiter)[1];
        if (!li) return await abbruch("Multiple tab not found");
        li.click();
        st = await slipStand(F.stand);
        if (!st || !st.ok || st.activeTab !== st.tabMultiple) return await abbruch("could not switch the betslip to Multiple");
      }
      // 4) Gesamtquote = Produkt der Quoten im Schein, und mindestens die verlangte
      const produkt = st.prices.reduce((a, p) => a * p.coef, 1);
      if (!(Math.abs(st.totalCoef - produkt) <= 0.011)) return await abbruch("the betslip total odds (" + st.totalCoef + ") are not the product of the legs (" + produkt.toFixed(3) + ")");
      if (!(produkt >= minTotal)) return await abbruch("total odds " + produkt.toFixed(2) + " are below the min total odds " + minTotal.toFixed(2));
      // 5) Einsatz (in der Waehrung des Scheins, wie bei der Einzelwette)
      const feld = document.querySelector(SEL.einsatz);
      if (!feld) return await abbruch("stake field not found");
      // Die Waehrung des Scheins MUSS lesbar sein (am echten Schein steht sie neben dem moeglichen Gewinn: „… 0.00 EUR“): der
      // Betrag des Auftrags ist in Euro — in ein BTC-Feld getippt waere „5“ fuenf Bitcoin. Ohne lesbare Waehrung wird nichts gesetzt.
      const cur = waehrung();
      if (!cur) return await abbruch("the betslip currency is not readable — the stake was not entered");
      let stakeStr = String(amount), soll = amount, stakeNote = { amount, currency: cur };
      if (cur === "BTC" || cur === "MBTC") {
        if (!(msg.amountBtc != null && Number(msg.amountBtc) > 0)) return await abbruch("the betslip is in " + cur + " but the order carries no BTC amount — switch the wallet to EUR");
        const btc = Math.round(Number(msg.amountBtc) * 1e8) / 1e8;
        stakeStr = (cur === "MBTC") ? (btc * 1000).toFixed(5) : btc.toFixed(8); soll = Number(stakeStr);
        stakeNote = { amount_eur: (msg.amountEur != null ? msg.amountEur : amount), amount_btc: stakeStr, rate: msg.rate || null, currency: cur };
      } else if (cur !== "EUR") return await abbruch("the betslip currency is " + cur + " — only EUR and BTC are handled");
      feldSetzen(feld, stakeStr);
      st = await slipStand(F.stand);
      if (!st || !st.ok || !(Math.abs(st.betAmount - soll) <= Math.max(1e-8, soll * 1e-6))) return await abbruch("the stake in the betslip (" + (st && st.betAmount) + ") is not the ordered stake (" + soll + ")");
      if (st.prices.length !== gelegt.length || st.activeTab !== st.tabMultiple || st.prices.map((p) => p.id).sort().join(",") !== gelegt.map((x) => x.itemId).sort().join(",")) return await abbruch("the betslip changed while the stake was entered");
      const ergebnis = { odds: +produkt.toFixed(3), legs: gelegt, cur };
      emit("Combo built and checked", Object.assign({ legs: gelegt.length, totalOdds: ergebnis.odds, armed, ms: Math.round(jetztMs() - T0) }, stakeNote));
      // Sicherheits-Halt: nur abgeben, wenn ausdruecklich scharf. Sonst bleibt der gepruefte Schein zur Ansicht stehen.
      if (!armed) return mit(Object.assign({ status: "staged", note: "Betslip built and checked, NOT placed (armed=false). Review it and click Place Bet yourself, or clear it." }, ergebnis));
      // 6) Abgeben — EIN Klick
      const knopf = document.querySelector(SEL.setzen);
      if (!knopf) return await abbruch("Place Bet button not found");
      const ta = jetztMs(), warte = ticketErwarten(F.ticket);
      geklicktAbgeben = true;
      knopf.click();
      const t = await warte;
      ms.abgeben = Math.round(jetztMs() - ta);
      if (!t) {
        // keine Antwort mitgelesen: der Schein KANN angenommen sein → nie „blocked“
        emit("Combo: no confirmation signal — uncertain", {});
        return mit(Object.assign({ status: "uncertain", reason: "Clicked Place Bet but read no answer — POSSIBLY placed. Please check your bet history." }, ergebnis));
      }
      if (Array.isArray(t.items) && t.items.map((x) => String(x.itemId)).sort().join(",") !== gelegt.map((x) => x.itemId).sort().join(",")) {
        emit("⚠ COMBO AUDIT: the selections sent differ from the order", { sent: t.items, order: gelegt.map((x) => x.itemId) });
        return mit(Object.assign({ status: "uncertain", reason: "AUDIT FAILED: the selections sent to the book differ from the order. Check the bet history immediately." }, ergebnis));
      }
      const ticket = t.result || {};
      if (ticket.Status === "accepted" || ticket.Status === "waiting") {
        emit("Combo confirmed", { status: ticket.Status, legs: gelegt.length, ms: ms.abgeben });
        return mit(Object.assign({ status: "placed", note: ticket.Status === "waiting" ? "Status: waiting for acceptance. Please check your bet history." : "Status: accepted.", ticket }, ergebnis));
      }
      emit("Combo rejected", { status: ticket.Status, errors: ticket.Errors });
      let leer = false; try { leer = await leeren(F); } catch (_) {}
      return mit(Object.assign({ status: "failed", reason: "The book rejected the combo: " + fehlerText(ticket) + (leer ? "" : " (betslip not cleared)") }, ergebnis));
    } catch (e) {
      const text = String((e && e.message) || e);
      // Nach dem Klick auf „Place Bet“ darf eine Ausnahme nie „nicht gesetzt“ heissen — der Schein kann beim Buch sein.
      if (geklicktAbgeben) return mit({ status: "uncertain", reason: "Exception after Place Bet (" + text + ") — POSSIBLY placed. Please check your bet history.", legs: gelegt });
      return await abbruch("exception: " + text);
    } finally { laeuft = false; }
  }

  // laeuft(): wird in diesem Frame gerade ein Kombi-Schein gebaut? Die Einzelwetten-Wege desselben Tabs fragen das ab, bevor sie
  // den Schein anfassen (sie leeren ihn sonst mitten im Aufbau — und legten ihre Auswahl zu fremden Beinen).
  // 05.10.2026 — slipStand und zelleAufSeite stehen auch der EINZELWETTE offen (mystake-content.js placeOneClick / highlight,
  // Engine mystake-place.js): dieselbe Zellen-Suche (ein Cent Toleranz, Kit 50-fallen.md P16) und derselbe Blick in den Schein
  // (Auswahl-Nummer, echte Quote) wie beim Kombi-Aufbau. Am Ablauf der Kombiwette aendert das nichts.
  self.MSKOMBI = { place, laeuft: () => laeuft, slipStand, zelleAufSeite, _quotenAlle: quotenAlle, _zelleAufSeite: zelleAufSeite, _bisDa: bisDa, SEL, MARKT, SPORT_CFG, _sprache: sprache };
})();
