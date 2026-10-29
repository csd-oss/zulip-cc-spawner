# zulip-cc-spawner

A Zulip bot that spawns, tracks and reaps **Claude Code sessions** ("hands") on command. Each
hand is an interactive `claude` in a detached tmux session with its own Zulip bot identity, talking
to Zulip through the [mcpl-cc-bridge](https://github.com/anima-research/mcpl-cc-bridge) plugin and
[zulip_mcp](https://github.com/antra-tess/zulip_mcp).

A port of [cc-spawner](https://github.com/anima-research/cc-spawner) (Discord) to Zulip. The command
grammar, the tmux handling, the dialog bridge and the transcript watcher come from there; the
control surface, identities, auth and hosting model are Zulip's.

## Commands

Mention the spawner at the **start** of a message in an allowed stream (or DM it):

```
@**CC Spawner** spawn opus-5-5 [name=scout] [effort=high]   # home = this stream + topic
@**CC Spawner** list
@**CC Spawner** stop scout                                   # alias: kill
@**CC Spawner** peek scout [lines]                           # terminal tail, by DM
@**CC Spawner** answer scout 2 | 1,3 | yes | text: … | esc   # a hand blocked on a dialog
@**CC Spawner** press scout 1 enter                          # raw keys, the escape hatch
@**CC Spawner** rescan
```

- **Models** are explicit versions (`opus-5-5`, `sonnet-5-5`, `fable-5-1`, `haiku-4-5`, … or a full
  id). Bare `opus`/`sonnet` are refused: the model is part of the hand's name, so a name must keep
  meaning one model. **Effort** (`low`…`max`, `ultracode`) is validated per model and kept across
  revivals; `effort=default` clears it.
- **Names**: hand `Claude-Code-<model>-<name>`, bot `cc-<model>-<name>-bot@…`, tmux `cc-<model>-<name>`.
- **Revival**: `spawn <same model> name=<same>` brings back the same bot **and** the same
  conversation (`claude --resume`), in the same stream (a new topic is fine).
- **Blocked hands**: a question dialog or permission prompt is posted in the hand's topic; answer
  with `answer`, or in that topic simply `@**CC Spawner** yes` / `2` / `esc`.
- **Reaping**: a hand with no public Zulip activity for 24 h (checked against Zulip before acting)
  is stopped; its identity and conversation are kept. A hand that says nothing for 10 minutes
  after starting gets a warning — it may not be connected.
- Commands sent while the spawner was offline are never run; it says so once per topic.

## How a hand is wired

```
claude --dangerously-skip-permissions \
       --dangerously-load-development-channels plugin:mcpl-bridge@mcpl-bridge-dev \
       --session-id <uuid> | --resume <uuid>  --model <id> [--effort <lvl>]  "<seed>"
  MCPL_BRIDGE_CONFIG=<handDir>/mcpl-bridge.json  → zulip_mcp with the hand's own zuliprc
```

Per hand, in `handsDir/<bot short name>/`: `zuliprc`, `mcpl-bridge.json` (home stream open,
other channels and DMs closed, any mention wakes, ambient traffic held), `zulip-state/` (catch-up
watermarks, kept across revivals) and `seed.md`.

Hands run with `--dangerously-skip-permissions`; who may spawn them is the security boundary
(fail closed). Stream confinement is attention, not a sandbox: a hand's bot can post wherever Zulip
lets it (including streams its owner is in) — see [deploy/SETUP.md](deploy/SETUP.md).

## Run

```sh
npm ci && npm run build
node dist/src/main.js       # first run writes ~/.cc-spawner/config.json (deny-all)
```

Production layout (two OS users, systemd, sudo): [deploy/SETUP.md](deploy/SETUP.md). For a dev
machine set `"devMode": true` (hands run as you and can read your zuliprc files).

State: `~/.cc-spawner/{config.json,registry.json,state.json,spawner.lock}`. Knobs:
`CC_SPAWNER_CONFIG`, `CC_SPAWNER_STATE_DIR`, `CC_SPAWNER_INACTIVITY_MS`,
`CC_SPAWNER_REAP_INTERVAL_MS`, `CC_SPAWNER_WATCH_INTERVAL_MS`.

## Develop

```sh
npm test          # unit + integration (real tmux and shell, a fake `claude`, a fake Zulip)
npm run coverage
```

Requires tmux on PATH for the tests.

## License

MIT — see [LICENSE](LICENSE).
