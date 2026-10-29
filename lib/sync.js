/**
 * Remote bootstrapping and configuration sync.
 *
 * The remote machine runs its own dsh process: this module installs that dsh
 * into a user-owned prefix (`~/.dsh/remote-bin`), copies the pieces of the
 * local configuration that make the remote feel like home — model/provider
 * settings, credentials, plugin selection, skills and instruction files — then
 * starts `dsh --profile web` in the chosen directory and waits for the token
 * URL it prints.
 *
 * @module dsh-remote-anywhere/sync
 */

import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, posix } from 'node:path'

import {
  agentsHome,
  dshHome,
  errorMessage,
  nodeMajor,
  profileDir,
  shellQuote,
  sleep,
  statOrNull,
} from './util.js'

const FALLBACK_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const FALLBACK_PATCH_IDS = new Set(['ui-settings-general', 'agent-default-model', 'llm-pi-ai', 'ui-theme'])

/** Local dsh version, read from the running installation. */
let cachedLocalVersion
export function localDshVersion () {
  if (cachedLocalVersion !== undefined) return cachedLocalVersion
  const candidates = []
  try {
    const requireFromHere = createRequire(import.meta.url)
    candidates.push(requireFromHere.resolve('@deepseek-ai/dsh/package.json'))
  } catch { /* resolver may not expose the installation package here */ }
  const entry = process.argv[1]
  if (typeof entry === 'string' && entry !== '') {
    candidates.push(join(dirname(entry), '..', 'package.json'))
    candidates.push(join(dirname(entry), '..', '..', 'package.json'))
  }
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8'))
      if (manifest?.name === '@deepseek-ai/dsh' && typeof manifest.version === 'string') {
        cachedLocalVersion = manifest.version
        return cachedLocalVersion
      }
    } catch { /* try the next candidate */ }
  }
  cachedLocalVersion = null
  return cachedLocalVersion
}

/** js-yaml from the profile's dependency tree (the local patch is YAML). */
function loadYaml () {
  try {
    const requireFromProfile = createRequire(join(profileDir(), 'package.json'))
    return requireFromProfile('js-yaml')
  } catch {
    return undefined
  }
}

