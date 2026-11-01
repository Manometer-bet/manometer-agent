// superbet-place.js — PLACEMENT ONLY content script für Superbet.gr (Plattform „betler").
// Läuft auf https://superbet.gr/*. Der Engine-Service-Worker (books/superbet.js) liest die Quoten und
// baut das Ticket-Item; DIESES Script setzt in der Login-Session (credentials:include, same-site zur
// api-Subdomain) und BESTÄTIGT die Wette.
//
// Bestätigung (zwei Stufen, nie fälschlich „placed" = Phantom-Bet-Schutz):
//   1) submitTicket-Verdikt: {code:0, data:{ticketId, status:"approved"}} → placed (Server hat bestätigt).
//   2) Read-back: fehlt ein klares Verdikt (Verbindung abgerissen o. ä.), wird die Ticket-Liste
//      gelesen und geprüft, ob das Ticket / das Event dort auftaucht. Nur dann placed, sonst uncertain.
// HAR-verifiziert 01.09.2026, LIVE-Platzierung bewiesen 02.09.2026.
(() => {
  "use strict";
  const V = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return "?"; } })();
  if (window.__engineSbPlace) return;
  window.__engineSbPlace = V;

  const BET_API = "https://api.web.production.betler.superbet.gr";
  const SUBMIT = BET_API + "/legacy-web/betting/submitTicket?clientSourceType=Desktop_new";
  const TICKETS = "https://prod-superbet-betting.freetls.fastly.net/tickets/presentation-api/v3/SB_GR/user";

  function uuid() {
    try { return crypto.randomUUID(); } catch (_) {}
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
  function deviceId() {
    const rx = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i) || "";
        if (/device.?id|deviceidentifier|seon|fingerprint/i.test(k)) {
          const m = String(localStorage.getItem(k) || "").match(rx);
          if (m) return m[0];
        }
      }
    } catch (_) {}
    try { const m = String(document.cookie).match(/device[_-]?id=([^;]+)/i); if (m) { const v = decodeURIComponent(m[1]); if (rx.test(v)) return v.match(rx)[0]; } } catch (_) {}
    return uuid();
  }
  // userId für den Read-back: aus localStorage/Cookie (Superbet legt die Profil-/Auth-ID ab). Best effort.
  function userId() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i) || "";
        if (!/user|profile|account|auth|session/i.test(k)) continue;
        const raw = String(localStorage.getItem(k) || "");
        let m = raw.match(/"(?:userId|user_id|id|customerId|clientId)"\s*:\s*"?(\d{4,})"?/i);
        if (m) return m[1];
      }
    } catch (_) {}
    try { const m = String(document.cookie).match(/(?:userId|user_id|customerId)=(\d{4,})/i); if (m) return m[1]; } catch (_) {}
    return null;
  }

  // Read-back: taucht das Ticket (oder das Event) in der eigenen Ticket-Liste auf? Tolerant: findet es
  // sich nicht / geht der Abruf nicht, bleibt es „nicht bestätigt" (nie fälschlich placed).
  async function readback(ident, ticketId) {
    const uid = userId();
    if (!uid) return { ok: false, why: "keine userId" };
    try {
      const r = await fetch(`${TICKETS}/${uid}/tickets?ticketStatus=ALL&pageSize=20`, { credentials: "include", cache: "no-store" });
      if (!r.ok) return { ok: false, why: "HTTP " + r.status };
      const txt = await r.text();
      const hit = (ticketId && txt.indexOf(String(ticketId)) >= 0) ||
        (ident && ident.eventId && txt.indexOf(String(ident.eventId)) >= 0) ||
        (ident && ident.betradarId && ident.betradarId.length > 3 && txt.indexOf(String(ident.betradarId)) >= 0);
      return { ok: !!hit, why: hit ? "gefunden" : "nicht in Liste" };
    } catch (e) { return { ok: false, why: String((e && e.message) || e) }; }
  }

  async function place(msg) {
    const item = msg.item;
    if (!item || !item.oddUuid) return { status: "blocked", reason: "superbet: unvollständiges Ticket-Item" };
    const dev = deviceId();
    const body = {
      ticketOnline: "online", total: Number(msg.total) || 0, betType: "prematch", combs: "",
      items: [item], clientSourceType: "Desktop_new", paymentBonusType: 1, locale: "en-GR",
      requestDetails: { deviceId: dev }, geoLocation: "develop", deviceIdentifier: dev,
      autoAcceptChanges: "1", ticketUuid: uuid(),
    };
    let r;
    try {
      r = await fetch(SUBMIT, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch (e) {
      // Anfrage evtl. schon raus, als die Verbindung abriss → Read-back entscheidet, sonst uncertain.
      const rb = await readback(msg.ident, null);
      if (rb.ok) return { status: "placed", odds: Number(item.value) || null, note: "per Read-back bestätigt (POST-Verbindung abgerissen)" };
      return { status: "uncertain", reason: "superbet: Verbindung beim Absenden abgerissen (im Konto prüfen): " + String((e && e.message) || e), odds: Number(item.value) || null };
    }
    if (r.status === 401 || r.status === 403) return { status: "blocked", reason: "superbet: nicht angemeldet (HTTP " + r.status + ") — auf superbet.gr einloggen" };
    let j = null; try { j = await r.json(); } catch (_) {}
    if (j && j.code === 0 && j.data && j.data.ticketId) {
      const d = j.data;
      const fill = Number(d.sumCoefficient) || Number(item.value) || null;
      const approved = String(d.status || "").toLowerCase() === "approved";
      // Zusätzliche Sicherheit: Read-back bestätigt das Ticket unabhängig vom POST-Verdikt.
      let note = approved ? undefined : ("Status: " + d.status + " — im Konto prüfen");
      try { const rb = await readback(msg.ident, d.ticketId); if (!rb.ok && !note) note = "Ticket vergeben, per Read-back (noch) nicht bestätigt (" + rb.why + ")"; } catch (_) {}
      return { status: "placed", odds: fill, ticket: String(d.ticketId), note };
    }
    if (!r.ok || (j && j.code != null && j.code !== 0)) {
      let m = j && (j.message || (typeof j.error === "string" && j.error) || (j.data && (j.data.message || j.data.reason)) || (Array.isArray(j.errors) && j.errors.map((x) => (x && (x.message || x.code)) || x).join("; ")));
      if (!m || typeof m !== "string") m = j ? JSON.stringify(j) : "";
      const reason = "HTTP " + r.status + (j && j.code != null ? " · code " + j.code : "") + (m ? " · " + m : "");
      return { status: "blocked", reason: "superbet: " + reason.slice(0, 400), odds: Number(item.value) || null };
    }
    // POST war raus, aber kein klares Verdikt → Read-back, sonst uncertain (nie fälschlich placed).
    const rb = await readback(msg.ident, null);
    if (rb.ok) return { status: "placed", odds: Number(item.value) || null, note: "per Read-back bestätigt (kein klares POST-Verdikt)" };
    return { status: "uncertain", reason: "superbet: kein eindeutiges Verdikt (im Konto prüfen)", odds: Number(item.value) || null };
  }

  // 1.2.71 (05.10.2026) — KOMBIWETTE: der ganze Ablauf steht in content/superbet-kombi.js (SBKOMBI; byte-gleich mit
  // superbet-kombi.js des Operators, VOR dieser Datei eingespritzt). Die Einzelwette (sbPlace) bleibt unberuehrt.
  const kombiDa = () => (typeof SBKOMBI !== "undefined" && !!SBKOMBI && typeof SBKOMBI.place === "function" && typeof SBKOMBI.nachfragen === "function");

  chrome.runtime.onMessage.addListener((msg, _sender, send) => {
    if (!msg || !msg.cmd) return;
    if (msg.cmd === "ping") { send({ ok: true, bm: "superbet", v: V, kombi: kombiDa() }); return; }
    if (msg.cmd === "sbPlaceCombo" || msg.cmd === "sbKombiNachfragen") {
      if (!kombiDa()) { send({ status: "blocked", reason: "superbet combo: placement script not loaded (reload the superbet.gr tab) — nothing sent" }); return; }
      const lauf = msg.cmd === "sbKombiNachfragen" ? SBKOMBI.nachfragen(msg.warteId) : SBKOMBI.place(msg, {});
      Promise.resolve(lauf).then(send).catch((e) => send({ status: "uncertain", reason: "superbet combo: " + String((e && e.message) || e) + " — check the bet history" }));
      return true;
    }
    if (msg.cmd === "sbPlace") { place(msg).then(send).catch((e) => send({ status: "uncertain", reason: "superbet: " + String((e && e.message) || e) })); return true; }
  });
})();
