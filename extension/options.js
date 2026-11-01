// options.js — Oberfläche für den Betreiber der Engine. Er entscheidet hier: an/aus, welche seiner Buchmacher-Konten aktiv sind und (31.10.2026) zwei eigene Grenzen,
// die nur auf diesem Rechner stehen. Einsatz und Agents wählt er in seinem Konto; alles andere kommt signiert vom Operator und wird nur angezeigt.
// Sprache des Browsers (Deutsch, sonst Englisch), angezeigt wird nur, was der Agent wirklich prüft.
"use strict";
const $ = (id) => document.getElementById(id);
const DE = /^de\b/i.test(navigator.language || "");
const t = (de, en) => (DE ? de : en);
const BOOK_LABEL = { fonbet: "Fonbet (.com)", fonbetgr: "Fonbet.gr", mystake: "MyStake", jackbit: "Jackbit", trustdice: "TrustDice (BTC)", stoiximan: "Stoiximan (GR)", elabet: "Elabet (GR)", efbet: "efbet (GR)", pamestoixima: "pamestoixima (GR)", interwetten: "Interwetten (GR)", superbet: "Superbet (GR)", foxtipp: "Foxtipp", betonline: "BetOnline", orbitxch: "Orbit Exchange" };
function send(msg) { return new Promise((rs) => { try { chrome.runtime.sendMessage(msg, (r) => rs(r || {})); } catch (_) { rs({}); } }); }
function eur(v) { return (v == null || !isFinite(+v)) ? "—" : "€" + (+v).toFixed(2); }
// 31.10.2026: Texte der Bücher und Vorgaben kommen von außen, sie laufen hier nicht als HTML.
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// Feste Texte der Seite
const TEXTE = {
  txPlace: t("Wetten platzieren", "Place bets"), txPlaceSub: t("Aus = es wird nichts gesetzt. Der Agent meldet weiter seinen Status.", "Off = nothing is placed. The Agent keeps reporting its status."),
  txBooks: t("Meine Buchmacher", "My bookmakers"), txBooksHint: t("Hake nur die Konten an, bei denen du tatsächlich angemeldet bist. Nur dort wird gesetzt.", "Tick only the accounts you are signed in to. Bets are placed only there."),
  txCfg: t("Meine Einstellungen", "My settings"), txCfgSub: t("Agents und Einsätze änderst du in deinem Konto unter Auto-betting.", "You change agents and stakes in your account under Auto-betting."),
  txLim: t("Meine Grenzen", "My limits"), txLimHint: t("Sie stehen nur auf diesem Rechner, niemand sonst kann sie ändern. Ein höherer Einsatz wird gekürzt; ist die Tagesgrenze erreicht, wird heute nichts mehr gesetzt. Leer = keine Grenze.", "They are stored only on this computer and nobody else can change them. A larger stake is cut; once the daily limit is reached, nothing more is placed today. Empty = no limit."),
  txLimBet: t("Höchstens je Wette (€)", "Maximum per bet (€)"), txLimDay: t("Höchstens je Tag (€)", "Maximum per day (€)"), limSave: t("Grenzen speichern", "Save limits"),
  txKonto: t("Konto lesen", "Account reading"), txKontoAn: t("Ich stimme zu", "I agree"),
  txKontoHint: t("Wenn du zustimmst, liest der Agent bei deinen angehakten Buchmachern alle Wetten mit Ergebnis, auch die, die nicht über Manometer liefen, und die Kontobewegungen, soweit das Buch sie zeigt, und schickt sie an Manometer. Wir brauchen das, um Wetten sicher abzurechnen und später das Ergebnis des ganzen Kontos zu berechnen. Nicht gesendet werden Passwörter, Sitzungsdaten, dein Name und deine IP. Ohne Zustimmung liest der Agent nur den Kontostand. Du kannst das jederzeit ausschalten.", "If you agree, the Agent reads all bets with their results at the bookmakers you ticked, including bets that did not come through Manometer, and the account movements as far as the bookmaker shows them, and sends them to Manometer. We need this to settle bets reliably and later to calculate the result of the whole account. Passwords, session data, your name and your IP are not sent. Without your agreement the Agent only reads the balance. You can switch this off at any time."),
  txLog: t("Mein Bet-Log", "My bet log"), txLogOpen: t("Wetten & Ergebnisse öffnen", "Open bets and results"), copyLog: t("Protokoll kopieren", "Copy log"),
  openBoard: t("Edge Board öffnen", "Open Edge Board"), txAct: t("Aktivität", "Activity"), run: t("Jetzt prüfen", "Check now"), txHelp: t("Hilfe und Update im Konto", "Help and updates in your account"),
};
for (const k of Object.keys(TEXTE)) { const e = $(k); if (e) e.textContent = TEXTE[k]; }
document.documentElement.lang = DE ? "de" : "en";

