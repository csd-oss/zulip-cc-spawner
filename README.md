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
@**CC Spawner** rename scout Pathfinder                      # visible name only; follows creatorOnlyControls
@**CC Spawner** models                                     # also: help models
@**CC Spawner** list
@**CC Spawner** list stopped                                 # creator, home, last activity
@**CC Spawner** delete scout [confirm]                       # preview unless confirm; creator/owner only
@**CC Spawner** stop scout                                   # alias: kill
@**CC Spawner** peek scout [lines] [here]                    # terminal tail, DM unless here
@**CC Spawner** answer scout 2 | 1,3 | yes | text: … | esc   # a hand blocked on a dialog
@**CC Spawner** show scout                                   # read its screen again, post the request in full
@**CC Spawner** press scout 1 enter                          # raw keys (not for prompts: use answer)
@**CC Spawner** rescan
```

`list` and `list stopped` use Markdown tables with columns **hand / model / home /
activity / creator**; stopped hands also have **size** between home and activity.
Homes are clickable Zulip links, activity is relative (minutes, hours or days;
past the first hour the absolute UTC minute follows, e.g. `10 d ago (2026-11-04
09:30 UTC)`; unknown activity is explicit), and each hand occupies one row.
Registry text in cells (names, models, topics, creators) is written with numeric
character references for Markdown-significant characters, because Zulip has no
backslash escapes: pipes, `$$`, `~~`, mentions and links show as plain text. Blank lines before
and after each table let Zulip render it correctly. Redundant generated names
are omitted; ambiguous short names get a copyable command target in parentheses.
`list stopped` shows each stopped hand once, with short command name, creator
(username or user id; unknown for old records), home topic and last activity when
recorded. A failed liveness check is reported per hand (tmux or process check);
other verified stopped hands remain listed. `list` still shows only running hands.

To revive or rehome, use `spawn <model> name=<listed-target>` in the desired home.
This retains the bot, workdir and available conversation rather than creating a
new hand named after the target. Exact model-qualified legacy revivals still work;
unresolved ties refuse without changes. Use the parenthesized target when shown:
it may be a tmux name or a reserved `hand:<encoded-tmux>` address that cannot be
confused with another hand's alias (the `hand:` prefix is reserved in any case,
e.g. `HAND:`; the encoded tmux name is exact). These targets also work with `stop`, `peek`,
`answer`, `press`, `model`, `rename` and `delete`. Hints use the same selection.
New names remain limited to 1–24 letters, digits or hyphens, and cannot overlap
another identity's names, tmux, email or aliases.

`delete <hand>` previews **all launch records** for that hand, its hand directory,
recorded work directory/directories and bot deactivation, without changing anything.
Use `delete <hand> confirm` to permanently remove them. Short names, rename aliases,
display names, bot emails and tmux sessions resolve as for `rename`. Only the
recorded creator or configured `ownerUserId` can delete, **regardless of
`creatorOnlyControls`**; a hand with no creator requires a configured owner.
Normal caller/stream allow-lists still apply. Replies go to the invoking topic/DM.

Deletion requires stopped registry records, no live tmux session and no surviving
hand process. It reuses tmux's absence checks and inspects Linux `/proc` as the
agents user (session ids, command/environment paths and working directories);
unavailable liveness information fails closed. For every enumerated same-uid thread group
(other than the scanning helper itself), the scanner reads leader cmdline,
environ and cwd, lists /proc/<pid>/task, and reads every task's environ and cwd.
A matching marker blocks deletion; any unreadable field or unlistable task
directory remains ambiguous and blocks deletion. Empty argv and zombie state
are not exemptions. Missing fields alone never prove disappearance: only a
stat of the /proc/<pid> directory reporting ENOENT/ESRCH does. Start times are
rechecked to detect PID reuse. Earlier EACCES/EPERM evidence remains ambiguous
even if later reads report disappearance. Diagnostics identify the PID. There is no
user-manager or `(sd-pam)` exemption: even a genuine non-dumpable PAM helper
is ambiguous. Process names and cgroups cannot establish safe exclusion.

A nondumpable zombie of the agents uid can therefore block deletion until it
is reaped. The operator must find its parent (for example, inspect PPid in
/proc/<pid>/status) and have that parent reap it; repair or restart the parent
under the site's operational policy if it is not collecting children. Do not
bypass the check based on a zombie state: a dead leader can have live workers.

Another tmux session's pane ancestry is **diagnostic only**, not an exclusion:
panes can move and descendants can retain a hand's working directory. There is
no second pane inventory used to authorize deletion. Readable target markers
always win. All unreadable same-uid processes remain ambiguous, including
orphans and processes with hidden/broken ancestry. A different cgroup or nested
PID namespace alone is **not** an exclusion. This is a best-effort live snapshot,
not process isolation; concurrent externally launched processes are not prevented.
Processes whose `/proc/<pid>` directory is owned by another uid remain ignored
(the existing ownership rule); root-owned files inside a same-uid process do not
qualify for that rule.

Failures now give Zulip a short cause (`exec ENOENT`, numeric exit code with a
stderr class, `unreadable-process`, `helper-error` with errno/stage, or invalid
response). The spawner's `[liveness]` log records unreadable counts, PID, errno,
read stage, ancestry classification, numeric Uid/Gid, NSpid depth, and Dumpable
when the kernel supplies it. Namespace depth/dumpable are hints, not diagnoses;
modern kernels may omit Dumpable. Cgroup diagnostics report only entry count,
v1/v2 and root/non-root classification, **never cgroup paths or unit names**.
Neither log nor reply includes foreign cmdline, environment, cwd, paths, raw
stderr, or raw exception messages. Missing pane-enumeration evidence cannot
authorize ignoring an unreadable process. Path-helper failures expose only bounded
cause, errno, stage and optional hand-root kind, never child paths. Hosts with unrelated unreadable orphans may therefore
still require operator investigation; diagnostics should explain the ambiguity.

Known limitation (LOW-2): long-lived shared daemons that
inherit a hand's environment/cwd (e.g. a Codex daemon or local tmux server)
can keep that hand classified as running after its session stops. This is
intentionally fail-closed; shared-process attribution is not resolved here.

Both directory paths
must be strictly inside `handsDir` / `workRoot` (default `projectDir/hands`), with
no `..` or symlinks, including links within the trees. Roots and directories shared
with another registered hand are protected. Traversal and removal refuse paths
whose device differs from their configured root's device (including nested
mounts); same-device bind mounts cannot be distinguished by this device check.
Legacy hands without a recorded
`workDir` keep `projectDir`. Missing directories are reported as already absent;
other filesystem failures keep the registry for retry after inspection.

Ordinary recursive deletion requires a path-specific creation attestation for this hand:
the directory's `{dev, ino, nonce}`, plus its own readiness flag.
New folders are created under random names inside `<root>/.cc-spawner-staging/`,
never at their final path. This private directory must be owned by the agents user,
mode 0700, and on the same filesystem as the destination parent (checked via
`st_dev`). It is spawner infrastructure, **not a workspace**: hands must not write
there. Do not share it with other applications. As with the registry, malicious
code running as the same Unix user is outside this isolation boundary.
After exclusive mkdir there, the agents user opens it with O_DIRECTORY|O_NOFOLLOW,
fstats it, and requires an empty directory owned by that user. It exclusively
creates a mode-0600 `.cc-spawner-owner` containing a random 256-bit nonce through
the directory fd. Publication uses Linux `renameat2(RENAME_NOREPLACE)` via a
local **Python 3 + libc renameat2** helper (stdlib `ctypes`; no packages). Node
has no native binding; ordinary rename could overwrite an empty foreign folder,
so there is no fallback. Missing helper/kernel support fails spawn closed.
Inherited directory fds anchor the move. The open fd's device/inode must match
the final path afterward; failed publication records no ownership and cleans
only the private staging entry, never an unverified public replacement.
Revival and cleanup require both the opened directory identity
and marker nonce to match; inode reuse alone grants no authority.
The hidden marker is metadata, not a workspace input or credential: leave it in
place. It does not change the workspace cwd, uploads, trust settings or transcript
paths. Git may show it as untracked; add `.cc-spawner-owner` to the workspace's
`.git/info/exclude` after initializing a repository if desired. Ordinary spawn → stop → delete removes it with both folders.
Status, the other directory's flag, and readiness alone
never prove ownership. Rename/rehome/revival cannot mint a creation attestation
for an existing directory. Workspace revival refuses to adopt an unattested
directory, with one exception below; an existing unattested hand directory stays
explicitly unproven. Moved-aside originals are never searched for or removed.

**Pre-attestation workspace revival.** A hand created before workspace attestation
has registry history for its tmux name with this exact `workDir`,
`workDirReady: true` and no `workDirIdentity`. `spawn … name=<hand>` adopts that
workspace once, as the agents user, only if it is exactly
`<workRoot>/<tmux-name>`; every path component is a non-symlink and the path is
canonical; the directory is owned by the agents user, on `workRoot`'s device and
with no mount at or below it; it is neither a configured root (`projectDir`,
`handsDir`, `workRoot`) nor an ancestor of one; and it neither equals, contains
nor sits inside another hand's recorded handDir/workDir/seed (by path,
canonical path or inode). The marker is created exclusively: a folder that
already has `.cc-spawner-owner` is refused. The folder is set to mode 0700, as
the pre-attestation spawner did on every preparation. Adoption is recorded as
`workDirAdoption` (`{dev, ino, nonce}`), never as `workDirIdentity`; later
revivals require it to match, so a swapped folder is refused, not re-adopted.
No legacy record, a record for another path, or any recorded identity for this
path (matching or not) still refuses. A legacy hand without a recorded `workDir`
keeps using `projectDir` and is never adopted.

**Delete consequence:** adoption proves continuity, not creation, so it grants no
deletion authority. Ordinary `delete` still keeps a non-empty adopted workspace
(**kept: not created by this hand**; the marker alone makes it non-empty).
`delete … force-legacy` stays available to admins for such a hand, with the
same exact-path checks, preview token and recursive removal as before adoption.
(Exception, unchanged rule: if the legacy handDir was missing and revival created
a fresh attested one, the history now has a creation attestation, so
force-legacy refuses; ordinary delete removes that handDir and keeps the workspace.)
If preparation fails after adoption (e.g. invalid Claude config), the helper
removes its own marker again. If the spawner crashes before recording the
adoption, the next revival refuses because the marker exists; inspect the folder, then remove only
`.cc-spawner-owner` to retry. An older spawner binary ignores
`workDirAdoption`, so it again refuses to revive and treats the hand as legacy.

All existing hands from before this change lack attestations: their non-empty
directories are kept and require manual cleanup. Unattested or identity-mismatched
directories are only eligible for non-recursive rmdir when empty; otherwise
preview and result report **kept: not created by this hand**. A failed file write
never establishes hand-directory readiness.

Only bots positively recorded with `botCreatedBySpawner: true` are deactivated;
old/adopted bots without this provenance are kept (the preview says so). New
spawns record provenance and revivals preserve it. If bot deactivation fails,
local cleanup still completes and the reply asks for manual deactivation. Deleting
again reports **not found**. Transcripts outside these directories and global CLI
configuration are not removed. This is not `stop`: deletion removes revival history.

`peek <hand> [lines]` DMs the terminal tail to you (default 20 lines, range
1–400). Add `here` before or after the line count to reply in the stream and
topic where you issued the command, **not** the hand's home topic. Privacy
trade-off: the screen becomes visible to everyone in that topic and may contain
sensitive terminal output. In a DM, `here` replies in that DM instead.

- **Models** are explicit versions (`opus-5-5`, `sonnet-5-5`, `fable-5-1`, `haiku-4-5`, … or a full
  id). Bare `opus`/`sonnet` are refused so launches do not silently change meaning after a CLI upgrade. **Effort** (`low`…`max`, `ultracode`) is validated per model and kept across
  revivals; `effort=default` clears it.
- **Names**: new hand `[cc-<model>/<effort>] <name>`, bot `cc-<name>-bot@…`, tmux `cc-<name>`
  (Codex uses `cx`). Model/effort changes update only the display name, not email, tmux or workspace.
- **Revival/rehome**: stop the hand, then `spawn <model> name=<same>` in the desired home stream/topic.
  It resumes the same conversation with the same bot and workspace. The bot subscribes to the new
  stream and **keeps the old subscription**; bridge openChannels/filters and the resume prompt use
  the new home. A missing transcript still has the existing explicit lost-context warning.
  A same-engine model change is allowed; Claude↔Codex is refused (start a new hand instead).
  An unchanged model/effort revival leaves the bot's display name untouched, including legacy names.
  Model/effort display-name changes keep the previous full name as an alias.
  Changing model or home (including topic) follows `creatorOnlyControls`: any allowed caller
  by default; creator/owner in strict mode (with the adopted-hand exception below).
  Revival never transfers authorship to the reviver; ordinary command allow-lists still apply.
- **Blocked hands**: a question dialog or permission prompt is posted in the hand's topic; answer
  with `answer`, or in that topic simply `@**CC Spawner** yes` / `2` / `esc`. A permission prompt's
  post is the whole request as the hand's terminal shows it (see *Permission prompts* below);
  `show <hand>` (in its topic: `show`) reads the screen again and posts what is open now.
  The few prompts the bot cannot tell from a request asked after them are posted with the
  reason and take no answer from here (same section); no post asks for raw keys.
- **Answers**: AskUserQuestion remains collaborative for allowed users. Tool permission
  prompts and raw keys are collaborative by default, restricted with `creatorOnlyControls: true`.
  Model-menu answers also follow `creatorOnlyControls` (open to allowed callers by default).
- **Raw keys** (in streams and DMs; optionally creator/owner-only): `press` uses the `space` keyword for spaces; literal text starting with
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

The production sudoers file (`deploy/sudoers-cc-spawner`) requires
`Defaults:cc-spawner !pam_session`, scoped only to the spawner user. On hosts
whose sudo PAM stack starts `pam_systemd` (notably EL9), this is required for
delete to work: otherwise each sudo call can create a user manager and a
non-dumpable `(sd-pam)`, causing liveness to fail closed, including for the
liveness helper's own sudo call.

`!pam_session` also skips `pam_keyinit`, `pam_limits`, `pam_env`, mkhomedir and
session logging for those spawner sudo calls. On Ubuntu this includes sudo's
`pam_limits` and `pam_env` session entries (including `/etc/default/locale`),
even if its stack does not use `pam_systemd`.

With the managed tmux server running, hands are forked by that server under
`cc-agents-tmux.service`, not by the sudo client: hand limits come from the
service. Put required hand environment/locale in `agentsEnvFile`. A missing
server that auto-starts via a sudo client, or custom tmux environment updates,
can change that inheritance.

Direct sudo helpers do not receive those PAM session limits/environment. Source
audit found no requirement for a PAM-set locale or raised limits in the filesystem,
liveness or rollout-discovery helpers: they use explicit byte/UTF-8, JSON or
numeric formats. One existing locale-sensitive assumption remains: tmux-client
absence detection matches English diagnostics (including strerror text). An
unrecognized/localized error fails closed rather than proving absence; this
is not a dependency on PAM loading `/etc/default/locale`. Codex queue explicitly
sources `agentsEnvFile` and sets `HOME`/`CODEX_HOME`; it does not set resource
limits or require a PAM locale in this repository. The external Codex binary and
operator env-file contents are not covered by that source audit. If those need
specific locale or limits, provide/verify them explicitly in the direct-helper
execution context; the tmux service's limits do not apply to direct helpers.

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
npm run test:integration # CC_SPAWNER_INTEGRATION=1; includes fake-CLI/real-tmux tests
```

