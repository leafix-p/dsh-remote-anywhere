/**
 * Remote Anywhere orchestration: targets, connections, the connect pipeline,
 * and the small amount of persistent settings the panel owns.
 *
 * A connection is a long-lived object shared with the browser half. Its
 * lifecycle is deliberately explicit (`steps`, `state`, `error`) so the UI can
 * show what a slow first connection is doing instead of a spinner.
 *
 * @module dsh-remote-anywhere/remote
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  atomicWriteJson,
  dshHome,
  errorMessage,
  isPosixAbsolute,
  makeId,
  normalizePosix,
  nodeMajor,
  posixBasename,
  posixJoin,
  readJson,
  safeSegment,
  sleep,
} from './util.js'
import {
  deleteSshHost,
  inspectWslDistro,
  listSshHosts,
  listWslDistros,
  resolveSshHost,
  saveSshHost,
  targetHome,
} from './store.js'
import { SshTransport } from './ssh.js'
import { WslTransport } from './wsl.js'
import { launchLocal } from './launcher.js'
import {
  ensureRemoteDsh,
  ensureRemoteWorkspace,
  localDshVersion,
  startRemoteDsh,
  stopRemoteDsh,
  syncRemoteConfiguration,
  waitForHttp,
} from './sync.js'
import { LogBuffer } from './util.js'

/** Settings file next to the SSH store. */
function settingsPath () {
  return join(dshHome(), 'dsh-remote-anywhere.json')
}

/** Default connection options. */
const DEFAULT_OPTIONS = {
  syncCredentials: true,
  syncPlugins: true,
  syncSkills: true,
  syncPrompts: true,
  npmRegistry: '',
  dshVersion: 'auto',
  pluginsTimeoutMs: 300_000,
  startTimeoutMs: 120_000,
}

/** Target id helpers. */
export function sshTargetId (alias) {
  return `ssh:${alias}`
}

export function wslTargetId (distro) {
  return `wsl:${distro}`
}

/** Split a target id. */
function parseTargetId (targetId) {
  const text = String(targetId ?? '')
  if (text.startsWith('ssh:') && text.length > 4) return { kind: 'ssh', value: text.slice(4) }
  if (text.startsWith('wsl:') && text.length > 4) return { kind: 'wsl', value: text.slice(4) }
  return undefined
}

/** One dsh-remote-anywhere instance. */
export class RemoteAnywhere {
  /**
   * @param {object} ctx - host plugin context.
   * @param {object} config - plugin config.
   */
  constructor (ctx, config = {}) {
    this.ctx = ctx
    this.config = config
    this.connections = new Map()
    this.targetsCache = undefined
    this.targetsAt = 0
    this.wslCache = undefined
    this.wslAt = 0
    this.wslRefresh = undefined
    this.wslPending = false
    this.settings = { ...DEFAULT_OPTIONS }
    this.settingsLoaded = false
    this.disposed = false
    this.localVersion = localDshVersion()
    this.localNode = process.version
  }

  /** Load persisted options once. */
  async loadSettings () {
    if (this.settingsLoaded) return
    this.settingsLoaded = true
    const fromConfig = this.config.sync ?? {}
    this.settings = {
      ...DEFAULT_OPTIONS,
      ...(fromConfig.credentials === false ? { syncCredentials: false } : {}),
      ...(fromConfig.plugins === false ? { syncPlugins: false } : {}),
      ...(fromConfig.skills === false ? { syncSkills: false } : {}),
      ...(fromConfig.prompts === false ? { syncPrompts: false } : {}),
      ...(typeof this.config.npmRegistry === 'string' ? { npmRegistry: this.config.npmRegistry } : {}),
      ...(typeof this.config.dshVersion === 'string' ? { dshVersion: this.config.dshVersion } : {}),
    }
    try {
      const stored = await readJson(settingsPath())
      if (stored !== undefined && typeof stored === 'object' && stored !== null) {
        this.settings = { ...this.settings, ...stored }
      }
    } catch { /* a broken settings file keeps defaults */ }
  }

