/**
 * Target discovery and the shared SSH host store.
 *
 * The host store is the same `$DSH_HOME/dsh-ssh.json` document used by
 * dsh-ssh-workspace. Reading and writing it (instead of inventing a second
 * file) means a host configured in either panel is immediately visible in
 * both. Secrets keep the exact at-rest spelling used there: AES-256-GCM
 * ciphertext prefixed with `enc:v1:`, keyed by `$DSH_HOME/dsh-ssh.key`.
 *
 * WSL distributions are discovered from `wsl.exe`; they need no store entry.
 *
 * @module dsh-remote-anywhere/store
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import {
  atomicWriteJson,
  dshHome,
  errorMessage,
  expandHome,
  runLocal,
  statOrNull,
  wslExecutable,
} from './util.js'

const SECRET_PREFIX = 'enc:v1:'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

/** Absolute path of the shared SSH host store. */
export function sshStorePath () {
  return join(dshHome(), 'dsh-ssh.json')
}

/** Absolute path of the shared secret key. */
export function sshKeyPath () {
  return join(dshHome(), 'dsh-ssh.key')
}

/** True when a stored value is encrypted by this codec. */
export function isEncrypted (value) {
  return typeof value === 'string' && value.startsWith(SECRET_PREFIX)
}

/**
 * At-rest secret codec (compatible with dsh-ssh-workspace).
 */
export class SecretCodec {
  constructor (path = sshKeyPath()) {
    this.path = path
    this.key = undefined
  }

  encrypt (value) {
    if (typeof value !== 'string' || value === '') return undefined
    if (isEncrypted(value)) return value
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.#loadKey(), iv)
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return SECRET_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
  }

  decrypt (value) {
    if (typeof value !== 'string' || value === '') return undefined
    if (!isEncrypted(value)) return value
    const raw = Buffer.from(value.slice(SECRET_PREFIX.length), 'base64')
    if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error(`stored secret is not a valid ${SECRET_PREFIX} value`)
    const iv = raw.subarray(0, IV_BYTES)
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
    const body = raw.subarray(IV_BYTES + TAG_BYTES)
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#loadKey(), iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
    } catch {
      throw new Error(`cannot decrypt the stored secret: key file ${this.path} does not match the key it was written with`)
    }
  }

  #loadKey () {
    if (this.key !== undefined) return this.key
    if (existsSync(this.path)) {
      const key = Buffer.from(readFileSync(this.path, 'utf8').trim(), 'base64')
      if (key.length !== KEY_BYTES) {
        throw new Error(`secret key file ${this.path} does not hold a ${KEY_BYTES}-byte key; restore the original file`)
      }
      this.key = key
      return key
    }
    const key = randomBytes(KEY_BYTES)
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    writeFileSync(this.path, `${key.toString('base64')}\n`, { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(this.path, 0o600) } catch { /* win32 may not honor it */ }
    this.key = key
    return key
  }
}

/** Read the raw shared store (an empty document when it does not exist). */
export async function readSshStore () {
  try {
    const text = await readFile(sshStorePath(), 'utf8')
    const parsed = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) throw new Error('store is not a JSON object')
    return parsed
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { version: 1, knownHosts: {}, workspaces: { disabled: [] }, hosts: [], secrets: {} }
    }
    throw new Error(`cannot read ${sshStorePath()}: ${errorMessage(error)}`)
  }
}