Default `npm test` explicitly disables integration, even if the opt-in environment
variable is inherited. `npm run test:integration` enables it with
`CC_SPAWNER_INTEGRATION=1`. The integration tests require tmux on PATH;
they use isolated sockets and fake CLIs, never a deployed spawner.

## License

MIT — see [LICENSE](LICENSE).

## New-hand names and workspaces

Effort labels are `min`, `low`, `med`, `h`, `xh`, `max`, and `u` (ultra/ultracode); `d` means no explicit effort.

New hands display as `[cc-<modelSlug>/<effort>] <name>` (the supplied name's case is
preserved, otherwise four random hex characters). `cc` is the Claude harness label
(`cx` for Codex). Tmux and bot short names are model-independent lowercase
`cc-<name>` / `cx-<name>`. Names are bounded to 49 display characters, 40 short
characters and 44 email-local-part characters including `-bot`. These are
local compatibility budgets; actual Zulip server limits are **GUESS**, not
verified against a live server. Full bracket names, legacy names, short names,
and suffixes work with stop/peek/answer.

`rename <hand> <new-friendly-name>` works on running or stopped hands and follows
`creatorOnlyControls`: any allowed caller by default, creator/owner in strict mode
(with the adopted-hand exception below). Names use 1–24 ASCII letters,
digits or hyphens; the whole persona must fit 49 characters. It PATCHes only
the Zulip full name: bot email, tmux session, handDir, workDir,
`ZULIP_SESSION_ID`, and conversation id never change. Provisioning hands and
names/aliases reserved by another hand are refused. The new name and all old
names resolve to that same hand for stop/peek/press/model and `spawn … name=…`
(including revival/rehome); `list` shows the new name. Model/effort changes keep
the custom friendly name. For example, after `rename scout Pathfinder`, either
`spawn opus-5-5 name=Pathfinder` or `spawn opus-5-5 name=scout` revives it.
Rename checks every resulting name/alias, including the fixed suffix and tmux
session, against other hands' reserved names; pre-existing overlaps can therefore
prevent a rename. Spawn resolves exact/legacy/history identities before rename aliases.
Registry metadata is additive and optional (`friendlyName`, `nameAliases`);
old registries load without migration, and history entries are not rewritten.
Older spawner versions can still load/save the JSON, but do not implement the
new aliases or rename-aware revival. Read compatibility is not a guarantee that
an older binary can manage renamed hands.

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
can leave a workspace containing only its owner marker **before** `workDirReady` is persisted. Repairing
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
   not a symlink and owned by the hand user. If its only entry is the regular
   `.cc-spawner-owner` file from this failed preparation, inspect and remove that
   file manually first. Never remove other contents to force recovery. The
   directory must then be completely empty. For example,
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

