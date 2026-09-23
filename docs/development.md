# Development and releases

## Development checks

Run the same core checks used by CI before opening a PR:

```bash
npm run check
```

That command lints the codebase, typechecks the server and web app, discovers and runs all TypeScript tests, and builds the production UI plus the compiled CLI, server and MCP (`dist/node`, via esbuild) that the npm package runs without `tsx`. CI additionally tests the real minimum runtime (Node 22.13.0) and the current Node 24 line on macOS, reviews dependency changes, audits production dependencies, collects coverage, and runs CodeQL. See [Reproducible checks](../TESTING.md) for `npm run check:all` and the CI topology.

PR titles use Conventional Commit syntax because release versioning is derived from them. Examples: `fix: handle reconnect races`, `feat(mcp): add a new tool`, `feat!: change the wire contract`.

## Releases

Merges to `main` update an automated draft Release Please PR. When you want a stable release, mark that PR ready for review; CI and CodeQL then validate its current head. Merging the validated release PR creates the SemVer tag and GitHub Release. The release workflow reruns the full checks, builds an installable npm tarball, attaches a SHA-256 checksum, and records GitHub build provenance for the package.

The generated `.tgz` can be installed directly:

```bash
npm install -g ./hivemind-X.Y.Z.tgz
```

A registry publish can be added later without changing the versioning flow.

## Edge builds

Every CI-green merge to `main` publishes a rolling GitHub prerelease tagged `edge`. It contains:

- `hivemind-edge.tgz`
- `SHA256SUMS.txt`
- a CycloneDX SBOM
- GitHub build provenance for the package

The `edge` prerelease is continuously replaced by the latest tested `main` build. Stable SemVer releases remain separate.