  /** Persist options. */
  async saveSettings (patch) {
    await this.loadSettings()
    const next = { ...this.settings }
    if (typeof patch?.syncCredentials === 'boolean') next.syncCredentials = patch.syncCredentials
    if (typeof patch?.syncPlugins === 'boolean') next.syncPlugins = patch.syncPlugins
    if (typeof patch?.syncSkills === 'boolean') next.syncSkills = patch.syncSkills
    if (typeof patch?.syncPrompts === 'boolean') next.syncPrompts = patch.syncPrompts
    if (typeof patch?.npmRegistry === 'string') next.npmRegistry = patch.npmRegistry.trim()
    if (typeof patch?.dshVersion === 'string' && patch.dshVersion.trim() !== '') next.dshVersion = patch.dshVersion.trim()
    this.settings = next
    try { await atomicWriteJson(settingsPath(), next, 0o600) } catch { /* settings are a convenience */ }
    return next
  }

  /** All targets: SSH hosts first, then WSL distributions. */
  async listTargets ({ refresh = false } = {}) {
    await this.loadSettings()
    if (!refresh && this.targetsCache !== undefined && Date.now() - this.targetsAt < 15_000) return this.targetsCache
    const sshRows = await listSshHosts()
    const ssh = sshRows.map(row => ({
      id: sshTargetId(row.alias),
      kind: 'ssh',
      name: row.alias,
      detail: `${row.user === '' ? '' : `${row.user}@`}${row.host}:${row.port}`,
      source: row.source,
      alias: row.alias,
      host: row.host,
      port: row.port,
      user: row.user,
      auth: row.auth.kind,
      keyPath: row.auth.keyPath,
      agentPath: row.auth.agentPath,
      keyReady: row.keyReady,
      description: row.description,
      proxyJump: row.proxyJump,
      tags: row.tags ?? [],
      available: true,
    }))
    const distros = await this.#wslDistros(refresh)
    // Do not run a shell probe for every distro while the panel is opening:
    // a stopped or system distro (docker-desktop) can take seconds to answer,
    // which made the whole target list wait. Availability is decided by the
    // connect pipeline; the list only reports what `wsl.exe -l -q` knows.
    const wsl = distros.map(distro => ({
      ...distro,
      available: distro.system !== true,
      detail: distro.system ? `WSL · ${distro.name}（系统发行版）` : `WSL · ${distro.name}`,
      home: undefined,
      user: undefined,
    }))
    const result = {
      ssh,
      wsl,
      wslPending: this.wslPending,
      local: { version: this.localVersion, node: this.localNode },
      refreshedAt: Date.now(),
    }
    this.targetsCache = result
    this.targetsAt = Date.now()
    return result
  }