### Hand attachments

Hands can attach local files as `work/<relative-path>` instead of sending base64.
Their Zulip MCP server exports only `ZULIP_UPLOAD_ROOTS=work=<absolute workDir>`;
revival/rehome keeps the recorded workspace. Private `handsDir` files (including
`zuliprc`) are not exported. Legacy hands with no recorded workspace have no
upload root; overlapping private/workspace paths are also left unexported.

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

## Control configuration and upgrade notes

- `creatorOnlyControls` is a boolean, default **false**: any caller allowed to use the
  spawner may `rename`, switch models live, answer model menus, `press`, answer permission
  prompts, and revive with another model or home topic/stream. Set **true** to restrict
  those controls to creator/owner (with the adopted-hand exception below).
- `ownerUserId` is optional: omitted or `null` means **no owner**, never implicit user 9.
  Set a positive Zulip user ID explicitly if an operator needs owner powers.
  Upgrading from the earlier PR #8 build: set `creatorOnlyControls: true` and an explicit
  `ownerUserId` to retain its restrictive policy; allow-lists still apply to the owner.
- `adminUserIds` is an optional array of positive Zulip user IDs for **force-legacy
  only**. When omitted, it falls back to `ownerUserId` for existing configs.
  An explicit list replaces that fallback (even the owner must be listed);
  `[]` disables force-legacy. It grants no other creator/owner powers and does
  not bypass caller/stream allow-lists. No owner is required when a list is set.
