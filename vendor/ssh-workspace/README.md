# Vendored `@shiqyka/dsh-ssh-workspace` host half

Source: <https://github.com/siqyka/dsh-ssh-workspace> — npm
`@shiqyka/dsh-ssh-workspace@0.2.6`, MIT (see `LICENSE`).

Copied into `dsh-remote-anywhere` so this plugin can serve `ssh://` workspaces
on its own. The host half under `lib/` (everything except `client.js`) is used;
the upstream client panel is not. `lib/index.js` is consumed through its
`apply(ctx, config)` entry from `lib/index.js` in this repository.

No code changes are made to the vendored files beyond this directory layout.
Keep this directory in sync with the upstream package when updating.
