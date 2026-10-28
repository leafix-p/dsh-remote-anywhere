/**
 * Small shared helpers for dsh-remote-anywhere.
 *
 * Everything here is host-side (the local dsh process). Remote paths are
 * POSIX; local paths keep the platform's own spelling.
 *
 * @module dsh-remote-anywhere/util
 */

import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'

/** The Harness home (`$DSH_HOME`, otherwise `~/.dsh`). */
export function dshHome () {
  const configured = process.env.DSH_HOME
  return typeof configured === 'string' && configured.trim() !== ''
    ? resolve(configured)
    : join(homedir(), '.dsh')
}

/** The active profile directory (`$DSH_PROFILE_DIR`, otherwise `$DSH_HOME/profiles/<profile>`). */
export function profileDir () {
  const configured = process.env.DSH_PROFILE_DIR
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured)
  return join(dshHome(), 'profiles', process.env.DSH_PROFILE ?? 'web')
}

/** The shared agents root (`$DSH_AGENTS_HOME`, otherwise `~/.agents`). */
export function agentsHome () {
  const configured = process.env.DSH_AGENTS_HOME
  return typeof configured === 'string' && configured.trim() !== ''
    ? resolve(configured)
    : join(homedir(), '.agents')
}

/** Expand a leading `~` against the local home directory. */
export function expandHome (value) {
  const text = String(value ?? '')
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return text
}

/** POSIX absolute path check (remote side). */
export function isPosixAbsolute (value) {
  return typeof value === 'string' && value.startsWith('/') && !value.includes('\0')
}

/** Normalize an absolute POSIX path without resolving symlinks. */
export function normalizePosix (value) {
  const normalized = posix.normalize(String(value).replaceAll('\\', '/'))
  if (!normalized.startsWith('/')) return `/${normalized}`
  return normalized.length > 1 ? normalized.replace(/\/+$/u, '') : normalized
}

/** Join remote path segments. */
export function posixJoin (...parts) {
  return normalizePosix(posix.join(...parts.map(part => String(part))))
}

/** Basename of a remote path. */
export function posixBasename (value) {
  return posix.basename(normalizePosix(value))
}

/** Quote one string for a POSIX shell. */
export function shellQuote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

/** Quote a value for POSIX shell double quotes. */
export function doubleQuote (value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`')}"`
}

/** SHA-256 fingerprint in the OpenSSH `SHA256:...` spelling. */
export function sha256Fingerprint (key) {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')
  return `SHA256:${digest}`
}

/** A fresh opaque id. */
export function makeId (prefix = 'id') {
  return `${prefix}-${randomUUID()}`
}

/** Best-effort human-readable error message. */
export function errorMessage (error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Read a JSON file, or return `undefined` when it does not exist. */
export async function readJson (filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/** Atomically write a UTF-8 file through a same-directory temporary file. */
export async function atomicWriteFile (filePath, content, mode = 0o600) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temporary, content, { encoding: 'utf8', mode })
  await rename(temporary, filePath)
}

/** Atomically write JSON with two-space indentation. */
export async function atomicWriteJson (filePath, value, mode = 0o600) {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, mode)
}

/** Stat without throwing for a missing path. */
export async function statOrNull (filePath) {
  try {
    return await stat(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
    throw error
  }
}

/** Existing local path check. */
export function exists (filePath) {
  return existsSync(filePath)
}

/**
 * Run a local process and collect its output.
 *
 * @param {string} command - executable.
 * @param {string[]} args - arguments.
 * @param {object} [options] - `cwd`, `env`, `timeoutMs`, `input`, `encoding`.
 * @returns {Promise<{exitCode: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean}>}
 */
export function runLocal (command, args, options = {}) {
  const {
    cwd,
    env = process.env,
    timeoutMs = 30_000,
    input,
    maxBytes = 4 * 1024 * 1024,
  } = options
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    let timedOut = false
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(value)
    }
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.stdout.on('data', (chunk) => {
      if (stdoutBytes >= maxBytes) return
      const part = chunk.subarray(0, maxBytes - stdoutBytes)
      stdoutBytes += part.length
      stdout.push(part)
    })
    child.stderr.on('data', (chunk) => {
      if (stderrBytes >= maxBytes) return
      const part = chunk.subarray(0, maxBytes - stderrBytes)
      stderrBytes += part.length
      stderr.push(part)
    })
    child.on('close', (exitCode, signal) => {
      finish({
        exitCode,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
    if (input !== undefined) {
      child.stdin.end(input)
    } else {
      child.stdin.end()
    }
  })
}

/** Sleep helper. */
export function sleep (ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

/**
 * Keep a bounded, line-oriented log for one connection.
 *
 * Secrets are never passed to this class; callers mask values before logging.
 */
export class LogBuffer {
  /**
   * @param {number} [limit] - maximum retained characters.
   */
  constructor (limit = 120_000) {
    this.limit = limit
    this.text = ''
  }

  /** Append one line (or block) with a timestamp. */
  add (line) {
    const stamp = new Date().toISOString().slice(11, 19)
    for (const part of String(line).split(/\r?\n/u)) {
      if (part === '') continue
      this.text += `[${stamp}] ${part}\n`
    }
    if (this.text.length > this.limit) this.text = this.text.slice(-this.limit)
  }

  /** Current tail. */
  tail (max = 16_000) {
    return this.text.length > max ? this.text.slice(-max) : this.text
  }
}

/** Safe filename segment. */
export function safeSegment (value) {
  const text = String(value ?? '').trim().replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return text === '' ? 'target' : text.slice(0, 80)
}

/**
 * Pick one of several likely `wsl.exe` locations (Windows only).
 *
 * @returns {string} the executable to spawn.
 */
export function wslExecutable () {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const candidate = join(systemRoot, 'System32', 'wsl.exe')
  return exists(candidate) ? candidate : 'wsl.exe'
}

/** The local machine's Node version string, e.g. `v24.15.0`. */
export function localNodeVersion () {
  return process.version
}

/** Parse the major component out of a `v22.16.0` style version. */
export function nodeMajor (version) {
  const match = /^v?(\d+)/u.exec(String(version ?? '').trim())
  return match === null ? null : Number.parseInt(match[1], 10)
}

