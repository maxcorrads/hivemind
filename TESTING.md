# Reproducible checks

Supported CI runs on macOS with Node 22.13.0 and Node 24. Install the Node version
under test, npm, zsh (required by the existing shell contracts), then:

```sh
npm ci
npx playwright install chromium
npm run check:all
```

`check:all` fails fast and runs lint, all three strict typechecks, separately
reported unit/integration suites, production build, unchanged coverage thresholds,
Chromium contracts, installed-package smoke and production dependency audit.
CI runs the same commands in parallel jobs; the existing Tests / Node gate names
remain unchanged. PR title/dependency review and hosted CodeQL are additional CI
checks, not local test results. An audit failure needs review, not an automatic
claim that the app is exploitable. `npm run check` remains the lighter release
command for backwards compatibility; use `check:all` for complete acceptance.

## Discovery and classifications

`npm test` automatically discovers every `.test.ts`, `.test.tsx` and `.test.mjs`
under src, web and scripts. `test:unit` selects explicitly named `.unit.test.*` files and the reviewed
pure legacy files in scripts/test-suites.mjs. Everything else, including
mixed tests, defaults to integration. New tests cannot disappear for lacking a
manifest entry. Browser `.spec.ts` files are discovered separately by Playwright.

The current fault matrix includes message atomicity (#1), real HTTP error status
and stdio invalid authentication (#2), stdio/HTTP cancellation (#4), storage/CLI/
stdio pagination with gaps (#5), serialized HTTP/WS thread contracts (#9), and
nine Chromium transport/reading regressions (#11/#21). Regression fixes and
historical negative controls are documented on their PRs; no claim is made that
all current tests run against every old checkout.

## Retained diagnostics

CI routes test stdout/stderr through scripts/run-logged.mjs **before** either
console output or artifact persistence. Redaction covers authorization/cookie
headers, common token/password/API-key fields, URL user-info, known provider-key
forms, configured secret environment values, and private-key blocks. Streaming
UTF-8/chunk boundaries are handled; oversized lines are omitted and artifact logs
are capped at 4 MiB. No generic detector guarantees removal of arbitrary secrets
in free prose: keep credentials out of test output and fixtures.

CI uploads only sanitized text logs, with separate unit/integration/browser
artifacts and seven-day retention. Raw Playwright trace/video/screenshot archives
are deliberately **not uploaded**: binary visual data cannot be reliably redacted
by a text filter. Developers may inspect the failure-only local synthetic trace
under artifacts/playwright after reviewing its contents. No raw environments,
credentials, provider reasoning or user workspace files are fixture inputs.
