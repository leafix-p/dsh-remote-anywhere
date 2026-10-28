/**
 * SSH transport for dsh-remote-anywhere.
 *
 * Uses `ssh2` (the same implementation dsh-ssh-workspace depends on), loaded
 * lazily from the active profile so this plugin needs no additional install of
 * its own. One connection per target carries exec channels, SFTP, and local
 * port forwards.
 *
 * @module dsh-remote-anywhere/ssh
 */

import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { expandHome, errorMessage, profileDir, shellQuote } from './util.js'
import { knownHostKey, rememberHostKey } from './store.js'

/** Load ssh2 from the profile's dependency tree. */
function loadSsh2 () {
  const requireFromProfile = createRequire(join(profileDir(), 'package.json'))
  try {
    return requireFromProfile('ssh2')
  } catch (error) {
    throw new Error(`无法加载 ssh2：${errorMessage(error)}。请先安装 dsh-ssh-workspace 插件（它带有 ssh2 依赖），或在当前 profile 中安装 ssh2。`)
  }
}

/** Promise wrapper for one ssh2 SFTP operation. */
function sftpCall (sftp, method, ...args) {
  return new Promise((resolvePromise, rejectPromise) => {
    sftp[method](...args, (error, value) => {
      if (error) rejectPromise(error)
      else resolvePromise(value)
    })
  })
}

/** One SSH connection to a host row. */
export class SshTransport {
  /**
   * @param {object} host - resolved host row (contains decrypted password/passphrase).
   * @param {object} [options] - `connectTimeoutMs`, `keepaliveIntervalMs`, `log`.
   */
  constructor (host, options = {}) {
    this.host = host
    this.options = options
    this.client = undefined
    this.sftpSession = undefined
    this.server = undefined
    this.sockets = new Set()
    this.connected = false
    this.hostKeyFingerprint = undefined
    this.newHostKey = false
    this.hostKeyError = undefined
    this.forwardPort = undefined
  }

