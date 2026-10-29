# Setting up a host

A Linux box (systemd, tmux ≥ 3.2, Node ≥ 20) with two OS users:

| User | Runs | Holds |
|---|---|---|
| `cc-spawner` | the daemon (`cc-spawner.service`) | the spawner bot's zuliprc, the bot owner's zuliprc, the registry |
| `cc-agents` | every hand (`cc-agents-tmux.service`) | the hands' bot keys, the shared model credentials, transcripts |

`cc-spawner` may act as `cc-agents` through sudo; `cc-agents` gets no sudo and no `docker`
group. The owner's API key never reaches a hand.

## 1. Users and sudo

```sh
useradd -m -s /bin/bash cc-spawner
useradd -m -s /bin/bash cc-agents
chmod 0700 /home/cc-spawner
install -m 0440 deploy/sudoers-cc-spawner /etc/sudoers.d/cc-spawner && visudo -cf /etc/sudoers.d/cc-spawner
```

## 2. Software for the hands (as `cc-agents`)

- Claude Code (`claude`), signed in or pointed at your model endpoint (step 4).
- [bun](https://bun.sh) — the bridge plugin runs on it.
- The MCPL bridge plugin:
  ```sh
  git clone https://github.com/anima-research/mcpl-cc-bridge ~/mcpl-cc-bridge
  (cd ~/mcpl-cc-bridge/plugins/mcpl-bridge && bun install)
  claude plugin marketplace add ~/mcpl-cc-bridge
  claude plugin install mcpl-bridge@mcpl-bridge-dev --scope user
  ```
- [zulip_mcp](https://github.com/antra-tess/zulip_mcp), built (`npm ci && npm run build`); point
  `zulipMcp` at its `build/index.js`.
- The shared working directory (`projectDir`), e.g. `mkdir ~/workspace`.
- **One-time consents a person gives** (the spawner refuses to click these for you): run
  `cd ~/workspace && claude --dangerously-skip-permissions` once, accept the bypass-permissions
  warning and trust the folder, then exit.

## 3. The tmux server and the daemon

```sh
# as root
install -m 0644 deploy/cc-agents-tmux.service deploy/cc-spawner.service /etc/systemd/system/
git clone <this repo> /opt/zulip-cc-spawner && (cd /opt/zulip-cc-spawner && npm ci && npm run build)
systemctl daemon-reload
systemctl enable --now cc-agents-tmux.service
```

Adjust `PATH` in `cc-agents-tmux.service` to where `claude`, `bun` and `node` live for `cc-agents`.

## 4. Model credentials for the hands

Every hand sources `agentsEnvFile` before starting `claude`. Render it with whatever secret
manager you use, readable by `cc-agents` and nobody else who runs untrusted code:

```sh
# /etc/cc-agents/agents.env   (root:cc-agents, 0640; /etc/cc-agents 0750 root:cc-agents)
ANTHROPIC_BASE_URL=https://your-model-endpoint.example
ANTHROPIC_API_KEY=...
```

If `claude` asks "Do you want to use this API key?" at startup, the spawner answers Yes. For
per-hand attribution on a gateway, set `attributionHeaders` in the config
(`{"x-origin": "cc-spawner", "x-hand": "{hand}", "x-by": "{spawnedBy}"}`); they are sent as
`ANTHROPIC_CUSTOM_HEADERS`.

## 5. Zulip

1. **Bot owner**: a *human* account allowed to create bots (Zulip's "who can create bots"
   setting). The spawner creates one generic bot per hand under it, reads the bots' keys back
   and subscribes them to their home stream. Zulip lets a bot post to any stream its owner is
   subscribed to — use a dedicated account that is in few or no private streams. Its zuliprc →
   `adminRc` (owned by `cc-spawner`, 0600).
2. **Spawner bot**: a generic bot owned by the same account. Create it (or, on a rerun, find
   it) and write its zuliprc → `spawnerRc`:
   ```sh
   node dist/src/setup-bot.js --owner owner.zuliprc --out spawner.zuliprc \
     [--name "CC Spawner"] [--short cc-spawner] [--subscribe <stream>]…
   ```
   The spawner hears only streams its bot is subscribed to; add it to more streams in Zulip
   at any time.
3. Config: copy `deploy/config.example.json` to `~cc-spawner/.cc-spawner/config.json` and fill in
   `allowedStreams` (stream names, or `["*"]` for every stream the spawner bot is in),
   `allowedUsers` (Zulip user ids) and/or `allowedGroups` (user-group ids; system groups such as
   administrators work), and optionally `allowedResidents` (bot user ids of agents allowed to
   summon hands). Empty lists deny everyone. A hand can only be spawned in a stream the bot
   owner may add bots to (for a private stream: one the owner is in).

```sh
systemctl enable --now cc-spawner.service
journalctl -u cc-spawner -f
```

## Checks

- Restart the daemon while a hand runs (`systemctl restart cc-spawner`): the hand must survive.
- `@**CC Spawner** spawn sonnet-5-5 name=smoke` in an allowed stream: the hand should post within
  a minute; if it stays silent for 10 minutes the spawner says so — `peek smoke` shows its screen.
