/**
 * `@` file references for `ssh://` workspaces.
 *
 * DSH's `ctx.fileReferences` service is local-filesystem only: it indexes the
 * Session cwd on this machine. A Session whose cwd is `ssh://alias/path` has
 * no local cwd, so the `@` picker showed nothing. This module wraps that
 * service and, only for remote cwds, lists one directory over the embedded
 * SSH engine. Typing `@` shows the remote workspace root; typing `@src/`
 * drills into a subdirectory, matching DSH's own file-reference grammar.
 *
 * The wrapper delegates every local Session to the original implementation.
 *
 * @module dsh-remote-anywhere/remote-references
 */

import { parseRemoteWorkspacePath } from './remote-workspaces.js'
import { errorMessage } from './util.js'

const MAX_RESULTS = 20
const LIST_TIMEOUT_MS = 6_000
const CACHE_TTL_MS = 5_000

/** Join POSIX path segments, keeping the leading slash of an absolute base. */
function joinPosix (base, part) {
  if (part === '') return base
  const left = base === '/' ? '' : base.replace(/\/+$/u, '')
  return `${left}/${part.replace(/^\/+/u, '')}`
}

/** Quote-free query text from the picker (`@"dir/file` arrives quoted). */
function cleanQuery (query) {
  let text = typeof query === 'string' ? query : ''
  if (text.startsWith('"')) text = text.slice(1)
  if (text.endsWith('"')) text = text.slice(0, -1)
  return text
}

function withTimeout (promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}（${ms}ms）`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => { clearTimeout(timer) })
}

/**
 * Wrap the file-reference service so remote Sessions list remote files.
 *
 * @param {object} ctx - host plugin context.
 * @param {{engine?: object}} sshHost - result of the vendored host `apply()`.
 * @param {object} [config] - `remoteReferences.enabled`.
 * @returns {() => void} disposer.
 */
export function installRemoteFileReferences (ctx, sshHost, config = {}) {
  if (config.enabled === false) return () => {}
  const engine = sshHost?.engine
  if (engine === undefined || engine === null) return () => {}

  const cache = new Map()
  const disposers = []
  let fiber

  const listRemote = async (cwd, query, signal) => {
    const parsed = parseRemoteWorkspacePath(cwd)
    if (parsed === undefined) return []
    const text = cleanQuery(query)
    const slash = text.lastIndexOf('/')
    const dirPart = slash < 0 ? '' : text.slice(0, slash + 1)
    const prefix = slash < 0 ? text : text.slice(slash + 1)
    const target = dirPart.startsWith('/') ? dirPart : joinPosix(parsed.directory, dirPart)
    const key = `${parsed.alias}\u0000${target}`
    const cached = cache.get(key)
    if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
      return filterRows(cached.rows, dirPart, prefix)
    }
    const rows = await withTimeout(
      engine.withSftp(parsed.alias, (sftp) => new Promise((resolve, reject) => {
        sftp.readdir(target, (error, list) => {
          if (error !== undefined && error !== null) reject(error)
          else resolve(Array.isArray(list) ? list : [])
        })
      })),
      LIST_TIMEOUT_MS,
      '读取远端目录超时',
    ).catch((error) => {
      if (signal?.aborted !== true) ctx.logger?.warn?.(`remote-anywhere: @ reference listing failed: ${errorMessage(error)}`)
      return []
    })
    if (signal?.aborted === true) return []
    const mapped = rows
      .filter(entry => typeof entry?.filename === 'string' && entry.filename !== '.' && entry.filename !== '..')
      .map(entry => ({
        path: `${dirPart}${entry.filename}`,
        kind: entry.attrs?.isDirectory?.() === true ? 'directory' : 'file',
      }))
    cache.set(key, { at: Date.now(), rows: mapped })
    if (cache.size > 64) cache.delete(cache.keys().next().value)
    return filterRows(mapped, dirPart, prefix)
  }

  fiber = ctx.inject(['fileReferences', 'workingDirectory'], (scoped) => {
    const service = scoped.get('fileReferences')
    if (service === undefined || service === null || typeof service.list !== 'function') return
    const original = service.list
    const marker = Symbol.for('dsh-remote-anywhere/remote-references')
    if (service[marker] === true) return
    const wrapped = async function (agent, query, signal) {
      try {
        if (scoped.workingDirectory !== undefined) {
          const cwd = await scoped.workingDirectory.ensure(agent, signal)
          if (typeof cwd === 'string' && cwd.startsWith('ssh://')) return await listRemote(cwd, query, signal)
        }
      } catch { /* remote listing failed — fall through to the local service */ }
      return await original.call(this, agent, query, signal)
    }
    Object.defineProperty(service, 'list', { value: wrapped, writable: true, configurable: true, enumerable: false })
    Object.defineProperty(service, marker, { value: true, configurable: true })
    disposers.push(() => {
      if (service.list === wrapped) Object.defineProperty(service, 'list', { value: original, writable: true, configurable: true, enumerable: false })
      delete service[marker]
    })
  })

  return () => {
    for (const dispose of disposers) dispose()
    disposers.length = 0
    cache.clear()
    void fiber?.dispose?.()
  }
}

/** Filter by the typed prefix and keep the picker's result budget. */
function filterRows (rows, dirPart, prefix) {
  const needle = prefix.toLowerCase()
  const matched = needle === ''
    ? rows
    : rows.filter(row => row.path.slice(dirPart.length).toLowerCase().startsWith(needle))
  return matched
    .slice()
    .sort((a, b) => {
      const byKind = (a.kind === 'directory' ? 0 : 1) - (b.kind === 'directory' ? 0 : 1)
      return byKind !== 0 ? byKind : a.path.localeCompare(b.path)
    })
    .slice(0, MAX_RESULTS)
}