let _books = [], _on = false;

// Zwei Versionen vergleichen: Ist b neuer als a?
function neuer(a, b) { const x = String(a || "").split(".").map(Number), y = String(b || "").split(".").map(Number); for (let i = 0; i < 3; i++) { if ((y[i] || 0) > (x[i] || 0)) return true; if ((y[i] || 0) < (x[i] || 0)) return false; } return false; }
const AGENT_NAME = (s) => { const v = String(s).replace(/-/g, " "); return v.charAt(0).toUpperCase() + v.slice(1); };

async function refresh() {
  const s = await send({ cmd: "engineStatus" });
  if (!s || !s.version) return;
  $("ver").textContent = "v" + s.version;
  $("who").textContent = s.boot && s.boot.name ? (t("Konto: ", "Account: ") + s.boot.name) : "";
  _on = !!(s.local && s.local.on);
  _books = (s.local && s.local.books) || [];
  $("onOff").checked = _on;

  // Gesamtstatus: was hindert gerade am Setzen?
  const cs = s.cfgState || {};
  const st = $("mainSt");
  if (!s.boot || !s.boot.ok) { st.className = "st bad"; st.textContent = t("Kein Zugang im Paket gefunden. Bitte das Paket in deinem Konto neu laden.", "No access found in this package. Please download it again in your account."); }
  else if (!cs.ok) { st.className = "st bad"; st.textContent = t("Es wird nicht gesetzt: ", "Nothing is placed: ") + (cs.reason || t("keine Verbindung", "no connection")); }
  else if (!_on) { st.className = "st warn"; st.textContent = t("Bereit, aber ausgeschaltet. Schalter unten umlegen, um zu starten.", "Ready, but switched off. Use the switch below to start."); }
  else if (!_books.length) { st.className = "st warn"; st.textContent = t("Eingeschaltet, aber kein Buchmacher angehakt.", "Switched on, but no bookmaker ticked."); }
  else { st.className = "st ok"; st.textContent = t("Aktiv. Es wird gesetzt bei: ", "Active. Bets are placed at: ") + _books.map((b) => BOOK_LABEL[b] || b).join(", "); }

  // Verbindung EXPLIZIT anzeigen: frische, gültige Vorgaben = verbunden & alles ok.
  const conn = $("connSt");
  if (conn) {
    if (!s.boot || !s.boot.ok) { conn.className = "st bad"; conn.textContent = t("⛔ Kein Zugang im Paket. Bitte das Paket neu laden.", "⛔ No access in this package. Please download it again."); }
    else if (cs.ok) {
      const ts = cs.cfg && cs.cfg.ts;
      const age = ts ? Math.max(0, Math.round((Date.now() - ts) / 1000)) : null;
      const ago = age == null ? "" : (age < 90 ? t(" · aktuell (vor " + age + " s)", " · current (" + age + " s ago)") : t(" · zuletzt vor " + Math.round(age / 60) + " min", " · last " + Math.round(age / 60) + " min ago"));
      conn.className = "st ok"; conn.textContent = "✅ " + t("Verbunden", "Connected") + (s.boot.name ? " · " + s.boot.name : "") + ago;
    } else { conn.className = "st bad"; conn.textContent = "❌ " + t("Nicht verbunden: ", "Not connected: ") + (cs.reason || t("keine Einstellungen empfangen", "no settings received")); }
  }

  // Hinweise: neue Version, zweite Kopie
  const c = cs.cfg || {};
  const hin = [];
  if (Number(s.zweiteKopie) > 0 && Date.now() - Number(s.zweiteKopie) < 24 * 3600e3) hin.push(["bad", t("Eine zweite Kopie dieses Agents läuft, in einem anderen Ordner, Chrome-Profil oder auf einem anderen Rechner. Jede Wette geht nur an eine Kopie. Bitte die andere entfernen.", "A second copy of this Agent is running, in another folder, Chrome profile or on another computer. Each bet goes to one copy only. Please remove the other one.")]);
  if (c.neueste && neuer(s.version, c.neueste)) hin.push(["warn", t("Neue Version " + c.neueste + " verfügbar. Lade sie in deinem Konto unter Agent und entpacke sie über denselben Ordner.", "New version " + c.neueste + " available. Download it in your account under Agent and unzip it over the same folder.")]);
  const hb = $("hinweise");
  if (hb) hb.innerHTML = hin.map((h) => '<div class="st ' + h[0] + '" style="margin-bottom:6px">' + esc(h[1]) + "</div>").join("");

  // Bücher: die vom Betreiber freigegebenen — plus gleichwertige Länderseiten desselben Buchmachers.
  // Der Betreiber gibt "fonbet" frei; ob du dort über .com oder die griechische Seite setzt, ist deine
  // Sache (gleiche Event-IDs, gleicher Auftrag). Hake an, wo du wirklich ein Konto hast.
  const VENUES = { fonbet: ["fonbet", "fonbetgr"] };
  const base = (cs.cfg && cs.cfg.books) || Object.keys(s.books || {});
  const allowed = [];
  base.forEach((b) => (VENUES[b] || [b]).forEach((v) => { if (allowed.indexOf(v) < 0 && (s.books || {})[v]) allowed.push(v); }));
  $("books").innerHTML = allowed.map((k) => {
    const b = (s.books || {})[k] || {};
    const on = _books.indexOf(k) >= 0;
    return `<div class="bk">
      <label class="switch" style="width:44px;height:24px"><input type="checkbox" data-bk="${esc(k)}"${on ? " checked" : ""} /><span class="slider"></span></label>
      <div class="name">${esc(BOOK_LABEL[k] || k)}<div class="det">${esc(b.ready ? ("✅ " + (b.detail || t("angemeldet", "signed in"))) : ("⚠ " + (b.detail || t("nicht bereit", "not ready"))))}</div></div>
    </div>`;
  }).join("") || '<div class="sub">' + esc(t("Für dieses Konto sind noch keine Buchmacher freigegeben.", "No bookmakers are enabled for this account yet.")) + "</div>";
  Array.from(document.querySelectorAll("[data-bk]")).forEach((el) => { el.onchange = saveLocal; });

  // Einstellungen zum Nachsehen: nur, was der Agent wirklich anwendet (Höchsteinsatz, die Wahl aus dem Konto), dazu die Beteiligung.
  $("cfg").innerHTML = [
    [t("Höchsteinsatz des Kontos", "Account maximum per bet"), eur(c.maxStakeEur)],
  ].concat(wahlZeilen(c.wahl), [[t("Beteiligung am neuen Gewinn", "Share of new profit"), c.feePct != null ? c.feePct + " %" : "—"]]).map((r) => `<div class="row"><span>${esc(r[0])}</span><span>${esc(r[1])}</span></div>`).join("");
  limitsAnzeigen(s.limits);

  const lg = (s.log || []).slice(-50).reverse().map((l) => l.t.slice(11, 19) + "  " + l.msg).join("\n");
  $("log").textContent = lg || "—";
  const placed = (s.receipts || []).filter((r) => r.status === "placed").length;
  const unc = (s.receipts || []).filter((r) => r.status === "uncertain").length;
  $("logHint").textContent = placed + t(" gesetzt", " placed") + (unc ? " · " + unc + t(" unklar", " uncertain") : "");
}