/** Strip ANSI escapes from remote log text. */
export function stripAnsi (text) {
  return String(text).replace(/\u001B\[[0-9;]*[A-Za-z]/gu, '')
}

/** Remove launch tokens before text reaches the log buffer shown in the UI. */
export function maskSecrets (text) {
  return String(text)
    .replace(/([?&]token=)[A-Za-z0-9_-]+/gu, '$1***')
    .replace(/(authorization:\s*bearer\s+)[^\s]+/giu, '$1***')
}

/**
 * Ensure a usable dsh exists inside the remote user's home.
 *
 * @param {object} transport - SSH or WSL transport.
 * @param {object} options - `version`, `registry`, `log`, `timeoutMs`.
 * @returns {Promise<{bin:string, version:string, node:string, npm:string, home:string, prefix:string, installed:boolean}>}
 */
export async function ensureRemoteDsh (transport, options = {}) {
  const log = options.log
  const probe = await transport.probe()
  if (probe.home === '' || !probe.home.startsWith('/')) throw new Error('无法确定远端 home 目录')
  if (probe.node === '') {
    throw new Error('远端没有 Node.js。请先在远端安装 Node.js 22 或 24（例如通过 nvm 或发行版包管理器），然后重试。')
  }
  const major = nodeMajor(probe.node)
  if (major === null || major < 22) {
    throw new Error(`远端 Node.js 版本过低（${probe.node}）。远端 dsh 需要 Node.js 22 或 24，请升级后重试。`)
  }
  if (probe.npm === '') {
    throw new Error('远端没有 npm。请安装 npm（通常随 Node.js 一起提供）后重试。')
  }
  const version = options.version && options.version !== 'auto' && options.version !== ''
    ? options.version
    : (localDshVersion() ?? 'latest')
  const prefix = options.prefix ?? posix.join(probe.home, '.dsh', 'remote-bin')
  const packageDir = posix.join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
  const wrapper = posix.join(prefix, 'dsh-wrap.mjs')
  const binJs = posix.join(packageDir, 'lib', 'bin.js')
  const wrapperText = `import { runCli } from ${JSON.stringify(`file://${binJs}`)}\nawait runCli()\n`
  const writeWrapper = async () => {
    await transport.writeFile(wrapper, Buffer.from(wrapperText, 'utf8'), 0o755)
  }
  const testWrapper = async () => {
    const result = await transport.exec(`node ${shellQuote(wrapper)} --version`, { timeoutMs: 30_000 })
    const reported = stripAnsi(result.stdout).trim().split(/\r?\n/u).pop() ?? ''
    return { ok: result.exitCode === 0 && reported !== '', reported, detail: stripAnsi(result.stderr || result.stdout).slice(-2000) }
  }
  const install = async () => {
    log?.add(`安装远端 dsh ${version}（首次安装约 30–60 秒）`)
    await transport.mkdirp(prefix)
    const registry = options.registry && options.registry !== '' ? ` --registry=${shellQuote(options.registry)}` : ''
    const command = [
      'set -e',
      `cd ${shellQuote(probe.home)}`,
      // No --legacy-peer-deps here: dsh-app-boot's peer packages (for example
      // @deepseek-ai/cordis-plugin-group) must be installed for the CLI to
      // load, and npm 9 does not add them under that flag.
      `npm install --prefix ${shellQuote(prefix)} --omit=dev --no-audit --no-fund --loglevel=error @deepseek-ai/dsh@${shellQuote(version)}${registry}`,
    ].join(' && ')
    const result = await transport.exec(command, { timeoutMs: options.timeoutMs ?? 300_000 })
    if (result.exitCode !== 0) {
      throw new Error(`远端安装 dsh 失败（exit ${result.exitCode}）：${stripAnsi(result.stderr || result.stdout).slice(-2000)}`)
    }
    const after = await remoteDshVersion(transport, packageDir)
    if (after === undefined) throw new Error('远端安装完成，但没有找到 @deepseek-ai/dsh 包；请检查 npm 输出')
  }

  const installedVersion = await remoteDshVersion(transport, packageDir)
  let installed = installedVersion === version
  try {
    await writeWrapper()
  } catch (error) {
    throw new Error(`写入远端 dsh 启动器失败（${wrapper}）：${errorMessage(error)}`)
  }
  let check = installed ? await testWrapper() : { ok: false, reported: '', detail: '' }
  if (installed && !check.ok) {
    log?.add('远端 dsh 安装不完整，正在重新安装依赖…')
    await transport.exec(`rm -rf ${shellQuote(posix.join(prefix, 'node_modules'))}`, { timeoutMs: 60_000 }).catch(() => {})
    installed = false
  }
  if (!installed) {
    await install()
    await writeWrapper()
    check = await testWrapper()
    installed = true
  }
  if (!check.ok) {
    throw new Error(`远端 dsh 无法启动（exit 非零）：${check.detail}`)
  }
  log?.add(`远端 dsh 就绪：${check.reported}`)
  return {
    bin: wrapper,
    version: check.reported,
    node: probe.node,
    npm: probe.npm,
    home: probe.home,
    prefix,
    installed,
  }
}

/** Read the installed dsh version from the remote prefix (or undefined). */
async function remoteDshVersion (transport, packageDir) {
  const file = posix.join(packageDir, 'package.json')
  try {
    const text = (await transport.readFile(file)).toString('utf8')
    const parsed = JSON.parse(text)
    return typeof parsed?.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

/**
 * Rewrite the local profile manifest for the remote installation.
 *
 * Local-only dependencies (`link:` / `file:` / `workspace:`) and this plugin
 * itself cannot exist on the remote machine; leaving them in makes `npm
 * install` fail and forces every connection into the base-plugin fallback.
 */
function sanitizeProfileManifest (localText, warnings) {
  let manifest
  try {
    manifest = JSON.parse(localText)
  } catch (error) {
    warnings.push(`本地 profile package.json 解析失败：${errorMessage(error)}`)
    return undefined
  }
  if (typeof manifest !== 'object' || manifest === null) return undefined
  const dependencies = {}
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (name === 'dsh-remote-anywhere') continue
    if (typeof spec === 'string' && /^(link|file|workspace|portal):/iu.test(spec)) {
      warnings.push(`远端无法安装本地路径依赖 ${name}（${spec}），已跳过`)
      continue
    }
    dependencies[name] = spec
  }
  const bundles = (manifest.dsh?.profile?.bundles ?? []).filter(name => name !== 'dsh-remote-anywhere')
  return `${JSON.stringify({
    ...manifest,
    dependencies,
    dsh: {
      ...(manifest.dsh ?? {}),
      profile: {
        ...(manifest.dsh?.profile ?? {}),
        bundles,
      },
    },
  }, null, 2)}\n`
}

/**
 * Register the chosen directory as a workspace in the remote dsh registry.
 *
 * The remote Web GUI reads this document at startup; without an entry it
 * shows "选择工作区" and the user's directory is not actually open. Registering
 * it here (and making it the default when the remote has none) is what turns
 * "run dsh on the remote" into "open this folder on the remote".
 *
 * @param {object} transport - connected transport.
 * @param {string} workspacePath - absolute remote directory.
 * @param {object} [log] - log buffer.
 * @returns {Promise<{id:string, path:string, created:boolean}>}
 */
export async function ensureRemoteWorkspace (transport, workspacePath, log) {
  const home = await transport.home()
  const file = posix.join(home, '.dsh', 'storages', 'workspace.json')
  let document
  try {
    document = JSON.parse((await transport.readFile(file)).toString('utf8'))
  } catch {
    document = undefined
  }
  if (document === undefined || typeof document !== 'object' || document === null) {
    document = { unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: [] }, tables: { workspaces: {} } }
  }
  document.unit = document.unit ?? { name: 'workspace', version: 2 }
  document.global = document.global ?? { initialized: true, workspaceIds: [] }
  document.tables = document.tables ?? {}
  document.tables.workspaces = document.tables.workspaces ?? {}
  document.global.workspaceIds = Array.isArray(document.global.workspaceIds) ? document.global.workspaceIds : []
  const workspaces = document.tables.workspaces
  let existing = Object.entries(workspaces).find(([, workspace]) => workspace?.path === workspacePath)
  let id
  let created = false
  if (existing === undefined) {
    id = randomUUID()
    const now = new Date().toISOString()
    workspaces[id] = {
      path: workspacePath,
      title: posix.basename(workspacePath) || workspacePath,
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    }
    created = true
  } else {
    id = existing[0]
    workspaces[id].title = workspaces[id].title || posix.basename(workspacePath)
  }
  if (!document.global.workspaceIds.includes(id)) document.global.workspaceIds.unshift(id)
  // The user picked this directory for this connection: make it the one the
  // remote GUI opens, even when the remote already had another default.
  document.global.defaultWorkspaceId = id
  document.global.initialized = true
  await transport.writeFile(file, Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8'), 0o600)
  log?.add(`${created ? '已注册' : '已存在'}远端工作区：${workspacePath}`)
  return { id, path: workspacePath, created }
}

/** Build the minimal profile patch used when full plugin sync cannot work. */
function buildFallbackPatch (localPatchText, warnings) {  const yaml = loadYaml()
  if (yaml === undefined) {
    warnings.push('未找到 js-yaml，无法筛选本地配置；远端将没有任何模型配置')
    return '[]\n'
  }
  let entries
  try {
    entries = yaml.load(localPatchText ?? '')
  } catch (error) {
    warnings.push(`本地 cordis.patch.yml 解析失败：${errorMessage(error)}`)
    return '[]\n'
  }
  if (!Array.isArray(entries)) {
    warnings.push('本地 cordis.patch.yml 不是补丁数组；已跳过')
    return '[]\n'
  }
  const kept = entries.filter(entry => entry !== null && typeof entry === 'object' && FALLBACK_PATCH_IDS.has(entry.id))
  const dropped = entries.length - kept.length
  if (dropped > 0) warnings.push(`基础插件集不包含 ${dropped} 条本地补丁项，已跳过`)
  try {
    return yaml.dump(kept, { lineWidth: 120, noRefs: true })
  } catch (error) {
    warnings.push(`生成远端补丁失败：${errorMessage(error)}`)
    return '[]\n'
  }
}

/** Recursively collect files under a local directory, skipping link loops. */
async function collectFiles (root, { maxFiles = 6000, maxBytes = 80 * 1024 * 1024 } = {}) {
  const files = []
  const directories = []
  let bytes = 0
  let truncated = false
  async function walk (directory, relative) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (truncated) return
      const rel = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        directories.push(rel)
        await walk(join(directory, entry.name), rel)
        continue
      }
      if (!entry.isFile()) continue
      if (files.length >= maxFiles) {
        truncated = true
        return
      }
      try {
        const info = await statOrNull(join(directory, entry.name))
        if (info === null) continue
        bytes += info.size
        if (bytes > maxBytes) {
          truncated = true
          return
        }
        files.push({ relative: rel, localPath: join(directory, entry.name), size: info.size })
      } catch { /* skip unreadable files */ }
    }
  }
  await walk(root, '')
  return { files, directories, truncated }
}

