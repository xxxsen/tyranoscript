# Retrom TyranoScript fork maintenance rules

This fork pins the TyranoScript baseline used to validate the standalone
Retrom host bridge. It does not own Retrom application APIs, databases,
review workflows, credentials, or private games.

## Repository identity

- `master` is an unmodified, fast-forward-only mirror of `upstream/master`.
- `retrom/gc8dbfd492afd` is the only active Retrom maintenance baseline and
  the repository default branch. Retrom changes and release tags originate
  there, never from `master`.
- `upstream` must point to `https://github.com/ShikemokuMK/tyranoscript.git`.
- `retrom-fork.json` is the machine-readable baseline and release contract.
  Its upstream commit must never be replaced with a floating branch.
- A new upstream baseline requires a reviewed
  `sync/upstream-g<12-hex-commit>` branch and a new matching `retrom/g*`
  maintenance branch.

## Branches and commits

- Create short-lived `fix/*`, `feat/*`, `build/*`, or `sync/upstream-*`
  branches from `retrom/gc8dbfd492afd`.
- Branch names use lowercase ASCII and hyphens. Do not create parallel
  long-lived maintenance branches or branches named after an agent.
- Keep changes small and reviewable. Release ancestry after the fixed
  upstream baseline must not contain merge commits.
- Never force-push, move immutable tags, or delete another contributor's work.

## Runtime and licence boundary

- Upstream `LICENCE.txt` prohibits redistribution of TyranoScript itself.
  Release assets from this fork therefore contain only the independently
  authored Retrom host bridge, its licence, and release metadata. They must
  never contain the TyranoScript engine, sample game, or a repackaged project.
- Games supply their own TyranoScript engine and project files. The bridge
  may use documented/public browser globals but must not import Retrom source,
  HTTP routes, database types, or UI code.
- The bridge protocol must remain host-independent and strict: lifecycle
  ready/exit, pause/resume, standard browser gamepads, screenshot, and bounded
  checkpoint creation/restoration belong to the public runtime boundary.
- A checkpoint must restore directly in a fresh page to the captured scenario
  state without opening the game's load menu. BGM state and post-restore input
  are part of the restore contract.
- A game-owned `window.close()` or TyranoScript `[close]` must emit one exit
  request, disable further checkpoints, and release input.
- Tests use only this repository's upstream sample project. Never download or
  commit private/commercial games, credentials, or user saves.

## Quality and releases

- Before pushing, run `python3 .github/rpg-runtime/verify-source.py`.
- Bridge changes must also run the checked-in Node unit tests and the Chrome
  sample-project lifecycle test registered by the quality workflow.
- PRs to `retrom/gc8dbfd492afd` must pass
  `.github/workflows/rpg-runtime-quality.yml`.
- Release tags are `retrom-core-gc8dbfd492afd-rN`, with optional `-rc.N` only
  for integration candidates. Tags are annotated and immutable.
- Existing `rpg-runtime-*` tags are immutable historical records. Never create
  another tag in that retired namespace.
- The tag workflow is the only supported release path. Repository, tag, tag
  commit, asset filename, and adapter ABI define identity; observed SHA-256 is
  cache-integrity information, not a compatibility identity.
- Do not create `retrom-web-*`, `latest`, `stable`, or other alias tags.

Do not add Retrom host-product logic, third-party game payloads, credentials,
or a distributable TyranoScript engine bundle.
