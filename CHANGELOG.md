# Changelog

## [0.4.0](https://github.com/maxcorrads/hivemind/compare/v0.3.0...v0.4.0) (2026-09-24)


### ⚠ BREAKING CHANGES

* **routing:** the Human send response no longer carries adaptiveStates; jevAdvice is absent instead of null when there is no usable advice; PUT /api/ui/adaptive-routing rejects fallback and topologyFallback; the benchmark:topology:study script is removed.
* **mcp:** the old MCP tool names are gone; restart agents' MCP clients after upgrading.

### Features

* **agents:** remove agents as transactional tombstones that keep history ([#233](https://github.com/maxcorrads/hivemind/issues/233)) ([ea6d100](https://github.com/maxcorrads/hivemind/commit/ea6d10099aff784befed36daf9648c630bc367f9)), closes [#215](https://github.com/maxcorrads/hivemind/issues/215)
* **mcp:** consolidate duplicate tools, drop executionId, fix #name, guard attach ([#229](https://github.com/maxcorrads/hivemind/issues/229)) ([927a0fc](https://github.com/maxcorrads/hivemind/commit/927a0fc2f022cbd8f9cfa141c323058545e4a5d4)), closes [#218](https://github.com/maxcorrads/hivemind/issues/218)
* **routing:** take Jev off the send path and make it fully optional ([#234](https://github.com/maxcorrads/hivemind/issues/234)) ([9e56de6](https://github.com/maxcorrads/hivemind/commit/9e56de64abb30452f1cfba64df8cd72b5045ef76)), closes [#214](https://github.com/maxcorrads/hivemind/issues/214)
* **storage:** add indexes, batch hot queries and a 30-day configurable retention ([#230](https://github.com/maxcorrads/hivemind/issues/230)) ([212d13c](https://github.com/maxcorrads/hivemind/commit/212d13c1a23a20217c21ac9dbfa3fc74191f8b6d)), closes [#217](https://github.com/maxcorrads/hivemind/issues/217)
* **ui:** accessibility pass, loading/empty/error states and OS theme ([#228](https://github.com/maxcorrads/hivemind/issues/228)) ([d5117bb](https://github.com/maxcorrads/hivemind/commit/d5117bbfe626e081f302c34421a494b3d4166321)), closes [#220](https://github.com/maxcorrads/hivemind/issues/220)
* **ui:** channel tabs, task stepper, one-click decisions and thread header ([#232](https://github.com/maxcorrads/hivemind/issues/232)) ([62aaeba](https://github.com/maxcorrads/hivemind/commit/62aaebaf15eadde8dc78f9b0b3874d66b34dbb49)), closes [#224](https://github.com/maxcorrads/hivemind/issues/224)
* **ui:** mobile layout with full-screen screens and bottom tabs ([#226](https://github.com/maxcorrads/hivemind/issues/226)) ([466adee](https://github.com/maxcorrads/hivemind/commit/466adeec9f15c6f9ea9c3265b309a7864cb376af)), closes [#223](https://github.com/maxcorrads/hivemind/issues/223)
* **ui:** server-backed For you Activity feed and Unread that matches the badges ([#235](https://github.com/maxcorrads/hivemind/issues/235)) ([0a6418a](https://github.com/maxcorrads/hivemind/commit/0a6418a0fb8dc0ea49f0a99de67217765c70f05e))
* **ui:** Slack-style message stream with grouping, markdown, dividers and cards ([#231](https://github.com/maxcorrads/hivemind/issues/231)) ([4b02e57](https://github.com/maxcorrads/hivemind/commit/4b02e5736aea66065afc17d7638875db45f8d52c)), closes [#221](https://github.com/maxcorrads/hivemind/issues/221)
* **ui:** Slack-style navigation with project rail, Cmd+K switcher and badges ([#237](https://github.com/maxcorrads/hivemind/issues/237)) ([6e3113a](https://github.com/maxcorrads/hivemind/commit/6e3113a7b861fcc58410caba1c37ea15b5a23c62))


### Bug Fixes

* **server:** transactional Telegram outbox, infallible post-commit listeners, single-instance lock ([#238](https://github.com/maxcorrads/hivemind/issues/238)) ([8bac931](https://github.com/maxcorrads/hivemind/commit/8bac931a212026a665bafd84f4ed9d92d16a339c))
* **ui:** hide the queue badge when the queued count is unknown ([#239](https://github.com/maxcorrads/hivemind/issues/239)) ([717388b](https://github.com/maxcorrads/hivemind/commit/717388b72456712e608b22f1b0ddb523b1dd4e0e))
* **ui:** reliable sends, render performance, realtime coalescing, keyboard mentions ([#236](https://github.com/maxcorrads/hivemind/issues/236)) ([1581717](https://github.com/maxcorrads/hivemind/commit/15817178838cf13be2d99456d1b3e66c615f3db8)), closes [#219](https://github.com/maxcorrads/hivemind/issues/219)

## [0.3.0](https://github.com/maxcorrads/hivemind/compare/v0.2.0...v0.3.0) (2026-09-23)


### ⚠ BREAKING CHANGES

* **routing:** nothing is enforced any more; clients relying on 409 admission, the lock endpoint, routing/lockScope, the directive or adaptiveRouting must stop doing so.
* **mcp:** rewrite agent instructions with one home per rule ([#185](https://github.com/maxcorrads/hivemind/issues/185))
* **identity:** resume no longer requires or reads a saved token, and the agent credential endpoints under /api/ui/projects/:project/agents are removed.

### Features

* add explicit Human-only Jev connection diagnostics ([#140](https://github.com/maxcorrads/hivemind/issues/140)) ([f20019b](https://github.com/maxcorrads/hivemind/commit/f20019b32020b46ec3194b22cb8d67beb6cd8e79))
* **benchmark:** add isolated paired-study runner for the Phase 2 topology protocol ([#197](https://github.com/maxcorrads/hivemind/issues/197)) ([dd4a80c](https://github.com/maxcorrads/hivemind/commit/dd4a80c54daee5879e8f3131a38f0fa2b4f0e251))
* **identity:** resume brains and workers by name without credentials ([#144](https://github.com/maxcorrads/hivemind/issues/144)) ([11e8fe8](https://github.com/maxcorrads/hivemind/commit/11e8fe8b98a2aeabeef1a1135f2753d6a606a8ff))
* **mcp:** rewrite agent instructions with one home per rule ([#185](https://github.com/maxcorrads/hivemind/issues/185)) ([aec45a4](https://github.com/maxcorrads/hivemind/commit/aec45a4697a4e7fac7909380a544dfb7689345df)), closes [#149](https://github.com/maxcorrads/hivemind/issues/149) [#165](https://github.com/maxcorrads/hivemind/issues/165)
* **observability:** surface evidence-collector health and capture completeness ([#196](https://github.com/maxcorrads/hivemind/issues/196)) ([f570b60](https://github.com/maxcorrads/hivemind/commit/f570b60962876e1e7013e61458eb074048053510))
* raise message body limit to 20,000 characters ([#206](https://github.com/maxcorrads/hivemind/issues/206)) ([08669dc](https://github.com/maxcorrads/hivemind/commit/08669dc72ec88f4c1bac9a745d7bc4d3a289ffdd))
* **routing:** make Jev advisory-only ([#212](https://github.com/maxcorrads/hivemind/issues/212)) ([dcbfe75](https://github.com/maxcorrads/hivemind/commit/dcbfe756dcb0d57fc3046ec2ee07cb6354d211f8))
* **routing:** route every Human request to a brain through Jev ([#142](https://github.com/maxcorrads/hivemind/issues/142)) ([95952bd](https://github.com/maxcorrads/hivemind/commit/95952bd77b6782a5357a3f6276143db094f72330))
* **routing:** support a pinned Jev model identifier for reproducible evaluation ([#194](https://github.com/maxcorrads/hivemind/issues/194)) ([e885670](https://github.com/maxcorrads/hivemind/commit/e88567006a5bc0a8c95556201c38efb1988d18a8))
* **ui:** add a Human-only Jev call history section ([#143](https://github.com/maxcorrads/hivemind/issues/143)) ([cb9370f](https://github.com/maxcorrads/hivemind/commit/cb9370f1281e6030acd13f113db53e6800597932))
* **ui:** add a Routing log, a visible Launch agent entry and cursor paging for Jev history ([#176](https://github.com/maxcorrads/hivemind/issues/176)) ([a9aa055](https://github.com/maxcorrads/hivemind/commit/a9aa055688284e8705c80fabe08d0eefce67e9b6)), closes [#164](https://github.com/maxcorrads/hivemind/issues/164) [#153](https://github.com/maxcorrads/hivemind/issues/153) [#161](https://github.com/maxcorrads/hivemind/issues/161)
* **ui:** keep archived channels in a collapsible sidebar section ([#213](https://github.com/maxcorrads/hivemind/issues/213)) ([d48a10d](https://github.com/maxcorrads/hivemind/commit/d48a10d068e7211122ee2273dafbe88d496980af))
* **ui:** show draining executions in the Routing panel ([#186](https://github.com/maxcorrads/hivemind/issues/186)) ([c440b54](https://github.com/maxcorrads/hivemind/commit/c440b54e6bd95a0a6edf796c9c39df82aaef64ae))


### Bug Fixes

* **coordination:** unblock workers and report committed agent actions ([#180](https://github.com/maxcorrads/hivemind/issues/180)) ([547680f](https://github.com/maxcorrads/hivemind/commit/547680fa88561d9f2281f257af9e14e26453bbc6))
* **mcp:** spell out action shapes for task_event, room_event and decision_event ([#205](https://github.com/maxcorrads/hivemind/issues/205)) ([487b377](https://github.com/maxcorrads/hivemind/commit/487b377cfd3a4bd5ed2a94e79bd72ec8d849036b))
* **routing:** ask Jev for one joint plan instead of topology and budget separately ([#208](https://github.com/maxcorrads/hivemind/issues/208)) ([c755738](https://github.com/maxcorrads/hivemind/commit/c7557381fb1c98910c8e26b344fbfae343708dcf)), closes [#207](https://github.com/maxcorrads/hivemind/issues/207)
* **routing:** let superseded executions drain instead of blocking Human requests ([#182](https://github.com/maxcorrads/hivemind/issues/182)) ([658ed53](https://github.com/maxcorrads/hivemind/commit/658ed539b697b340dd3b8e99400fcbbb3b145cca))
* **routing:** treat incoherent Jev answers as uncertain and label fallbacks precisely ([#210](https://github.com/maxcorrads/hivemind/issues/210)) ([c584db6](https://github.com/maxcorrads/hivemind/commit/c584db639ff86e55e83dd53e722e4a1a86ed26f6)), closes [#209](https://github.com/maxcorrads/hivemind/issues/209)
* **ui:** self-host fonts, hold the thread-open scroll anchor and gate merges on the browser suite ([#177](https://github.com/maxcorrads/hivemind/issues/177)) ([99ad6d5](https://github.com/maxcorrads/hivemind/commit/99ad6d549a93730c9c458ab4ce76d7f73921e4b7)), closes [#154](https://github.com/maxcorrads/hivemind/issues/154) [#155](https://github.com/maxcorrads/hivemind/issues/155)
* **ui:** show sent messages and preserve thread scroll position ([#139](https://github.com/maxcorrads/hivemind/issues/139)) ([16ef62e](https://github.com/maxcorrads/hivemind/commit/16ef62ee5c7b7fca95f5d673202e1ee1f3a2c6b1))

## [0.2.0](https://github.com/maxcorrads/hivemind/compare/v0.1.0...v0.2.0) (2026-09-22)


### Features

* **benchmark:** add Human decision queue evaluation ([#124](https://github.com/maxcorrads/hivemind/issues/124)) ([c0453ad](https://github.com/maxcorrads/hivemind/commit/c0453adcb8201c13ee422e18f604fb35dfb06759))
* **coordination:** add isolated Codex pilot runner ([#108](https://github.com/maxcorrads/hivemind/issues/108)) ([5c24766](https://github.com/maxcorrads/hivemind/commit/5c24766bf4040930e39968f36feea2315cbe30aa))
* **coordination:** integrate structured tasks, rooms and targeted notifications ([#85](https://github.com/maxcorrads/hivemind/issues/85)) ([cde4d8e](https://github.com/maxcorrads/hivemind/commit/cde4d8eba8c80bbe39e3e6f6afd6970f7141604f))
* **decisions:** add task-bound Human decision queue ([#100](https://github.com/maxcorrads/hivemind/issues/100)) ([2dcc5f7](https://github.com/maxcorrads/hivemind/commit/2dcc5f7383a1172ef787989dbcd3b6ee2620b1bc))
* integrate project-scoped bots plugins and credential security ([#83](https://github.com/maxcorrads/hivemind/issues/83)) ([def8e09](https://github.com/maxcorrads/hivemind/commit/def8e091d639f542c8608474cea121c0000965e9))
* **names:** expand and verify 500 unique agent identities ([#45](https://github.com/maxcorrads/hivemind/issues/45)) ([63bdb18](https://github.com/maxcorrads/hivemind/commit/63bdb18c0705909234a7928488cc1fb061da199c))
* **observability:** collect and export Phase 2 Jev attempt evidence ([#131](https://github.com/maxcorrads/hivemind/issues/131)) ([37d50ac](https://github.com/maxcorrads/hivemind/commit/37d50ac3e0e8bec36cee2881306e81bd39beab05))
* **routing:** add continuous capacity-aware Jev topology routing ([#129](https://github.com/maxcorrads/hivemind/issues/129)) ([05454b4](https://github.com/maxcorrads/hivemind/commit/05454b4462f3485f372c6ec229de95b79b9dfc83))
* **routing:** add opt-in capabilities and explainable worker suggestions ([#95](https://github.com/maxcorrads/hivemind/issues/95)) ([ebd4e4c](https://github.com/maxcorrads/hivemind/commit/ebd4e4c26849639a0ae75233d44de2961bf7997b))
* **routing:** add optional active Jev orchestration routing ([#126](https://github.com/maxcorrads/hivemind/issues/126)) ([fb56437](https://github.com/maxcorrads/hivemind/commit/fb56437020144d2801bcabe4b2c14054ae0b9887))
* **tasks:** add advisory claims and accepted prerequisite gates ([#94](https://github.com/maxcorrads/hivemind/issues/94)) ([176b70c](https://github.com/maxcorrads/hivemind/commit/176b70c025f4107e8fbf4837783b91527aefc6c5))
* **tasks:** persist versioned checkpoints and bounded resume handoffs ([#92](https://github.com/maxcorrads/hivemind/issues/92)) ([7301e33](https://github.com/maxcorrads/hivemind/commit/7301e33025cfe73ab0f04deead37d414f7316d05))
* **timeline:** add redacted coordination provenance and replay ([#101](https://github.com/maxcorrads/hivemind/issues/101)) ([2f946f6](https://github.com/maxcorrads/hivemind/commit/2f946f66239ec0e0010f5a13ba5c1f090a9ba69a))


### Bug Fixes

* **api:** validate inputs and bound JSON upload and client resources ([#91](https://github.com/maxcorrads/hivemind/issues/91)) ([cd59b0c](https://github.com/maxcorrads/hivemind/commit/cd59b0c2f5e60136e75d1ee9a725f3bbff66ded8))
* **ci:** clean up edge release notes ([abdf87d](https://github.com/maxcorrads/hivemind/commit/abdf87d629d6547de7c64b222a90b51f9b137493))
* **ci:** make release packaging robust ([e49e335](https://github.com/maxcorrads/hivemind/commit/e49e335d5ee6f74344fa92bb0b2be4f8ae462eca))
* **coordination:** bootstrap Human session in room pilot ([#111](https://github.com/maxcorrads/hivemind/issues/111)) ([a370e2d](https://github.com/maxcorrads/hivemind/commit/a370e2d26f19903cae7bf7b064218bc6c59e563f))
* **coordination:** correct cumulative OpenCode token accounting ([#118](https://github.com/maxcorrads/hivemind/issues/118)) ([7f16640](https://github.com/maxcorrads/hivemind/commit/7f1664078c0221025733c47ae5ce786c90da48d2))
* **coordination:** disable Codex memory in pilot seats ([#109](https://github.com/maxcorrads/hivemind/issues/109)) ([1e95699](https://github.com/maxcorrads/hivemind/commit/1e9569963e4df9286b36d32007079c7b8429a40c))
* **coordination:** make room pilot valid across hosts ([#110](https://github.com/maxcorrads/hivemind/issues/110)) ([1c30863](https://github.com/maxcorrads/hivemind/commit/1c30863ff6d3785f9d71d5a02a30a1cd5ecbef24))
* **coordination:** pin OpenCode trial workspace and usage ([#116](https://github.com/maxcorrads/hivemind/issues/116)) ([015a44c](https://github.com/maxcorrads/hivemind/commit/015a44c69845f65a11e814550610bda893f5ff59))
* **coordination:** support OpenCode 1.18 CLI ([#115](https://github.com/maxcorrads/hivemind/issues/115)) ([0bc507b](https://github.com/maxcorrads/hivemind/commit/0bc507b6bf2cd153e4b1b6b24a3d92d8e991ddd3))
* **delivery:** integrate reliable bounded inbox delivery ([#78](https://github.com/maxcorrads/hivemind/issues/78)) ([1d7b9e5](https://github.com/maxcorrads/hivemind/commit/1d7b9e5d1ef4a7c73c973428616d4937f850d8c5))
* **files:** rebase bounded file handling onto current main ([#62](https://github.com/maxcorrads/hivemind/issues/62)) ([9170138](https://github.com/maxcorrads/hivemind/commit/91701385d760a4f96f92f5fa9355214cb18f8498))
* **identity:** scope credentials and require explicit Human recovery ([#90](https://github.com/maxcorrads/hivemind/issues/90)) ([30f8fee](https://github.com/maxcorrads/hivemind/commit/30f8feebf677f1d6b98641156980798441b64e2a))
* **messaging:** persist idempotent sends and desired-state reactions ([#89](https://github.com/maxcorrads/hivemind/issues/89)) ([80a128f](https://github.com/maxcorrads/hivemind/commit/80a128f7024a6ec3648591198e621843ad5aaa82))
* **realtime:** bound slow sockets and live conversation windows ([#63](https://github.com/maxcorrads/hivemind/issues/63)) ([5df9817](https://github.com/maxcorrads/hivemind/commit/5df9817d357a5f537e09c5ecbc694af0b8db91fd))
* **release:** gate stable releases with draft PRs ([f51b2b7](https://github.com/maxcorrads/hivemind/commit/f51b2b707c5dd3d3c4716d29777f1ebc0bfdb330))
* **release:** keep stable releases pre-1.0 ([4a7f4bf](https://github.com/maxcorrads/hivemind/commit/4a7f4bf5d4f55c6e88e8fca9b3a16619b1d3971e))
* **storage:** make migrations and membership changes atomic and recoverable ([#56](https://github.com/maxcorrads/hivemind/issues/56)) ([53ffbcd](https://github.com/maxcorrads/hivemind/commit/53ffbcdf8aced6563c2cf7dcf24382dcffff17bc))
* **telegram:** authenticate realtime health regression ([#84](https://github.com/maxcorrads/hivemind/issues/84)) ([0ed01a5](https://github.com/maxcorrads/hivemind/commit/0ed01a518b413396637e9d639957808f35ba02dd))
* **ui:** clarify navigation and prevent accidental modal dismissal ([#138](https://github.com/maxcorrads/hivemind/issues/138)) ([0ad88d7](https://github.com/maxcorrads/hivemind/commit/0ad88d79b24f014b15cd3a08cede44d8b1553b8f))
* **ui:** coalesce presence and fence authenticated realtime connections ([#80](https://github.com/maxcorrads/hivemind/issues/80)) ([c2532ab](https://github.com/maxcorrads/hivemind/commit/c2532ab80781845c1efb9d713db300d6f50ea249))
* **ui:** improve bot avatar contrast in dark mode ([#127](https://github.com/maxcorrads/hivemind/issues/127)) ([90a4134](https://github.com/maxcorrads/hivemind/commit/90a413417bcb29d23d528c7d9c93020f470657b3)), closes [#122](https://github.com/maxcorrads/hivemind/issues/122)
* **ui:** integrate scoped read receipts with current realtime stack ([#86](https://github.com/maxcorrads/hivemind/issues/86)) ([4ad8fd5](https://github.com/maxcorrads/hivemind/commit/4ad8fd5905847f34cfd0a20c72eacc95bb6f82bb))


### Performance Improvements

* **mcp:** reduce recoverable coordination tool errors ([#123](https://github.com/maxcorrads/hivemind/issues/123)) ([e65f385](https://github.com/maxcorrads/hivemind/commit/e65f3858a23b8f0c4d14e14d15af0aed913ded23))
* **storage:** integrate scoped and batched hydration ([#64](https://github.com/maxcorrads/hivemind/issues/64)) ([bae04e3](https://github.com/maxcorrads/hivemind/commit/bae04e3efa07f70a756d9cb2118cc0cb3139d814))