// Die Wahl aus dem Konto zum Nachsehen: geändert wird sie im Konto.
function wahlZeilen(w) {
  if (!w || !w.agents) return [];
  const an = Object.keys(w.agents).filter((k) => w.agents[k] && w.agents[k].on);
  if (!an.length) return [[t("Meine Agents", "My agents"), t("keiner ausgewählt", "none selected")]];
  const einsatz = (a) => {
    const s = a.modus === "standard" ? w.standard : a;
    if (s && s.modus === "leiter") return t("Leiter", "Ladder") + ": " + eur(s.einheit) + " × " + t("bis", "up to") + " " + s.maxE;
    if (s && s.modus === "kelly") return "Kelly " + Math.round(Number(s.anteil) * 100) + " % " + t("von", "of") + " " + eur(s.bank);
    return eur(s ? s.eur : null);
  };
  const aus = Object.keys(w.buecher || {}).map((b) => { const x = w.buecher[b], l = []; if (x.pre === false) l.push("Pre"); if (x.live === false) l.push("Live"); if (x.parlay === false) l.push("Parlay"); return l.length ? (BOOK_LABEL[b] || b) + ": " + l.join(", ") : ""; }).filter(Boolean);
  // 01.11.2026: Pause zwischen zwei Wetten, wie im Konto festgelegt (CORE.pauseSekunden)
  const pausen = Object.keys(w.buecher || {}).filter((b) => typeof w.buecher[b].pauseS === "number").map((b) => (BOOK_LABEL[b] || b) + ": " + w.buecher[b].pauseS + " s");
  const pauseZeile = [[t("Pause zwischen Wetten", "Pause between bets"), [(typeof w.pauseS === "number" ? w.pauseS : 90) + " s"].concat(pausen).join(" · ")]];
  return an.map((k) => [AGENT_NAME(k), einsatz(w.agents[k])]).concat(aus.length ? [[t("Im Konto ausgeschaltet", "Switched off in your account"), aus.join(" · ")]] : [], pauseZeile);
}
let _limitsAktiv = false;
function limitsAnzeigen(l) {
  const a = $("limBet"), b = $("limDay"); if (!a || !b || _limitsAktiv) return;
  if (document.activeElement === a || document.activeElement === b) return;
  a.value = l && l.maxBet != null ? l.maxBet : ""; b.value = l && l.maxDay != null ? l.maxDay : "";
}
async function limitsSpeichern() {
  _limitsAktiv = true;
  const r = await send({ cmd: "engineSetLimits", limits: { maxBet: $("limBet").value, maxDay: $("limDay").value } });
  _limitsAktiv = false;
  if (r && r.limits) { $("limMsg").textContent = t("Gespeichert.", "Saved."); limitsAnzeigen(r.limits); setTimeout(() => { $("limMsg").textContent = ""; }, 2500); }
}
if ($("limSave")) $("limSave").onclick = limitsSpeichern;
async function saveLocal() {
  const books = Array.from(document.querySelectorAll("[data-bk]")).filter((e) => e.checked).map((e) => e.getAttribute("data-bk"));
  await send({ cmd: "engineSetLocal", on: $("onOff").checked, books });
  refresh();
}
$("onOff").onchange = saveLocal;
$("run").onclick = async () => { await send({ cmd: "engineTick" }); refresh(); };
// Protokoll zum Weitergeben: Kopf mit Version/Zustand + alle Zeilen, aeltest zuerst (liest sich
// wie ein Ablauf statt rueckwaerts).
$("copyLog").onclick = async () => {
  const s = await send({ cmd: "engineStatus" });
  const head = [
    "Manometer Agent " + (s.version || "?") + " · " + new Date().toISOString(),
    "Account: " + ((s.boot && s.boot.name) || "?") + " · active: " + (((s.local && s.local.books) || []).join(", ") || "none") + " · on: " + !!(s.local && s.local.on),
    "Settings: " + ((s.cfgState && s.cfgState.ok) ? "ok" : ("BLOCKED: " + ((s.cfgState && s.cfgState.reason) || "?"))),
    "Books: " + Object.keys(s.books || {}).map((k) => k + "=" + (s.books[k] && s.books[k].ready ? "ready" : "not ready")).join(" · "),
    "".padEnd(60, "-"),
  ].join("\n");
  const body = (s.log || []).map((l) => l.t.slice(11, 19) + "  " + l.msg).join("\n");
  try { await navigator.clipboard.writeText(head + "\n" + body); $("copyLog").textContent = t("kopiert ✓", "copied ✓"); }
  catch (_) { $("copyLog").textContent = t("Kopieren nicht erlaubt", "Copying not allowed"); }
  setTimeout(() => { $("copyLog").textContent = TEXTE.copyLog; }, 2000);
};
refresh();
setInterval(refresh, 5000);

