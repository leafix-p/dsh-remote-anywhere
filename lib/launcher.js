/**
 * Local launch helpers: open the remote directory in VS Code Remote, open a
 * remote terminal, or open a WSL directory in Windows Explorer.
 *
 * Everything here runs on the local host. The remote side has no part in it
 * beyond being the target these commands point at, which is exactly what makes
 * VS Code's own remote terminal and explorer work in the connected state.
 *
 * @module dsh-remote-anywhere/launcher
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { parseSshConfig } from './store.js'
import { errorMessage, wslExecutable } from './util.js'

const KINDS = new Set(['vscode', 'terminal', 'explorer'])

/** Locate the VS Code CLI on Windows (or fall back to PATH elsewhere). */
function findCodeCli () {
  if (process.platform !== 'win32') return 'code'
  const candidates = [
    process.env.VSCODE_CLI,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd') : undefined,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'Microsoft VS Code', 'bin', 'code.cmd') : undefined,
    process.env['ProgramFiles(x86)'] ? join(process.env['ProgramFiles(x86)'], 'Microsoft VS Code', 'bin', 'code.cmd') : undefined,
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('未找到 VS Code CLI（code）。请安装 VS Code，或把 bin/code.cmd 所在目录加入 PATH。')
}

/** Locate Windows Terminal, or fall back to PATH. */
function findWindowsTerminal () {
  if (process.platform !== 'win32') return 'wt'
  const candidates = [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe') : undefined,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'WindowsApps', 'wt.exe') : undefined,
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return 'wt.exe'
}

/** Quote one argument for PowerShell's call operator. */
function quotePowerShell (value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

/** Spawn a detached local process and do not wait for it. */
function spawnDetached (command, args, options = {}) {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    ...options,
  })
  child.on('error', () => { /* the caller sees the window fail to appear */ })
  child.unref()
}

/**
 * Spawn a batch/CLI command through Windows PowerShell.
 *
 * `code.cmd` lives under `C:\Program Files\...`; invoking it through cmd.exe
 * with a path containing spaces is unreliable (and differs with /S /C quote
 * stripping). PowerShell's call operator handles the quoted executable and
 * arguments consistently.
 */
function spawnThroughPowerShell (command, args) {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const line = `& ${quotePowerShell(command)} ${args.map(quotePowerShell).join(' ')}`
  const child = spawn(powershell, ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', line], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', () => { /* nothing else we can do */ })
  child.unref()
}

/** WSL path → `\\wsl.localhost\<distro>\...` for Explorer. */
export function wslUncPath (distro, remotePath) {
  const tail = String(remotePath).replace(/^\/+/u, '').replaceAll('/', '\\')
  return `\\\\wsl.localhost\\${distro}\\${tail}`
}

/**
 * Resolve the Remote-SSH authority VS Code accepts.
 *
 * Preference order: a real ~/.ssh/config alias for the same host/port/user,
 * then `user@host` for port 22. VS Code Remote-SSH reads ports from the SSH
 * config, so a custom port without a Host block cannot be expressed here.
 */
async function sshAuthority (target) {
  if (target.source === 'ssh-config' && typeof target.alias === 'string' && target.alias !== '') {
    return target.alias
  }
  try {
    const rows = await parseSshConfig()
    const match = rows.find(row =>
      row.host === target.host &&
      row.port === target.port &&
      (target.user === '' || row.user === target.user))
    if (match !== undefined) return match.alias
  } catch { /* fall through to an ad-hoc authority */ }
  if (target.port === 22) {
    return target.user === '' ? target.host : `${target.user}@${target.host}`
  }
  throw new Error(
    `VS Code Remote-SSH 无法直接表达 ${target.host}:${target.port} 的非 22 端口。` +
    '请先在 ~/.ssh/config 中为它添加一个 Host 别名（HostName / User / Port），再用 VS Code 打开。',
  )
}

/** Build the launch plan without spawning anything (also useful for tests). */
export async function planLaunch (target, remotePath, kind) {
  if (!KINDS.has(kind)) throw new Error(`未知的打开方式：${kind}`)
  if (typeof remotePath !== 'string' || !remotePath.startsWith('/')) {
    throw new Error(`远端路径必须是绝对 POSIX 路径：${remotePath}`)
  }
  if (target.kind === 'wsl') {
    if (kind === 'vscode') {
      return {
        kind,
        command: findCodeCli(),
        args: ['--remote', `wsl+${target.distro}`, remotePath],
        viaPowerShell: process.platform === 'win32',
        description: `VS Code（WSL: ${target.distro}）`,
      }
    }
    if (kind === 'terminal') {
      return {
        kind,
        command: findWindowsTerminal(),
        args: ['new-tab', '--title', target.name ?? target.distro, wslExecutable(), '-d', target.distro, '--cd', remotePath],
        description: `WSL 终端（${target.distro}）`,
      }
    }
    return {
      kind,
      command: 'explorer.exe',
      args: [wslUncPath(target.distro, remotePath)],
      description: `Windows 资源管理器（${target.distro}）`,
    }
  }

  if (kind === 'vscode') {
    return {
      kind,
      command: findCodeCli(),
      args: ['--remote', `ssh-remote+${await sshAuthority(target)}`, remotePath],
      viaPowerShell: process.platform === 'win32',
      description: `VS Code（SSH: ${target.alias ?? target.host}）`,
    }
  }
  if (kind === 'terminal') {
    const sshArgs = []
    if (target.port !== 22) sshArgs.push('-p', String(target.port))
    sshArgs.push(target.user === '' ? target.host : `${target.user}@${target.host}`)
    return {
      kind,
      command: findWindowsTerminal(),
      args: ['new-tab', '--title', target.name ?? target.alias ?? target.host, 'ssh', ...sshArgs],
      description: `SSH 终端（${target.alias ?? target.host}）`,
    }
  }
  throw new Error('Windows 资源管理器不能直接浏览 SSH 文件。SSH 目标请使用「VS Code」或「终端」。')
}

/** Launch one plan. Throws only when the local process cannot be spawned. */
export function launchPlan (plan) {
  try {
    if (plan.viaPowerShell === true) spawnThroughPowerShell(plan.command, plan.args)
    else spawnDetached(plan.command, plan.args)
  } catch (error) {
    throw new Error(`启动 ${plan.description} 失败：${errorMessage(error)}`)
  }
}

/**
 * Plan and launch in one call.
 *
 * @param {object} target - SSH row or WSL target.
 * @param {string} remotePath - absolute remote directory.
 * @param {'vscode'|'terminal'|'explorer'} kind - what to open.
 * @returns {Promise<object>} the plan that was launched.
 */
export async function launchLocal (target, remotePath, kind) {
  const plan = await planLaunch(target, remotePath, kind)
  launchPlan(plan)
  return plan
}


