/**
 * Remote workspace status monitor.
 *
 * DSH lists `ssh://<alias>/<path>` workspaces from
 * `@shiqyka/dsh-ssh-workspace`, but that plugin only connects lazily and keeps
 * its connection pool private. This monitor gives the browser a small, honest
 * status surface for those rows: list the registered remote workspaces, probe
 * one over SSH on demand, and keep a short phase log (connect, handshake,
 * directory check, device name) so a hover card can explain a slow or failed
 * workspace instead of showing a spinner that never ends.
 *
 * The probe is deliberately separate from the workspace plugin's pool. It opens
 * its own short-lived connection, records timings, and closes it; the shared
 * host store (`$DSH_HOME/dsh-ssh.json`) supplies credentials and known keys.
 *
 * @module dsh-remote-anywhere/remote-workspaces
 */

import { resolveSshHost } from './store.js'
import { SshTransport } from './ssh.js'
import { errorMessage } from './util.js'

const SSH_SCHEME = 'ssh://'
const MAX_LOG = 80
const DEFAULT_PROBE_TIMEOUT_MS = 15_000
const DEFAULT_CONNECT_TIMEOUT_MS = 8_000

/**
 * Parse one `ssh://alias/path` workspace path.
 *
 * The browser half of the workspace plugin displays the alias with a trailing
 * `@` (`ssh://alias@/path`) but the registry stores the plain spelling, so
 * both are accepted here.
 *
 * @param {unknown} value - workspace path.
 * @returns {{alias: string, directory: string} | undefined} parsed parts, or
 *   `undefined` when the value is not a remote workspace path.
 */
