// Preloaded into every test process by scripts/run-tests.mjs (#201).
//
// Under --experimental-test-coverage the runner points NODE_V8_COVERAGE of each
// test process at one shared directory and parses every JSON file in it at the
// end. V8 has already read the variable when this runs, so the test process
// still writes its own coverage; removing it from process.env keeps every
// descendant out of that directory, including children started by production
// code or scripts under test (plugins, bin launcher, topology study host) that
// cannot use childEnv() from src/test-support/child-process.ts. A descendant
// killed or orphaned while writing there leaves an empty or truncated file and
// the runner then aborts the whole coverage report.
//
// Only test processes are touched (NODE_TEST_CONTEXT is set by the runner for
// them); the runner itself needs the variable to set up coverage.
if (process.env.NODE_TEST_CONTEXT) delete process.env.NODE_V8_COVERAGE;
