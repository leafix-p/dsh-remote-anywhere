/**
 * Remote devices inside DSH's own "add workspace" directory browser.
 *
 * DSH renders one workspace picker: the `ctx.directoryPicker` service behind
 * the `browse` capability, consumed by `dsh-client-ui-directory-picker-browse`.
 * That browser asks for one directory level at a time and never manipulates
 * paths itself — it opens whatever `path` a row carries. This module therefore
 * teaches the seam one extra spelling instead of shipping a second picker:
 *
 *   - `ssh://`          the device root: one row per configured SSH host.
 *   - `ssh://alias/`    that host's filesystem root, with a `~` shortcut row.
 *   - `ssh://alias/abs` one remote directory over SFTP.
 *
 * Local paths are delegated to the deployment's own implementation unchanged,
 * and the local HOME level gains the device rows so "Add workspace" shows both
 * worlds in one list. Every path the browser commits goes through the ordinary
 * `workspaces.create` RPC, so a remote directory becomes an `ssh://` workspace
 * exactly like one mounted by `ssh_workspace_mount`.
 *
 * @module dsh-remote-anywhere/directory-picker
 */

import {
  formatRemotePath,
  isRemotePath,
  parseRemotePath,
} from '../vendor/ssh-workspace/lib/protocol.js'
import { errorMessage } from './util.js'

/** The virtual root that lists every configured device. */
const DEVICE_ROOT = 'ssh://'

/** Bound on one remote level, matching the local backend's 1,000-row budget. */
const MAX_ENTRIES = 1000

/** One remote round-trip may not outlive this. */
const REMOTE_TIMEOUT_MS = 10_000

/** The device list is cheap but not free (settings + ssh config reads). */
const DEVICE_CACHE_MS = 5_000

/** Marker preventing a double wrap across plugin reloads. */
const MARKER = Symbol.for('dsh-remote-anywhere/directory-picker')

/** POSIX join for remote absolute paths. */
function joinRemote (base, name) {
  const left = base === '/' ? '' : String(base).replace(/\/+$/u, '')
  return `${left}/${name}`
}

/**
 * Turn a transport failure into something an operator can act on.
 *
 * The raw messages here are ssh2's (`Failed to retrieve identities from
 * agent`, `All configured authentication methods failed`), which say nothing
 * about the fix — the fix being "give this host a password or a key".
 *
 * @param {string} alias - the host alias being read.
 * @param {unknown} error - the transport failure.
 * @returns {string} the operator-facing message.
 */
function describeRemoteFailure (alias, error) {
  const message = errorMessage(error)
  if (/identit|agent|SSH_AUTH_SOCK/iu.test(message)) {
    return `无法连接「${alias}」：这台主机配置为 SSH Agent 认证，但本机没有可用的 agent。` +
      '请在「远程资源管理器」里为它保存密码或私钥后再试。'
  }
  if (/authentication|auth methods/iu.test(message)) {
    return `无法连接「${alias}」：认证失败。请在「远程资源管理器」里检查这台主机的密码或私钥配置。`
  }
  if (/timed? ?out|超时/iu.test(message)) return `无法连接「${alias}」：连接超时，主机可能不可达。`
  return `无法读取「${alias}」的目录：${message}`
}

/** Reject after `ms`, never leaving the timer ref'd once the race settles. */
function withTimeout (promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}（${ms}ms）`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => { clearTimeout(timer) })
}

/** Resolve with the SFTP handle's answer, reject on its error argument. */
function sftpCall (sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (error, value) => {
      if (error !== undefined && error !== null) reject(error)
      else resolve(value)
    })
  })
}

/**
 * Ancestor chain from the device root down to one remote directory.
 *
 * The first crumb is the device list itself, so a deep remote directory stays
 * one click away from switching hosts.
 */
function remoteCrumbs (alias, directory) {
  const crumbs = [{ name: '远程设备', path: DEVICE_ROOT, hidden: false }]
  crumbs.push({ name: alias, path: `ssh://${alias}/`, hidden: false })
  let current = ''
  for (const segment of String(directory).split('/')) {
    if (segment === '') continue
    current += `/${segment}`
    crumbs.push({ name: segment, path: formatRemotePath(alias, current), hidden: false })
  }
  return crumbs
}