  /** Open the connection (idempotent). */
  async connect () {
    if (this.connected && this.client !== undefined) return this
    const ssh2 = loadSsh2()
    const client = new ssh2.Client()
    const options = {
      host: this.host.host,
      port: this.host.port,
      username: this.host.user,
      readyTimeout: this.options.connectTimeoutMs ?? 25_000,
      keepaliveInterval: this.options.keepaliveIntervalMs ?? 10_000,
      keepaliveCountMax: 3,
      hostVerifier: (key) => {
        const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`
        this.hostKeyFingerprint = fingerprint
        this.newHostKey = this.expectedFingerprint === undefined
        if (this.expectedFingerprint !== undefined && this.expectedFingerprint !== fingerprint) {
          this.hostKeyError = `主机密钥与记录不一致（记录 ${this.expectedFingerprint}，实际 ${fingerprint}）。如果这台机器确实重装过，请到「远程工作区」面板忘记该主机密钥后重试。`
          return false
        }
        return true
      },
    }
    this.expectedFingerprint = await knownHostKey(this.host.alias)
    if (this.host.auth.kind === 'password') {
      if (typeof this.host.password !== 'string' || this.host.password === '') {
        throw new Error(`主机 ${this.host.alias} 没有保存密码，请编辑主机填写密码`)
      }
      options.password = this.host.password
    } else if (this.host.auth.kind === 'key') {
      const keyPath = expandHome(this.host.auth.keyPath)
      if (keyPath === '') throw new Error(`主机 ${this.host.alias} 没有配置私钥路径`)
      try {
        options.privateKey = await readFile(keyPath)
      } catch (error) {
        throw new Error(`无法读取私钥 ${keyPath}：${errorMessage(error)}`)
      }
      if (typeof this.host.passphrase === 'string' && this.host.passphrase !== '') {
        options.passphrase = this.host.passphrase
      }
    } else {
      const agent = this.host.auth.agentPath || process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? 'pageant' : undefined)
      if (agent === undefined) throw new Error(`主机 ${this.host.alias} 使用 SSH Agent 认证，但当前没有可用的 agent`)
      options.agent = agent
    }
    await new Promise((resolvePromise, rejectPromise) => {
      let settled = false
      const done = (error) => {
        if (settled) return
        settled = true
        if (error) {
          const detail = this.hostKeyError ?? errorMessage(error)
          rejectPromise(new Error(`连接 ${this.host.alias}（${this.host.host}:${this.host.port}）失败：${detail}`))
        } else {
          resolvePromise()
        }
      }
      client.once('ready', () => done())
      client.once('error', error => done(error))
      client.once('close', () => {
        if (!this.connected) done(new Error('连接在握手完成前被关闭'))
      })
      try {
        client.connect(options)
      } catch (error) {
        done(error)
      }
    })
    this.client = client
    this.connected = true
    if (this.newHostKey && this.hostKeyFingerprint !== undefined) {
      try {
        await rememberHostKey(this.host.alias, this.host.host, this.host.port, this.hostKeyFingerprint)
      } catch { /* TOFU recording is best-effort */ }
    }
    return this
  }

  /** Lazily open the SFTP channel. */
  async sftp () {
    if (this.sftpSession !== undefined) return this.sftpSession
    await this.connect()
    const channel = await new Promise((resolvePromise, rejectPromise) => {
      this.client.sftp((error, value) => error ? rejectPromise(error) : resolvePromise(value))
    })
    this.sftpSession = channel
    return channel
  }

  /**
   * Run one command on the host.
   *
   * @param {string} command - POSIX shell command.
   * @param {object} [options] - `cwd`, `timeoutMs`, `maxBytes`.
   * @returns {Promise<{exitCode:number|null, signal:string|null, stdout:string, stderr:string, timedOut:boolean}>}
   */
  async exec (command, options = {}) {
    await this.connect()
    const { cwd, timeoutMs = 120_000, maxBytes = 4 * 1024 * 1024 } = options
    const full = cwd === undefined || cwd === ''
      ? command
      : `cd ${shellQuote(cwd)} && ${command}`
    return await new Promise((resolvePromise, rejectPromise) => {
      let settled = false
      let timedOut = false
      let stdoutBytes = 0
      let stderrBytes = 0
      const stdout = []
      const stderr = []
      const timer = setTimeout(() => {
        timedOut = true
        try { stream.destroy() } catch { /* already gone */ }
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
      let stream
      this.client.exec(full, (error, value) => {
        if (error) {
          clearTimeout(timer)
          settled = true
          rejectPromise(error)
          return
        }
        stream = value
        stream.on('data', (chunk) => {
          if (stdoutBytes >= maxBytes) return
          const part = chunk.subarray(0, maxBytes - stdoutBytes)
          stdoutBytes += part.length
          stdout.push(part)
        })
        stream.stderr.on('data', (chunk) => {
          if (stderrBytes >= maxBytes) return
          const part = chunk.subarray(0, maxBytes - stderrBytes)
          stderrBytes += part.length
          stderr.push(part)
        })
        stream.on('close', (code, signal) => finish(code, signal))
        stream.on('error', error => {
          clearTimeout(timer)
          if (!settled) {
            settled = true
            rejectPromise(error)
          }
        })
      })
    })
  }

  /**
   * Start one foreground remote process and stream its output.
   *
   * The process lives exactly as long as this SSH channel: closing the
   * channel (or `stop()`) terminates it. That is how the remote dsh server is
   * kept alive without nohup/PID files, and it survives even when the remote
   * login shell has no writable log directory.
   *
   * @param {string} command - POSIX command (already shell-quoted).
   * @param {object} [options] - `cwd`, `onData(kind, text)`.
   * @returns {Promise<{kind:'ssh', stop:() => Promise<void>, onExit:(cb:(code:number|null, signal:string|null)=>void) => void}>}
   */
  async startProcess (command, options = {}) {
    await this.connect()
    const full = options.cwd === undefined || options.cwd === ''
      ? command
      : `cd ${shellQuote(options.cwd)} && ${command}`
    return await new Promise((resolvePromise, rejectPromise) => {
      this.client.exec(full, (error, stream) => {
        if (error) {
          rejectPromise(error)
          return
        }
        stream.on('data', chunk => options.onData?.('stdout', chunk.toString('utf8')))
        stream.stderr.on('data', chunk => options.onData?.('stderr', chunk.toString('utf8')))
        let stopped = false
        const exitCallbacks = []
        stream.on('close', (code, signal) => {
          for (const callback of exitCallbacks) {
            try { callback(code, signal) } catch { /* listener error is not ours */ }
          }
        })
        resolvePromise({
          kind: 'ssh',
          stream,
          onExit (callback) { exitCallbacks.push(callback) },
          async stop () {
            if (stopped) return
            stopped = true
            try { stream.signal('TERM') } catch { /* channel may not support signals */ }
            await new Promise(resolvePromise => setTimeout(resolvePromise, 400))
            try { stream.close() } catch { /* already closed */ }
          },
        })
      })
    })
  }

  /** Create a directory and its parents (POSIX `mkdir -p`). */
  async mkdirp (remotePath) {
    await this.exec(`mkdir -p ${shellQuote(remotePath)}`, { timeoutMs: 30_000 })
  }

  /** Read one remote file as bytes. */
  async readFile (remotePath) {
    const sftp = await this.sftp()
    return await sftpCall(sftp, 'readFile', remotePath)
  }

  /** Write one remote file (atomic: temporary sibling then rename). */
  async writeFile (remotePath, content, mode = 0o644) {
    const sftp = await this.sftp()
    const slash = remotePath.lastIndexOf('/')
    const directory = slash <= 0 ? '/' : remotePath.slice(0, slash)
    const name = slash <= 0 ? remotePath.slice(1) : remotePath.slice(slash + 1)
    await this.mkdirp(directory)
    const temporary = `${directory}/.${name}.tmp-${process.pid}-${Date.now()}`
    await new Promise((resolvePromise, rejectPromise) => {
      sftp.writeFile(temporary, content, { mode }, error => error ? rejectPromise(error) : resolvePromise())
    })
    try {
      await new Promise((resolvePromise, rejectPromise) => {
        sftp.rename(temporary, remotePath, error => error ? rejectPromise(error) : resolvePromise())
      })
    } catch (error) {
      // Some SFTP servers refuse rename-over-existing. Fall back to a direct
      // write so a configuration file is still published; the temporary file
      // is removed afterwards.
      try {
        await new Promise((resolvePromise, rejectPromise) => {
          sftp.writeFile(remotePath, content, { mode }, error2 => error2 ? rejectPromise(error2) : resolvePromise())
        })
      } catch (error2) {
        throw new Error(`SFTP 写入 ${remotePath} 失败：${errorMessage(error2)}（临时文件 rename 也失败：${errorMessage(error)}）`)
      }
      try { await sftpCall(sftp, 'unlink', temporary) } catch { /* best-effort */ }
    }
    try { await sftpCall(sftp, 'chmod', remotePath, mode) } catch { /* mode may be unsupported */ }
  }

  /** List a remote directory. */
  async readdir (remotePath) {
    const sftp = await this.sftp()
    const list = await sftpCall(sftp, 'readdir', remotePath)
    return list.map(entry => {
      const attrs = entry.attrs ?? {}
      const longname = typeof entry.longname === 'string' ? entry.longname : ''
      return {
        name: entry.filename,
        isDirectory: typeof attrs.isDirectory === 'function' ? attrs.isDirectory() : longname.startsWith('d'),
        isSymbolicLink: typeof attrs.isSymbolicLink === 'function' ? attrs.isSymbolicLink() : longname.startsWith('l'),
        size: typeof attrs.size === 'number' ? attrs.size : undefined,
        mtime: typeof attrs.mtime === 'number' ? attrs.mtime * 1000 : undefined,
      }
    })
  }

  /** Stat one remote path; `undefined` when missing. */
  async stat (remotePath) {
    const sftp = await this.sftp()
    try {
      const attrs = await sftpCall(sftp, 'stat', remotePath)
      return {
        isDirectory: typeof attrs.isDirectory === 'function' ? attrs.isDirectory() : false,
        isFile: typeof attrs.isFile === 'function' ? attrs.isFile() : false,
        size: typeof attrs.size === 'number' ? attrs.size : 0,
        mtime: typeof attrs.mtime === 'number' ? attrs.mtime * 1000 : 0,
      }
    } catch (error) {
      if (error?.code === 2 || /No such file/iu.test(errorMessage(error))) return undefined
      throw error
    }
  }

  /** Delete one remote file (best-effort). */
  async unlink (remotePath) {
    const sftp = await this.sftp()
    try { await sftpCall(sftp, 'unlink', remotePath) } catch { /* already gone */ }
  }

  /** The remote home directory. */
  async home () {
    const result = await this.exec('printf "%s\\n" "$HOME"', { timeoutMs: 15_000 })
    const home = result.stdout.trim().split(/\r?\n/u)[0] ?? ''
    if (!home.startsWith('/')) throw new Error(`无法确定远端 home 目录：${result.stderr || result.stdout}`)
    return home
  }

  /** Compact environment probe. */
  async probe () {
    const script = [
      'printf "HOME=%s\\n" "$HOME"',
      'printf "USER=%s\\n" "$(id -un 2>/dev/null || whoami)"',
      'printf "OS=%s\\n" "$(uname -s 2>/dev/null || echo unknown)"',
      'printf "ARCH=%s\\n" "$(uname -m 2>/dev/null || echo unknown)"',
      'printf "NODE=%s\\n" "$(node -v 2>/dev/null || true)"',
      'printf "NPM=%s\\n" "$(npm -v 2>/dev/null || true)"',
      'printf "DSH=%s\\n" "$(command -v dsh 2>/dev/null || true)"',
      'printf "RG=%s\\n" "$(command -v rg 2>/dev/null || true)"',
      'printf "GIT=%s\\n" "$(command -v git 2>/dev/null || true)"',
    ].join('; ')
    const result = await this.exec(script, { timeoutMs: 30_000 })
    const values = {}
    for (const line of result.stdout.split(/\r?\n/u)) {
      const index = line.indexOf('=')
      if (index > 0) values[line.slice(0, index)] = line.slice(index + 1).trim()
    }
    return {
      home: values.HOME ?? '',
      user: values.USER ?? this.host.user,
      os: values.OS ?? 'unknown',
      arch: values.ARCH ?? '',
      node: values.NODE ?? '',
      npm: values.NPM ?? '',
      dsh: values.DSH ?? '',
      rg: values.RG ?? '',
      git: values.GIT ?? '',
    }
  }

  /**
   * Open a local loopback port forwarded to `remotePort` on the host.
   *
   * @param {number} remotePort - port on the remote loopback interface.
   * @returns {Promise<{localPort:number, close:() => Promise<void>}>}
   */
  async forward (remotePort) {
    if (this.server !== undefined && this.forwardPort !== undefined) {
      return { localPort: this.forwardPort, close: () => this.closeForward() }
    }
    await this.connect()
    const server = createServer((socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
      socket.on('error', () => {})
      this.client.forwardOut('127.0.0.1', socket.remotePort ?? 0, '127.0.0.1', remotePort, (error, stream) => {
        if (error) {
          socket.destroy()
          return
        }
        socket.pipe(stream).pipe(socket)
        stream.on('error', () => socket.destroy())
        stream.on('close', () => socket.destroy())
        socket.on('close', () => {
          try { stream.destroy() } catch { /* already gone */ }
        })
      })
    })
    await new Promise((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', rejectPromise)
        resolvePromise()
      })
    })
    const address = server.address()
    this.server = server
    this.forwardPort = typeof address === 'object' && address !== null ? address.port : remotePort
    return { localPort: this.forwardPort, close: () => this.closeForward() }
  }

  /** Close the forward listener and every bridged socket. */
  async closeForward () {
    const server = this.server
    this.server = undefined
    this.forwardPort = undefined
    for (const socket of this.sockets) {
      try { socket.destroy() } catch { /* best-effort */ }
    }
    this.sockets.clear()
    if (server !== undefined) {
      await new Promise((resolvePromise) => server.close(() => resolvePromise()))
    }
  }

  /** Close the connection and release every channel. */
  async close () {
    await this.closeForward()
    try { this.sftpSession?.end?.() } catch { /* already closed */ }
    this.sftpSession = undefined
    try { this.client?.end() } catch { /* already closed */ }
    this.client = undefined
    this.connected = false
  }
}

/** Probe one SSH host without keeping a long-lived connection. */
export async function probeSshHost (host, options = {}) {
  const transport = new SshTransport(host, options)
  try {
    const info = await transport.probe()
    return { ok: true, ...info }
  } finally {
    await transport.close()
  }
}

