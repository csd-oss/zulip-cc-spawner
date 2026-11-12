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
@**CC Spawner** model scout [opus-5-5] [effort=medium]    # live switch; omit model to list
@**CC Spawner** models                                     # also: help models
@**CC Spawner** list
@**CC Spawner** stop scout                                   # alias: kill
@**CC Spawner** peek scout [lines]                           # terminal tail, by DM
@**CC Spawner** answer scout 2 | 1,3 | yes | text: … | esc   # a hand blocked on a dialog
@**CC Spawner** press scout 1 enter                          # raw keys, the escape hatch
@**CC Spawner** rescan
```

- **Models** are explicit versions (`opus-5-5`, `sonnet-5-5`, `fable-5-1`, `haiku-4-5`, … or a full
  id). Bare `opus`/`sonnet` are refused so launches do not silently change meaning after a CLI upgrade. **Effort** (`low`…`max`, `ultracode`) is validated per model and kept across
  revivals; `effort=default` clears it.
- **Names**: new hand `[cc-<model>] <name>`, bot `cc-<name>-bot@…`, tmux `cc-<name>`
  (Codex uses `cx`). Model changes update only the display name, not email, tmux or workspace.
- **Revival/rehome**: stop the hand, then `spawn <model> name=<same>` in the desired home stream/topic.
  It resumes the same conversation with the same bot and workspace. The bot subscribes to the new
  stream and **keeps the old subscription**; bridge openChannels/filters and the resume prompt use
  the new home. A missing transcript still has the existing explicit lost-context warning.
  A same-engine model change is allowed; Claude↔Codex is refused (start a new hand instead).
  Missing historical authorship stays unknown on revival (only the owner may rehome/re-model it).
  Changing home (including topic) or model requires the original creator (`spawnedBy`) or
  `ownerUserId` (default **9**); ordinary command allow-lists still apply. Revival never transfers
  authorship to the reviver. `allowedUsers` is not an ownership list: not everyone allowed to drive
  the spawner should be allowed to rehome other people's hands.
- **Blocked hands**: a question dialog or permission prompt is posted in the hand's topic; answer
  with `answer`, or in that topic simply `@**CC Spawner** yes` / `2` / `esc`.
- **Answers**: AskUserQuestion remains collaborative for allowed users. Tool permission
  prompts require the hand’s creator or owner, as do raw keys and model-menu answers.
- **Raw keys** (creator/owner only, in streams and DMs): `press` uses the `space` keyword for spaces; literal text starting with
  `-` or `--` works too, e.g. `press scout /codex:review space --base space main enter`.
  Sends are sequential, not atomic; on failure the reply lists the completed keys and recovery options.
- **Reaping**: a hand with no public Zulip activity for 24 h (checked against Zulip before acting)
  is stopped; its identity and conversation are kept. A hand that says nothing for 10 minutes
  after starting gets a warning — it may not be connected. Messages during startup count;
  pre-launch messages do not, even if delivered late. Spawn time is rounded down to
  Zulip's seconds so same-second startup posts count. Activity uses message time,
  never moves backwards, and reactions count by receipt time only while alive.
  Event and history message times may be at most 60 seconds ahead of local receipt
  time (clock-skew tolerance); non-finite or further-future times are ignored for
  both startup proof and activity, rather than extending a hand's idle lifetime.
  Zulip is checked before warning, and a failed lookup is logged and retried next sweep
  rather than treated as silence.
- Commands sent while the spawner was offline are never run; it says so once per topic.

## Models and effort

`models` (or `help models`) lists aliases → full model ids, CLI, allowed efforts,
and default behaviour. `gpt-*` selects Codex; other ids select Claude. Override
with `engine=codex|claude`. Codex hands are named `[cx-<model>] <name>`.

Thin-portal rule: pass through what the CLI accepts or rejects loudly; refuse only to prevent a silent downgrade, never impose guessed limits.

All Codex models accept the portal vocabulary `minimal`, `low`, `medium`, `high`,
`xhigh`, `max`, and `ultra` for pass-through, including listed models, unlisted
models and arbitrary ids with `engine=codex`. Codex decides model compatibility;
local packaged CLI/help does not establish unsupported-effort behavior.
`models` shows relayed capability data (upstream codex PR #761, not independently
verified) as **advisory only**: Astra/Sol/Terra up to ultra, Luna up to max,
and 5.5/5.4-mini up to xhigh. Higher vocabulary efforts are still passed through.
`ultracode` is Claude-only. For example: `spawn gpt-5.5 name=scout effort=ultra`.
Claude's existing rules are unchanged: they are documented as preventing silent
CLI fallback; consult `models`.
There is no default model. `effort=default` clears any stored effort and lets
the CLI choose (no override); omitting effort inherits it on revival.

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
npm test          # offline unit tests; no real Zulip/tmux/Claude/Codex
npm run typecheck
npm run coverage
# Optional, only where live local tmux is permitted (NOT run for TASK-GJ15G):
CC_SPAWNER_INTEGRATION=1 npm test # also runs legacy fake-CLI/real-tmux integration tests
```

Default tests do not need tmux. The opt-in integration tests require it on PATH;
they use isolated sockets and fake CLIs, never a deployed spawner.

## License

MIT — see [LICENSE](LICENSE).

## New-hand names and workspaces

New hands display as `[cc-<modelSlug>] <name>` (the supplied name's case is
preserved, otherwise four random hex characters). `cc` is the Claude harness label
(`cx` for Codex). Tmux and bot short names are model-independent lowercase
`cc-<name>` / `cx-<name>`. Names are bounded to 49 display characters, 40 short
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

## Codex hands