/** Race one promise against a labelled timeout. */
function withTimeout (promise, ms, label) {
  let timer
  const timeout = new Promise((_, rejectPromise) => {
    timer = setTimeout(() => rejectPromise(new Error(`${label}（${ms}ms）`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => { clearTimeout(timer) })
}

/**
 * Copy a local directory tree to a remote directory.
 *
 * Skill trees can hold thousands of small files, and one SSH round trip per
 * file made a connect look frozen: no progress lines, no timeout, and the
 * whole pipeline waited forever on a single stalled SFTP write. Upload in a
 * small pool instead, report every 50 files, bound each write, and stop at a
 * total deadline so a large tree degrades to a warning rather than a hang.
 */
export async function copyTree (transport, localRoot, remoteRoot, report, label, options = {}) {
  if (!existsSync(localRoot)) return
  const log = options.log
  const timeoutMs = options.timeoutMs ?? 120_000
  const fileTimeoutMs = options.fileTimeoutMs ?? 20_000
  const deadline = Date.now() + timeoutMs
  const { files, directories, truncated } = await collectFiles(localRoot)
  if (truncated) report.warnings.push(`${label} 超过复制上限，部分文件未同步`)
  if (files.length === 0) {
    report.details.push(`${label}: 空`)
    return
  }
  log?.add(`${label}：${files.length} 个文件`)
  try {
    await withTimeout(transport.mkdirp(remoteRoot), 30_000, `创建远端目录 ${remoteRoot} 超时`)
  } catch (error) {
    report.warnings.push(`${label}：${errorMessage(error)}`)
    return
  }
  for (const directory of directories) {
    try {
      await withTimeout(transport.mkdirp(posix.join(remoteRoot, directory)), 30_000, `创建远端目录 ${directory} 超时`)
    } catch (error) {
      report.warnings.push(`${label}：${directory} 创建失败（${errorMessage(error)}）`)
    }
  }
  let copied = 0
  let failed = 0
  let cancelled = false
  const queue = [...files]
  const worker = async () => {
    while (!cancelled) {
      const file = queue.shift()
      if (file === undefined) return
      if (Date.now() > deadline) {
        cancelled = true
        return
      }
      try {
        const content = await readFile(file.localPath)
        await withTimeout(
          transport.writeFile(posix.join(remoteRoot, file.relative), content, 0o644),
          fileTimeoutMs,
          `上传 ${file.relative} 超时`,
        )
        copied += 1
        if (log !== undefined && copied % 50 === 0) log.add(`${label}：${copied}/${files.length}`)
      } catch (error) {
        failed += 1
        if (failed <= 3) report.warnings.push(`${label}：${file.relative} 失败（${errorMessage(error)}）`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, files.length) }, () => worker()))
  if (cancelled) report.warnings.push(`${label} 同步超时（${timeoutMs}ms），已上传 ${copied}/${files.length} 个文件`)
  if (failed > 0) report.warnings.push(`${label}：${failed} 个文件上传失败`)
  report.copiedFiles += copied
  report.details.push(`${label}: ${copied} 个文件`)
}

/**
 * Sync the local configuration to the remote dsh home.
 *
 * @param {object} transport - connected transport.
 * @param {object} options - `credentials`, `plugins`, `skills`, `prompts`, `log`, `pluginsTimeoutMs`.
 * @returns {Promise<object>} a structured report for the UI.
 */
export async function syncRemoteConfiguration (transport, options = {}) {
  const log = options.log
  const report = {
    mode: 'base',
    credentials: false,
    skills: false,
    prompts: false,
    copiedFiles: 0,
    details: [],
    warnings: [],
  }
  const remoteHome = await transport.home()
  const remoteDshHome = posix.join(remoteHome, '.dsh')
  const remoteAgentsHome = posix.join(remoteHome, '.agents')
  const remoteProfile = posix.join(remoteDshHome, 'profiles', 'web')
  const localProfile = profileDir()
  await transport.mkdirp(remoteProfile)
  await transport.mkdirp(posix.join(remoteDshHome, 'logs', 'remote-anywhere'))

  if (options.credentials !== false) {
    const credentialsPath = join(dshHome(), '.credentials.yaml')
    if (existsSync(credentialsPath)) {
      const content = await readFile(credentialsPath)
      await transport.writeFile(posix.join(remoteDshHome, '.credentials.yaml'), content, 0o600)
      report.credentials = true
      report.details.push('模型凭据 .credentials.yaml')
    } else {
      report.warnings.push('本地没有 .credentials.yaml，远端模型可能没有 API Key')
    }
  }

  const localPatchPath = join(localProfile, 'cordis.patch.yml')
  const localPatch = existsSync(localPatchPath) ? await readFile(localPatchPath, 'utf8') : ''
  const fallbackWarnings = []
  const fallbackPatch = buildFallbackPatch(localPatch, fallbackWarnings)

  const basePackage = {
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: FALLBACK_BUNDLES } },
  }
  const basePackageText = `${JSON.stringify(basePackage, null, 2)}\n`
  const packagePath = join(localProfile, 'package.json')
  const localPackageText = existsSync(packagePath) ? await readFile(packagePath, 'utf8') : ''
  const remotePackageText = localPackageText === '' ? undefined : sanitizeProfileManifest(localPackageText, report.warnings)

  if (options.plugins !== false && remotePackageText !== undefined) {
    log?.add('同步插件清单并安装远端依赖（这一步最慢）')
    await transport.writeFile(posix.join(remoteProfile, 'package.json'), Buffer.from(remotePackageText, 'utf8'), 0o644)
    await transport.writeFile(posix.join(remoteProfile, 'cordis.patch.yml'), Buffer.from(localPatch, 'utf8'), 0o644)
    const registry = options.registry && options.registry !== '' ? ` --registry=${shellQuote(options.registry)}` : ''
    const command = `npm install --omit=dev --legacy-peer-deps --no-audit --no-fund --loglevel=error${registry}`
    const installed = await transport.exec(command, {
      cwd: remoteProfile,
      timeoutMs: options.pluginsTimeoutMs ?? 300_000,
    })
    if (installed.exitCode === 0) {
      const dshBin = options.dshBin ?? posix.join(remoteHome, '.dsh', 'remote-bin', 'dsh-wrap.mjs')
      const dump = await transport.exec(`node ${shellQuote(dshBin)} --profile web --dump-config >/dev/null 2>&1`, {
        timeoutMs: 120_000,
      })
      if (dump.exitCode === 0) {
        report.mode = 'full'
        report.details.push('本地插件集与补丁（完整同步）')
        log?.add('插件同步完成，远端配置与本地一致')
      } else {
        report.warnings.push('插件已安装，但远端加载配置失败；已回退到基础插件集')
        log?.add('远端加载完整插件集失败，回退到基础插件集')
      }
    } else {
      report.warnings.push(`插件依赖安装失败（exit ${installed.exitCode}），已回退到基础插件集：${stripAnsi(installed.stderr || installed.stdout).slice(-1000)}`)
      log?.add('插件安装失败，回退到基础插件集')
    }
  } else if (options.plugins === false) {
    report.warnings.push('插件同步已关闭；远端只启用基础插件集')
  }

  if (report.mode !== 'full') {
    report.warnings.push(...fallbackWarnings)
    await transport.writeFile(posix.join(remoteProfile, 'package.json'), Buffer.from(basePackageText, 'utf8'), 0o644)
    await transport.writeFile(posix.join(remoteProfile, 'cordis.patch.yml'), Buffer.from(fallbackPatch, 'utf8'), 0o644)
    if (localPatch !== '') report.details.push('模型 / 主题补丁（筛选后的基础配置）')
  }
  await transport.writeFile(posix.join(remoteProfile, 'cordis.yml'), Buffer.from('[]\n', 'utf8'), 0o644)

  if (options.prompts !== false) {
    const promptFiles = [
      [join(dshHome(), 'AGENTS.md'), posix.join(remoteDshHome, 'AGENTS.md')],
      [join(agentsHome(), 'AGENTS.md'), posix.join(remoteAgentsHome, 'AGENTS.md')],
    ]
    for (const [local, remote] of promptFiles) {
      if (!existsSync(local)) continue
      await transport.writeFile(remote, await readFile(local), 0o644)
      report.prompts = true
      report.details.push(`提示词 ${basename(local)} → ${remote}`)
    }
  }

  if (options.skills !== false) {
    await copyTree(transport, join(agentsHome(), 'skills'), posix.join(remoteAgentsHome, 'skills'), report, '技能 ~/.agents/skills', { log })
    await copyTree(transport, join(dshHome(), 'skills'), posix.join(remoteDshHome, 'skills'), report, '技能 ~/.dsh/skills', { log })
    report.skills = true
  }

  return report
}

/**
 * Start the remote dsh web server in the chosen directory.
 *
 * The server runs in the foreground of one transport channel (an SSH exec
 * channel or a `wsl.exe` child). Its lifetime is therefore tied to the
 * connection object, and its own stdout is the URL/log source — no remote
 * nohup, PID file, or log tailing is involved.
 *
 * @param {object} transport - connected transport.
 * @param {object} options - `bin`, `workspacePath`, `startTimeoutMs`, `log`.
 * @returns {Promise<{url:string, token:string, port:number, handle:object}>}
 */
export async function startRemoteDsh (transport, options) {
  const { bin, workspacePath } = options
  const home = await transport.home()
  const command = `env DSH_HOME=${shellQuote(posix.join(home, '.dsh'))} node ${shellQuote(bin)} --profile web --host 127.0.0.1 --port 0 --no-open`
  let text = ''
  let settled = false
  let handle
  let resolveUrl
  let rejectUrl
  const urlPromise = new Promise((resolvePromise, rejectPromise) => {
    resolveUrl = resolvePromise
    rejectUrl = rejectPromise
  })
  const consume = (kind, chunk) => {
    const clean = stripAnsi(chunk)
    if (clean === '') return
    text += clean
    if (text.length > 200_000) text = text.slice(-120_000)
    for (const line of clean.split(/\r?\n/u)) {
      if (line.trim() !== '') options.log?.add(`${kind === 'stderr' ? 'stderr: ' : ''}${maskSecrets(line)}`)
    }
    const match = /dsh web:\s+(https?:\/\/\S+)/u.exec(text)
    if (match !== null && !settled) {
      settled = true
      resolveUrl(match[1])
    }
    if (!settled && /EADDRINUSE|Cannot find module|error while loading|failed to start/iu.test(clean)) {
      settled = true
      rejectUrl(new Error(`远端 dsh 启动失败：${text.slice(-3000)}`))
    }
  }
  try {
    handle = await transport.startProcess(command, {
      cwd: workspacePath,
      onData: consume,
    })
  } catch (error) {
    throw new Error(`启动远端 dsh 失败：${errorMessage(error)}`)
  }
  handle.onExit((code, signal) => {
    if (settled) return
    settled = true
    rejectUrl(new Error(`远端 dsh 在报告 URL 前退出（code ${code ?? 'null'}${signal ? `, ${signal}` : ''}）：${text.slice(-3000)}`))
  })
  const timeoutMs = options.startTimeoutMs ?? 120_000
  let timer
  try {
    const url = await Promise.race([
      urlPromise,
      new Promise((resolvePromise, rejectPromise) => {
        timer = setTimeout(() => rejectPromise(new Error(`等待远端 dsh 启动超时（${Math.round(timeoutMs / 1000)} 秒）：${text.slice(-3000)}`)), timeoutMs)
      }),
    ])
    clearTimeout(timer)
    const parsed = new URL(url)
    const token = parsed.searchParams.get('token') ?? ''
    const port = Number.parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'), 10)
    options.log?.add(`远端 dsh 已监听 ${parsed.hostname}:${port}`)
    return { url, token, port, handle }
  } catch (error) {
    clearTimeout(timer)
    try { await handle.stop() } catch { /* best-effort */ }
    throw error
  }
}

/** Terminate the remote dsh process held by one foreground handle. */
export async function stopRemoteDsh (transport, handle, log) {
  if (handle === undefined || handle === null) return
  try {
    await handle.stop()
    log?.add('已停止远端 dsh 进程')
  } catch { /* the channel may already be gone */ }
}

/** Poll an HTTP URL until it answers, or throw. */
export async function waitForHttp (url, { timeoutMs = 45_000, intervalMs = 700 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(5_000) })
      if (response.status >= 200 && response.status < 500) {
        await response.text().catch(() => {})
        return true
      }
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = errorMessage(error)
    }
    await sleep(intervalMs)
  }
  throw new Error(`远端界面无法访问：${lastError}`)
}

