# Changelog

## [0.2.0](https://github.com/maxcorrads/hivemind/compare/v0.1.0...v0.2.0) (2026-09-22)


### Features

* **benchmark:** add Human decision queue evaluation ([#124](https://github.com/maxcorrads/hivemind/issues/124)) ([39b815d](https://github.com/maxcorrads/hivemind/commit/39b815d46021eb39750cc8e65aab5ff5fa27afd7))
* **coordination:** add isolated Codex pilot runner ([#108](https://github.com/maxcorrads/hivemind/issues/108)) ([cbbdad5](https://github.com/maxcorrads/hivemind/commit/cbbdad5cdcd1de3fc7d8b22caf9a6f87ffcc432b))
* **coordination:** integrate structured tasks, rooms and targeted notifications ([#85](https://github.com/maxcorrads/hivemind/issues/85)) ([030bc4a](https://github.com/maxcorrads/hivemind/commit/030bc4af0477b623fd26c28b9939561bc54b9d55))
* **decisions:** add task-bound Human decision queue ([#100](https://github.com/maxcorrads/hivemind/issues/100)) ([0280e58](https://github.com/maxcorrads/hivemind/commit/0280e585377f4b467f08739b6babdc98fa1fb140))
* integrate project-scoped bots plugins and credential security ([#83](https://github.com/maxcorrads/hivemind/issues/83)) ([c6d0750](https://github.com/maxcorrads/hivemind/commit/c6d0750c73876ea2f5b471dfeddc328643d773af))
* **names:** expand and verify 500 unique agent identities ([#45](https://github.com/maxcorrads/hivemind/issues/45)) ([15d634b](https://github.com/maxcorrads/hivemind/commit/15d634b17ae1f3261b0c845c41649b2762bbb356))
* **observability:** collect and export Phase 2 Jev attempt evidence ([#131](https://github.com/maxcorrads/hivemind/issues/131)) ([e699b2a](https://github.com/maxcorrads/hivemind/commit/e699b2aa748c92389db7b4851f5e039bbdbf122b))
* **routing:** add continuous capacity-aware Jev topology routing ([#129](https://github.com/maxcorrads/hivemind/issues/129)) ([dc9323c](https://github.com/maxcorrads/hivemind/commit/dc9323c650530e4d58be6dc15f2fbf7816c3aca3))
* **routing:** add opt-in capabilities and explainable worker suggestions ([#95](https://github.com/maxcorrads/hivemind/issues/95)) ([5866976](https://github.com/maxcorrads/hivemind/commit/5866976da7e27bee7d5e65dfda5fb9d7ff4deb52))
* **routing:** add optional active Jev orchestration routing ([#126](https://github.com/maxcorrads/hivemind/issues/126)) ([ee6bc3c](https://github.com/maxcorrads/hivemind/commit/ee6bc3c87ba82d03b384374038141a47567ceff4))
* **tasks:** add advisory claims and accepted prerequisite gates ([#94](https://github.com/maxcorrads/hivemind/issues/94)) ([37344dd](https://github.com/maxcorrads/hivemind/commit/37344ddc3139ebf8e43d656b01c450f2c28df316))
* **tasks:** persist versioned checkpoints and bounded resume handoffs ([#92](https://github.com/maxcorrads/hivemind/issues/92)) ([0812c6d](https://github.com/maxcorrads/hivemind/commit/0812c6d8555063585190c18acf6fc098a88fec90))
* **timeline:** add redacted coordination provenance and replay ([#101](https://github.com/maxcorrads/hivemind/issues/101)) ([cfcd07c](https://github.com/maxcorrads/hivemind/commit/cfcd07c4d40d472e5acfa259c41daaa16f2d3ffd))


### Bug Fixes

* **api:** validate inputs and bound JSON upload and client resources ([#91](https://github.com/maxcorrads/hivemind/issues/91)) ([d92277d](https://github.com/maxcorrads/hivemind/commit/d92277d8f2277a569b444677a0ebaddf5226a75c))
* **ci:** clean up edge release notes ([64f30d3](https://github.com/maxcorrads/hivemind/commit/64f30d315b91a350e7109e30c3f3155b72e79287))
* **ci:** make release packaging robust ([575a282](https://github.com/maxcorrads/hivemind/commit/575a282f4a1ea488eaaf4a2f0851cef0d41e10fe))
* **coordination:** bootstrap Human session in room pilot ([#111](https://github.com/maxcorrads/hivemind/issues/111)) ([18ce9e0](https://github.com/maxcorrads/hivemind/commit/18ce9e0e199368e06d2708b4edb324c072dfc8ac))
* **coordination:** correct cumulative OpenCode token accounting ([#118](https://github.com/maxcorrads/hivemind/issues/118)) ([24eb1b4](https://github.com/maxcorrads/hivemind/commit/24eb1b4a457001e4983d243c47a451b66a4c6e9e))
* **coordination:** disable Codex memory in pilot seats ([#109](https://github.com/maxcorrads/hivemind/issues/109)) ([849bdfe](https://github.com/maxcorrads/hivemind/commit/849bdfea621c70998e40822c93df895afbe877f1))
* **coordination:** make room pilot valid across hosts ([#110](https://github.com/maxcorrads/hivemind/issues/110)) ([ce39356](https://github.com/maxcorrads/hivemind/commit/ce39356d6d943a673629fb9ba2ed15f2f862508d))
* **coordination:** pin OpenCode trial workspace and usage ([#116](https://github.com/maxcorrads/hivemind/issues/116)) ([cf74bc2](https://github.com/maxcorrads/hivemind/commit/cf74bc2de21b792174376967c383bd8ac4aaf52f))
* **coordination:** support OpenCode 1.18 CLI ([#115](https://github.com/maxcorrads/hivemind/issues/115)) ([4a7832d](https://github.com/maxcorrads/hivemind/commit/4a7832dfda4a8796e519864471c39911df276339))
* **delivery:** integrate reliable bounded inbox delivery ([#78](https://github.com/maxcorrads/hivemind/issues/78)) ([5383e3d](https://github.com/maxcorrads/hivemind/commit/5383e3d071712b74f0233fcce56ec2d0c66586c5))
* **files:** rebase bounded file handling onto current main ([#62](https://github.com/maxcorrads/hivemind/issues/62)) ([977c571](https://github.com/maxcorrads/hivemind/commit/977c571a8749468e64ad7e52e7796d4c0f481fb1))
* **identity:** scope credentials and require explicit Human recovery ([#90](https://github.com/maxcorrads/hivemind/issues/90)) ([2ac2158](https://github.com/maxcorrads/hivemind/commit/2ac2158c137df52a2d7d5b0fc9f123ae03debc1d))
* **messaging:** persist idempotent sends and desired-state reactions ([#89](https://github.com/maxcorrads/hivemind/issues/89)) ([6b7b129](https://github.com/maxcorrads/hivemind/commit/6b7b12968195238ee2fc2e51956d0fde29239b99))
* **realtime:** bound slow sockets and live conversation windows ([#63](https://github.com/maxcorrads/hivemind/issues/63)) ([9081655](https://github.com/maxcorrads/hivemind/commit/9081655d196ec84b4b0e6269fb6723941553386e))
* **release:** gate stable releases with draft PRs ([cc07909](https://github.com/maxcorrads/hivemind/commit/cc079096f98738393ddd604fc383812c70071e84))
* **release:** keep stable releases pre-1.0 ([a9df43d](https://github.com/maxcorrads/hivemind/commit/a9df43d2b759b563f70098e2ded815e94b1355e3))
* **storage:** make migrations and membership changes atomic and recoverable ([#56](https://github.com/maxcorrads/hivemind/issues/56)) ([1073510](https://github.com/maxcorrads/hivemind/commit/1073510878dad212878dbdff58dd876c13e6cefb))
* **telegram:** authenticate realtime health regression ([#84](https://github.com/maxcorrads/hivemind/issues/84)) ([f008d2b](https://github.com/maxcorrads/hivemind/commit/f008d2b4364b105bffbd1029fca264195c9ab117))
* **ui:** clarify navigation and prevent accidental modal dismissal ([#138](https://github.com/maxcorrads/hivemind/issues/138)) ([1c3ab01](https://github.com/maxcorrads/hivemind/commit/1c3ab01820fb68a73793ea20ffe8e87d0a83d811))
* **ui:** coalesce presence and fence authenticated realtime connections ([#80](https://github.com/maxcorrads/hivemind/issues/80)) ([fd89680](https://github.com/maxcorrads/hivemind/commit/fd89680a7a8a8f643582a28937fef6244f7f7fd4))
* **ui:** improve bot avatar contrast in dark mode ([#127](https://github.com/maxcorrads/hivemind/issues/127)) ([c100077](https://github.com/maxcorrads/hivemind/commit/c100077d5f80b120d609256c4d781ff14aa3ffbd)), closes [#122](https://github.com/maxcorrads/hivemind/issues/122)
* **ui:** integrate scoped read receipts with current realtime stack ([#86](https://github.com/maxcorrads/hivemind/issues/86)) ([7521dc7](https://github.com/maxcorrads/hivemind/commit/7521dc7dc7f62bc772b3eb2fd055c0b08ffd9100))


### Performance Improvements

* **mcp:** reduce recoverable coordination tool errors ([#123](https://github.com/maxcorrads/hivemind/issues/123)) ([621a40c](https://github.com/maxcorrads/hivemind/commit/621a40cef4ae73d23d82eec84b0780c17104e9c9))
* **storage:** integrate scoped and batched hydration ([#64](https://github.com/maxcorrads/hivemind/issues/64)) ([2f4477d](https://github.com/maxcorrads/hivemind/commit/2f4477d649662ccc3a502c9916fa178053a35bf8))