- Upgrade note: rename/model now follow `creatorOnlyControls`, too. They are open to
  allowed callers by default; enable strict mode to retain creator/owner-only controls.
- Upgrade note: a permission prompt already pending during upgrade will be reposted
  if it's still on screen at the next sweep or `rescan`. Answers against the old
  signature are refused until the replacement is posted; a failed post is retried.
  A repost doesn't mean the prompt was answered.
- Upgrade note (pane size): new and revived Claude hands start in a terminal of
  `paneRows` rows (default **50**; `paneCols` columns if set, else tmux's
  `default-size`, 80). Hands already running keep their 80×24 until a prompt does
  not fit it; then they are resized as described below. Codex hands are unchanged.

### Permission prompts

A permission prompt of a Claude hand is answered from Zulip wherever the bot can
show the whole request and can later tell that the screen still shows *that*
request. Two rules decide it:

> **A key is sent only to a prompt that the hand's screen shows from its title
> down, and only while the screen shows the very request that was posted — not
> one that merely reads the same.**
>
> **Where the bot cannot tell, it sends nothing:** it posts what is on screen
> and says why it takes no answer.

- **The hand's own pane, and no other.** A hand's tmux session can hold more
  than the hand: someone attaches, splits the window, starts another program —
  another Claude Code session, even — and leaves that pane selected. The bot
  does not read or key "the session" (which is whichever pane was selected
  last). It asks tmux what each pane of the session was started with, takes
  the one started with the hand's conversation id (`--session-id <id>` /
  `--resume <id>`, as the launcher starts it) for the hand's, and reads, sizes
  and keys that pane **by its pane id** — the list and the screen come from
  one tmux command, and the key goes to the id that was read. That holds for
  prompts, questions, `show`, `rescan`, `peek`, `press` and the live model
  switch. A post of a prompt is for the pane it was read from: if the hand
  later turns up in another pane (restarted by hand with `--resume`), the
  prompt there is posted anew, marked ♻️, and the earlier post takes no
  answer. The bot reads nothing and sends nothing — an answer is refused with
  the reason, and the hand's topic is told once that its prompts are not
  relayed until this is put right — when it cannot tell the pane, or cannot
  key it alone: no pane of the session was started for the hand (its pane is
  gone while the session lives on, or it was restarted without that id); its
  program has exited; several panes were started for it; or its window has
  tmux's `synchronize-panes` on, which would hand every key to all panes of
  the window. (Codex hands have no dialogs bridged; their `peek` and `press`
  go to the session as before.)
