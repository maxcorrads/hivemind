# Reproducible checks

Primary PR CI runs on Ubuntu with Node 22.13.0 and Node 24, plus one focused
macOS compatibility job for the native zsh/Terminal-launch shell contracts. For a
full local check, install the Node version under test, npm, zsh and Chromium, then:

```sh
npm ci
npx playwright install chromium
npm run check:all
```

`check:all` fails fast and runs lint, all three strict typechecks, separately
reported unit/integration suites, production build, unchanged coverage thresholds,
Chromium contracts, installed-package smoke and production dependency audit.
`npm run check` remains the lighter release command for backwards compatibility;
use `check:all` for complete local acceptance.

PR CI deliberately uses a lower-latency topology than `check:all` while preserving
its effective scope:

- CPU-heavy quality, test and browser jobs run on Ubuntu rather than competing for
  the much smaller hosted macOS concurrency pool.
- Node 24 unit and four historically timing-balanced integration shards run independently.
- Node 22.13.0 runs the same full unit/integration scope with two timing-balanced integration shards, reducing compatibility-runner overhead without reducing coverage.
- The existing required gate names `Tests / Node 24` and `Tests / Node 22.13.0`
  are aggregation jobs over all corresponding shards.
- Node 24 test jobs collect LCOV during their normal execution. `Coverage` merges
  those artifacts and enforces the unchanged 80% line / 75% branch / 75% function
  thresholds, so CI no longer executes the complete suite a third time.
- Playwright browser downloads use a version-sensitive Linux cache; required
  Chromium system packages are installed explicitly. Browser contracts stay isolated
  from server integration shards.
- Linux integration jobs ensure zsh is available, so generated shell contracts are
  still parsed/executed during the full Node suites.
- One focused native macOS job runs the launch/plugin shell contracts with the real
  macOS zsh environment. `Tests / Node 24` requires that job as well as every Node 24 shard.
- npm's download cache is used; `node_modules` is not cached.

See [ci-performance.md](docs/ci-performance.md) for the measured baseline, shard
weight methodology, runner-cost trade-off and after-measurement protocol.
PR title/dependency review also run on Ubuntu. Hosted CodeQL is an additional CI
check, not a local test result. An audit failure needs review, not an automatic
claim that the app is exploitable.

## Discovery and classifications

`npm test` automatically discovers every `.test.ts`, `.test.tsx` and `.test.mjs`
under src, web and scripts. `test:unit` selects explicitly named `.unit.test.*` files and the reviewed
pure legacy files in scripts/test-suites.mjs. Everything else, including
mixed tests, defaults to integration. New tests cannot disappear for lacking a
manifest entry. Browser `.spec.ts` files are discovered separately by Playwright.

CI integration shards are assigned by deterministic largest-processing-time
balancing using `scripts/ci-test-timings.json`. Measured slow files receive their
historical weight; every unmeasured/new integration file gets a fallback weight
and is still assigned to exactly one shard. Sharding therefore cannot silently
drop an unlisted test.

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
artifacts and seven-day retention. LCOV artifacts contain source paths and numeric
coverage data only; the intermediate shard artifacts are short-lived and the
merged report is retained for seven days. Raw Playwright trace/video/screenshot
archives are deliberately **not uploaded**: binary visual data cannot be reliably
redacted by a text filter. Developers may inspect the failure-only local synthetic
trace under artifacts/playwright after reviewing its contents. No raw environments,
credentials, provider reasoning or user workspace files are fixture inputs.

## Synthetic storage performance evidence

`node --import tsx scripts/benchmark-storage-matrix.mjs` runs nine independent
fixture shapes (12 samples by default) in temporary databases. Read
[storage-benchmark.md](docs/storage-benchmark.md) for the exact #64 before/after
commands, retained raw results, counter limitations and current HTTP receipt
probe. The heavy matrix is opt-in; a bounded smoke/metadata test is discovered in
CI. SQL rows returned are not rows examined, and synthetic latency is not model
quality or cost evidence.
