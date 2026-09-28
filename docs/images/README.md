# README screenshots

These PNGs show the actual Hivemind web UI with an entirely synthetic project, conversations, tasks, worker templates, and terminal output. They are product illustrations, not records of real agent work or model benchmark results.

Regenerate from a checkout with dependencies and Playwright Chromium installed:

```sh
npm run build:web
node scripts/capture-readme.mjs
```

`demo.gif` shows the same synthetic project as a short story: Human posts a goal, Atlas delegates, Forge reports a result, and Prism and Atlas review it in the thread. Regenerate it after `npm run build:web` with `node scripts/record-readme-demo.mjs` (needs `ffmpeg` on the `PATH`). It uses the same isolation as the screenshots: the fixtures, static server, and request checks are shared through `scripts/readme-fixtures.mjs`, and new messages arrive as mocked in-browser WebSocket frames.

The capture script starts only a static file server on a randomly allocated loopback port. It does not start the Hivemind backend, read a hive database, use a native terminal broker, or launch agents. All API and WebSocket responses are supplied in the browser; unexpected requests fail the capture. Requests to any other origin are blocked. The server and browser close when capture finishes.

The native bridge used for terminal screenshots is an in-memory mock. Terminal data is rendered by the app's actual terminal component; no commands shown in the screenshots are executed.

Keep the fixed date, English locale, viewport, and synthetic identities in the capture script for repeatable captures. Inspect each image after regeneration. The app icon in the main README is the existing `web/public/icon.png` asset.
