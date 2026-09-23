# Reproducible checks

Primary PR CI runs on Ubuntu with Node 22.13.0, the latest Node 22.x and Node 24, plus one focused
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
- Node 22.13.0 runs the same full unit/integration scope with four timing-balanced integration shards; Ubuntu concurrency now makes the full 4-way split useful without the former macOS queue penalty.
- The same Node 22 unit/integration matrix also runs on `22.x` (latest Node 22 release) next to the 22.13.0 engines floor, so changes to the still-experimental `node:sqlite` in newer Node 22 minors surface in CI. Both lanes feed the `Tests / Node 22.13.0` gate.
- The existing required gate names `Tests / Node 24` and `Tests / Node 22.13.0`
  are aggregation jobs over all corresponding shards. `Tests / Node 24` also
  requires `Browser / Chromium`, so a failing browser contract blocks merging
  (Playwright retries stay at 0 so flakes remain visible).
- Node 24 test jobs collect LCOV during their normal execution. `Coverage` merges
  those artifacts and enforces the unchanged 80% line / 75% branch / 75% function
  thresholds, so CI no longer executes the complete suite a third time.
- Playwright browser downloads use a version-sensitive Linux cache; required
  Chromium system packages are installed explicitly. Browser contracts stay isolated
  from server integration shards.
- Cross-platform shell argument contracts run with bash on Linux; zsh-only syntax
  validation remains in the focused native macOS job, avoiding repeated package-manager setup on ephemeral Linux runners.
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
balancing using `scripts/ci-test-timings.json`. The checked-in historical weights retain the coverage-stable assignment already validated across normal Node 24 coverage producers; every unmeasured/new integration file gets a fallback weight
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
merged report is retained for seven days. On a browser failure CI also uploads the
failure-only Playwright trace/video/screenshot directory (artifacts/playwright) with
the same seven-day retention. Binary visual data cannot be redacted by a text
filter, so this is safe only because the browser suite is fully synthetic and
hermetic: every `/api` call is answered by an in-test fixture and the shared
fixture (tests/browser/fixtures.ts) aborts, and fails the test on, any request to
a non-local host. Keep it that way: never feed real data into a browser fixture.
No raw environments, credentials, provider reasoning or user workspace files are
fixture inputs.

## Synthetic storage performance evidence

`node --import tsx scripts/benchmark-storage-matrix.mjs` runs nine independent
fixture shapes (12 samples by default) in temporary databases. Read
[storage-benchmark.md](docs/storage-benchmark.md) for the exact #64 before/after
commands, retained raw results, counter limitations and current HTTP receipt
probe. The heavy matrix is opt-in; a bounded smoke/metadata test is discovered in
CI. SQL rows returned are not rows examined, and synthetic latency is not model
quality or cost evidence.
