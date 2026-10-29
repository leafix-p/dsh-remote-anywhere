/**
 * Compatibility shims for third-party remote terminals.
 *
 * dsh 0.2.1's browser-terminal controller calls `handle.inspectActivity()` when
 * it allocates a terminal. The remote PTY handle shipped by
 * `@shiqyka/dsh-ssh-workspace` 0.2.6 predates that call and only implements
 * `inspectForeground()`; the missing method throws during allocation, leaving a
 * shell tab that never receives input or output.
 *
 * The shim adds the method in two independent places:
 *
 * 1. directly around the live `ctx.subprocess.spawnTerminal`, when this plugin
 *    happens to be the outer wrapper;
 * 2. on `RemoteTerminalRouter.prototype`, so the ssh-workspace wrapper sees the
 *    patched method even when it is the outer wrapper.
 *
 * Both are no-ops for handles that already implement it.
 *
 * @module dsh-remote-anywhere/compat
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { profileDir } from './util.js'

const ACTIVITY_SYMBOL = Symbol.for('dsh-remote-anywhere/inspect-activity')
const INSTALLED_SYMBOL = Symbol.for('dsh-remote-anywhere/terminal-router-compat')
const SUBPROCESS_SYMBOL = Symbol.for('dsh-remote-anywhere/subprocess-terminal-compat')

/** Add a conservative `inspectActivity()` to one terminal handle. */
function addActivity (handle) {
  if (handle === null || typeof handle !== 'object') return handle
  if (typeof handle.inspectActivity === 'function') return handle
  try {
    Object.defineProperty(handle, ACTIVITY_SYMBOL, { value: true, configurable: true })
    Object.defineProperty(handle, 'inspectActivity', {
      value: async () => ({ state: handle.exited ? 'idle' : 'unknown', revision: 0 }),
      configurable: true,
      writable: true,
    })
  } catch { /* a frozen handle keeps its original failure */ }
  return handle
}

/**
 * Patch `RemoteTerminalRouter.prototype.spawnTerminal` from ssh-workspace.
 *
 * The router is instantiated by the ssh-workspace plugin. Its `spawnTerminal`
 * wrapper calls `router.spawnTerminal(spec)` dynamically, so replacing the
 * prototype method affects an already-created router too.
 */
async function patchRouterPrototype (ctx) {
  let module
  try {
    const requireFromProfile = createRequire(join(profileDir(), 'package.json'))
    const manifest = requireFromProfile.resolve('@shiqyka/dsh-ssh-workspace/package.json')
    const modulePath = join(dirname(manifest), 'lib', 'patch-terminal.js')
    module = await import(pathToFileURL(modulePath).href)
  } catch {
    return false
  }
  const Router = module?.RemoteTerminalRouter
  if (typeof Router !== 'function' || typeof Router.prototype?.spawnTerminal !== 'function') return false
  if (Router.prototype[INSTALLED_SYMBOL] === true) return true
  const original = Router.prototype.spawnTerminal
  Router.prototype.spawnTerminal = async function (spec) {
    return addActivity(await original.call(this, spec))
  }
  Object.defineProperty(Router.prototype, INSTALLED_SYMBOL, { value: true, configurable: true })
  ctx.logger?.info?.('remote-anywhere: patched ssh-workspace terminals for inspectActivity')
  return true
}

/** Wrap the live subprocess seam as a fallback. */
function patchSubprocess (ctx) {
  ctx.inject(['subprocess'], (scoped) => {
    const subprocess = scoped.get('subprocess')
    if (subprocess === undefined || subprocess === null) return
    if (typeof subprocess.spawnTerminal !== 'function') return
    if (subprocess[SUBPROCESS_SYMBOL] === true) return
    const original = subprocess.spawnTerminal
    const wrapped = async function (spec) {
      return addActivity(await original.call(this, spec))
    }
    Object.defineProperty(subprocess, 'spawnTerminal', {
      value: wrapped,
      writable: true,
      configurable: true,
      enumerable: false,
    })
    Object.defineProperty(subprocess, SUBPROCESS_SYMBOL, { value: true, configurable: true })
    scoped.logger?.info?.('remote-anywhere: wrapped ctx.subprocess.spawnTerminal for terminal compatibility')
    return () => {
      if (subprocess.spawnTerminal !== wrapped) return
      Object.defineProperty(subprocess, 'spawnTerminal', {
        value: original,
        writable: true,
        configurable: true,
        enumerable: false,
      })
      delete subprocess[SUBPROCESS_SYMBOL]
    }
  })
}

/**
 * Install both compatibility paths.
 *
 * @param {object} ctx - host plugin context.
 * @returns {Promise<void>}
 */
export async function patchRemoteTerminalCompatibility (ctx) {
  patchSubprocess(ctx)
  try {
    await patchRouterPrototype(ctx)
  } catch (error) {
    ctx.logger?.warn?.(`remote-anywhere: terminal compatibility patch failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
