/**
 * Workspace-terminal fallback for `ssh://` sessions.
 *
 * dsh 0.2.1's browser terminal shows the remote prompt but cannot attach input
 * or render output for the PTY handle returned by dsh-ssh-workspace 0.2.6/0.2.7.
 * The local terminal path works, so this module starts a local PTY running the
 * system `ssh` client instead:
 *
 *     ssh -t <host> "cd '<workspace>' && exec \"$SHELL\" -l"
 *
 * The browser sees an ordinary local terminal (input/output/rendering all use
 * the well-tested local handle), while the shell itself is on the remote host.
 * It is a compatibility fallback, not a replacement for the remote PTY path;
 * set `terminalMode: 'remote'` in the plugin config to keep the native path.
 *
 * @module dsh-remote-anywhere/local-terminal
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { listSshHosts } from './store.js'
import { expandHome } from './util.js'

const INSTALLED = Symbol.for('dsh-remote-anywhere/local-terminal-installed')
const ORIGINAL_REMOTE_TERMINAL = Symbol.for('@shiqyka/dsh-ssh-workspace/terminal-original')

/** Whether a terminal spec points at a remote workspace. */
function isRemoteCwd (value) {
  return typeof value === 'string' && value.startsWith('ssh://')
}

/** Split `ssh://alias/path` into its parts. */
function parseRemoteCwd (value) {
  const match = /^ssh:\/\/([^/]+)(\/.*)?$/u.exec(String(value))
  if (match === null) return undefined
  return {
    alias: match[1],
    remotePath: match[2] !== undefined && match[2] !== '' ? match[2] : '/',
  }
}

/** Single-quote a string for a POSIX shell. */
function quotePosix (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

/** The system OpenSSH client. */
function sshExecutable () {
  const candidates = [
    process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'OpenSSH', 'ssh.exe') : undefined,
    'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return 'ssh'
}

/**
 * Build a local terminal spec that runs an SSH shell in the remote workspace.
 *
 * @param {object} spec - the browser terminal spec (cols/rows/env/signal/...).
 * @returns {Promise<object>} a local `spawnTerminal` spec.
 */
async function buildLocalTerminalSpec (spec) {
  const parts = parseRemoteCwd(spec.cwd)
  if (parts === undefined) throw new Error(`无法解析远端终端路径：${spec.cwd}`)
  const rows = await listSshHosts()
  const row = rows.find(candidate => candidate.alias === parts.alias)
  if (row === undefined) throw new Error(`SSH 主机 ${JSON.stringify(parts.alias)} 不存在，无法打开工作区终端`)

  // Prefer a ~/.ssh/config alias for the same authority: it carries the port,
  // user and identity settings the system ssh client already understands.
  let authority = row.source === 'ssh-config' ? row.alias : ''
  let configAlias = row.source === 'ssh-config'
  if (authority === '') {
    const match = rows.find(candidate =>
      candidate.source === 'ssh-config' &&
      candidate.host === row.host &&
      candidate.port === row.port &&
      (row.user === '' || candidate.user === row.user))
    if (match !== undefined) {
      authority = match.alias
      configAlias = true
    }
  }
  if (authority === '') authority = row.user === '' ? row.host : `${row.user}@${row.host}`

  const args = ['-t']
  if (!configAlias && row.port !== 22) args.push('-p', String(row.port))
  if (!configAlias && row.auth?.kind === 'key' && row.auth.keyPath !== '') {
    args.push('-i', expandHome(row.auth.keyPath), '-o', 'IdentitiesOnly=yes')
  }
  args.push(authority, `cd ${quotePosix(parts.remotePath)} && exec "$SHELL" -l`)

  return {
    ...spec,
    argv: [sshExecutable(), ...args],
    cwd: homedir(),
    // The terminal is still a shell, but on the other side of an SSH client;
    // keeping the flag makes the local handle expose process activity.
    shellActivity: true,
  }
}

/**
 * Install the fallback on the live subprocess seam.
 *
 * The assignment is deliberately delayed one turn: ssh-workspace installs its
 * own `spawnTerminal` wrapper during activation, and this wrapper must sit on
 * the outside so it can replace the remote PTY path.
 *
 * @param {object} ctx - host plugin context.
 * @param {object} [config] - plugin config; `terminalMode: 'remote'` disables.
 * @returns {void}
 */
export function installLocalTerminalFallback (ctx, config = {}) {
  if (config.terminalMode === 'remote') return
  let disposed = false
  const install = () => {
    if (disposed) return
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined || subprocess === null) return
    if (subprocess[INSTALLED] === true) return
    if (typeof subprocess.spawnTerminal !== 'function') return
    const current = subprocess.spawnTerminal
    const local = subprocess[ORIGINAL_REMOTE_TERMINAL]
    if (typeof local !== 'function') {
      // Without the ssh-workspace original there is no local primitive to call;
      // leave the native remote path untouched.
      return
    }
    const wrapped = async function (spec) {
      if (spec !== null && typeof spec === 'object' && isRemoteCwd(spec.cwd)) {
        return await local.call(subprocess, await buildLocalTerminalSpec(spec))
      }
      return await current.call(subprocess, spec)
    }
    Object.defineProperty(subprocess, 'spawnTerminal', {
      value: wrapped,
      writable: true,
      configurable: true,
      enumerable: false,
    })
    Object.defineProperty(subprocess, INSTALLED, { value: true, configurable: true })
    ctx.logger?.info?.('remote-anywhere: using local ssh PTY for ssh:// workspace terminals')
  }
  const timer = setTimeout(install, 500)
  ctx.effect(() => () => {
    disposed = true
    clearTimeout(timer)
  }, 'remote-anywhere: local terminal fallback')
}
