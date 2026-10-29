/**
 * Actionable errors for programs the remote subprocess bridge refuses.
 *
 * The embedded ssh-workspace host patches `ctx.subprocess` so a spec whose cwd
 * is `ssh://alias/path` runs on the remote machine — but only for `git` and
 * `rg`, the two helpers DSH's own file tools spawn. That is deliberate: those
 * are the only executables whose remote behaviour is known to match the local
 * one. Anything else is rejected synchronously with a one-line English
 * message naming the whitelist and nothing about what to do instead.
 *
 * `run_code` (the PTC runtime) is the loud case: it spawns `node` with the
 * remote workspace as cwd, so every call in an `ssh://` Session used to fail
 * with "only git and ripgrep (rg) are supported over the remote subprocess
 * bridge" — accurate, and useless to an agent that just needs to know it
 * should call the bash tool instead.
 *
 * This module wraps that patch from the outside and rewrites the rejection. It
 * never changes which programs are allowed and never starts anything itself.
 *
 * @module dsh-remote-anywhere/subprocess-hint
 */

import { errorMessage } from './util.js'

/** Marker preventing a double wrap across plugin reloads. */
const MARKER = Symbol.for('dsh-remote-anywhere/subprocess-hint')

/** The upstream rejection this module rewrites. */
const REFUSAL_RE = /only git and ripgrep|remote subprocess bridge/iu

/**
 * Rewrite one refusal into the instruction an agent can act on.
 *
 * @param {object} spec - the spawn spec the caller passed.
 * @param {unknown} error - what the wrapped implementation threw.
 * @returns {unknown} the original error when it is unrelated, else a new one.
 */
function actionable (spec, error) {
  const message = errorMessage(error)
  if (REFUSAL_RE.test(message) !== true) return error
  const program = Array.isArray(spec?.argv) === true ? String(spec.argv[0] ?? '') : String(spec?.command ?? '')
  const target = typeof spec?.cwd === 'string' && spec.cwd.startsWith('ssh://') ? `「${spec.cwd}」上` : '远端'
  return new Error(
    `无法在${target}启动「${program}」：ssh:// 的远端子进程桥只放行 git 与 ripgrep（用于搜索与变更追踪）。\n` +
    '这个工作区在远端时请改用：\n' +
    '- bash / pwsh：workdir 落在 ssh:// 时命令直接在远端主机执行；\n' +
    '- read / write / edit：通过 SFTP 读写远端文件；\n' +
    '- glob / grep：调用远端 ripgrep。\n' +
    'run_code（PTC）需要在本地起 node 进程，因此不支持远程工作区。',
  )
}

/**
 * Wrap the (already patched) subprocess service so refusals explain themselves.
 *
 * Installed after the embedded ssh-workspace host, so this wrapper sits outside
 * its patch and sees the rejection first.
 *
 * @param {object} ctx - host plugin context.
 * @returns {() => void} disposer.
 */
export function installRemoteSubprocessHint (ctx) {
  const disposers = []
  const fiber = ctx.inject(['subprocess'], (scoped) => {
    const service = scoped.get('subprocess')
    if (service === undefined || service === null || typeof service.spawn !== 'function') return
    if (service[MARKER] === true) return
    const original = service.spawn
    const wrapped = function (spec) {
      let result
      try {
        result = original.call(this, spec)
      } catch (error) {
        throw actionable(spec, error)
      }
      // The remote bridge throws synchronously on purpose, but a different
      // implementation may answer with a promise; cover both shapes.
      if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
        return result.catch((error) => { throw actionable(spec, error) })
      }
      return result
    }
    Object.defineProperty(service, 'spawn', { value: wrapped, writable: true, configurable: true, enumerable: false })
    Object.defineProperty(service, MARKER, { value: true, configurable: true })
    disposers.push(() => {
      delete service[MARKER]
      if (service.spawn === wrapped) {
        Object.defineProperty(service, 'spawn', { value: original, writable: true, configurable: true, enumerable: false })
      }
    })
  })

  return () => {
    for (const dispose of disposers.reverse()) dispose()
    disposers.length = 0
    void fiber?.dispose?.()
  }
}
