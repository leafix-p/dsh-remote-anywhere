# Changelog

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
