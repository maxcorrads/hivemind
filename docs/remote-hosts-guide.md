# Running agents on a second Mac

A step-by-step guide to [remote hosts](remote-hosts.md): brains and workers that
run on another Mac on your local network, while Hivemind itself (the server, the
UI, your accounts and every decision) stays on the Mac you use every day, the
**control Mac**. The remote Mac only runs the agents: you never open Hivemind
there.

```text
Control Mac                                   Remote Mac (reached with SSH)
Hivemind Server.app, Hivemind.app      SSH    tmux with the agents, their CLIs and logins,
server, database, accounts         ==========> your project clones, Hivemind's MCP
```

With no remote host configured, Hivemind works exactly as before. You can add and
remove a host at any time.

## 1. Prepare the remote Mac

Once, on the remote Mac:

1. **Turn on Remote Login.** System Settings → General → Sharing → Remote Login.
2. **Give Remote Login Full Disk Access** if your projects live in `~/Documents`,
   `~/Desktop` or `~/Downloads`: in Remote Login's options (the ⓘ next to it), turn
   on "Allow full disk access for remote users". Without it, agents fail there with
   `Operation not permitted`.
3. **Install the tools your agents use:** `tmux` and the agent CLIs (`codex`,
   `claude`, Cursor's `agent`, `opencode`…), plus `git`, `gh` and whatever your
   projects build with (Xcode, the Android SDK, Node.js…). Hivemind needs no install
   of its own there: it copies its runtime over SSH.

On the control Mac:

4. **Log in with an SSH key, without a password**, and accept the host key once:

   ```sh
   ssh-copy-id user@mini.local     # once, if the key is not there yet
   ssh -o BatchMode=yes user@mini.local true && echo ok
   ```

   Hivemind never answers a password or host-key prompt: `BatchMode` must succeed.

## 2. Add the host

In the **Hivemind Server** menu, **Hosts → Add Host…**:

| Field | Example | Meaning |
| --- | --- | --- |
| Name | `Mac mini` | What Hivemind shows. |
| SSH destination | `user@mini.local` | As `ssh` takes it: `user@host`, or a `Host` alias from `~/.ssh/config`. |
| Extra forwards | `-R 1080` | Optional, passed to `ssh` as they are. See [Private networks](#6-reach-private-networks-through-the-control-mac). |

The first host makes the server restart once, to open its agent-only listener;
running agents just see a short pause. The menu then shows the host as
*connecting*, then *online*, while Hivemind copies its runtime there the first
time. **Show Hosts Log** says why when it stays offline.

## 3. Log in the accounts there

The remote Mac uses your accounts as they are configured on the control Mac: the
same entries, the same policy. Each one needs a login **on the remote Mac**, once:
Hivemind never copies a login or a token.

1. In Hivemind.app, open **Accounts** and press **Prepare** on an account.
   Hivemind creates its home on the remote Mac (same path, same settings, skills,
   plugins and, for Codex, the Hivemind MCP block), without any credential.
2. Under the account, a line for the host says **Ready**, or *not logged in* with
   the exact command to run there and **Copy**.
3. Run it on the remote Mac (`ssh -t user@mini.local`), log in to the **same**
   provider account as on the control Mac, and press **Prepare** again. Hivemind
   compares the two account identities, without reading any token, and refuses a
   launch on a home logged in to another account.

Logging in over SSH, without a screen on the remote Mac:

- **Codex** opens a browser on `http://127.0.0.1:1455/…`. The browser runs on the
  control Mac, so the redirect cannot reach the remote `codex login`. Use
  `codex login --device-auth` if your Codex version offers it, or copy the address the
  browser could not open and deliver it on the remote Mac:
  `ssh user@mini.local "curl -s 'http://127.0.0.1:1455/auth/callback?…'"`.
- **Cursor** stores its login in the macOS keychain, which an SSH session finds
  locked: run `security unlock-keychain ~/Library/Keychains/login.keychain-db`
  first, then `agent login`. Keep the remote Mac's user logged in, or the agents
  may not find the login after a restart.
- **GitHub, GitLab:** `gh auth login`, `glab auth login` (a personal access
  token works where the browser flows do not), and an SSH key added to each.

**Homes that are not Hivemind accounts** (a CLI alias such as `claude-work` with
its own `CLAUDE_CONFIG_DIR`) are not prepared by Hivemind. Create them yourself on
the remote Mac at the same path, with the configuration only (settings, skills,
plugins, `config.toml`; never `auth.json`, `.credentials.json` or `.claude.json`),
add the alias to the remote `~/.zshrc`, and log in. For Codex, copy the
`[mcp_servers.hivemind]` block from a prepared home's `config.toml` there. For
Cursor, write the MCP and stop-hook files with the remote runtime:

```sh
R="$HOME/Library/Application Support/Hivemind/remote/<version>"
HIVEMIND_URL=http://127.0.0.1:7422 "$R/node" "$R/server/bin/hivemind.mjs" mcp-config --cursor
HIVEMIND_URL=http://127.0.0.1:7422 "$R/node" "$R/server/bin/hivemind.mjs" mcp-config --cursor-hooks
```

These hand-made files name the runtime's version: update them when Hivemind is
updated (prepared accounts are updated by Hivemind itself).

## 4. Put the projects there

Each project must be at the **same path** on the remote Mac as on the control Mac.

- **A clean checkout is enough:** do nothing. The first launch on the host clones
  the project there, from the control Mac's `origin`, with the remote Mac's own git
  credentials.
- **The project has unpublished work** (local commits, uncommitted changes, stashes,
  worktrees) that the agents rely on: copy the whole working copy once instead,
  leaving out build caches, which are tied to the machine and rebuilt on the first
  build:

  ```sh
  rsync -aH --exclude='.build/' --exclude='DerivedData/' \
    ~/Documents/develop/my-app user@mini.local:Documents/develop/
  ```

  From then on, work in one copy only: agents on the remote Mac use its copy.

## 5. Launch on the host

- **Launch** and **Resume…** have a **Host** field once a host exists: pick it.
- **Worker templates** have a **Host** too. Set it on a project's templates when its
  brains run on the remote Mac, so their workers start there with the same copy of
  the project.
- **Open terminal** opens a remote agent's terminal in Hivemind.app, as for local
  ones. **Stop session** stops it there.

### Move a running agent to the host

An agent keeps its conversation if you move its transcript with it:

1. Wait until it is idle, then stop its session on the control Mac.
2. Copy its conversation to the same paths on the remote Mac, in the home it
   launches with:
   - **Claude:** `projects/<project folder>/<session id>.jsonl`, the folder of the
     same name next to it, `file-history/<session id>` and `session-env/<session id>`;
   - **Codex:** `sessions/<yyyy>/<mm>/<dd>/rollout-…-<session id>.jsonl`.

   Also copy any files of its own it names (notes, a memory folder, a working folder).
3. Open the agent's **Resume…**, pick the **Host**, the same **Software**, and its
   **Conversation** ID (**Find last conversations** fills it from the transcripts).

## 6. Reach private networks through the control Mac

If some services are reachable only from the control Mac, for example a Git server
behind a VPN that runs there, the remote Mac can use the control Mac's network
instead of a VPN of its own. Add `-R 1080` to the host's extra forwards: the remote
Mac then has a SOCKS proxy on `127.0.0.1:1080` that comes out on the control Mac.
Point only those services at it, on the remote Mac:

```text
# ~/.ssh/config: git over SSH
Host gitlab.example.com
  ProxyCommand /usr/bin/nc -X 5 -x 127.0.0.1:1080 %h %p
```

```sh
# git over HTTPS
git config --global http.https://gitlab.example.com/.proxy socks5h://127.0.0.1:1080
# a CLI: a small wrapper earlier in PATH, e.g. ~/.local/bin/glab
#   HTTPS_PROXY=socks5h://127.0.0.1:1080 exec /opt/homebrew/bin/glab "$@"
```

Everything else keeps its direct route. It works while the control Mac is on its
network (and its VPN) with the host online. Check your organisation's policy before
sharing a VPN connection with another machine this way.

## Troubleshooting

| What you see | Why, and what to do |
| --- | --- |
| The host stays *offline* | **Show Hosts Log** has `ssh`'s reason. `ssh -o BatchMode=yes <destination> true` must work from the control Mac. |
| `Operation not permitted`, or "The current working directory must be readable" | macOS privacy: Remote Login needs Full Disk Access on the remote Mac for protected folders. |
| A line says *not logged in* or *another account* | Log in that home on the remote Mac with the command shown, to the same account as here, then **Prepare**. |
| An agent says its Hivemind tools are missing | It started while the MCP was still connecting: tell it to call `join` again, or resume it. |
| Cursor: "Your macOS login keychain is locked" | `security unlock-keychain` on the remote Mac, then retry. |
| Git or a CLI cannot reach an internal server | It needs the [SOCKS forward](#6-reach-private-networks-through-the-control-mac) and the control Mac on its VPN. |

## Limits

- The control Mac must be on, with Hivemind Server running: remote agents reach
  Hivemind through it. They keep running without it, but their calls fail until it
  is back.
- Each Mac has its own transcripts: moving an agent between Macs means copying its
  conversation, as in [Move a running agent](#move-a-running-agent-to-the-host).
- The remote host's runtime follows the control Mac's version automatically; files
  you wrote by hand (see [step 3](#3-log-in-the-accounts-there)) do not.

The design, the security model and the protocol are in [Remote hosts](remote-hosts.md).