/** Persist the shared store atomically, preserving every field we do not own. */
export async function writeSshStore (store) {
  const file = sshStorePath()
  const candidate = {
    ...store,
    version: store.version ?? 1,
    knownHosts: store.knownHosts ?? {},
    hosts: Array.isArray(store.hosts) ? store.hosts : [],
    secrets: store.secrets ?? {},
  }
  // A concurrent writer (the ssh-workspace panel, the agent tools) may have
  // changed unrelated fields since this process read the file. Merge those
  // fields back before publishing so we never drop a workspace registration
  // or a new host key.
  try {
    const current = JSON.parse(await readFile(file, 'utf8'))
    if (typeof current === 'object' && current !== null) {
      candidate.workspaces = current.workspaces ?? candidate.workspaces
      candidate.knownHosts = { ...(current.knownHosts ?? {}), ...(candidate.knownHosts ?? {}) }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') { /* unreadable current file: publish our merged view */ }
  }
  await atomicWriteJson(file, candidate, 0o600)
}

/**
 * Parse concrete `Host` blocks out of `~/.ssh/config`.
 *
 * Wildcard patterns, negations, and `Match` blocks are ignored: they do not
 * name one connectable authority. `Include` is not followed.
 *
 * @returns {Promise<Array<object>>} host rows in file order.
 */
export async function parseSshConfig () {
  const file = join(homedir(), '.ssh', 'config')
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  /** @type {Map<string, object>} */
  const blocks = new Map()
  let current = null
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.replace(/#.*$/u, '').trim()
    if (line === '') continue
    const match = /^([A-Za-z][A-Za-z0-9]*)\s+(.+)$/u.exec(line)
    if (match === null) continue
    const key = match[1].toLowerCase()
    const value = match[2].trim().replace(/^"(.*)"$/u, '$1')
    if (key === 'host') {
      const aliases = value.split(/\s+/u).filter(alias => alias !== '' && !/[*?!]/u.test(alias))
      current = aliases.length === 0 ? null : { aliases, values: {} }
      if (current !== null) {
        for (const alias of aliases) {
          if (!blocks.has(alias)) blocks.set(alias, current)
        }
      }
      continue
    }
    if (key === 'match') {
      current = null
      continue
    }
    if (current === null) continue
    if (!current.values[key]) current.values[key] = value
  }
  const rows = []
  for (const [alias, block] of blocks) {
    const { values } = block
    const host = values.hostname ?? alias
    if (host === '' || /\s/u.test(host)) continue
    const port = Number.parseInt(values.port ?? '22', 10)
    const user = values.user ?? process.env.USERNAME ?? process.env.USER ?? ''
    const keyPath = values.identityfile ? expandHome(values.identityfile) : ''
    rows.push({
      alias,
      host,
      port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 22,
      user,
      auth: { kind: keyPath === '' ? 'agent' : 'key', keyPath, agentPath: '' },
      description: values['proxyjump'] ? `ProxyJump ${values['proxyjump']} (not supported)` : '~/.ssh/config',
      proxyJump: values['proxyjump'] ?? '',
      source: 'ssh-config',
      keyReady: keyPath === '' ? true : existsSync(keyPath),
      agentForward: values.forwardagent === 'yes',
      compress: values.compression === 'yes',
      tags: [],
    })
  }
  return rows
}

/** Store rows (source `store`) projected for the explorer. */
function projectStoreRows (store) {
  const rows = []
  for (const entry of Array.isArray(store.hosts) ? store.hosts : []) {
    if (typeof entry?.alias !== 'string' || entry.alias.trim() === '') continue
    const auth = entry.auth ?? {}
    const kind = auth.kind === 'password' ? 'password' : auth.kind === 'key' ? 'key' : 'agent'
    const keyPath = typeof auth.keyPath === 'string' ? auth.keyPath : ''
    const agentPath = typeof auth.agentPath === 'string' ? auth.agentPath : ''
    rows.push({
      alias: entry.alias,
      host: typeof entry.host === 'string' && entry.host !== '' ? entry.host : entry.alias,
      port: Number.isInteger(entry.port) ? entry.port : 22,
      user: typeof entry.user === 'string' ? entry.user : '',
      auth: { kind, keyPath, agentPath },
      description: typeof entry.description === 'string' ? entry.description : '',
      proxyJump: Array.isArray(entry.proxyJump) ? entry.proxyJump.join(', ') : '',
      source: 'store',
      keyReady: kind !== 'key' ? true : keyPath !== '' && existsSync(expandHome(keyPath)),
      agentForward: entry.agentForward === true,
      compress: entry.compress === true,
      tags: Array.isArray(entry.tags) ? entry.tags : [],
    })
  }
  return rows
}

/** All SSH hosts: store rows first, then config-only rows, deduplicated by alias. */
export async function listSshHosts () {
  const store = await readSshStore()
  const rows = projectStoreRows(store)
  const seen = new Set(rows.map(row => row.alias))
  for (const row of await parseSshConfig()) {
    if (seen.has(row.alias)) continue
    seen.add(row.alias)
    rows.push(row)
  }
  return rows
}

/** Find one host row by alias. */
export async function findSshHost (alias) {
  const rows = await listSshHosts()
  return rows.find(row => row.alias === alias)
}

/** Full connect material (including decrypted secrets) for one alias. */
export async function resolveSshHost (alias) {
  const row = await findSshHost(alias)
  if (row === undefined) throw new Error(`no SSH host named ${JSON.stringify(alias)}`)
  const store = await readSshStore()
  const secret = store.secrets?.[alias] ?? {}
  const codec = new SecretCodec()
  const password = row.source === 'store' ? codec.decrypt(secret.password) : undefined
  const passphrase = row.source === 'store' ? codec.decrypt(secret.passphrase) : undefined
  return { ...row, password, passphrase }
}

/**
 * Create or update one store host.
 *
 * @param {object} payload - editor payload; secret fields left empty keep the stored value.
 * @param {string} [originalAlias] - alias being edited.
 * @returns {Promise<object>} the projected row.
 */
export async function saveSshHost (payload, originalAlias) {
  const alias = String(payload?.alias ?? '').trim()
  const host = String(payload?.host ?? '').trim()
  const user = String(payload?.user ?? '').trim()
  const port = Number(payload?.port ?? 22)
  const kind = payload?.auth?.kind === 'password' ? 'password' : payload?.auth?.kind === 'key' ? 'key' : 'agent'
  if (alias === '') throw new Error('别名不能为空')
  if (host === '') throw new Error('主机地址不能为空')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1-65535 的整数')
  const keyPath = String(payload?.auth?.keyPath ?? '').trim()
  if (kind === 'key' && keyPath === '') throw new Error('密钥认证需要填写私钥路径')
  const store = await readSshStore()
  const configAliases = (await parseSshConfig()).map(row => row.alias)
  const editing = typeof originalAlias === 'string' && originalAlias !== ''
  if (!editing && configAliases.includes(alias)) {
    throw new Error(`别名 ${JSON.stringify(alias)} 已存在于 ~/.ssh/config；请直接使用它，或换一个别名`)
  }
  if (editing && originalAlias !== alias && configAliases.includes(alias)) {
    throw new Error(`别名 ${JSON.stringify(alias)} 已存在于 ~/.ssh/config；请换一个别名`)
  }
  if (editing) {
    const exists = store.hosts.some(entry => entry?.alias === originalAlias)
    if (!exists) throw new Error(`要编辑的主机 ${JSON.stringify(originalAlias)} 不在插件主机列表中`)
  }
  const previous = editing ? store.hosts.find(entry => entry?.alias === originalAlias) : undefined
  const codec = new SecretCodec()
  const passwordInput = typeof payload?.auth?.password === 'string' ? payload.auth.password : ''
  const passphraseInput = typeof payload?.auth?.passphrase === 'string' ? payload.auth.passphrase : ''
  const previousSecrets = store.secrets?.[originalAlias ?? alias] ?? {}
  const nextSecrets = {}
  const password = passwordInput !== '' ? codec.encrypt(passwordInput) : previousSecrets.password
  const passphrase = passphraseInput !== '' ? codec.encrypt(passphraseInput) : previousSecrets.passphrase
  if (kind === 'password' && password === undefined && !editing) throw new Error('密码认证需要填写密码')
  if (password !== undefined) nextSecrets.password = password
  if (passphrase !== undefined) nextSecrets.passphrase = passphrase

  const entry = {
    ...(previous ?? {}),
    alias,
    host,
    port,
    user,
    auth: { kind, keyPath, agentPath: String(payload?.auth?.agentPath ?? '').trim() },
    proxyJump: [],
    tags: Array.isArray(payload?.tags) ? payload.tags : [],
    description: String(payload?.description ?? ''),
    agentForward: payload?.agentForward === true,
    compress: payload?.compress === true,
    createdAt: previous?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  }
  const hosts = Array.isArray(store.hosts) ? store.hosts.filter(item => item?.alias !== (originalAlias ?? alias)) : []
  hosts.push(entry)
  store.hosts = hosts
  store.secrets = { ...(store.secrets ?? {}) }
  if (originalAlias !== undefined && originalAlias !== alias) delete store.secrets[originalAlias]
  if (Object.keys(nextSecrets).length === 0) delete store.secrets[alias]
  else store.secrets[alias] = nextSecrets
  await writeSshStore(store)
  return {
    alias,
    host,
    port,
    user,
    auth: { kind, keyPath, agentPath: entry.auth.agentPath },
    description: entry.description,
    proxyJump: '',
    source: 'store',
    keyReady: kind !== 'key' ? true : existsSync(expandHome(keyPath)),
    agentForward: entry.agentForward,
    compress: entry.compress,
    tags: entry.tags,
  }
}

/** Delete one store host (config hosts cannot be deleted here). */
export async function deleteSshHost (alias) {
  const store = await readSshStore()
  const before = Array.isArray(store.hosts) ? store.hosts.length : 0
  store.hosts = (Array.isArray(store.hosts) ? store.hosts : []).filter(entry => entry?.alias !== alias)
  if (store.hosts.length === before) throw new Error(`主机 ${JSON.stringify(alias)} 不在插件主机列表中（~/.ssh/config 主机请直接编辑该文件）`)
  if (store.secrets && typeof store.secrets === 'object') delete store.secrets[alias]
  await writeSshStore(store)
}

/** Record a TOFU host-key fingerprint after a successful first connection. */
export async function rememberHostKey (alias, host, port, fingerprint) {
  const store = await readSshStore()
  const knownHosts = store.knownHosts ?? {}
  const existing = knownHosts[alias]
  if (existing?.fingerprint === fingerprint) return
  knownHosts[alias] = {
    host,
    port,
    keyType: existing?.keyType ?? 'unknown',
    fingerprint,
    recordedAt: Date.now(),
  }
  store.knownHosts = knownHosts
  await writeSshStore(store)
}

/** The stored fingerprint for one alias, when any. */
export async function knownHostKey (alias) {
  const store = await readSshStore()
  return store.knownHosts?.[alias]?.fingerprint
}

/** List configured WSL distributions. */
export async function listWslDistros ({ timeoutMs = 2_500 } = {}) {
  if (process.platform !== 'win32') return []
  let result
  try {
    result = await runLocal(wslExecutable(), ['-l', '-q'], {
      env: { ...process.env, WSL_UTF8: '1' },
      timeoutMs,
    })
  } catch {
    return []
  }
  if (result.exitCode !== 0) return []
  const names = result.stdout
    .replace(/\u0000/gu, '')
    .replace(/^\uFEFF/u, '')
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line !== '')
  return [...new Set(names)].map(name => ({
    id: `wsl:${name}`,
    kind: 'wsl',
    name,
    detail: `WSL · ${name}`,
    distro: name,
    source: 'wsl',
    system: /^docker-desktop/u.test(name),
  }))
}

