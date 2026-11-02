# What the Agent sends

Everything that leaves your computer, by destination. If this file and the code ever disagree, that is a bug: please report it (see `SECURITY.md`).

## 1. The bridge (`bridgeUrl` in your `engine-boot.json`, `https://app.manometer.bet`)

The bridge is a small document store between the Agent and the operator, on the operator's own server, over HTTPS. Every request carries your Agent's name and its own key (`bridgeKey`). That key opens your channel and nothing else. Without it nothing can be read, and other Agents cannot read your documents.

**The Agent reads**

| Path | What |
| --- | --- |
| `GET /api/proposals` | Signed proposals for your Agent. You receive only your own. The bridge keeps this request open for up to 10 seconds and answers as soon as your list changes. |
| `GET /api/doc/cfg-<channel>` | Signed settings from the operator: limits, books, kill switch, and the agents and stakes you chose in your account. |
| `GET /api/doc/log-<channel>` | Your settled bets, for the bet log page. |
| `GET /api/doc/st-<channel>` | Only when no local settings exist: your last bookmaker choice. The Agent stays off until you switch it on. |

**The Agent writes**

`POST /api/claim`, right before it places a bet: `proposalId` and a random id of this installation. If a second copy of your Agent is running, only the first copy places the bet; the other one shows a warning.

`POST /api/doc/st-<channel>`, at most every 20 seconds and right after a bet:

- `ts, executorId, instanz, engineVersion, zweiteKopie, on, booksActive, cfgOk, cfgReason` (`instanz` is a random id of this copy, so that two browsers on one account add up instead of overwriting each other)
- `bookStatus` for all adapters: `{ ready, detail }`
- `balances` for active bookmakers with a balance check (Fonbet, Fonbet.gr, MyStake, Jackbit, Interwetten, TrustDice, Stoiximan, Superbet, Elabet, efbet): `{ saldo, bonus, hold, cur, ts }`
- `receipts`, the last 300: `ts, proposalId, executorId, engineVersion, book, sport, mkt, scope, sel, line, bookEventId, status, stakeEur, wantStake, partial, minOdds, fillOdds, ticket, verified, note, cur, reason, latencyMs`

`POST /api/doc/enginelog-<channel>`: the local log, up to 800 lines: `ts, executorId, name, engineVersion, n, log[{ t, msg }]`.

`POST /api/konto`, only if you switched on **Account reading** in the settings, every 10 minutes for the bookmakers you ticked (today Fonbet, Fonbet.gr, MyStake, Jackbit, Interwetten, BetOnline):

- bets in your account, also those that did not come through Manometer: `id, ts, einsatz, quote, status, auszahlung, waehrung, kombi, bonus` and for every selection `spielId, start, heim, gast, liga, sport, markt, tipp, quote, ergebnis, stand, live`
- account movements: `id, ts, betrag, art, bezug`, and totals for deposits, withdrawals, stakes and wins (`summen`) where the bookmaker offers them
- Why: to settle bets reliably and later to calculate the result of the whole account. Off by default; switching it off stops this at once. Your name, player number, IP address and session data are not sent; the operator's server also drops every other field.

**What you should know**

- **Your bookmaker balances leave your computer.** They are part of the status, and they can also appear as text in `bookStatus.detail` and in `reason`.
- **Switching the Agent off does not stop the status reports.** It stops placing, not reporting, so you can see that it is off and still healthy.
- **efbet:** the balance can be sent while efbet is not ticked, if an efbet tab is open when the Agent starts.
- **Page text can reach the log.** Error messages of a bookmaker, the address of a tab, labels of buttons (at most 400 characters) and a betslip's text are logged when a placement fails, and the log is sent. A label or an error could contain an account name or a balance. Nothing filters it.
- `name` is the name of your package, not your bookmaker login.
- Your own limits per bet and per day are not sent. A bet stopped by them shows up in the log as refused.

**Never sent:** session tokens, cookies, passwords. The log names fields, not their values.

## 2. Bookmakers

Only what is needed to read odds, check the session and the balance, place and read back, and only to the bookmakers you use:

| Bookmaker | Hosts |
| --- | --- |
| Fonbet | `fonbet001.com`, `line01`, `clientsapi01.fm41d5-resources.com` (the permissions also name `line02` and `clientsapi11` on the same domain) |
| Fonbet.gr | `fonbet.gr`, `line21`, `line31`, `line32`, `clientsapi31`–`33.gr-resource.com` |
| MyStake, Jackbit | `mystake.com`, `jack.com`, `jackbit.com`, `analytics-sp.googleserv.tech` |
| TrustDice | `trustdice.win`, `api.trustdice.win`, `api-*.sptpub.com` |
| Stoiximan | `en.stoiximan.gr` |
| Superbet | `superbet.gr`, `api.web.production.betler.superbet.gr`, `production-superbet-offer-gr` and `prod-superbet-betting.freetls.fastly.net` |
| Elabet | `elabet.gr`, `*.biahosted.com` |
| efbet | `efbet.gr`, through the page's own connection to `*.betconstruct.com` |
| Pame Stoixima | `www`, `capi`, `api`, `papi`, `taxation.pamestoixima.gr` |
| Interwetten | `www.interwetten.gr` |
| Foxtipp | `foxtipp.com` and its `*.foxtipp.com` hosts |
| BetOnline | `www.betonline.ag`, through the page's own connection to `api-offering` and `api-betslip` |
| Orbit | `orbitxch.com`, `www.orbitxch.com` |

Session data the Agent picks up from a bookmaker goes only back to that bookmaker's own hosts. It stays in `chrome.storage` on your computer.

## 3. Others

- `api.coinbase.com`, `api.coingecko.com`, `api.kraken.com`: the BTC/EUR price, without credentials, on every TrustDice placement. These services see your IP address and the time.
- Google, through `chrome.storage.sync`: your on/off state and your bookmaker choice, if Chrome sync is on.
- `boardUrl`: only when you click to open the board.

No telemetry, no analytics, no other third party.

## What stays on your computer

`engineBoot` (with your `secret` and `bridgeKey`), `engineLocal`, `engineLimits` (your own limits), `engineCfgTs`, `engineCfgState`, `engineFired` and the session data of Fonbet, Fonbet.gr and Elabet stay in `chrome.storage`. `engineLog` and `engineReceipts` are stored there too, and sent as described above.