  /**
   * WSL distributions with a non-blocking cache.
   *
   * `wsl.exe -l -q` can take a long time when the WSL service is cold or
   * wedged; awaiting it made the whole target list look stuck. The browser
   * gets whatever is cached (or an empty list with `wslPending: true`) after a
   * short grace period, and polls until the background discovery finishes.
   */
  async #wslDistros (refresh) {
    const now = Date.now()
    const fresh = this.wslCache !== undefined && now - this.wslAt < 30_000
    if (!refresh && fresh) return this.wslCache
    if (this.wslRefresh === undefined) {
      this.wslPending = true
      this.wslRefresh = listWslDistros({ timeoutMs: 30_000 })
        .then(rows => {
          this.wslCache = rows
          this.wslAt = Date.now()
        })
        .catch(() => {
          if (this.wslCache === undefined) this.wslCache = []
          this.wslAt = Date.now()
        })
        .finally(() => {
          this.wslPending = false
          this.wslRefresh = undefined
          this.targetsCache = undefined
        })
    }
    await Promise.race([this.wslRefresh, sleep(1200)])
    return this.wslCache ?? []
  }

  /** Find one target by id. */
  async findTarget (targetId) {
    const parsed = parseTargetId(targetId)
    if (parsed === undefined) throw new Error(`未知的目标 ${JSON.stringify(targetId)}`)
    if (parsed.kind === 'ssh') {
      const row = (await listSshHosts()).find(item => item.alias === parsed.value)
      if (row === undefined) throw new Error(`SSH 主机 ${JSON.stringify(parsed.value)} 不存在`)
      if (typeof row.proxyJump === 'string' && row.proxyJump !== '') {
        throw new Error(`SSH 主机 ${JSON.stringify(row.alias)} 使用 ProxyJump（${row.proxyJump}）。本插件目前只支持直连；请先在 ~/.ssh/config 中改成直连，或使用系统 ssh 建立隧道。`)
      }
      return { ...row, id: sshTargetId(row.alias), kind: 'ssh', name: row.alias }
    }
    const distros = this.wslCache ?? await this.#wslDistros(false)
    const distro = distros.find(item => item.distro === parsed.value)
    if (distro === undefined) throw new Error(`WSL 发行版 ${JSON.stringify(parsed.value)} 不存在`)
    if (distro.system === true) throw new Error(`WSL 系统发行版 ${JSON.stringify(distro.name)} 不提供登录环境，无法运行远端 dsh`)
    const info = await inspectWslDistro(distro.distro)
    if (info.available === false) throw new Error(info.error ?? `WSL 发行版 ${distro.name} 不可用`)
    return {
      ...distro,
      id: wslTargetId(distro.distro),
      kind: 'wsl',
      name: distro.name,
      home: info.home,
      user: info.user,
    }
  }

  /** Create a transport for a target (resolves credentials for SSH). */
  async transportFor (target) {
    if (target.kind === 'wsl') return new WslTransport(target.distro)
    return new SshTransport(await resolveSshHost(target.alias), {
      connectTimeoutMs: this.config.connectTimeoutMs ?? 25_000,
      keepaliveIntervalMs: this.config.keepaliveIntervalMs ?? 10_000,
    })
  }

  /** Browse one remote directory. */
  async listDirectory (targetId, requestedPath) {
    const target = await this.findTarget(targetId)
    const transport = await this.transportFor(target)
    try {
      await transport.connect()
      const home = await transport.home()
      const path = requestedPath === undefined || requestedPath === '' || requestedPath === '~'
        ? home
        : (requestedPath.startsWith('~') ? posixJoin(home, requestedPath.slice(1)) : normalizePosix(requestedPath))
      if (!isPosixAbsolute(path)) throw new Error(`路径必须是绝对路径：${requestedPath}`)
      const info = await transport.stat(path)
      if (info === undefined) throw new Error(`目录不存在：${path}`)
      if (!info.isDirectory) throw new Error(`不是目录：${path}`)
      const entries = await transport.readdir(path)
      const rows = entries
        .filter(entry => entry.isDirectory)
        .map(entry => ({ name: entry.name, path: posixJoin(path, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name))
      const parent = path === '/' ? null : normalizePosix(posixJoin(path, '..'))
      return { path, parent, home, entries: rows }
    } finally {
      await transport.close()
    }
  }

  /** Snapshot exposed to the browser (never includes credentials). */
  snapshot (connection) {
    return {
      id: connection.id,
      targetId: connection.targetId,
      targetName: connection.targetName,
      targetKind: connection.targetKind,
      workspace: connection.workspace,
      state: connection.state,
      steps: connection.steps.map(step => ({ ...step })),
      error: connection.error,
      url: connection.url,
      embedUrl: connection.embedUrl,
      remotePort: connection.remotePort,
      localPort: connection.localPort,
      dshVersion: connection.dshVersion,
      node: connection.node,
      home: connection.home,
      syncReport: connection.syncReport,
      createdAt: connection.createdAt,
      readyAt: connection.readyAt,
    }
  }

  /** All connections, newest first. */
  listConnections () {
    return [...this.connections.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(connection => this.snapshot(connection))
  }

  /** One connection snapshot. */
  getConnection (id) {
    const connection = this.connections.get(id)
    if (connection === undefined) throw new Error(`连接 ${JSON.stringify(id)} 不存在`)
    return this.snapshot(connection)
  }

  /** The log tail for one connection. */
  connectionLog (id, max = 16_000) {
    const connection = this.connections.get(id)
    if (connection === undefined) throw new Error(`连接 ${JSON.stringify(id)} 不存在`)
    return connection.log.tail(max)
  }

  /** Update one step in place. */
  #step (connection, key, label, state, detail) {
    let step = connection.steps.find(item => item.key === key)
    if (step === undefined) {
      step = { key, label, state: 'pending', detail: '' }
      connection.steps.push(step)
    }
    const previousState = step.state
    step.label = label
    if (state !== undefined) step.state = state
    if (detail !== undefined) step.detail = detail
    if (state !== undefined && state !== previousState) {
      if (state === 'running') connection.log.add(`${label}…`)
      else if (state === 'done') connection.log.add(`${label}：${detail === undefined || detail === '' ? '完成' : detail}`)
      else if (state === 'error') connection.log.add(`${label}失败${detail === undefined || detail === '' ? '' : `：${detail}`}`)
    }
    connection.updatedAt = Date.now()
  }

  /**
   * Start one connection. The returned snapshot is `working`; the browser
   * polls until it becomes `ready` or `error`.
   */
  async connect (payload = {}) {
    await this.loadSettings()
    const targetId = String(payload.targetId ?? '')
    const target = await this.findTarget(targetId)
    const wantedPath = typeof payload.path === 'string' ? payload.path.trim() : ''
    // One target has one remote dsh home (`~/.dsh`). Running two servers
    // against the same home would race on the workspace registry and session
    // store, so reuse a live connection instead of starting a second one.
    const existing = [...this.connections.values()].find(connection =>
      connection.targetId === targetId && (connection.state === 'ready' || connection.state === 'working'))
    if (existing !== undefined) {
      if (wantedPath === '' || wantedPath === '~' || normalizePosix(wantedPath) === existing.workspace) {
        return this.snapshot(existing)
      }
      throw new Error(`${target.name} 已有一个远端 dsh 连接（${existing.workspace}）。请先断开它，或直接在连接里切换目录。`)
    }
    const options = {
      ...this.settings,
      ...(payload.options ?? {}),
    }
    const connection = {
      id: makeId('conn'),
      targetId,
      targetName: target.name,
      targetKind: target.kind,
      target,
      workspace: typeof payload.path === 'string' ? payload.path.trim() : '',
      state: 'working',
      steps: [],
      error: undefined,
      url: undefined,
      embedUrl: undefined,
      remotePort: undefined,
      localPort: undefined,
      dshVersion: undefined,
      node: undefined,
      home: undefined,
      syncReport: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      readyAt: undefined,
      log: new LogBuffer(),
      transport: undefined,
      forward: undefined,
      handle: undefined,
      options,
    }
    this.connections.set(connection.id, connection)
    void this.#run(connection).catch(error => this.#fail(connection, error))
    return this.snapshot(connection)
  }

  /** Mark one connection failed and release its resources. */
  async #fail (connection, error) {
    const message = errorMessage(error)
    connection.state = 'error'
    connection.error = message
    connection.log.add(`错误：${message}`)
    const running = connection.steps.find(step => step.state === 'running')
    if (running !== undefined) running.state = 'error'
    await this.#cleanup(connection)
    connection.updatedAt = Date.now()
    this.ctx.logger?.warn?.(`remote-anywhere: connection to ${connection.targetName} failed: ${message}`)
  }

  /** Stop the remote process, tunnel and transport. */
  async #cleanup (connection) {
    const transport = connection.transport
    if (connection.handle !== undefined) {
      try { await stopRemoteDsh(transport, connection.handle, connection.log) } catch { /* best-effort */ }
      connection.handle = undefined
    }
    if (connection.forward !== undefined) {
      try { await connection.forward.close() } catch { /* best-effort */ }
      connection.forward = undefined
    }
    if (transport !== undefined) {
      try { await transport.close() } catch { /* best-effort */ }
    }
  }

  /** The connect pipeline. */
  async #run (connection) {
    const { target, options } = connection
    const log = connection.log
    let transport
    try {
      this.#step(connection, 'connect', `连接 ${target.name}`, 'running')
      transport = await this.transportFor(target)
      connection.transport = transport
      await transport.connect()
      this.#step(connection, 'connect', `连接 ${target.name}`, 'done', target.kind === 'wsl' ? 'WSL 已就绪' : `${target.host}:${target.port}`)

      this.#step(connection, 'probe', '检查远端环境', 'running')
      const probe = await transport.probe()
      connection.home = probe.home
      connection.node = probe.node
      log.add(`远端环境：${probe.os} ${probe.arch} · Node ${probe.node || '缺失'} · npm ${probe.npm || '缺失'}`)
      const major = nodeMajor(probe.node)
      if (probe.node === '' || major === null || major < 22) {
        throw new Error(`远端 Node.js 不可用或版本过低（${probe.node || '未安装'}）。远端 dsh 需要 Node.js 22 或 24。`)
      }
      this.#step(connection, 'probe', '检查远端环境', 'done', `${probe.os} ${probe.arch} · Node ${probe.node}`)

      this.#step(connection, 'path', '确认工作目录', 'running')
      let workspace = connection.workspace
      if (workspace === '' || workspace === '~') workspace = probe.home
      if (workspace.startsWith('~')) workspace = posixJoin(probe.home, workspace.slice(1))
      workspace = normalizePosix(workspace)
      const directory = await transport.stat(workspace)
      if (directory === undefined) throw new Error(`远端目录不存在：${workspace}`)
      if (!directory.isDirectory) throw new Error(`不是目录：${workspace}`)
      connection.workspace = workspace
      this.#step(connection, 'path', '确认工作目录', 'done', workspace)

      this.#step(connection, 'install', '准备远端 dsh', 'running')
      const dsh = await ensureRemoteDsh(transport, {
        version: options.dshVersion,
        registry: options.npmRegistry,
        log,
        timeoutMs: 300_000,
      })
      connection.dshVersion = dsh.version
      this.#step(connection, 'install', '准备远端 dsh', 'done', `dsh ${dsh.version}`)

      this.#step(connection, 'sync', '同步本地配置', 'running')
      const report = await syncRemoteConfiguration(transport, {
        credentials: options.syncCredentials !== false,
        plugins: options.syncPlugins !== false,
        skills: options.syncSkills !== false,
        prompts: options.syncPrompts !== false,
        pluginsTimeoutMs: options.pluginsTimeoutMs,
        registry: options.npmRegistry,
        dshBin: dsh.bin,
        log,
      })
      connection.syncReport = report
      log.add(`配置同步：${report.mode === 'full' ? '完整插件集' : '基础插件集'}，技能 ${report.copiedFiles} 个文件`)
      for (const warning of report.warnings) log.add(`提示：${warning}`)
      this.#step(connection, 'sync', '同步本地配置', 'done', report.mode === 'full' ? '插件 / 模型 / 技能 / 提示词' : '基础插件 + 模型 / 技能 / 提示词')

      this.#step(connection, 'workspace', '打开远端目录', 'running')
      const workspaceRecord = await ensureRemoteWorkspace(transport, workspace, log)
      this.#step(connection, 'workspace', '打开远端目录', 'done', workspaceRecord.created ? `已注册 ${workspace}` : `已存在 ${workspace}`)

      this.#step(connection, 'start', '启动远端 dsh', 'running')
      const started = await startRemoteDsh(transport, {
        bin: dsh.bin,
        workspacePath: workspace,
        startTimeoutMs: options.startTimeoutMs,
        log,
      })
      connection.handle = started.handle
      connection.remotePort = started.port
      connection.token = started.token
      this.#step(connection, 'start', '启动远端 dsh', 'done', `端口 ${started.port}`)
      started.handle.onExit?.((code, signal) => {
        if (this.disposed || connection.closing || connection.state === 'closed') return
        connection.log.add(`远端 dsh 进程退出（code ${code ?? 'null'}${signal ? `, ${signal}` : ''}）`)
        if (connection.state === 'ready') {
          connection.state = 'error'
          connection.error = `远端 dsh 进程已退出（code ${code ?? 'null'}）`
          connection.updatedAt = Date.now()
          void this.#cleanup(connection)
        }
      })

      this.#step(connection, 'tunnel', '建立本地访问', 'running')
      const forward = await transport.forward(started.port)
      connection.forward = forward
      connection.localPort = forward.localPort
      const localUrl = new URL(started.url)
      localUrl.hostname = '127.0.0.1'
      localUrl.port = String(forward.localPort)
      connection.url = localUrl.toString()
      connection.embedUrl = localUrl.toString()
      await waitForHttp(connection.url, { timeoutMs: 45_000 })
      this.#step(connection, 'tunnel', '建立本地访问', 'done', `http://127.0.0.1:${forward.localPort}`)

      connection.state = 'ready'
      connection.readyAt = Date.now()
      log.add('远端 dsh 已就绪')
      this.ctx.logger?.info?.(`remote-anywhere: ${target.name} ready at ${connection.url.replace(/token=[^&]+/u, 'token=***')}`)
    } catch (error) {
      await this.#fail(connection, error)
    }
  }

  /** Stop one connection. */
  async disconnect (id) {
    const connection = this.connections.get(id)
    if (connection === undefined) throw new Error(`连接 ${JSON.stringify(id)} 不存在`)
    connection.closing = true
    connection.log.add('正在断开…')
    await this.#cleanup(connection)
    connection.state = 'closed'
    connection.url = undefined
    connection.embedUrl = undefined
    connection.updatedAt = Date.now()
    return this.snapshot(connection)
  }

  /**
   * Open the remote directory locally: VS Code Remote, a remote terminal, or
   * Windows Explorer (WSL only). The remote dsh connection must be ready so we
   * know the exact remote path.
   */
  async openLocal (payload = {}) {
    const connection = this.connections.get(String(payload.id ?? ''))
    if (connection === undefined) throw new Error(`连接 ${JSON.stringify(payload.id)} 不存在`)
    if (connection.state !== 'ready') throw new Error('远端 dsh 还没就绪，暂时不能打开 VS Code / 终端')
    const kind = String(payload.kind ?? '')
    const plan = await launchLocal(connection.target, connection.workspace, kind)
    connection.log.add(`已打开 ${plan.description}`)
    return { ok: true, kind, description: plan.description }
  }

  /** Re-run only the config sync (requires a live connection or transport). */
  async resync (id) {
    const connection = this.connections.get(id)
    if (connection === undefined) throw new Error(`连接 ${JSON.stringify(id)} 不存在`)
    if (connection.transport === undefined) throw new Error('连接尚未建立，无法重新同步')
    const { options } = connection
    this.#step(connection, 'sync', '同步本地配置', 'running')
    const report = await syncRemoteConfiguration(connection.transport, {
      credentials: options.syncCredentials !== false,
      plugins: options.syncPlugins !== false,
      skills: options.syncSkills !== false,
      prompts: options.syncPrompts !== false,
      pluginsTimeoutMs: options.pluginsTimeoutMs,
      registry: options.npmRegistry,
      log: connection.log,
    })
    connection.syncReport = report
    this.#step(connection, 'sync', '同步本地配置', 'done', report.mode === 'full' ? '插件 / 模型 / 技能 / 提示词' : '基础插件 + 模型 / 技能 / 提示词')
    connection.log.add('配置已重新同步；远端 dsh 需重启后生效')
    return this.snapshot(connection)
  }

  /** Resolve the default folder for a target (used by the picker). */
  async defaultFolder (targetId) {
    const target = await this.findTarget(targetId)
    if (target.kind === 'wsl' && typeof target.home === 'string' && target.home !== '') return target.home
    const info = await targetHome(target)
    return info.home
  }

  /** Save one SSH host from the editor. */
  async saveHost (payload, originalAlias) {
    const row = await saveSshHost(payload, originalAlias)
    this.targetsCache = undefined
    return row
  }

  /** Delete one SSH host. */
  async deleteHost (alias) {
    await deleteSshHost(alias)
    this.targetsCache = undefined
  }

  /** Best-effort shutdown of every live connection. */
  async dispose () {
    if (this.disposed) return
    this.disposed = true
    const connections = [...this.connections.values()]
    await Promise.allSettled(connections.map(async (connection) => {
      await this.#cleanup(connection)
      connection.state = 'closed'
    }))
  }
}

/** Human title for a workspace path (used by the page header). */
export function workspaceTitle (path) {
  return safeSegment(posixBasename(path))
}

/** True when a path looks like a directory we can launch in. */
export function isAbsoluteRemotePath (path) {
  return isPosixAbsolute(path)
}

/** Sleep re-export for tests. */
export { sleep }

