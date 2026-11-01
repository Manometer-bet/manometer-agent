# Contributing

Contributions need a Developer Certificate of Origin sign-off (`git commit -s`), and code owners review the sensitive parts: the signature check, the limits and everything that sends data.

Run `npm run test:dev` while you work; the CI runs the same checks on a pull request. The maintainers sign the release after merging. A change to what the Agent sends has to change `PHONE_HOME.md` in the same commit.
