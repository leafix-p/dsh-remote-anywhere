# Changelog

## 0.3.1 — 2026-10-29

- **`run_code` now fails with an instruction instead of a whitelist message.**
  The PTC runtime spawns a local `node` process with the Session workspace as
  cwd; in an `ssh://` workspace the remote subprocess bridge refuses it with
  "only git and ripgrep (rg) are supported over the remote subprocess bridge".
  That message names the rule but not the way out, so an agent burned a turn
  discovering it. The refusal is now rewritten to point at bash / pwsh (which
  do run remotely), read / write / edit (SFTP) and glob / grep (remote
  ripgrep), and to say that `run_code` itself is unsupported here. The
  whitelist is unchanged: a local node process cannot execute against a remote
  cwd, and silently redirecting it to a local directory would make user code
  read the wrong files.
- The plugin's agent guidance and the README both state the tool choice for
  remote workspaces up front.

## 0.3.0 — 2026-10-29

- **One "Add workspace" dialog for local and remote directories.** DSH's
  workspace picker is the `browse` face of `ctx.directoryPicker`; this release
  teaches that seam the `ssh://` grammar instead of shipping a second picker.
  The local HOME level gains a `远程设备（N）` row, the device root lists the
  configured SSH hosts, and `ssh://alias/` lists that host's filesystem over
  SFTP with a `~ 主目录` shortcut and clickable breadcrumbs
  (`远程设备 > 主机 > home > 用户 > 项目`). Picking a remote directory and
  pressing 打开 creates the `ssh://` workspace through the ordinary
  `workspaces.create` path — no separate mount dialog.
- **`ssh://` workspaces mount their root when created.** A workspace made from
  the browser previously registered fine but stayed outside every served root
  until the next restart's re-mount sweep, so its first writes were fenced off
  with `FS_OUTSIDE_WORKSPACE`. `workspaces.create` now mounts the remote root
  first, for both the browser and any other caller.
- **Pin the directory picker to the `browse` interaction** in the bundle patch:
  the adaptive chooser resolves to `native` on an attended Windows/macOS host,
  and an OS chooser can neither list remote directories nor be driven by a
  plugin. The bundle patch documents how to restore the system dialog.
- **The workspace path is now the primary one in Remote Explorer.** A target
  card's main action is 添加为工作区 — the directory becomes an `ssh://`
  workspace, the Session runs locally and every file, search, command and
  terminal tool acts on the remote host. Starting a full remote dsh moved to a
  secondary 在远端窗口中打开 button, so the plugin no longer reads as
  "remote desktop" by default.
- **Only hosts the picker can authenticate are offered.** A `~/.ssh/config`
  entry with neither a saved credential nor a readable key falls back to
  ssh-agent, which failed with ssh2's `Failed to retrieve identities from
  agent` on a machine without one. Those hosts stay in the Remote Explorer
  panel for a remote-dsh connection. A machine reached under two aliases (an IP
  from the config plus the saved host) collapses to one row, listing failures
  are translated into what to change, and the device root carries a
  local-disk row so the browser has a way back.
- New config: `directoryPicker.enabled` and `directoryPicker.localDevices`.

## 0.2.7 — 2026-10-29

- **Fix a fatal `dsh web` crash on SSH authentication failure.** ssh2 emits a
  second `error` after the handshake rejects; `SshTransport` listened with
  `once('error')`, so the second event had no listener and killed the whole
  dsh process (`fatal uncaught exception: All configured authentication
  methods failed`). The listener now stays attached for the life of the
  client and records later errors instead.
- **Fix a connect that appeared to hang after "插件同步完成".** Skill trees were
  uploaded one file per SFTP round trip with no timeout or progress; a single
  stalled write blocked the pipeline forever. The copy now uses six parallel
  uploads, logs every 50 files, bounds each write (20s) and the whole tree
  (120s), and turns a timeout into a warning so the connect continues.
- Skip auto-probing remote workspaces until the detached list has loaded, so a
  deliberately disabled workspace is not probed (and cannot produce a
  needless authentication failure) on the first poll.

## 0.2.6 — 2026-10-29

- **`@` references now work in remote workspaces.** DSH's `ctx.fileReferences`
  indexes the local Session cwd, so a Session whose cwd is `ssh://alias/path`
  had no candidates. The plugin wraps that service: for remote cwds it lists
  one directory over the embedded SSH engine (root on bare `@`, drill-in on
  `@src/`, prefix filter while typing), delegates local Sessions unchanged, and
  caches listings for 5 seconds.