// Edge Board — der Link kommt PRO BETTOR aus dem Paket (engine-boot.json → boot.boardUrl); der Bettor tippt nichts.
(function () {
  const a = $("openBoard"), hint = $("boardHint"); if (!a) return;
  function apply(u) {
    u = (u || "").trim();
    if (u) { a.href = u; a.style.opacity = ""; if (hint) hint.textContent = ""; }
    else { a.href = "#"; a.style.opacity = ".45"; if (hint) hint.textContent = t("Kein Board-Link im Paket. Bitte das Paket in deinem Konto neu laden.", "No board link in this package. Please download it again in your account."); }
  }
  send({ cmd: "engineStatus" }).then((s) => apply(s && s.boot && s.boot.boardUrl)).catch(() => apply(""));
})();

// 01.11.2026: Konto lesen, nur mit Zustimmung (engine-sw.js kontoLesenAlle)
async function kontoZeigen() {
  const s = await send({ cmd: "engineKontoStatus" }), z = Object.keys(s.stand || {}).map((k) => { const x = s.stand[k]; return (BOOK_LABEL[k] || k) + ": " + (x.fehler ? t("nicht lesbar", "not readable") : x.n + " " + t("Wetten gelesen", "bets read")); });
  $("kontoAn").checked = s.on === true;
  $("kontoSt").textContent = s.on === true ? (z.length ? z.join(" · ") : t("Das erste Lesen läuft mit dem nächsten Takt.", "The first read runs with the next cycle.")) : t("Aus: Es wird nur der Kontostand gelesen.", "Off: only the balance is read.");
}
$("kontoAn").onchange = async () => { await send({ cmd: "engineSetKonto", on: $("kontoAn").checked }); kontoZeigen(); };
kontoZeigen();