`spawn gpt-5 name=scout effort=high` infers Codex; Claude remains the default
for other models. `engine=codex` or `engine=claude` overrides inference.
Codex identities use `[cx-<model>] <name>` (the existing bounded model slug).
Set optional `codexBin` to the agents user's Codex executable; default: `codex`.
Use the deployed **0.163.0** pin. The supplied dispatch brief confirms that
version's `queue --thread/--message` and `resume [SESSION_ID]` help.
Offline verification here used installed 0.166.0 help only; no model/gate calls.

Hands use the same isolated working-directory allocation under `workRoot`
(deployment: `/home/cc-agents/workspace/hands/<short>`), not their credential
directory. Codex does not write Claude trust settings. Startup accepts directory
trust, the existing-model option, and press-enter prompts; login fails with an
operator message, and startup times out after 90 seconds.

The existing agents user's `~/.codex/config.toml` supplies provider/base URL
(including the deployment gate's `/codex` route). No URL or token is hardcoded.
Model and optional effort are passed on every launch, including resume.
MCP overrides are per invocation; no Codex config edits. The same `nodeBin`,
`zulipMcp`, and five `ZULIP_*` transport variables as Claude's bridge are
reused directly in **plain MCP** mode (`MCPL_ENABLED=false`). Codex does not
forward arbitrary parent environment variables to MCP children: we explicitly
pass these variables and HOME; do not rely on agentsEnvFile variables, PATH,
MCPL_BRIDGE_CONFIG, or model credentials reaching that child. Prefer absolute
nodeBin/zulipMcp paths. MCPL push/channel features are not used in this mode.

The spawner must be subscribed to each home stream. It fetches each candidate
message **as the hand's bot**, using Zulip's authoritative `mentioned` flag
(the spawner's own flag is not evidence). Only non-self mentions in the home
stream/topic wake Codex, including mentions from bots; DMs/ambient traffic do
not. Sender, topic and message are queued using execFile argv, never evaluated
as shell text. Addressing checks use a separate bounded intake retaining the newest 20 pending
candidates; overload and lookup failures are console-only. Only confirmed mentions
consume wake capacity. Per-hand wake queues serialize, space attempts by one second,
and cap backlog at 20. Public failures (including addressed overflow) use fixed
text, coalesced to at most one per hand per minute with no concurrent notices;
details are console-only.
Offline messages are not replayed by the spawner. The hand can fetch backscroll.

New rollouts must match launch time and canonical cwd; ambiguity is refused.
Discovered session ids persist in the registry. Revival uses `codex resume <id>`
with the same model/workdir/MCP. Without an id it starts fresh and says so; an
unavailable id disables mention-wake. Known ids are not silently replaced on
resume failure. Stop, peek (private), and press still use tmux. Claude-specific
transcript/dialog parsing is skipped for Codex; use peek/press for its dialogs.

### Risks

Codex runs with **--dangerously-bypass-approvals-and-sandbox (YOLO)**.
This is not a sandbox. Hands share the agents Unix user, ~/.codex authentication,
and one subscription's limits. Credentials/tokens may be persisted in Codex
state/WAL; protect the entire agents home and backups, not just config.toml.
No new sandbox is installed. Bubblewrap was not on PATH in this implementation
environment; host availability must be checked by the operator.

Codex spawn/revive snapshots an inclusive home-topic message-ID boundary: catch-up may answer only still-unanswered mentions at or below it; newer mentions are delivered only by the spawner queue, buffered until startup completes. Earlier conversation requests are not re-admitted from backscroll; Claude catch-up is unchanged.

## Live model switching

`model <hand> [<model>] [effort=...]` works without stopping a live hand, with the
same creator/owner authorization as rehome. Use an explicit version/id or a
supported Claude alias. The session, Zulip bot, workspace and persona are kept.
After a confirmed change the admin client PATCHes `/bots/<id>` with `full_name`;
rename failure is a warning, not a model rollback.

- Claude: sends `/model <id>`, checks that “Switch model?” names the requested
  model, confirms Yes, and waits for “Set model to …”. Claude may save the model
  as the CLI default; the spawner deliberately leaves that alone and still passes
  `--model` on **every** launch. Live Claude `effort=` changes are refused: use
  stop/spawn for those; omitting effort preserves the recorded launch setting.
- Codex: opens `/model`, matches the **visible display name** (case/spaces/dashes
  normalized, never hard-coded model ordinals), chooses reasoning effort or the
  menu default, and presses **s** to apply **for this session only**. Explicit
  efforts must be on screen (max/ultra can use “More reasoning…”); config.toml
  is not edited. The confirmed reasoning level is recorded for future launches.
- With no model, or when it is absent from the visible menu, options are posted
  to the hand's **home topic**. A ↓ is reported as more off-screen entries, not
  treated as a complete inventory. The menu is closed immediately; reply via
  `answer <hand> <number>` or a bare spawner-mentioned number in that home topic.
  Only creator/owner may answer, snapshots expire after five minutes, and the
  menu is reopened and the named choice reverified. `answer <hand> esc` cancels.
- Unexpected screens/timeouts cause Escape cleanup, an error report, and **no
  registry model/name update**. If a confirmation was sent but success could not
  be observed, inspect `peek`: the terminal may have applied it despite the
  missing acknowledgement. Do not assume an unconfirmed terminal was rolled back.

Existing `bracket-v1` and `Claude-Code-*` identities keep their old email, tmux,
handDir and workDir. Exact historical names still resolve; changed models use a
unique historical suffix. Ambiguous distinct historical identities are refused
rather than guessed, and unmarked bracket-name collisions stay fail-closed.
