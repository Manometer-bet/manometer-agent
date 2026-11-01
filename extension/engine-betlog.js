// engine-betlog.js — der Bet-Log des Bettors. Design und Aufbau sind 1:1 die betlog.html des
// Operators; die Daten kommen fertig gesettlet vom Operator (Kanal log-<channel>) und sind hier
// bewusst NUR LESBAR: der Bettor kann nichts ändern, nichts nachtragen, nichts löschen.
"use strict";
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var ALL = [];

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function money(v) { return (v == null || !isFinite(+v)) ? "—" : (v < 0 ? "-€" + Math.abs(v).toFixed(2) : "€" + (+v).toFixed(2)); }
  function pct(v) { return (v == null || !isFinite(+v)) ? "—" : ((+v >= 0 ? "+" : "") + (+v).toFixed(1) + "%"); }
  function num(v) { return (v == null || v === "" || !isFinite(+v)) ? "—" : String(v); }
  function parseUtc(s) {
    if (!s) return 0;
    var t = String(s).trim().replace(" ", "T");
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(t)) t += "Z";
    var v = Date.parse(t); return isFinite(v) ? v : 0;
  }
  function tms(r) { return parseUtc(r.betLogged || r.startTime); }
  function isSettled(r) {
    var x = String(r.result || "").toUpperCase();
    return x === "WIN" || x === "WON" || x === "LOSS" || x === "LOST" || x === "VOID" || x === "PUSH" || x.indexOf("HALF") === 0;
  }
  function profitOf(r) {
    if (r.profit != null && isFinite(+r.profit)) return +r.profit;
    var x = String(r.result || "").toUpperCase(), st = +r.stake || 0, od = +r.odds || 0;
    if (x === "WIN" || x === "WON") return +(st * (od - 1)).toFixed(2);
    if (x === "LOSS" || x === "LOST") return +(-st).toFixed(2);
    if (x === "HALF_WON") return +(st * (od - 1) / 2).toFixed(2);
    if (x === "HALF_LOST") return +(-st / 2).toFixed(2);
    if (x === "VOID" || x === "PUSH") return 0;
    return null;
  }
  function statusOf(r) {
    var st = String(r.status || "").toLowerCase(), x = String(r.result || "").toUpperCase();
    if (st === "not_placed") return "skipped";
    if (st === "uncertain" && !isSettled(r)) return "uncertain";
    if (isSettled(r)) return (x === "WIN" || x === "WON" || x === "HALF_WON") ? "win" : (x === "LOSS" || x === "LOST" || x === "HALF_LOST") ? "loss" : "void";
    if (st === "placed" || st === "waiting") return "placed";
    return "pending";
  }
  function pill(r) {
    var s = statusOf(r);
    var lbl = (r.result && r.result !== "PENDING") ? r.result : (s === "uncertain" ? "BEING CHECKED" : s === "placed" ? "PLACED" : s === "skipped" ? "NOT PLACED" : "OPEN");
    return '<span class="pill ' + s + '">' + esc(lbl) + "</span>";
  }

  function filtered() {
    var range = parseInt(($("range") || {}).value, 10) || 0;
    var q = (($("search") || {}).value || "").toLowerCase().trim();
    var fs = (($("fStatus") || {}).value) || "all";
    var now = Date.now(), cutoff = range ? now - range * 86400000 : 0;
    return ALL.filter(function (r) {
      if (cutoff && tms(r) && tms(r) < cutoff) return false;
      if (fs !== "all") {
        var s = statusOf(r);
        if (fs === "settled" && !(s === "win" || s === "loss" || s === "void")) return false;
        if (fs === "pending" && s !== "pending") return false;
        if (fs === "placed" && s !== "placed") return false;
        if (fs === "uncertain" && s !== "uncertain") return false;
        if (fs === "skipped" && s !== "skipped") return false;
      }
      if (q) { var hay = ((r.event || "") + " " + (r.competition || "") + " " + (r.outcome || "")).toLowerCase(); if (hay.indexOf(q) < 0) return false; }
      return true;
    });
  }
  function kpis(recs) {
    var profit = 0, turnover = 0, bets = 0, pendStake = 0, pendN = 0;
    recs.forEach(function (r) {
      if (isSettled(r)) { bets++; turnover += +r.stake || 0; profit += profitOf(r) || 0; }
      else if (statusOf(r) === "placed" || statusOf(r) === "uncertain") { pendN++; pendStake += +r.stake || 0; }
    });
    return { profit: profit, turnover: turnover, bets: bets, pendStake: pendStake, pendN: pendN,
      yield: turnover > 0 ? profit / turnover * 100 : 0 };
  }
  function renderKpis(recs) {
    var k = kpis(recs), all = kpis(ALL);
    $("kpis").innerHTML = [
      ["Profit", money(k.profit), "total " + money(all.profit), k.profit > 0 ? "pos" : (k.profit < 0 ? "neg" : "")],
      ["Bets", String(k.bets), ALL.length + " in total", ""],
      ["Turnover", money(k.turnover), "settled stake", ""],
      ["Yield", k.yield.toFixed(2) + "%", "profit / turnover", k.yield > 0 ? "pos" : (k.yield < 0 ? "neg" : "")],
      ["Open", money(k.pendStake), k.pendN + " running bets", ""],
    ].map(function (c) {
      return '<div class="kpi"><div class="k-l">' + c[0] + '</div><div class="k-v ' + c[3] + '">' + c[1] + '</div><div class="k-s">' + esc(c[2]) + "</div></div>";
    }).join("");
  }
  function renderChart(recs) {
    var svg = $("chart"); if (!svg) return;
    var s = recs.filter(isSettled).sort(function (a, b) { return tms(a) - tms(b); });
    if (s.length < 2) { svg.innerHTML = '<text x="500" y="160" fill="#5f6b7a" font-size="13" text-anchor="middle">Too few settled bets for the chart yet.</text>'; return; }
    var cum = 0, pts = s.map(function (r) { cum += profitOf(r) || 0; return cum; });
    var W = 1000, H = 320, pad = 34;
    var min = Math.min.apply(null, pts.concat([0])), max = Math.max.apply(null, pts.concat([0])), rng = (max - min) || 1;
    var X = function (i) { return pad + (i / (pts.length - 1)) * (W - 2 * pad); };
    var Y = function (v) { return H - pad - ((v - min) / rng) * (H - 2 * pad); };
    var d = pts.map(function (v, i) { return (i ? "L" : "M") + X(i).toFixed(1) + "," + Y(v).toFixed(1); }).join(" ");
    svg.innerHTML = '<line x1="' + pad + '" y1="' + Y(0).toFixed(1) + '" x2="' + (W - pad) + '" y2="' + Y(0).toFixed(1) + '" stroke="#26303d"/>'
      + '<text x="' + pad + '" y="14" fill="#8a98a8" font-size="11">' + money(max) + "</text>"
      + '<text x="' + pad + '" y="' + (H - 6) + '" fill="#8a98a8" font-size="11">' + money(min) + "</text>"
      + '<path d="' + d + '" fill="none" stroke="#14e08a" stroke-width="2"/>';
  }
  function renderTable(recs) {
    var rows = recs.slice().sort(function (a, b) { return tms(b) - tms(a); });
    var empty = $("empty");
    if (!rows.length) { $("rows").innerHTML = ""; if (empty) { empty.style.display = "block"; empty.textContent = ALL.length ? "No bets for this filter." : "No bets yet. They appear here as soon as the Agent places them."; } return; }
    if (empty) empty.style.display = "none";
    $("rows").innerHTML = rows.map(function (r) {
      var p = profitOf(r);
      var pCls = p == null ? "muted" : (p > 0 ? "pos" : (p < 0 ? "neg" : "muted"));
      return "<tr>"
        + "<td>" + esc(r.event || "") + (r.book ? '<span class="badge">' + esc(r.book) + "</span>" : "") + "</td>"
        + "<td>" + esc((r.startTime || "").slice(5, 16)) + "</td>"
        + "<td>" + esc((r.betLogged || "").slice(5, 16)) + "</td>"
        + "<td>" + esc(r.market || "") + "</td>"
        + "<td>" + esc(r.outcome || "") + "</td>"
        + "<td>" + esc(r.period || "") + "</td>"
        + '<td class="num">' + money(r.stake) + "</td>"
        + '<td class="num" title="' + esc(r.minOdds != null ? "Preis-Floor ≥" + Number(r.minOdds).toFixed(2) : "") + '">' + num(r.odds) + "</td>"
        + '<td class="num ev ' + (r.loggedEV == null ? "muted" : (r.loggedEV >= 0 ? "pos" : "neg")) + '">' + pct(r.loggedEV) + "</td>"
        + '<td class="num ev ' + (r.currentEV == null ? "muted" : (r.currentEV >= 0 ? "pos" : "neg")) + '">' + pct(r.currentEV) + "</td>"
        + '<td class="num">' + (r.closingNVP == null || !isFinite(+r.closingNVP) ? "—" : (+r.closingNVP).toFixed(3)) + "</td>"
        + '<td class="num ev ' + (r.clv == null ? "muted" : (r.clv >= 0 ? "pos" : "neg")) + '">' + (r.clv == null ? "—" : pct(r.clv)) + "</td>"
        + "<td>" + pill(r) + "</td>"
        + '<td class="num ' + pCls + '">' + (p == null ? "—" : money(p)) + "</td>"
        + "<td></td>"
        + "</tr>";
    }).join("");
  }
  function renderAll() { var r = filtered(); renderKpis(r); renderChart(r); renderTable(r); }

  function load() {
    try {
      chrome.runtime.sendMessage({ cmd: "engineBetlog" }, function (res) {
        ALL = (res && res.rows) || [];
        var c = $("conn");
        if (c) { c.textContent = ALL.length ? (ALL.length + " bets · as of " + new Date().toLocaleTimeString()) : "no bets yet"; c.className = "conn ok"; }
        renderAll();
      });
    } catch (_) {}
  }
  ["range", "fStatus"].forEach(function (id) { if ($(id)) $(id).onchange = renderAll; });
  if ($("search")) $("search").oninput = renderAll;
  if ($("reload")) $("reload").onclick = load;
  if ($("exportBtn")) $("exportBtn").onclick = function () {
    var recs = filtered();
    var cols = ["event", "competition", "startTime", "betLogged", "market", "outcome", "stake", "odds", "status", "result", "profit"];
    var csv = cols.join(",") + "\n" + recs.map(function (r) { return cols.map(function (c) { var v = r[c] == null ? "" : String(r[c]); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(","); }).join("\n");
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "mein-betlog-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
  };
  load();
  setInterval(load, 60000);
})();
