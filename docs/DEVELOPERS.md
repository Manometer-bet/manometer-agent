# Developer guide

How the Agent is built, how a bet moves through it, and how to add a bookmaker. Code comments are partly in German.

Other documentation:

- [`PHONE_HOME.md`](../PHONE_HOME.md): everything the Agent sends, and to whom.
- [Developer documentation on manometer.bet](https://manometer.bet/developers.html): proposal contract v1, sealing, receipts, scoring and errors, for anyone sending signals.
- [manometer-originator-kit](https://github.com/Manometer-bet/manometer-originator-kit): seal and send proposals from Node or the browser.

## Layout

| Path | What it does |
| --- | --- |
| `extension/engine-sw.js` | Service worker: pulls signed proposals, verifies them, applies your settings, hands them to an adapter and reports back. It holds no betting logic and no model. |
| `extension/engine-core.js` | The gates that protect money: proposal checks, stake calculation, your limits, pauses, receipts. No browser APIs, so it can be tested in Node. |
| `extension/books/<id>.js` | One adapter per bookmaker. |
| `extension/content/` | Scripts that run in the bookmaker's tab, for books where placing only works from their own page. |
| `extension/options.html`, `options.js` | The on/off switch, bookmaker choice and your own limits. |
| `extension/betlog.html`, `engine-betlog.js` | The bet log page. |
| `extension/rules-trustdice.json` | Network rules for one bookmaker, loaded by the extension. |
| `release/` | `SHA256SUMS`, its signature and the public release key. |
| `scripts/verify-install.js` | Compares an installed folder with the signed release. |
| `test/` | `npm test`. |

## How a bet moves through the Agent

1. The Agent polls the bridge for proposals addressed to it, and for signed settings from the operator.
2. It checks the signature, expiry, kick-off and minimum odds, then your choice of agents and stakes, the stake limit of your account and your own limits.
3. It locks the `proposalId` before anything is sent, so a proposal delivered twice cannot place two bets.
4. It calls `place()` on the adapter of that bookmaker.
5. It writes a receipt from the result and reports it.

**It fails closed.** Without valid settings that match this account and are less than 6 hours old, nothing is placed. The same applies when the operator has switched it off, when no bookmaker is selected, and when the start time is unknown.

## Proposals

A proposal reaches the Agent in this form, signed by the operator (HMAC-SHA256 over the canonical JSON without `sig`):

```json
{
  "proposalId": "op-2026-07-29-abc123",
  "book": "fonbet",
  "executorId": "exec-anna",
  "sport": "cs2",
  "mkt": "mapWinner", "scope": "map2", "sel": "away",
  "bookRef": { "eventId": "66811567" },
  "minOdds": 1.931,
  "stakeEur": 5.46,
  "tsCreated": 1785247545071, "ttlMs": 60000,
  "startsTs": 1785247200000, "live": true,
  "sig": "<hmac-sha256 hex>"
}
```

The fair price, the expected value and the signal source are left out on purpose. The Agent does not need to know the model.

## Adding a bookmaker

Create `extension/books/<id>.js`, add one line to `ADAPTERS` in `engine-sw.js`, and add the hosts to `host_permissions` in the manifest and to `PHONE_HOME.md`.

```js
export const id = "mybook";
export const hosts = { site: "https://www.mybook.example" };  // what the adapter talks to
export function arm(ctx) {}                                   // optional: prepare the session
export function status() { return { ready: true, detail: "" }; }
export async function place(proposal, stakeEur, ctx) {
  // -> { status: "placed" | "blocked" | "uncertain", odds?, ticket?, reason? }
}
```

Optional exports:

| Export | Purpose |
| --- | --- |
| `sports` | The sports this adapter places, for example `{ fb: true, basket: true }`. Without it, football and CS2 only. |
| `kombi` | `true` if it places parlays (`p.mkt === "parlay"`). |
| `balance(venue)` | Reads the account balance: `{ saldo, bonus, hold, cur, ts }`. |
| `kontoLesen(venue, mark)` | Reads bets and account movements, only after the account holder has agreed. |

Two optional fields in the result of `place()`: `seite: true` says the adapter opened the page although the bet was blocked, so the pause between bets counts. `endgueltig: true` says the book refused, so the same proposal is not tried again.

**Three rules protect real money, and every adapter follows them:**

1. **Never resolve the game yourself.** The target comes from the operator as `proposal.bookRef`. An adapter that searches by team name can bet on the wrong game.
2. **Read fresh right before placing** and check the price against `minOdds`.
3. **Keep the truth table.** Once the bet has been sent, an unclear answer is `uncertain`, never `blocked`. Only an explicit refusal by the book means "not placed".

The adapter also uses your normal session in that browser. It handles no passwords and solves no captchas: when a book asks for one, that is reported as a refusal.

## Tests and releases

```bash
npm test
node scripts/verify-install.js extension
```

`npm test` runs the contract and money gates, checks the release signature and enforces the repository rules, for example that every host permission is named in `PHONE_HOME.md`. A change to what the Agent sends has to change `PHONE_HOME.md` in the same commit.

The operator signs releases, so a change here does not reach installed Agents on its own. See [`CONTRIBUTING.md`](../CONTRIBUTING.md) and, for security problems, [`SECURITY.md`](../SECURITY.md).