/** Inspect one WSL distro's user/home and runtime versions. */
export async function inspectWslDistro (distro, { deep = false } = {}) {
  const script = deep
    ? 'printf "%s\\n" "$HOME" "$(id -un)" "$(uname -s)" "$(uname -m)" "$(node -v 2>/dev/null || true)"'
    : 'printf "%s\\n" "$HOME" "$(id -un)"'
  let result
  try {
    result = await runLocal(wslExecutable(), ['-d', distro, '--', 'bash', '-lc', script], {
      env: { ...process.env, WSL_UTF8: '1' },
      timeoutMs: deep ? 20_000 : 12_000,
    })
  } catch (error) {
    return { available: false, error: errorMessage(error) }
  }
  if (result.exitCode !== 0) {
    return { available: false, error: (result.stderr || result.stdout || 'wsl.exe failed').trim() }
  }
  const [home = '', user = '', os = '', arch = '', node = ''] = result.stdout.replace(/\u0000/gu, '').trim().split(/\r?\n/u)
  if (!home.startsWith('/')) return { available: false, error: 'could not determine the WSL home directory' }
  return { available: true, home, user, os: os || 'Linux', arch: arch || '', node: node || '' }
}

/** Convenience: the default home for a target, used by the folder picker. */
export async function targetHome (target) {
  if (target.kind === 'wsl') {
    const info = await inspectWslDistro(target.distro)
    if (!info.available) throw new Error(info.error ?? `WSL 发行版 ${target.distro} 不可用`)
    return { home: info.home, user: info.user }
  }
  const host = await resolveSshHost(target.alias)
  return { home: `/home/${host.user}`.replace(/\/+$/u, ''), user: host.user }
}

/** Human-readable title for a directory path. */
export function directoryTitle (path) {
  const name = basename(path.replace(/[\\/]+$/u, ''))
  return name === '' ? path : name
}

/** Make sure the per-user cache directory exists. */
export function ensureCacheDir () {
  const dir = join(dshHome(), 'logs', 'remote-anywhere')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** Stat helper used by the WSL transport (UNC paths). */
export async function localStatOrNull (path) {
  return await statOrNull(path)
}

