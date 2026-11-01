# Manometer Agent

The program that places bets on the account holder's own accounts: placement, read-back of the ticket, limits, reports. It runs as a Chrome extension on your computer. It holds no odds model and creates no signals: it receives signed proposals, checks them, places them and reports what happened.

Everything about the money stays with you: your accounts, your balance, your on/off switch, your choice of bookmakers, agents and stakes.

## For developers

Start with [`docs/DEVELOPERS.md`](docs/DEVELOPERS.md): how the Agent is built, how a bet moves through it and how to add a bookmaker. If you build with an AI assistant, point it at [`AGENTS.md`](AGENTS.md). The proposal contract, sealing and receipts are documented at [manometer.bet/developers.html](https://manometer.bet/developers.html). To send signals, use the [Originator Kit](https://github.com/Manometer-bet/manometer-originator-kit).

## What is in here

- `extension/`: the Agent as it is installed. Byte for byte what `release/SHA256SUMS` lists.
- `PHONE_HOME.md`: every message the Agent sends, and to whom. Read this first.
- `docs/DEVELOPERS.md`: the developer guide.
- `release/`: checksums, their signature and the public release key.
- `scripts/verify-install.js`: checks a folder against the signed checksums.
- `test/`: `npm test` runs the checks for contract and money gates, the release signature and the repository rules.

## Install

You get your personal package in your Manometer sign-in area (Agent page). It is this extension plus one file, `engine-boot.json`, with the access of your own account.

1. Unzip it into a folder you keep.
2. In Chrome, open `chrome://extensions` and switch on Developer mode.
3. Click Load unpacked and choose that folder.

**Only one copy, on one computer.** If a second copy runs anyway, the bridge gives each bet to one copy only and the other copy shows a warning.

## Check what you installed

```bash
node scripts/verify-install.js /path/to/your/agent/folder
```

It compares every file with `release/SHA256SUMS`, verifies the signature against `release/release-key.pub` and names anything that differs. `engine-boot.json` is yours alone and is not part of the release.

## How a bet happens

1. The Agent polls the bridge for proposals addressed to it, and for signed settings from the operator.
2. It checks the signature, the expiry and the minimum odds, then your choice of agents and stakes from your account, the stake limit of your account, and the limits you set in the Agent itself. Without valid signed settings it places nothing.
3. It places through the bookmaker's own site or API, using your normal session in that browser. It handles no passwords.
4. It reads the ticket back and reports the result. A bet whose outcome it can't confirm is reported as uncertain, never as placed.

The Agent starts switched off. You switch it on, and you choose which of your bookmakers it may use. After a reinstall it restores your bookmaker choice from the bridge and stays off until you switch it on.

## What you decide

- **In the Agent:** on or off, which bookmakers, and two limits of your own, per bet and per day. They are stored only on your computer and nobody else can change them.
- **In your account (Auto-betting):** which agents may bet on your accounts and the stake per bet for each of them.

## Licence

Copyright (C) 2026 the Manometer contributors. AGPL-3.0: anyone who runs a modified version as a service has to publish it. See `LICENSE`. The Manometer name and logo are not covered by the licence.
