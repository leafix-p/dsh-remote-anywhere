/**
 * WSL transport for dsh-remote-anywhere.
 *
 * Commands run through `wsl.exe -d <distro> -- bash -lc`, while files are read
 * and written through the distro's 9P share (`\\wsl.localhost\<distro>\...`).
 * That keeps the local side free of an sshd requirement: a stock WSL distro
 * works out of the box, exactly like VS Code's WSL targets.
 *
 * @module dsh-remote-anywhere/wsl
 */

import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { errorMessage, normalizePosix, shellQuote, wslExecutable } from './util.js'

/** Run `wsl.exe` and collect its output. */
function runWsl (distro, script, options = {}) {
  const { timeoutMs = 60_000, maxBytes = 4 * 1024 * 1024 } = options
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    let timedOut = false
    const child = spawn(wslExecutable(), ['-d', distro, '--', 'bash', '-lc', script], {
      env: { ...process.env, WSL_UTF8: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    const finish = (exitCode, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({
        exitCode,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    }
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.stdout.on('data', chunk => {
      if (stdoutBytes >= maxBytes) return
      const part = chunk.subarray(0, maxBytes - stdoutBytes)
      stdoutBytes += part.length
      stdout.push(part)
    })
    child.stderr.on('data', chunk => {
      if (stderrBytes >= maxBytes) return
      const part = chunk.subarray(0, maxBytes - stderrBytes)
      stderrBytes += part.length
      stderr.push(part)
    })
    child.on('close', (code, signal) => finish(code, signal))
  })
}

/** One WSL distribution target. */
export class WslTransport {
  /**
   * @param {string} distro - distribution name from `wsl.exe -l -q`.
   * @param {object} [options] - `timeoutMs`, `log`.
   */
  constructor (distro, options = {}) {
    this.distro = distro
    this.options = options
    this.root = undefined
    this.started = false
  }

  /** Start the distro (a no-op when it is already running) and pick a UNC root. */
  async connect () {
    if (this.started && this.root !== undefined) return this
    await this.exec('true', { timeoutMs: 30_000 })
    this.started = true
    this.root = await this.#resolveRoot()
    return this
  }

  async #resolveRoot () {
    const candidates = [`\\\\wsl.localhost\\${this.distro}`, `\\\\wsl$\\${this.distro}`]
    for (const candidate of candidates) {
      try {
        const info = await stat(candidate)
        if (info.isDirectory()) return candidate
      } catch { /* try the next spelling */ }
    }
    throw new Error(`无法访问 WSL 发行版 ${this.distro} 的文件系统（已尝试 \\\\wsl.localhost 与 \\\\wsl$）`)
  }

  /** Map a POSIX path inside the distro to its Windows UNC path. */
  uncPath (posixPath) {
    if (this.root === undefined) throw new Error('WSL 传输尚未连接')
    return join(this.root, normalizePosix(posixPath).replaceAll('/', '\\'))
  }

  /**
   * Run a command inside the distro.
   *
   * @param {string} command - bash command.
   * @param {object} [options] - `cwd`, `timeoutMs`.
   */
  async exec (command, options = {}) {
    const { cwd, timeoutMs = 120_000 } = options
    const script = cwd === undefined || cwd === ''
      ? command
      : `cd ${shellQuote(cwd)} && ${command}`
    return await runWsl(this.distro, script, { timeoutMs })
  }

  async mkdirp (remotePath) {
    await this.connect()
    await mkdir(this.uncPath(remotePath), { recursive: true })
  }

  async readFile (remotePath) {
    await this.connect()
    return await readFile(this.uncPath(remotePath))
  }

  async writeFile (remotePath, content, mode = 0o644) {
    await this.connect()
    const target = this.uncPath(remotePath)
    const directory = target.slice(0, target.lastIndexOf('\\'))
    await mkdir(directory, { recursive: true })
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`
    await writeFile(temporary, content)
    await rename(temporary, target)
    try {
      await this.exec(`chmod ${mode.toString(8)} ${shellQuote(remotePath)}`, { timeoutMs: 15_000 })
    } catch { /* chmod is best-effort */ }
  }

  async readdir (remotePath) {
    await this.connect()
    const entries = await readdir(this.uncPath(remotePath), { withFileTypes: true })
    return entries.map(entry => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    }))
  }

  async stat (remotePath) {
    await this.connect()
    try {
      const info = await stat(this.uncPath(remotePath))
      return {
        isDirectory: info.isDirectory(),
        isFile: info.isFile(),
        size: info.size,
        mtime: info.mtimeMs,
      }
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined
      throw error
    }
  }

  async unlink (remotePath) {
    await this.connect()
    try { await unlink(this.uncPath(remotePath)) } catch { /* already gone */ }
  }

  async home () {
    const result = await this.exec('printf "%s\\n" "$HOME"', { timeoutMs: 15_000 })
    const home = result.stdout.trim().split(/\r?\n/u)[0] ?? ''
    if (!home.startsWith('/')) throw new Error(`无法确定 WSL home 目录：${result.stderr || result.stdout}`)
    return home
  }

  async probe () {
    const script = [
      'printf "HOME=%s\\n" "$HOME"',
      'printf "USER=%s\\n" "$(id -un 2>/dev/null || whoami)"',
      'printf "OS=%s\\n" "$(uname -s 2>/dev/null || echo unknown)"',
      'printf "ARCH=%s\\n" "$(uname -m 2>/dev/null || echo unknown)"',
      'printf "NODE=%s\\n" "$(node -v 2>/dev/null || true)"',
      'printf "NPM=%s\\n" "$(npm -v 2>/dev/null || true)"',
      'printf "HOME_DSH=%s\\n" "$(test -x "$HOME/.dsh/remote-bin/node_modules/.bin/dsh" && echo yes || echo no)"',
      'printf "RG=%s\\n" "$(command -v rg 2>/dev/null || true)"',
      'printf "GIT=%s\\n" "$(command -v git 2>/dev/null || true)"',
    ].join('; ')
    const result = await this.exec(script, { timeoutMs: 30_000 })
    if (result.exitCode !== 0) {
      throw new Error(`WSL ${this.distro} 不可用：${(result.stderr || result.stdout).trim() || `wsl.exe exit ${result.exitCode}`}`)
    }
    const values = {}
    for (const line of result.stdout.split(/\r?\n/u)) {
      const index = line.indexOf('=')
      if (index > 0) values[line.slice(0, index)] = line.slice(index + 1).trim()
    }
    return {
      home: values.HOME ?? '',
      user: values.USER ?? '',
      os: values.OS ?? 'Linux',
      arch: values.ARCH ?? '',
      node: values.NODE ?? '',
      npm: values.NPM ?? '',
      dsh: values.HOME_DSH === 'yes' ? '~/.dsh/remote-bin' : '',
      rg: values.RG ?? '',
      git: values.GIT ?? '',
    }
  }

  /**
   * Start one foreground process inside the distro and stream its output.
   *
   * `wsl.exe` is itself the lifetime owner: WSL tears the Linux process group
   * down when the console closes, so we keep the child alive for as long as
   * the connection is open. The Linux pid is also written to a file so a
   * separate `wsl.exe` invocation can kill it if the Windows child dies
   * without taking the process with it.
   *
   * @param {string} command - command to exec (already quoted).
   * @param {object} [options] - `cwd`, `onData(kind, text)`.
   */
  async startProcess (command, options = {}) {
    await this.connect()
    const pidFile = `/tmp/.dsh-remote-anywhere-${process.pid}-${Date.now()}.pid`
    const script = [
      options.cwd === undefined || options.cwd === '' ? ':' : `cd ${shellQuote(options.cwd)}`,
      `echo $$ > ${shellQuote(pidFile)}`,
      `exec ${command}`,
    ].join('; ')
    const child = spawn(wslExecutable(), ['-d', this.distro, '--', 'bash', '-lc', script], {
      env: { ...process.env, WSL_UTF8: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', chunk => options.onData?.('stdout', chunk.toString('utf8')))
    child.stderr.on('data', chunk => options.onData?.('stderr', chunk.toString('utf8')))
    let stopped = false
    const exitCallbacks = []
    child.on('exit', (code, signal) => {
      for (const callback of exitCallbacks) {
        try { callback(code, signal) } catch { /* listener error is not ours */ }
      }
    })
    return {
      kind: 'wsl',
      child,
      pidFile,
      onExit (callback) { exitCallbacks.push(callback) },
      async stop () {
        if (stopped) return
        stopped = true
        try { child.kill() } catch { /* already gone */ }
        await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
        try {
          await this.exec(`pid=$(cat ${shellQuote(pidFile)} 2>/dev/null || true); if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; sleep 0.3; kill -9 "$pid" 2>/dev/null || true; fi; rm -f ${shellQuote(pidFile)}`, { timeoutMs: 15_000 })
        } catch { /* the distro may already be gone */ }
      },
    }
  }

  /** WSL2 forwards loopback listeners to Windows, so the port is usable as-is. */
  async forward (remotePort) {
    await this.connect()
    return { localPort: remotePort, close: async () => {} }
  }

  async close () {
    /* wsl.exe is per-command; nothing long-lived to close. */
  }
}

/** Probe one WSL distro without keeping any state. */
export async function probeWslDistro (distro) {
  const transport = new WslTransport(distro)
  try {
    return { ok: true, ...(await transport.probe()) }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  } finally {
    await transport.close()
  }
}

