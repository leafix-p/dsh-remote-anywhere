# Changelog

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
