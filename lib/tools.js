/**
 * Agent tools for Remote Anywhere.
 *
 * The browser panel is the primary surface; these tools let the model list
 * targets and start/observe/stop a remote dsh when the user asks for it in
 * conversation.
 *
 * @module dsh-remote-anywhere/tools
 */

import { errorMessage } from './util.js'

/**
 * Convert the compact schema spec used by dsh tool definitions into real JSON
 * Schema. The official `defineTool` helper does the same; keeping a small
 * local copy avoids an extra profile dependency.
 *
 * Spec shape: object nodes carry `properties` (each property may use
 * `required: true`) and array nodes carry `items`. A node-level `required`
 * array passes through unchanged.
 */
function schemaFromSpec (spec) {
  if (spec === null || typeof spec !== 'object') return spec
  const { required, ...rest } = spec
  const output = { ...rest }
  if (rest.properties !== undefined && rest.properties !== null && typeof rest.properties === 'object') {
    const properties = {}
    const requiredNames = []
    for (const [name, value] of Object.entries(rest.properties)) {
      if (value === null || typeof value !== 'object') {
        properties[name] = value
        continue
      }
      const { required: isRequired, ...schema } = value
      properties[name] = schemaFromSpec(schema)
      if (isRequired === true) requiredNames.push(name)
    }
    output.properties = properties
    if (requiredNames.length > 0) output.required = requiredNames
    else if (Array.isArray(required)) output.required = required
  } else if (Array.isArray(required)) {
    output.required = required
  }
  if (rest.items !== undefined) output.items = schemaFromSpec(rest.items)
  return output
}

/** Minimal local equivalent of `@deepseek-ai/dsh-tools`'s defineTool. */
function defineTool (options) {
  return {
    name: options.name,
    description: options.description,
    parameters: schemaFromSpec({
      type: 'object',
      properties: options.parameters ?? {},
      additionalProperties: false,
    }),
    output: {
      schema: schemaFromSpec(options.output.schema),
      render: options.output.render,
      ...(options.output.presentationMeta === undefined ? {} : { presentationMeta: options.output.presentationMeta }),
    },
    async execute (args, exec) {
      return await options.execute(args, exec)
    },
  }
}

function text (value) {
  return [{ type: 'text', text: value }]
}

function renderTargets (targets) {
  const rows = []
  for (const row of targets.ssh ?? []) rows.push(`ssh | ${row.name} | ${row.detail} | ${row.keyReady ? 'key-ready' : 'check-key'} | ${row.source}`)
  for (const row of targets.wsl ?? []) rows.push(`wsl | ${row.name} | ${row.detail} | ${row.available ? 'available' : 'unavailable'}`)
  return text(rows.length === 0 ? 'no targets — configure an SSH host or a WSL distribution first' : rows.join('\n'))
}

function renderConnections (connections) {
  if (connections.length === 0) return text('no remote dsh connections')
  return text(connections.map(connection => [
    connection.id,
    connection.targetName,
    connection.state,
    connection.workspace,
    connection.url ?? '-',
    connection.error ?? '',
  ].join(' | ')).join('\n'))
}

/**
 * Build tool definitions bound to one explorer instance.
 *
 * @param {import('./remote.js').RemoteAnywhere} explorer - orchestrator.
 * @returns {Array<object>} tool definitions for `ctx.tools.register()`.
 */
export function makeTools (explorer) {
  return [
    defineTool({
      name: 'remote_anywhere_targets',
      description: 'List Remote Anywhere targets: SSH hosts (shared dsh-ssh.json store and ~/.ssh/config) and local WSL distributions, with availability. ' +
        'Use the returned id with remote_anywhere_connect. Triggers: remote targets, ssh hosts, wsl distros, remote machines.',
      parameters: {
        refresh: { type: 'boolean', description: 'Probe WSL availability again instead of using the 15-second cache.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ssh: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
            wsl: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          },
        },
        render: (_args, value) => renderTargets(value),
      },
      async execute (args) {
        const targets = await explorer.listTargets({ refresh: args.refresh === true })
        return { ssh: targets.ssh, wsl: targets.wsl }
      },
    }),
    defineTool({
      name: 'remote_anywhere_connect',
      description: 'Start a dsh server ON a remote target, opening a local forwarded URL and embedding it in the local GUI. ' +
        'The first connection installs dsh in ~/.dsh/remote-bin on the remote user account and syncs the local model / plugin / skill configuration. ' +
        'Returns immediately with a connection id; poll remote_anywhere_status until state is ready or error. Triggers: open remote dsh, run dsh on server, remote workspace.',
      parameters: {
        targetId: { type: 'string', required: true, description: 'Target id from remote_anywhere_targets, e.g. ssh:myserver or wsl:Ubuntu-22.04.' },
        path: { type: 'string', description: 'Absolute remote directory to open as the remote dsh workspace. Defaults to the remote home directory.' },
        syncPlugins: { type: 'boolean', description: 'Install the local plugin set remotely (slow; default follows the panel setting).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            state: { type: 'string', required: true },
            workspace: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => text(`remote dsh connection ${value.id}: ${value.state}${value.error ? ` — ${value.error}` : ''}`),
      },
      async execute (args) {
        const options = {}
        if (typeof args.syncPlugins === 'boolean') options.syncPlugins = args.syncPlugins
        const connection = await explorer.connect({
          targetId: args.targetId,
          path: args.path,
          options,
        })
        return {
          id: connection.id,
          state: connection.state,
          workspace: connection.workspace,
          ...(connection.error === undefined ? {} : { error: connection.error }),
        }
      },
    }),
    defineTool({
      name: 'remote_anywhere_status',
      description: 'Report Remote Anywhere connections (state, workspace, local URL, steps) or one connection by id. Triggers: remote connection status, is remote dsh ready.',
      parameters: {
        id: { type: 'string', description: 'Optional connection id; omit for all connections.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            connections: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          },
        },
        render: (_args, value) => renderConnections(value.connections ?? []),
      },
      async execute (args) {
        if (typeof args.id === 'string' && args.id !== '') return { connections: [explorer.getConnection(args.id)] }
        return { connections: explorer.listConnections() }
      },
    }),
    defineTool({
      name: 'remote_anywhere_disconnect',
      description: 'Stop a remote dsh started by Remote Anywhere and close its local port forward. Triggers: close remote dsh, disconnect remote connection.',
      parameters: {
        id: { type: 'string', required: true, description: 'Connection id from remote_anywhere_status.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean', required: true }, state: { type: 'string' } },
        },
        render: (_args, value) => text(value.ok ? `connection closed (${value.state})` : `disconnect failed: ${value.state ?? 'unknown error'}`),
      },
      async execute (args) {
        try {
          const connection = await explorer.disconnect(String(args.id ?? ''))
          return { ok: true, state: connection.state }
        } catch (error) {
          return { ok: false, state: errorMessage(error) }
        }
      },
    }),
  ]
}