/**
 * Install the `ssh://` branch onto the live directory-picker service.
 *
 * @param {object} ctx - host plugin context.
 * @param {object} deps - collaborators.
 * @param {object} [deps.engine] - the embedded SSH engine (`withSftp`).
 * @param {object} [deps.explorer] - the Remote Anywhere service (`listTargets`).
 * @param {object} [config] - `directoryPicker` config.
 * @param {boolean} [config.enabled] - set false to keep the deployment's own picker.
 * @param {boolean} [config.localDevices] - list devices in the local HOME level (default true).
 * @returns {() => void} disposer.
 */
export function installRemoteDirectoryPicker (ctx, deps, config = {}) {
  if (config.enabled === false) return () => {}
  const engine = deps?.engine
  const explorer = deps?.explorer
  if (engine === undefined || engine === null || typeof engine.withSftp !== 'function') return () => {}
  if (explorer === undefined || explorer === null || typeof explorer.listTargets !== 'function') return () => {}

  /** alias -> remote HOME, filled by the first listing of that device. */
  const homes = new Map()
  /** Cached device rows for the local HOME level. */
  let deviceCache
  let deviceCacheAt = 0
  const disposers = []
  let fiber

  /**
   * The configured SSH hosts, as browser rows.
   *
   * WSL distributions are deliberately absent: `ssh://` addresses an SSH
   * connection, and a WSL distribution's filesystem is already reachable as an
   * ordinary local path.
   *
   * @returns {Promise<Array<{name: string, path: string, hidden: boolean}>>} rows.
   */
  const deviceRows = async () => {
    if (deviceCache !== undefined && Date.now() - deviceCacheAt < DEVICE_CACHE_MS) return deviceCache
    let targets
    try {
      targets = await withTimeout(explorer.listTargets(), REMOTE_TIMEOUT_MS, '读取远程设备列表超时')
    } catch (error) {
      ctx.logger?.warn?.(`remote-anywhere: could not list devices for the workspace picker: ${errorMessage(error)}`)
      return []
    }
    // One machine reached under two aliases (a saved host plus the same
    // address in ~/.ssh/config) is one row: otherwise the list is a wall of
    // identical IPs and the operator cannot tell which one has credentials.
    const seen = new Map()
    const picked = []
    for (const target of targets?.ssh ?? []) {
      if (typeof target?.alias !== 'string' || target.alias === '') continue
      // `ssh://` needs a credential this machine can actually present. A host
      // that would fall back to ssh-agent is not offered here: that fallback is
      // exactly what failed with ssh2's `Failed to retrieve identities from
      // agent`, and a directory browser cannot explain it. Those hosts stay in
      // the Remote Explorer panel for a remote-dsh connection.
      if (target.source !== 'store' && target.source !== 'ssh-config') continue
      if (target.auth === 'agent') continue
      if (target.source === 'ssh-config' && target.keyReady === false) continue
      const key = `${target.user ?? ''}@${target.host ?? ''}:${target.port ?? 22}`
      const prior = seen.get(key)
      if (prior === undefined) {
        seen.set(key, target)
        picked.push(target)
        continue
      }
      // The store entry wins: it carries the credentials and a real alias.
      if (prior.source !== 'store' && target.source === 'store') {
        picked[picked.indexOf(prior)] = target
        seen.set(key, target)
      }
    }
    picked.sort((left, right) => {
      const bySource = (left.source === 'store' ? 0 : 1) - (right.source === 'store' ? 0 : 1)
      return bySource !== 0 ? bySource : left.alias.localeCompare(right.alias)
    })
    const rows = picked.map(target => ({
      name: target.alias,
      path: `ssh://${target.alias}/`,
      hidden: false,
    }))
    deviceCache = rows
    deviceCacheAt = Date.now()
    return rows
  }

  /**
   * The device list itself, as one browse level.
   *
   * @param {string} [localHome] - the local HOME, used for the way back.
   * @returns {Promise<object>} the device level.
   */
  const deviceRootListing = async (localHome) => {
    const entries = []
    // Without this row the depth-first browser has no exit from the remote
    // world except cancelling the whole dialog.
    if (typeof localHome === 'string' && localHome !== '') {
      entries.push({ name: '本地磁盘', path: localHome, hidden: false })
    }
    entries.push(...await deviceRows())
    return {
      path: DEVICE_ROOT,
      home: DEVICE_ROOT,
      crumbs: [{ name: '远程设备', path: DEVICE_ROOT, hidden: false }],
      entries,
      truncated: false,
    }
  }

  /** One remote directory level, plus the `~` shortcut row. */
  const remoteListing = async (alias, directory, signal) => {
    const target = directory === '' ? '/' : directory
    const rows = await withTimeout(
      engine.withSftp(alias, sftp => sftpCall(sftp, 'readdir', target)),
      REMOTE_TIMEOUT_MS,
      `读取 ${alias}:${target} 超时`,
    )
    if (signal?.aborted === true) throw new Error('aborted')

    let home = homes.get(alias)
    if (home === undefined) {
      // `realpath('.')` is the remote account's HOME; one extra round-trip on
      // the first listing of a device powers the `~` row and the Home crumb.
      home = await withTimeout(
        engine.withSftp(alias, sftp => sftpCall(sftp, 'realpath', '.')),
        REMOTE_TIMEOUT_MS,
        `读取 ${alias} 的主目录超时`,
      ).catch(() => undefined)
      if (typeof home !== 'string' || home === '') home = undefined
      if (home !== undefined) homes.set(alias, home)
    }

    const entries = []
    if (home !== undefined && home !== target) {
      entries.push({ name: '~ 主目录', path: formatRemotePath(alias, home), hidden: false })
    }
    for (const row of Array.isArray(rows) ? rows : []) {
      const name = row?.filename
      if (typeof name !== 'string' || name === '.' || name === '..') continue
      if (row.attrs?.isDirectory?.() !== true) continue
      entries.push({
        name,
        path: formatRemotePath(alias, joinRemote(target, name)),
        hidden: name.startsWith('.'),
      })
    }
    entries.sort((left, right) => {
      // The shortcut stays on top; the rest is the browser's usual name order.
      if (left.name === '~ 主目录') return -1
      if (right.name === '~ 主目录') return 1
      return left.name.localeCompare(right.name)
    })
    const truncated = entries.length > MAX_ENTRIES
    return {
      path: formatRemotePath(alias, target),
      home: home === undefined ? DEVICE_ROOT : formatRemotePath(alias, home),
      crumbs: remoteCrumbs(alias, target),
      entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries,
      truncated,
    }
  }

  /** Create one child directory on the host named by `path`. */
  const createRemoteDirectory = async (path, name) => {
    const parsed = parseRemotePath(path)
    if (parsed === undefined) throw new Error(`not a remote directory: ${path}`)
    const target = joinRemote(parsed.remotePath, name)
    try {
      await withTimeout(
        engine.withSftp(parsed.alias, sftp => sftpCall(sftp, 'mkdir', target)),
        REMOTE_TIMEOUT_MS,
        `在 ${parsed.alias}:${target} 新建目录超时`,
      )
    } catch (error) {
      const message = errorMessage(error)
      throw new Error(/exist/iu.test(message)
        ? `cannot create ${target}: ${target} already exists`
        : `cannot create ${target}: ${message}`)
    }
    return formatRemotePath(parsed.alias, target)
  }

  /**
   * Put the device list one row above the local HOME level's own children.
   *
   * A row per host would bury the local directories under a dozen IP-named
   * entries; one labelled doorway keeps the local list intact and still makes
   * "Add workspace" the single place where both worlds start.
   *
   * @param {object} listing - the local backend's listing.
   * @returns {Promise<object>} the listing with the doorway on top.
   */
  const withDevices = async (listing) => {
    if (config.localDevices === false) return listing
    if (listing?.path !== listing?.home) return listing
    const rows = await deviceRows()
    if (rows.length === 0) return listing
    const doorway = {
      name: `远程设备（${rows.length}）`,
      path: DEVICE_ROOT,
      hidden: false,
    }
    const rest = (listing.entries ?? []).filter(entry => entry.path !== DEVICE_ROOT)
    return { ...listing, entries: [doorway, ...rest] }
  }

  fiber = ctx.inject(['directoryPicker'], (scoped) => {
    const service = scoped.get('directoryPicker')
    if (service === undefined || service === null || typeof service.capability !== 'function') return
    if (service[MARKER] === true) return
    const capability = service.capability()
    if (capability?.kind !== 'browse') {
      ctx.logger?.info?.(
        `remote-anywhere: the directory picker is "${capability?.kind ?? 'unknown'}", not "browse"; ` +
        'remote devices stay out of the Add-workspace dialog (pin @deepseek-ai/dsh-host-directory-picker-browse to enable them)',
      )
      return
    }
    const base = capability
    // The capability object must stay stable for the service lifetime, so it is
    // built once here and returned by the patched method on every call.
    const bridged = {
      kind: 'browse',
      list: async (path, signal) => {
        // `ssh://` alone is not a remote target (no alias), so it is matched
        // before the generic branch.
        if (path === DEVICE_ROOT) {
          const local = await base.list(undefined, signal).catch(() => undefined)
          return await deviceRootListing(local?.home ?? local?.path)
        }
        if (isRemotePath(path)) {
          const parsed = parseRemotePath(path)
          if (parsed === undefined) throw new Error(`not a remote target: ${path}`)
          try {
            return await remoteListing(parsed.alias, parsed.remotePath, signal)
          } catch (error) {
            if (signal?.aborted === true) throw error
            ctx.logger?.warn?.(`remote-anywhere: listing ${path} failed: ${errorMessage(error)}`)
            throw new Error(describeRemoteFailure(parsed.alias, error))
          }
        }
        const listing = await base.list(path, signal)
        return await withDevices(listing)
      },
      createDirectory: async (path, name) => {
        if (isRemotePath(path)) return await createRemoteDirectory(path, name)
        return await base.createDirectory(path, name)
      },
    }
    const original = service.capability
    Object.defineProperty(service, 'capability', {
      value: () => bridged,
      writable: true,
      configurable: true,
      enumerable: false,
    })
    Object.defineProperty(service, MARKER, { value: true, configurable: true })
    disposers.push(() => {
      delete service[MARKER]
      if (service.capability !== original) {
        Object.defineProperty(service, 'capability', {
          value: original,
          writable: true,
          configurable: true,
          enumerable: false,
        })
      }
    })
    ctx.logger?.info?.('remote-anywhere: remote devices are available in the Add-workspace dialog')
  })

  // A workspace created from the browser arrives at the ordinary registry
  // `create` path, which knows nothing about `ssh://` roots. Mount the remote
  // root before registration so the new workspace is writable from its first
  // turn rather than only after the next restart's re-mount sweep.
  const registryFiber = ctx.inject(['fs', 'workspaceRegistry'], (scoped) => {
    const fs = scoped.get('fs')
    const registry = scoped.get('workspaceRegistry')
    if (typeof fs?.addRoot !== 'function' || typeof registry?.create !== 'function') return
    if (registry[MARKER] === true) return
    const original = registry.create
    const wrapped = async function (path, title) {
      if (path === DEVICE_ROOT) {
        throw new Error('「远程设备」只是主机列表，不是目录。请先进入某台主机、选好要打开的目录，再点「打开」。')
      }
      if (isRemotePath(path)) {
        try {
          const parsed = parseRemotePath(path)
          if (parsed !== undefined) fs.addRoot(parsed.alias, parsed.remotePath)
        } catch (error) {
          ctx.logger?.warn?.(`remote-anywhere: could not mount ${path}: ${errorMessage(error)}`)
        }
      }
      return await original.call(this, path, title)
    }
    Object.defineProperty(registry, 'create', { value: wrapped, writable: true, configurable: true, enumerable: false })
    Object.defineProperty(registry, MARKER, { value: true, configurable: true })
    disposers.push(() => {
      delete registry[MARKER]
      if (registry.create === wrapped) {
        Object.defineProperty(registry, 'create', { value: original, writable: true, configurable: true, enumerable: false })
      }
    })
    ctx.logger?.info?.('remote-anywhere: ssh:// workspaces mount themselves when created')
  })

  return () => {
    for (const dispose of disposers.reverse()) dispose()
    disposers.length = 0
    homes.clear()
    deviceCache = undefined
    void fiber?.dispose?.()
    void registryFiber?.dispose?.()
  }
}
