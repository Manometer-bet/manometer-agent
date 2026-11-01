// content/interwetten-place.js — Manometer Agent 1.2.78 (21.10.2026). Interwetten (interwetten.gr) fuer External Bettors.
//
// Fuehrt im Tab www.interwetten.gr den Setz-Kern aus (content/interwetten-setzen.js, IWSETZEN — byte-gleich mit dem des Operators):
// Interwettens eigener Wettschein (/bettingslip/*) mit der angemeldeten Sitzung des Bettors. Gesetzt wird NUR die genaue Auswahl
// des Operators (Ausgang, Markt, Spiel); die Engine sucht nie selbst eine Auswahl. Immer nur ein Auftrag zugleich.
// KOMBI (iwKombi) ueber IWSETZEN.setzenKombi — jedes Bein mit der
// genauen Auswahl des Operators (outcomeId, marketId, eventId), Einsatz auf die Kombi, Mindest-Gesamtquote. Jeder Auftrag traegt eine Nummer
// (auftragId): dieselbe Nummer laeuft im Tab nie zweimal (zwei Empfaenger, doppelte Zustellung bekommen dasselbe Ergebnis).
(() => {
  "use strict";
  const VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return "?"; } })();
  if (window.__iwPlace && window.__iwPlace.version === VERSION) return;      // schon da (zweites Einspritzen)
  window.__iwPlace = { version: VERSION };
  let laeuft = false;
  const _laeufe = new Map();          // Auftrags-Nr. → Promise des Ergebnisses (derselbe Kombi-Auftrag laeuft nie zweimal)
  function einmal(nr, lauf) {
    nr = String(nr == null ? "" : nr);
    if (_laeufe.has(nr)) return _laeufe.get(nr);
    let p; try { p = Promise.resolve(lauf()); } catch (e) { p = Promise.reject(e); }
    _laeufe.set(nr, p);
    while (_laeufe.size > 40) _laeufe.delete(_laeufe.keys().next().value);
    return p;
  }
  const kombiDa = () => (typeof IWSETZEN === "object" && !!IWSETZEN && typeof IWSETZEN.setzenKombi === "function");
  function abfrage() { return /just a moment|nur einen moment|un instant|attention required/i.test(document.title || "") || !!document.querySelector("#challenge-form, .cf-turnstile, #challenge-stage"); }
  async function post(pfad, inhalt) {
    const r = await fetch(pfad, { method: "POST", credentials: "include", headers: { Accept: "application/json", "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" }, body: JSON.stringify(inhalt) });
    const t = await r.text();
    if (!r.ok) throw new Error("HTTP " + r.status + (/just a moment|nur einen moment/i.test(t) ? " (Cloudflare check — open the tab and confirm once)" : ""));
    try { return JSON.parse(t); } catch (_) { throw new Error("no JSON (HTTP " + r.status + ")"); }
  }
  chrome.runtime.onMessage.addListener((msg, _abs, antwort) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.cmd === "iwPing") { antwort({ ok: true, version: VERSION, kern: typeof IWSETZEN === "object" ? IWSETZEN.VERSION : null, kombi: kombiDa(), ort: /foreign|blocked|restricted/i.test(location.pathname) ? "the page refuses this address (" + location.pathname.slice(0, 40) + ")" : null, abfrage: abfrage() }); return; }
    if (msg.cmd === "iwKombi") {
      if (!kombiDa()) { antwort({ status: "failed", reason: "interwetten combo: placement core without combos in the tab — nothing sent" }); return; }
      if (!/^[A-Za-z0-9_.:-]{6,80}$/.test(String(msg.auftragId == null ? "" : msg.auftragId))) { antwort({ status: "blocked", reason: "interwetten combo: order number missing — nothing sent" }); return; }
      if (abfrage()) { antwort({ status: "failed", reason: "interwetten combo: Cloudflare check open in the tab — confirm it once, nothing sent" }); return; }
      if (msg.armed !== true) { antwort({ status: "failed", reason: "interwetten combo: order not armed — nothing sent" }); return; }
      einmal(msg.auftragId, () => {
        if (laeuft) return { status: "failed", reason: "interwetten combo: another order is running in this tab — nothing sent" };
        laeuft = true;
        return IWSETZEN.setzenKombi({ legs: msg.legs, amount: msg.amount, minTotalOdds: msg.minTotalOdds, armed: true }, { post, warte: (ms) => new Promise((r) => setTimeout(r, ms)) })
          .finally(() => { laeuft = false; });
      }).then((r) => antwort(r), (e) => antwort({ status: "uncertain", reason: "interwetten combo: " + String((e && e.message) || e).slice(0, 120) + " — check the bet history" }));
      return true;
    }
    if (msg.cmd !== "iwPlace") return;
    if (typeof IWSETZEN !== "object") { antwort({ status: "failed", reason: "interwetten: placement core missing in the tab — nothing sent" }); return; }
    if (laeuft) { antwort({ status: "failed", reason: "interwetten: another order is running in this tab — nothing sent" }); return; }
    if (abfrage()) { antwort({ status: "failed", reason: "interwetten: Cloudflare check open in the tab — confirm it once, nothing sent" }); return; }
    if (msg.armed !== true) { antwort({ status: "failed", reason: "interwetten: order not armed — nothing sent" }); return; }
    laeuft = true;
    IWSETZEN.setzen({ outcomeId: msg.outcomeId, marketId: msg.marketId, eventId: msg.eventId, isLive: msg.isLive === true, amount: msg.amount, minOdds: msg.minOdds }, { post, warte: (ms) => new Promise((r) => setTimeout(r, ms)) })
      .then((r) => antwort(r), (e) => antwort({ status: "uncertain", reason: "interwetten: " + String((e && e.message) || e).slice(0, 120) + " — check the bet history" }))
      .finally(() => { laeuft = false; });
    return true;
  });
})();
