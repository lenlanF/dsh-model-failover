# Contributing

## Local checks

```sh
node --test tests/*.test.js
```

All tests are pure Node ESM (`node:test` + `node:assert/strict`); no network, no credentials, no DSH runtime install required.

## Never commit

- GitHub PATs, OAuth tokens, API keys, `.git-credentials`, `hosts.yml`
- Local DSH profiles (`~/.dsh/profiles/*`), `cordis.patch.yml` from a real machine, account IDs, phone numbers, emails
- Machine-specific absolute paths (use `<profile>`, `<dsh-home>`, `<repository-root>`)

The plugin's own config is stored in the user's DSH profile, never in this repository.