- **The pane is fitted to the prompt.** A prompt taller than the hand's terminal
  (the pane then starts in its description, inside its command box, or under it),
  one on a pane someone made small, or a subagent's prompt whose title is one row
  off screen, used to be posted once "for the terminal". Now the spawner makes the
  pane taller — twice its height per step, from `paneRows` up to `paneMaxRows`
  (default 1000) — until the title is on screen; Claude Code redraws the whole
  prompt, and from there it is read, posted and answered like any other. Only the
  height changes, so a request reads the same before and after: the hand's
  *window* is given more rows, its width is never set, so in a window someone
  has split the panes beside the hand's keep their width (panes stacked above
  or below share the added rows). Once no dialog is open the pane goes back to
  `paneRows` — a window that was split when it was grown goes back to the
  height it had. Nothing about the hidden rows is taken from the transcript or
  assumed: they are put on screen. (tmux keeps a window that was resized this
  way at the size it was given: someone attaching to such a hand sees it at
  that size, not at their terminal's.)
- **The post is the request, to the letter.** It is what the terminal shows from
  the title to the question; nothing in it comes from the transcript, and no row
  is altered to fit: the rows are in a code block fenced with more backticks
  than any run of them in the request. A long request takes several messages,
  each sized with everything that goes around its rows, so none is cut. More
  than two messages' worth is posted as its first and last rows with a count of
  what is between; `show <hand>` posts all of it, and only then is an option
  passed on — until then only `esc` is. So an approval is never for rows nobody
  was shown. (A request with a row too long for a message cannot be shown whole
  and takes no approval at all.)
- **Which request it is.** The rows of two requests can be the same, so rows
  alone do not say that the request on screen is the one that was posted. What
  does:
  1. *One pending call.* A Bash prompt is tied to a pending `tool_use` of the
     hand's transcript when that call is the **only** one fitting everything the
     dialog displays — its command, its description, and the hand's own title
     ("Bash command", with "2 of 3" when requests queue; in the screen-reader
     layout the heading "Bash command" or "Bash command 2 of 3"). The request is that
     call's: its id plus the rows from the title to the end of the command box.
     The countdown under it is no part of that, so it neither reposts the
     prompt nor stales an answer. Only the hand's own Bash requests are tied.
  2. *Its rows* — for a prompt no call is tied to, with **no countdown**, on
     its plain option list: a subagent's prompt ("Bash command · from the
     general-purpose agent", never tied to the hand's own calls), another
     tool's, or one whose transcript cannot be read. This is as it was before;
     two such requests that read the same are one request to the bot.
  The place in the queue that a title shows ("1 of 2") is one of the rows — a
  changed place is a changed screen, and reposts the prompt — but it is not
  the request's own: it is Claude Code's running count of requests settled and
  open, subagents' among them, and starts over when none is open. It never
  tells two fitting calls apart.
  The title is proven when the rule that opens the dialog is on screen; or when
  the screen's first row is a Bash prompt's title above a whole command box —
  known as the title by how the terminal sets it (the words "Bash command" in
  bold, read with `tmux capture-pane -e`), not by its words: a description may
  read "Bash command" while the real title, naming a subagent, is one row off
  screen. Resizing a hand's pane sideways re-wraps the box and reposts the
  prompt once.
- **What takes no key**, because the bot could not tell the request from one
  asked after it:
  - *several pending calls fit* (the same command and description twice in one
    turn). In an unattended session they are asked one after the other under
    the same title, the first still pending while the second asks; with
    permissions asked for, as "1 of 2" and "2 of 2". When only one of them is
    left pending, that request is posted anew and takes its answer;
  - *a prompt under Claude Code's countdown that no pending call identifies*:
    the hand's transcript cannot be read, or the prompt is not one of its own
    Bash requests. Its rows change every second, and the clock cannot stand in
    for them — see below. (In our runs of 2.1.306 / 2.1.323 under bypass, the
    prompts that carried a countdown were the hand's own Bash safety checks; a
    subagent's prompt had none, and writes to settings or hook files were not
    asked about at all);
  - *a prompt in its text field (after Tab at the terminal) or in the
    screen-reader layout that no pending call identifies.* Those take an answer
    in two keys, and each key needs the request identified afresh;
  - a prompt that does not fit `paneMaxRows` rows, or whose pane tmux will not
    resize; one that takes its answer in a way not known to the bot; and a
    screen-reader prompt with rows between the request and its question that
    the bot does not know from that layout (it knows the expiry notice and
    "/permissions to update rules") — its post says that, not that the
    terminal is too short.
  Such a prompt is posted **once**, as far as the screen shows it, with the
  reason, and is not repeated while it reads the same but for its countdown's
  clock. `show <hand>` reads it again. The post is a notification; no answer —
  `esc` included — is passed on to it. It can be answered at the hand's
  terminal; under a countdown Claude Code refuses it by itself; otherwise the
  hand can be stopped.
- **A countdown never proves it is the same request.** In an unattended session
  Claude Code refuses a request by itself after about two minutes ("will
  automatically block this request in 1:42"); the post gives that time
  (`⏳ … <time>`). Two requests asked a moment apart end a moment apart
  (measured: 130 ms), and the screen-reader layout counts in "about 2 minutes",
  so an agreeing clock says nothing. It is used the other way only: a countdown
  that ends at another time than the posted one (more than 3 s off), reads more
  minutes than it did, or is there where the post had none, belongs to a
  request asked again — nothing is sent, and that request is posted. This
  holds for every prompt, a tied one included. (A prompt under a countdown that
  was posted by an earlier release is therefore posted anew once.)
- **An answer is held to the post it answers:**
  1. *The screen.* The transcript is read, **then** the screen is captured, and
     nothing else is read between that capture and the key. The capture must
     show the posted request; else no key is sent and **the request that is on
     screen is posted in its place**. The same if the prompt is gone (answered
     at the terminal, or expired): nothing is sent, and the reply says so.
  2. *The order of messages.* An answer whose Zulip message is older than the
     post of the dialog now open (its last message, when there are several)
     was written looking at an earlier one — it waited behind a sweep, or
     behind another answer whose refusal posted the new dialog. It is refused,
     whether the dialog now open is a permission prompt or a question.
  3. *One post, one answer.* Once the first key of an answer from Zulip went to
     a post, a further answer to that post is refused — whatever was sent to
     the hand since, raw `press` keys included. If a prompt is open then — the
     same one because the key did not take, or a next one — it is posted as a
     request of its own (at once on such an answer, else at the next sweep).
  4. *The run that posted it.* A post of a permission prompt takes an answer
     only from the spawner process that made it. After a restart — an upgrade,
     a crash, a deploy — every such post still in the registry is void: it was
     made under the rules of whatever build posted it (an earlier release cut
     the middle out of long requests and changed their backticks), and a
     process that died may have sent a key on it without getting to record
     that. A prompt still open is posted anew — at the first sweep, or at once
     if an answer comes in before that — marked ♻️ ("This replaces an earlier
     post of this request…"), and that post is the one to answer. Nothing is
     written to disk between the look at the screen and the key for this: a
     post is simply never answered by a process that did not make it. So after
     every restart each open, answerable permission prompt appears once more
     in its topic. (A notification that takes no answer anyway is not
     repeated, and multiple-choice questions are answered across restarts as
     before.)
- **How the answer is given** is read off the screen too, and a key that would
  mean something else is never sent:
  - the option list (footer "Tab to amend"): the digit selects and submits;
  - the same list after someone pressed Tab at the terminal (its first row
    reads "Yes, and tell Claude what to do next", or its last "No, and tell
    Claude what to do differently" — a digit would be typed into that field):
    the post says so; an answer sends Tab, **reads the screen again**, and sends
    the digit only if it shows the same request back on its option list. What
    was typed in the field is dropped;
  - the screen-reader layout ("Select with numbers … Then Enter"): the digit is
    typed, the screen is read again, and Enter is sent only if its input field
    shows exactly that digit under the same request. Anything already typed
    there is deleted first, one character at a time: each backspace goes out
    only after the screen was read again and shows the same request with the
    field one character shorter. (A field with blanks in it cannot be counted
    from the screen; such a prompt takes no key.)
  The last two are done only for a request a pending call identifies (1
  above). "The same request" at the second look is that call again — and no
  expiry notice that the prompt the first key went to cannot have: a key makes
  the notice go away, so one that is there afterwards and was not before
  belongs to a request asked meanwhile. If a step does not get there, the
  answer stops — what went out is a Tab, a backspace or an unsubmitted digit,
  never a choice — the reply says which keys went, and what the screen shows
  is posted as a new request.
- **What is not covered.** Capture and key are two steps: a prompt that changes
  in the instant between them gets the key (nothing else is done in that
  instant). An answer sent after a new post appeared counts as an answer to
  that post, wherever it was written — the bot answers *the latest post*, it
  cannot know which one its sender was looking at. The pending calls are as the
  transcript had them just before the screen was captured: a transcript that
  stays behind through a whole turn of the model would let a request tied to a
  call pass for a later, identical one (the countdown check above is what is
  left then). Two prompts with no countdown and no fitting call that read the
  same are one request, as they always were. The hand's pane is told by what
  tmux started in it: a pane someone respawned with another program under the
  hand's own command line would pass for it. A hand's pane that someone has
  put in tmux's copy mode takes the key into that mode, not into Claude Code:
  the post is spent and the prompt posted anew. (The start-up screens of a
  launch are answered in the session as it was just created: one pane.)
- `press` is not part of any of this: it sends raw keys — to the hand's own
  pane — with no check of what is on screen, and no post or reply suggests it
  for a prompt.
- "Answer sent" confirms the key, not the outcome. If the bot cannot look at the
  screen after sending, or cannot save its record of what it sent, it says so
  on the "Answer sent" reply — the key is out, do not send it again. It reports
  "Could not deliver" when no key was sent — or when tmux failed on the very
  first key, where it cannot know: the reply then says the key may still have
  reached the terminal, and that post takes no further answer — and "Only part
  of the answer reached …" when an answer given in steps stopped before the
  key that submits.
- Adopted hands without `spawnedBy` never acquire the reviver as creator. With no owner
  configured, all these controls (including rename/model) remain collaborative **even
  in strict mode**, so they are not stranded. With an owner configured and strict mode enabled,
  only that owner may use their restricted controls. No registry authorship is fabricated.

## Live model switching

`model <hand> [<model>] [effort=...]` works without stopping a live hand and follows
`creatorOnlyControls`: any allowed caller by default, creator/owner in strict mode
(with the adopted-hand exception above). Use an explicit version/id or a
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
  Model-menu answers follow `creatorOnlyControls`, just like `model`; any authorized
  caller can retire an expired snapshot after five minutes. A pending terminal question takes
  precedence over (and discards) the closed model snapshot when answered;
  ordinary questions remain collaborative; permission prompts follow `creatorOnlyControls`.
  The
  menu is reopened and the named choice reverified. `answer <hand> esc` cancels.
- Unexpected screens/timeouts cause Escape cleanup, an error report, and **no
  registry model/name update**. If a confirmation was sent but success could not
  be observed, inspect `peek`: the terminal may have applied it despite the
  missing acknowledgement. Do not assume an unconfirmed terminal was rolled back.

Existing `bracket-v1` and `Claude-Code-*` identities keep their old email, tmux,
handDir and workDir. Exact historical names still resolve; changed models use a
unique historical suffix. Ambiguous distinct historical identities are refused
rather than guessed, and unmarked bracket-name collisions stay fail-closed.

### Legacy cleanup and stopped-hand inventory

`delete <hand> force-legacy` is **configured `adminUserIds` only** (with the
legacy owner fallback described above; the
normal caller/stream allow-lists still apply). It does not immediately delete:
The old `delete <hand> confirm force-legacy` preview spelling still works.
It previews exact directory paths and bot user IDs, then supplies a separate
`delete <tmux-name> confirm force-legacy <token>` command. The token expires in
five minutes, is single-use, and is invalidated by registry/configuration or
directory-identity changes. A restart loses pending confirmations. An ordinary
delete confirmation does not authorize this override.

This override is only for histories without directory creation attestations
(`handDirIdentity`/`workDirIdentity`); a revival-time `workDirAdoption` does not
count as one and is not consulted. It never creates ownership markers or changes provenance. It recursively removes only
the exact `<handsDir>/<tmux-name>` and recorded `<workRoot>/<tmux-name>` paths.
Nonstandard historical paths are refused, not guessed. A missing legacy workDir
means shared `projectDir`: it is shown and kept. Configured roots, paths overlapping
another registered hand's explicit handDir/workDir, shared
bots, symlinks and mount boundaries are refused. Refusals show the proposed paths,
bot IDs and reason; no registry removal or bot deactivation occurs. Both canonical
paths and filesystem identities are checked for aliases. The strict PR #11
liveness checks still apply, including processes whose cwd is exactly the implicit
projectDir (not unrelated descendants). The implicit projectDir remains a protected
root, never a removal target.
As with ordinary deletion, this is not isolation against a privileged actor
concurrently changing mounts/filesystems or starting new processes. Bot API
failure is reported for manual retry; filesystem failure retains the registry.

`list stopped [mine|by=<user-id>|by=unknown] [by size]` shows work-dir sizes.
Examples: `list stopped mine by size`, `list stopped by=9`, and
`list stopped by size by=unknown`. Filters use the current record's recorded
creator, never an inferred reviver; unknown creators are excluded from `mine`
and numeric filters. User IDs, not ambiguous display names, are accepted.

Sizes are displayed in decimal **MB**, switching to **GB at 1,000 MB**, with
at most two decimal places (for example `840 MB` or `≥840 MB (partial/unknown)`).
Partial lower bounds are rounded down. Sorting still uses unrounded bytes.
Sizes measure **apparent regular-file bytes**, including hidden files, deduplicating
hardlinks within each workDir (not allocated disk usage). Legacy projectDir is
labelled shared. Measurement runs as the agents user, does not follow symlinks
at any path component, and stays on the starting device. It streams directory
entries and stops at 10,000 entries, 100 levels or roughly 100 ms per unique path,
with a two-second aggregate scan budget and a three-second worker watchdog.
Unreadable, missing, changing or budget-exhausted paths show a partial/unknown
lower bound, never a falsely exact zero. `by size` sorts measured bytes descending;
partial results may underestimate large repositories. Duplicate paths are scanned
once per listing. Existing strict stopped/liveness verification is unchanged and
can add its own latency; the size scan does not weaken it.
