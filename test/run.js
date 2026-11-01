"use strict";
// npm test: release signature, repository rules, what PHONE_HOME.md promises, the contract and money gates of engine-core.
const fs = require("fs"), path = require("path"), cp = require("child_process");
const { pruefe } = require("../scripts/verify-install.js");
const R = path.join(__dirname, ".."), EXT = path.join(R, "extension");
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log("FAIL " + n + (x === undefined ? "" : "  " + JSON.stringify(x).slice(0, 400))); } };
const alle = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? alle(path.join(d, e.name)) : [path.join(d, e.name)]));
const r = pruefe(EXT);
// Only the maintainers can sign, so a change to extension/ can't pass this check. It runs on main, not in pull requests or with npm run test:dev.
if (process.env.GITHUB_EVENT_NAME === "pull_request" || process.env.MANOMETER_UNSIGNED === "1") console.log("note: release signature not checked" + (r.gut ? "" : " (extension/ differs from the signed release)"));
else ok("signature and checksums", r.gut, r);
const man = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8")), pkg = JSON.parse(fs.readFileSync(path.join(R, "package.json"), "utf8"));
ok("manifest and package have the same version", man.version === pkg.version, [man.version, pkg.version]);
ok("no boot file, no key in the repository", !fs.existsSync(path.join(EXT, "engine-boot.json")) && !alle(R).some((f) => /\.pem$/.test(f) && !/node_modules/.test(f)));
for (const f of ["README.md", "PHONE_HOME.md", "SECURITY.md", "CONTRIBUTING.md", "LICENSE", ".github/CODEOWNERS", ".github/workflows/ci.yml"]) ok(f + " exists", fs.existsSync(path.join(R, f)));
const phone = fs.readFileSync(path.join(R, "PHONE_HOME.md"), "utf8");
const felder = /stakeEur|fillOdds/.test(phone) && /balances/.test(phone) && /enginelog-/.test(phone);
ok("PHONE_HOME names receipts, balances and the log", felder);
const hosts = (man.host_permissions || []).map((h) => h.replace(/^https:\/\//, "").replace(/\/\*$/, "").replace(/^\*\./, ""));
const fehlt = hosts.filter((h) => { const kern = h.split(".").slice(-2).join("."); return phone.indexOf(kern) < 0; });
ok("every host permission is named in PHONE_HOME", fehlt.length === 0, fehlt);
const code = alle(EXT).filter((f) => /\.(js|html|json)$/.test(f)).map((f) => fs.readFileSync(f, "utf8")).join("\n");
const nurCode = alle(EXT).filter((f) => /\.(js|html)$/.test(f)).map((f) => fs.readFileSync(f, "utf8")).join("\n");   // rules-*.json names trackers in order to block them
ok("no private names or paths", !/\/Users\/|192\.168\./i.test(code), (code.match(/\/Users\/|192\.168\./i) || [])[0]);
ok("no remote code", !/\beval\(|new Function\(/.test(code.replace(/^\s*\/\/.*$/gm, "")));
ok("no analytics or beacon in the code", !/sendBeacon|google-analytics|googletagmanager|sentry\.io|mixpanel|segment\.io/.test(nurCode));
const t = cp.spawnSync(process.execPath, [path.join(__dirname, "test_engine_core.js")], { encoding: "utf8" });
ok("engine core: contract and money gates", t.status === 0, (t.stdout + t.stderr).slice(-400));
console.log("manometer-agent: pass " + pass + " fail " + fail);
process.exit(fail ? 1 : 0);
