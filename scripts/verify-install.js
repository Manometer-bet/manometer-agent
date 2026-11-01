#!/usr/bin/env node
"use strict";
// Checks a folder against the signed checksums of this release. No dependencies, no network.
//   node scripts/verify-install.js [folder]     default: ./extension
// Exit code 0 = everything matches. engine-boot.json is your own and is ignored.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const REL = path.join(__dirname, "../release");
function pruefe(ordner) {
  const sums = fs.readFileSync(path.join(REL, "SHA256SUMS")), sig = Buffer.from(fs.readFileSync(path.join(REL, "SHA256SUMS.sig"), "utf8").trim(), "base64");
  const key = crypto.createPublicKey(fs.readFileSync(path.join(REL, "release-key.pub")));
  const out = { signatur: crypto.verify(null, sums, key, sig), fehlt: [], anders: [], extra: [], ok: 0 };
  const soll = new Map(sums.toString("utf8").trim().split("\n").map((l) => { const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(l); return [m[2], m[1]]; }));
  const liste = (b) => fs.readdirSync(path.join(ordner, b), { withFileTypes: true }).flatMap((e) => { const r = b ? b + "/" + e.name : e.name; return e.isDirectory() ? liste(r) : [r]; });
  const ist = new Set(liste("").filter((r) => r !== "engine-boot.json" && !/(^|\/)\.DS_Store$/.test(r) && !/^_metadata\//.test(r)));
  for (const [r, h] of soll) {
    if (!ist.has(r)) { out.fehlt.push(r); continue; }
    if (crypto.createHash("sha256").update(fs.readFileSync(path.join(ordner, r))).digest("hex") !== h) out.anders.push(r); else out.ok++;
  }
  for (const r of ist) if (!soll.has(r)) out.extra.push(r);
  out.gut = out.signatur && !out.fehlt.length && !out.anders.length && !out.extra.length;
  return out;
}
module.exports = { pruefe };
if (require.main === module) {
  const ordner = path.resolve(process.argv[2] || path.join(__dirname, "../extension"));
  const r = pruefe(ordner);
  console.log(r.signatur ? "Signature: OK" : "Signature: WRONG");
  console.log(r.ok + " files match");
  for (const [t, l] of [["missing", r.fehlt], ["changed", r.anders], ["not in the release", r.extra]]) for (const x of l) console.log(t + ": " + x);
  console.log(r.gut ? "OK: this is the release." : "NOT the release.");
  process.exit(r.gut ? 0 : 1);
}
