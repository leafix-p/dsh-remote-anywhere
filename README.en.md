# DSH Remote Anywhere

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)]()
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.1--rc.2-blue)]()

**SSH / WSL remote development for DeepSeek Harness.**<br>
[简体中文](README.md) · **English**

DSH Remote Anywhere turns an SSH host or a local WSL distribution into a remote
dsh development target. It installs and runs a full `dsh` on the far side, syncs
the local model / plugin / skill / prompt configuration, and embeds the remote
GUI in the local window over a loopback tunnel.

The activity-bar entry is called **Remote Explorer** in the UI. It is inspired
by VS Code Remote Explorer, but the agent, files and conversation live on the
remote machine — the local window is only the view.

- **WSL without sshd** — commands go through `wsl.exe`, files through
  `\\wsl.localhost\<distro>`.
- **A real remote dsh** — not just forwarded tool calls. The remote side owns
  `dsh --profile web`, its sessions, its files and its terminal.
- **Local sync of configuration** — model/provider settings, credentials,
  plugin set, skills and `AGENTS.md`.

## Why this plugin?

| What you want | Use |
| --- | --- |
| The agent, sessions, tools and files should all live on a powerful remote machine | **DSH Remote Anywhere** |
| The conversation should stay local while tools read/write remote files | `dsh-ssh-workspace` |
| Windows + WSL, without installing sshd inside the distro | **DSH Remote Anywhere** |

It is not a file-mirroring tool, not a VS Code extension, and not a remote
desktop. The remote GUI is a normal dsh Web GUI served on the remote loopback
interface and reached through an SSH tunnel or WSL localhost forwarding.

## Features

| Capability | Details |
| --- | --- |
| SSH targets | Hosts from the shared `$DSH_HOME/dsh-ssh.json` store and `~/.ssh/config`; password, private key and ssh-agent auth |
| WSL targets | Distributions discovered through `wsl.exe -l -q`; no sshd required |
| Remote bootstrap | Installs `@deepseek-ai/dsh` under `~/.dsh/remote-bin` on the remote user account — no root, no global npm pollution |
| Remote workspace | Registers the selected directory as the remote default workspace and opens it in the remote GUI |
| Config sync | `cordis.patch.yml`, `.credentials.yaml`, plugin manifest, `~/.agents/skills`, `~/.dsh/skills`, `AGENTS.md` |
| Plugin fallback | If the remote plugin install/load fails, falls back to the base plugin set plus model configuration instead of failing to boot |
| Embedded GUI | SSH: ssh2 `forwardOut` tunnel; WSL2: localhost forwarding; the remote page is embedded in the local window |
| Live log | Progress and error views show a live, copyable log with launch tokens masked |
| Host editor | Add / edit / delete SSH hosts; passwords and passphrases are AES-256-GCM encrypted under `$DSH_HOME/dsh-ssh.key` |
| Agent tools | `remote_anywhere_targets`, `remote_anywhere_connect`, `remote_anywhere_status`, `remote_anywhere_disconnect` |

## Requirements

- Local dsh `>= 0.2.1-rc.2` with the Web GUI.
- Remote **Node.js 22/24** and **npm**. The plugin does not install a system
  runtime; it reports a clear error when Node or npm is missing.
- SSH hosts must be reachable directly. **ProxyJump / ProxyCommand are not
  supported yet.**
- WSL2 needs localhost forwarding (enabled by default). WSL1 works as long as
  the port is reachable from Windows.
- The first connection installs dsh and optionally the local plugin set; expect
  one to three minutes depending on npm cache and network.

## Install

### From source (development / local)

```bash
git clone https://github.com/leafix-p/dsh-remote-anywhere.git
cd dsh-remote-anywhere
node scripts/install.mjs
```

The installer links this checkout into
`$DSH_HOME/profiles/<profile>/node_modules/dsh-remote-anywhere`, adds the
dependency and `dsh.profile.bundles` entry to the profile manifest, and keeps a
`package.json.bak-<timestamp>` backup.

Restart dsh afterwards: the browser half is scanned at startup.

Uninstall:

```bash
node scripts/install.mjs --uninstall
```

Once published to npm:

```bash
dsh plugin --profile web add dsh-remote-anywhere
```

Then add `dsh-remote-anywhere` to `dsh.profile.bundles` in the profile
`package.json` (or merge the package's `cordis.patch.yml` into your profile
patch).

## Usage

1. Open **Remote Explorer** in the left activity bar.
2. Pick an SSH host or WSL distribution and click **Connect and open**.
3. Choose a remote directory (the remote home is the default), adjust sync
   options, and confirm.
4. The progress view walks through: connect → probe environment → confirm
   directory → prepare dsh → sync config → register workspace → start dsh →
   establish local access.
5. When ready, the full remote dsh GUI is embedded in the main area. **Open in
   new tab** is available too.
6. **Disconnect** stops the remote dsh and closes the tunnel. The live log is
   available on the progress/error view and from the **Log** button once ready.