export function parseRemoteWorkspacePath (value) {
  if (typeof value !== 'string' || !value.startsWith(SSH_SCHEME)) return undefined
  const rest = value.slice(SSH_SCHEME.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return undefined
  const alias = rest.slice(0, slash).replace(/@$/u, '')
  if (alias === '') return undefined
  const directory = rest.slice(slash)
  if (!directory.startsWith('/')) return undefined
  return { alias, directory }
}

function newRecord () {
  return {
    state: 'unknown',
    address: '',
    authKind: '',
    device: '',
    checkedAt: 0,
    durationMs: 0,
    startedAt: 0,
    error: '',
    log: [],
  }
}

/** One remote workspace monitor. */
export class RemoteWorkspaceMonitor {
  /**
   * @param {object} ctx - host plugin context (only `get()` is used).
   * @param {object} [config] - plugin config (`workspaceStatus` section).
   */
  constructor (ctx, config = {}) {
    const tuning = config.workspaceStatus ?? {}
    this.ctx = ctx
    this.enabled = tuning.enabled !== false
    this.probeTimeoutMs = Number.isFinite(tuning.probeTimeoutMs) && tuning.probeTimeoutMs > 0
      ? tuning.probeTimeoutMs
      : DEFAULT_PROBE_TIMEOUT_MS
    this.connectTimeoutMs = Number.isFinite(tuning.connectTimeoutMs) && tuning.connectTimeoutMs > 0
      ? tuning.connectTimeoutMs
      : DEFAULT_CONNECT_TIMEOUT_MS
    /** @type {Map<string, object>} path → record. */
    this.records = new Map()
    /** @type {Map<string, Promise<object>>} path → in-flight probe. */
    this.inflight = new Map()
    this.disposed = false
  }

  /** The workspace registry, when this deployment has one. */
  #registry () {
    try {
      return this.ctx.get('workspaceRegistry')
    } catch {
      return undefined
    }
  }

  /** One record, created on demand. */
  #record (path) {
    let record = this.records.get(path)
    if (record === undefined) {
      record = newRecord()
      this.records.set(path, record)
    }
    return record
  }

  /** Append one line to a record's ring log. */
  #log (record, text, level = 'info') {
    record.log.push({ at: Date.now(), text, level })
    if (record.log.length > MAX_LOG) record.log.splice(0, record.log.length - MAX_LOG)
  }

  /** Public snapshot of one record. */
  #snapshot (path, title) {
    const record = this.records.get(path) ?? newRecord()
    const parsed = parseRemoteWorkspacePath(path)
    return {
      id: path,
      title: typeof title === 'string' && title !== '' ? title : path,
      path,
      alias: parsed?.alias ?? '',
      directory: parsed?.directory ?? '',
      address: record.address,
      authKind: record.authKind,
      device: record.device,
      state: record.state,
      hot: false,
      checkedAt: record.checkedAt,
      durationMs: record.durationMs,
      error: record.error,
      log: record.log.slice(-40),
    }
  }

  /**
   * List registered `ssh://` workspaces with their last known status.
   *
   * This never connects: an unknown workspace stays `unknown` until the
   * browser asks for a probe, which keeps a page load from opening one SSH
   * connection per remote workspace.
   *
   * @returns {Array<object>} workspace snapshots.
   */
  list () {
    if (!this.enabled) return []
    const registry = this.#registry()
    const entities = typeof registry?.list === 'function' ? registry.list() : []
    const rows = []
    for (const entity of Array.isArray(entities) ? entities : []) {
      const path = typeof entity?.path === 'string' ? entity.path : ''
      const parsed = parseRemoteWorkspacePath(path)
      if (parsed === undefined) continue
      const snapshot = this.#snapshot(path, entity?.title)
      snapshot.id = String(entity?.id ?? path)
      rows.push(snapshot)
    }
    return rows
  }

  /** One workspace snapshot by path. */
  get (path) {
    return this.#snapshot(path)
  }

  /**
   * Probe one remote workspace. Concurrent calls for the same path share one
   * connection attempt (and one log) instead of racing each other.
   *
   * @param {string} path - `ssh://alias/path`.
   * @returns {Promise<object>} the resulting snapshot.
   */
  async probe (path) {
    if (!this.enabled) throw new Error('remote workspace status is disabled')
    if (this.disposed) throw new Error('remote workspace monitor is disposed')
    const parsed = parseRemoteWorkspacePath(path)
    if (parsed === undefined) throw new Error(`不是 ssh:// 工作区路径：${path}`)
    const existing = this.inflight.get(path)
    if (existing !== undefined) return await existing
    const task = this.#runProbe(path, parsed).finally(() => {
      if (this.inflight.get(path) === task) this.inflight.delete(path)
    })
    this.inflight.set(path, task)
    return await task
  }

  /** Execute one probe and always resolve to a snapshot. */
  async #runProbe (path, parsed) {
    const record = this.#record(path)
    const started = Date.now()
    record.state = 'checking'
    record.startedAt = started
    record.error = ''
    this.#log(record, `开始检查 ${parsed.alias}`)

    let transport
    try {
      const host = await resolveSshHost(parsed.alias)
      record.address = `${host.user}@${host.host}:${host.port}`
      record.authKind = host.auth?.kind ?? 'agent'
      this.#log(record, `主机配置：${record.address}`)

      transport = new SshTransport(host, {
        connectTimeoutMs: this.connectTimeoutMs,
        keepaliveIntervalMs: 0,
      })
      const connectStart = Date.now()
      await this.#withTimeout(transport.connect(), this.connectTimeoutMs + 2_000, 'SSH 连接超时')
      this.#log(record, `SSH 连接建立（${Date.now() - connectStart}ms）`, 'ok')

      const statStart = Date.now()
      const info = await this.#withTimeout(transport.stat(parsed.directory), this.probeTimeoutMs, '目录检查超时')
      if (info === undefined) throw new Error(`目录不存在：${parsed.directory}`)
      if (info.isDirectory !== true) throw new Error(`不是目录：${parsed.directory}`)
      this.#log(record, `目录可访问（${Date.now() - statStart}ms）`, 'ok')

      const nameStart = Date.now()
      const result = await this.#withTimeout(
        transport.exec('uname -n 2>/dev/null || hostname 2>/dev/null || true', { timeoutMs: 5_000, maxBytes: 4_096 }),
        this.probeTimeoutMs,
        '读取设备名超时',
      )
      const device = (result.stdout ?? '').trim().split(/\r?\n/u)[0] ?? ''
      if (device !== '') {
        record.device = device
        this.#log(record, `设备：${device}（${Date.now() - nameStart}ms）`, 'info')
      }

      record.state = 'connected'
      record.durationMs = Date.now() - started
      record.checkedAt = Date.now()
      this.#log(record, `检查完成（${record.durationMs}ms）`, 'ok')
      return this.#snapshot(path, this.#titleOf(path))
    } catch (error) {
      record.state = 'failed'
      record.error = errorMessage(error)
      record.durationMs = Date.now() - started
      record.checkedAt = Date.now()
      this.#log(record, `检查失败：${record.error}`, 'err')
      return this.#snapshot(path, this.#titleOf(path))
    } finally {
      if (transport !== undefined) {
        try { await transport.close() } catch { /* the probe already settled */ }
      }
      if (this.disposed) this.records.delete(path)
    }
  }

  /** Registry title for a path, falling back to the path itself. */
  #titleOf (path) {
    try {
      const registry = this.#registry()
      const entities = typeof registry?.list === 'function' ? registry.list() : []
      const entity = Array.isArray(entities) ? entities.find(item => item?.path === path) : undefined
      if (typeof entity?.title === 'string' && entity.title !== '') return entity.title
    } catch { /* registry may disappear during teardown */ }
    return path
  }

  /** Race one promise against a labelled timeout. */
  #withTimeout (promise, ms, label) {
    let timer
    const timeout = new Promise((_, rejectPromise) => {
      timer = setTimeout(() => rejectPromise(new Error(`${label}（${ms}ms）`)), ms)
    })
    return Promise.race([promise, timeout]).finally(() => { clearTimeout(timer) })
  }

  /** Mark disposed and drop cached records (in-flight probes settle alone). */
  dispose () {
    this.disposed = true
    this.records.clear()
  }
}
