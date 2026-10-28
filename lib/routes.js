/**
 * Browser-facing HTTP routes for dsh-remote-anywhere.
 *
 * Same fence as dsh-ssh-workspace: loopback remote address, a `Host` header
 * naming this loopback listener, and JSON content type on every POST. The
 * routes mutate the local machine's processes (they spawn remote dsh servers
 * and open tunnels), so a public deployment must not reach them.
 *
 * @module dsh-remote-anywhere/routes
 */

import { errorMessage } from './util.js'

export const ROUTES = {
  targets: '/api/dsh-remote-anywhere/targets',
  targetsRefresh: '/api/dsh-remote-anywhere/targets/refresh',
  ls: '/api/dsh-remote-anywhere/ls',
  connect: '/api/dsh-remote-anywhere/connect',
  connections: '/api/dsh-remote-anywhere/connections',
  connection: '/api/dsh-remote-anywhere/connection',
  log: '/api/dsh-remote-anywhere/log',
  disconnect: '/api/dsh-remote-anywhere/disconnect',
  resync: '/api/dsh-remote-anywhere/resync',
  hosts: '/api/dsh-remote-anywhere/hosts',
  hostSave: '/api/dsh-remote-anywhere/hosts/save',
  hostDelete: '/api/dsh-remote-anywhere/hosts/delete',
  settings: '/api/dsh-remote-anywhere/settings',
  settingsSave: '/api/dsh-remote-anywhere/settings/save',
}

function isLoopbackRequest (req) {
  const address = req.socket?.remoteAddress ?? req.connection?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address === 'localhost'
}

function isLoopbackHostHeader (req) {
  const port = req.socket?.localPort
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '' || !Number.isInteger(port)) return false
  return new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]).has(host.toLowerCase())
}

function isJsonContentType (req) {
  const header = req.headers?.['content-type']
  if (typeof header !== 'string') return false
  return header.split(';', 1)[0].trim().toLowerCase() === 'application/json'
}

function writeJson (res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function readJsonBody (req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 2 * 1024 * 1024) {
        rejectPromise(new Error('request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolvePromise({})
        return
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        rejectPromise(new Error(`invalid JSON body: ${errorMessage(error)}`))
      }
    })
    req.on('error', rejectPromise)
  })
}

/**
 * Build the route descriptors.
 *
 * @param {import('./remote.js').RemoteAnywhere} explorer - orchestrator.
 * @param {object} ctx - host plugin context.
 * @returns {Array<object>} descriptors for `webServer.register()`.
 */
export function makeRoutes (explorer, ctx) {
  const guard = (req, res, method) => {
    if (!isLoopbackRequest(req) || !isLoopbackHostHeader(req)) {
      writeJson(res, 403, { error: 'remote-anywhere routes are loopback-only' })
      return false
    }
    if (method !== undefined && req.method !== method) {
      res.setHeader('allow', method)
      writeJson(res, 405, { error: `method ${req.method} is not allowed; use ${method}` })
      return false
    }
    if (req.method === 'POST' && !isJsonContentType(req)) {
      writeJson(res, 415, { error: 'POST endpoints require content-type: application/json' })
      return false
    }
    return true
  }
  const run = (handler) => async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      const message = errorMessage(error)
      ctx.logger?.warn?.(`remote-anywhere: route failed: ${message}`)
      if (!res.headersSent) writeJson(res, 500, { error: message })
      else res.end()
    }
  }
  const query = (req, name) => new URL(req.url ?? '/', 'http://localhost').searchParams.get(name)

  return [
    {
      kind: 'exact',
      path: ROUTES.targets,
      handler: run(async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const refresh = query(req, 'refresh') === '1'
        const targets = await explorer.listTargets({ refresh })
        writeJson(res, 200, targets)
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.targetsRefresh,
      handler: run(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const targets = await explorer.listTargets({ refresh: true })
        writeJson(res, 200, targets)
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.ls,
      handler: run(async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const targetId = query(req, 'targetId') ?? ''
        const path = query(req, 'path') ?? ''
        const listing = await explorer.listDirectory(targetId, path)
        writeJson(res, 200, listing)
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.connect,
      handler: run(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const connection = await explorer.connect(body)
        writeJson(res, 200, connection)
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.connections,
      handler: run(async (req, res) => {
        if (!guard(req, res, 'GET')) return
        writeJson(res, 200, { connections: explorer.listConnections() })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.connection,
      handler: run(async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const id = query(req, 'id') ?? ''
        writeJson(res, 200, explorer.getConnection(id))
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.log,
      handler: run(async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const id = query(req, 'id') ?? ''
        writeJson(res, 200, { log: explorer.connectionLog(id) })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.disconnect,
      handler: run(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const connection = await explorer.disconnect(String(body?.id ?? ''))
        writeJson(res, 200, connection)
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.resync,
      handler: run(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const connection = await explorer.resync(String(body?.id ?? ''))
        writeJson(res, 200, connection)
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.hosts,
      handler: run(async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const targets = await explorer.listTargets({ refresh: true })
        writeJson(res, 200, { hosts: targets.ssh })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.hostSave,
      handler: run(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const originalAlias = typeof body?.originalAlias === 'string' && body.originalAlias.trim() !== ''
          ? body.originalAlias.trim()
          : undefined
        const host = await explorer.saveHost(body, originalAlias)
        writeJson(res, 200, { ok: true, host })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.hostDelete,
      handler: run(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        await explorer.deleteHost(String(body?.alias ?? ''))
        writeJson(res, 200, { ok: true })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.settings,
      handler: run(async (req, res) => {
        if (!guard(req, res, 'GET')) return
        await explorer.loadSettings()
        writeJson(res, 200, {
          settings: explorer.settings,
          local: { version: explorer.localVersion, node: explorer.localNode },
        })
      }),
    },
    {
      kind: 'exact',
      path: ROUTES.settingsSave,
      handler: run(async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const settings = await explorer.saveSettings(body?.settings ?? body)
        writeJson(res, 200, { settings })
      }),
    },
  ]
}