### Adding an SSH host

The host editor writes to `$DSH_HOME/dsh-ssh.json`, the same document used by
`dsh-ssh-workspace`:

- password auth: the password is encrypted at rest;
- private key: path plus optional passphrase;
- SSH agent: leave the address empty to use `SSH_AUTH_SOCK` / Pageant;
- `~/.ssh/config` hosts are read-only. The plugin never edits that file.

The first connection records the host-key fingerprint (TOFU). A changed
fingerprint is rejected with both fingerprints in the error.

## What gets synced

| Local source | Remote destination | Notes |
| --- | --- | --- |
| `$DSH_HOME/profiles/<profile>/package.json` | `~/.dsh/profiles/web/package.json` | Local-path deps and this plugin itself are removed; falls back to the base plugin set on failure |
| `$DSH_HOME/profiles/<profile>/cordis.patch.yml` | `~/.dsh/profiles/web/cordis.patch.yml` | Model, provider and theme configuration |
| `$DSH_HOME/.credentials.yaml` | `~/.dsh/.credentials.yaml` | API keys; mode 600 |
| `$DSH_HOME/AGENTS.md`, `~/.agents/AGENTS.md` | same paths | Global instructions |
| `~/.agents/skills/**`, `$DSH_HOME/skills/**` | same paths | Skills; symlinks and `node_modules` skipped |
| Selected remote directory | remote workspace registry | Registered as the remote default workspace |

The plugin manifest is sanitized before it is sent: `link:` / `file:` /
`workspace:` dependencies and `dsh-remote-anywhere` itself are removed. If the
remote `npm install` or `dsh --profile web --dump-config` fails, the plugin
writes a minimal base profile and a filtered model patch so the remote dsh can
still start.

## Security

- The local HTTP API accepts loopback requests only, validates the `Host`
  header, and requires `application/json` on POST.
- The remote dsh binds `127.0.0.1`; the local browser reaches it through the SSH
  tunnel or WSL localhost forwarding. The startup URL contains a per-process
  launch token.
- Tokens are replaced with `***` before log lines reach the browser.
- SSH host keys use TOFU; a mismatch refuses the connection.
- **Model credentials are copied to the remote host.** Use this plugin only with
  hosts you trust, or turn off “Sync model credentials” when connecting.
- Remote commands run with the remote login user's full permissions and are not
  covered by the local file sandbox.

## Architecture

```text
local dsh (Web GUI)
  ├─ browser half: sidebar.panellist + main page
  └─ host half
       ├─ targets: dsh-ssh.json / ~/.ssh/config / wsl.exe
       ├─ SSH transport: ssh2 (exec / SFTP / forwardOut)
       ├─ WSL transport: wsl.exe (exec) + \\wsl.localhost (files)
       ├─ bootstrap: npm install into ~/.dsh/remote-bin, write dsh-wrap.mjs
       ├─ sync: config / credentials / plugins / skills / prompts
       └─ run: remote dsh foreground process + local tunnel
```

The remote dsh lifetime is bound to the transport channel: an SSH exec channel
or a resident `wsl.exe` child. Closing the connection closes the channel and
terminates the remote process; there is no nohup or remote PID file.

Source layout:

```text
dsh-remote-anywhere/
  package.json          # dsh.bundle.patch + dsh.client metadata
  cordis.patch.yml      # bundle row and default config
  lib/index.js          # host entry: routes / tools / guidance
  lib/remote.js         # targets, connection state machine, pipeline
  lib/store.js          # dsh-ssh.json + ~/.ssh/config + WSL discovery
  lib/ssh.js            # ssh2 transport
  lib/wsl.js            # wsl.exe + UNC transport
  lib/sync.js           # install, config sync, workspace registration, launch
  lib/routes.js         # local HTTP API
  lib/tools.js          # agent tools
  lib/client.js         # browser half (no build step)
  scripts/install.mjs   # local install / uninstall
```

## Limitations

- **No ProxyJump / ProxyCommand.** Hosts using them are rejected with an
  explanation.
- **The remote needs Node.js 22/24 and npm.** No system runtime installation,
  no sudo, no distro package manager.
- **One remote dsh connection per target.** Multiple servers against the same
  `~/.dsh` would race on workspace/session state; the plugin reuses a live
  connection or asks you to disconnect first.
- **The remote GUI is a complete, independent UI.** Remote sessions are not
  merged into the local session list; the local window is its host.
- **The first connection is slow.** Later connections reuse npm's cache. A
  custom npm registry can be set in the settings panel.
- **WSL availability is decided at connect time.** The target list avoids
  running a shell for every distro; a stopped/unusable distro fails on connect.
- **No hot reload of the remote dsh.** Disconnect and reconnect after changing
  local configuration.
- **The local API is loopback-only.** Opening the GUI through a reverse proxy or
  public hostname returns 403 for Remote Anywhere endpoints.

## License

MIT
