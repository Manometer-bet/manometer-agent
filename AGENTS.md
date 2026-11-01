# Instructions for AI coding assistants

This repository is the Manometer Agent: a Chrome extension that places bets with real money on the account holder's own bookmaker accounts. Read [`docs/DEVELOPERS.md`](docs/DEVELOPERS.md) before changing anything.

## Commands

```bash
npm run test:dev   # all checks except the release signature: use this while you work
npm test           # the full check, including the signature
```

`npm test` fails as soon as a file in `extension/` changes, because only the maintainers can sign a release. That is expected, and pull requests skip this one check.

There is no build step. To try a change, load `extension/` unpacked in Chrome. It needs an `engine-boot.json` with your own access, from the Agent page of your Manometer account. Never commit that file.

## Rules that protect real money

1. Never resolve the game yourself. The target comes from the operator as `proposal.bookRef`.
2. Read the price fresh right before placing and check it against `minOdds`.
3. Once a bet has been sent, an unclear answer is `uncertain`, never `blocked`.
4. Keep failing closed: without valid signed settings, nothing is placed.
5. A change to what the Agent sends must change `PHONE_HOME.md` in the same commit.

## Do not

- Commit keys, tokens, account data or `engine-boot.json`.
- Add a way around a bookmaker's checks: no captcha solving, no disguised browser and no hidden identity. When a book asks for a check, report a refusal.
- Add analytics, remote code (`eval`, `new Function`) or a new destination for data.
- Change `release/`. The maintainers sign releases.

Commit with `git commit -s` (Developer Certificate of Origin).
