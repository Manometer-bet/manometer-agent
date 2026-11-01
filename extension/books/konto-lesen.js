// books/konto-lesen.js — Konto lesen.
// Adapter-Vertrag dazu: balance(venue) wie bisher; kontoLesen(venue, merker) → { wetten, buchungen, summen, voll, merker } oder null.
// Einheitliche Wette: { id, ts, einsatz, quote, status, auszahlung, waehrung, kombi, bonus, beine: [{ spielId, start, heim, gast, liga, sport, markt, tipp, quote, ergebnis, stand, live }] }.
// status: offen | gewonnen | verloren | void | cashout | unklar. Hier landet nichts über die Person: kein Name, keine Spieler-Nummer, keine IP, kein Prüfcode. Nur lesen, nie setzen.
// Bücher hinter Cloudflare antworten nur aus der Seite, darum läuft der Abruf zuerst in einem offenen Tab. Geöffnet wird dafür nie einer.
"use strict";

export async function imTab(origin, pfad, init) {
  let tabs = [];
  try { tabs = await new Promise((rs) => { try { chrome.tabs.query({ url: origin + "/*" }, (t) => rs(t || [])); } catch (_) { rs([]); } }); } catch (_) {}
  const tab = tabs.find((t) => !t.discarded);
  if (!tab) return null;
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async (p, i) => {
      try { const r = await fetch(p, Object.assign({ credentials: "include" }, i || {})); return { s: r.status, t: await r.text() }; }
      catch (e) { return { fehler: String((e && e.message) || e) }; }
    }, args: [pfad, init || null] });
    return (res && res[0] && res[0].result) || null;
  } catch (_) { return null; }
}
// Ohne offenen Tab direkt aus dem Agent, die Rechte für die Domain hat er. Nicht für Bücher hinter Cloudflare.
export async function imKonto(origin, pfad, init) {
  const r = await imTab(origin, pfad, init);
  if (r && r.s != null) return r;
  try {
    const a = new AbortController(), uhr = setTimeout(() => a.abort(), 15000);
    try { const x = await fetch(origin + pfad, Object.assign({ credentials: "include", signal: a.signal }, init || {})); return { s: x.status, t: await x.text() }; }
    finally { clearTimeout(uhr); }
  } catch (_) { return null; }
}
export function alsJson(r) {
  if (!r || r.s !== 200 || typeof r.t !== "string") return null;
  try { return JSON.parse(r.t); } catch (_) { return null; }
}
export const r2 = (x) => Math.round(Number(x) * 100) / 100;