- The vendored host now returns its connection engine so the reference source
  can reuse the pooled SSH connection instead of opening its own.

## 0.2.5 — 2026-10-29

- Add **挂载为工作区** to the connect dialog (SSH): mounts the selected remote
  directory as a local workspace without starting a remote dsh, then shows the
  resulting `ssh://` path.
- Add a global **断线后自动重连** option (default on), in both the connect and
  settings dialogs. A failed workspace probe retries with 10s / 30s / 60s
  backoff (at most three attempts); each retry also calls the idempotent mount
  endpoint so the embedded engine re-acquires its pooled connection.
- The hover card gains a **重试** button and reports the automatic reconnect
  attempt; turning the option off leaves only manual retries.

## 0.2.4 — 2026-10-29

- Vendor the `dsh-ssh-workspace` host half (MIT) under `vendor/ssh-workspace/`.
  remote-anywhere now owns the `ssh://` seams itself: the remote fs router,
  shell/subprocess/terminal patches, workspace mount routes and the
  `ssh_workspace_*` tools all come from this plugin.
- **No longer requires the `dsh-ssh-workspace` bundle to load**: the profile
  only enables `dsh-remote-anywhere`, so a plugin-market operation that drops
  another bundle can no longer take `ssh://` workspaces (and new sessions) down
  with it.
- Keep the `dsh-ssh-workspace` package as a dependency only for `ssh2` and the
  shared host store; its client panel is not needed.
- Document `sshWorkspace.enabled` / `sshWorkspace.engine` in the bundle patch.

## 0.2.3 — 2026-10-29

- Add live status to `ssh://` workspace rows in the sidebar: a green dot when
  the probe succeeds, a spinner while connecting, a red dot on failure, and a
  dim dot for a detached workspace.
- Add a hover card on those rows with the VS Code Remote Explorer fields —
  project name, device, connection type, address and directory — plus the
  recent probe log (connect time, handshake, directory check, device name,
  errors) and the last-checked time.
- Probe on page load, row hover and row click, with a 45s freshness window and
  two concurrent probes at most.
- Fix the badge stacking into a column: the title lives in a vertical block, so
  the badge now anchors after that block instead of inside it, and stray
  badges from earlier insertions are removed.

## 0.2.2 — 2026-10-29

- Fix `ssh://` workspace sidebar terminals showing a blank shell with no input
  or output: those terminals now run through a local SSH PTY (system `ssh`),
  which uses the same working terminal path as a local shell.
- Add `inspectActivity()` compatibility for the terminal handles returned by
  `@shiqyka/dsh-ssh-workspace` on dsh 0.2.1.
- Add `terminalMode: 'remote'` to opt back into the native remote PTY.

## 0.2.1 — 2026-10-28

- Add **VS Code**, **Terminal** and **File** actions directly on target cards,
  so a target can be opened without starting the remote dsh first.
- Resolve the remote home automatically when a direct target action has no
  explicit path.
- Fix a misleading empty action row on the progress screen.

## 0.2.0 — 2026-10-28

- Add **VS Code**, **Terminal** and **File** actions for ready connections:
  Remote-SSH / Remote-WSL folder open, Windows Terminal remote shell, and WSL
  Explorer.
- Discover WSL distributions from the per-user Lxss registry, so the target
  list appears instantly even when `wsl.exe -l -q` is slow.
- Add English README and clearer positioning against `dsh-ssh-workspace`.

## 0.1.0 — 2026-10-28

Initial open-source release.

- Remote Explorer panel with SSH and WSL targets.
- Install and run `dsh --profile web` on the remote host under `~/.dsh/remote-bin`.
- Sync model/provider settings, credentials, plugin manifest, skills and prompt files.
- Register the chosen remote directory as the remote default workspace.
- Embed the remote dsh GUI locally over an SSH tunnel or WSL localhost forwarding.
- Two-way SSH host store shared with `dsh-ssh-workspace`.
- Connection progress with a live, copyable log (tokens masked).
- Agent tools: `remote_anywhere_targets`, `remote_anywhere_connect`,
  `remote_anywhere_status`, `remote_anywhere_disconnect`.
