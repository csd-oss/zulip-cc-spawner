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
- **Names**: new hand `[cc-<model>] <name>`, bot `cc-<model>-<name>-bot@…`, tmux `cc-<model>-<name>`.
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

## New-hand names and workspaces

New hands display as `[cc-<modelSlug>] <name>` (the supplied name's case is
preserved, otherwise four random hex characters). `cc` is the harness label;
this does not add Codex support. Tmux and bot short names remain lowercase
`cc-<modelSlug>-<name>`. Names are bounded to 49 display characters, 40 short
characters and 44 email-local-part characters including `-bot`. These are
local compatibility budgets; actual Zulip server limits are **GUESS**, not
verified against a live server. Full bracket names, legacy names, short names,
and suffixes work with stop/peek/answer.

`workRoot` optionally sets the root for new hands' working directories. Its
default is `<projectDir>/hands`; each hand uses `<root>/<short-name>`, created
empty and mode 0700 as the hand OS user. Keep this root separate from
`handsDir`, which contains credentials and bridge files, not workspace content.
An existing directory is never adopted for a brand-new identity. Revivals keep
the recorded directory and its contents. Neither stop nor the reaper deletes
workspaces, hand files, trust entries or transcripts. Cleanup is manual: only
remove them after stopping the hand and deciding to discard its continuity.

Before launch, the spawner merges
`projects[<absolute workDir>].hasTrustDialogAccepted = true` into
`<agentsHome>/.claude.json`, retaining other keys and atomically renaming a
0600 temporary file. A lock directory serializes cooperating spawns across
processes. A lock older than a crashed process is not automatically stolen:
follow the first-preparation recovery procedure below. Invalid JSON fails closed. Other writers (including Claude itself)
do not honor this lock; avoid concurrent external configuration edits. This
assumes Claude uses the normal agentsHome configuration, not an overridden
`CLAUDE_CONFIG_DIR`/HOME. Bypass-permissions consent still requires a person.

### First-preparation recovery (manual, fail closed)

A failed first preparation (invalid `.claude.json`, lock timeout, or a crash)
can leave an empty workspace **before** `workDirReady` is persisted. Repairing
the JSON or removing the lock alone does not fix this: the retry deliberately
refuses the existing directory, naming its absolute path in the error.

1. Stop the spawner and verify that no other spawner/helper writer is running
   as the hand user. Inspect the registry entries for the exact identity and
   `workDir`, and the hand user's tmux sessions. Proceed only if this is a
   **never-launched, failed first preparation**, no session uses the directory,
   and no history for that directory has `workDirReady: true`. If uncertain,
   retain the directory and investigate; do not reset registry fields.
2. Repair `<agentsHome>/.claude.json` as the hand user, preserving unrelated
   keys (do not replace an existing real config with `{}`). If the lock is
   stale, inspect `<agentsHome>/.claude.json.spawner-lock`. After confirming no
   writer is alive, remove only its leftover `config.tmp`, if present, then
   `rmdir -- '<agentsHome>/.claude.json.spawner-lock'`. Unexpected contents or
   symlinks require investigation, not recursive removal.
3. As the hand user, inspect the **exact workspace path named in the error**:
   check its owner and use `ls -ld -- '<workDir>'` and
   `ls -la -- '<workDir>'` to include hidden files. It must be a real directory,
   not a symlink, owned by the hand user and completely empty. For example,
   after the history/session checks above:
   ```sh
   workdir='/absolute/path/from/the/error'  # replace with the verified path
   test ! -L "$workdir" && test -d "$workdir" && rmdir -- "$workdir"
   ```
   `rmdir` refuses a nonempty directory. Never use `rm -rf`, remove contents to
   make it empty, or delete a previously launched hand's workspace.
4. Restart the spawner and retry the same model/name. It will exclusively
   create a fresh empty directory and prepare trust again. Keep the registry,
   bot identity and hand credential files; do not delete them for this repair.

Legacy registry entries without `workDir`/`nameScheme` keep their old identity,
hand directory and global `projectDir` cwd. Do not change `projectDir` while
legacy hands need their transcripts. Spawn with the same model and suffix to
revive them. Optional fields leave the JSON array readable by the old binary,
but **downgrade is not behaviorally safe**: it ignores new cwd/name metadata.
