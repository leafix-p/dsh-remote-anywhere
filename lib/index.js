/**
 * DSH Remote Anywhere — host half.
 *
 * Adds a VS Code Remote Anywhere style surface to the Web GUI: SSH hosts and
 * WSL distributions in one target list, one-click remote dsh bootstrap with
 * local configuration sync, and the remote dsh GUI embedded in the local
 * window over a loopback port forward.
 *
 * The plugin owns no filesystem seam. Remote file editing continues to be the
 * job of dsh-ssh-workspace; this plugin's remote side is a full dsh process,
 * which works on its own machine natively.
 *
 * @module dsh-remote-anywhere
 */

import { RemoteAnywhere } from './remote.js'
import { RemoteWorkspaceMonitor } from './remote-workspaces.js'
import { makeRoutes } from './routes.js'
import { makeTools } from './tools.js'
import { patchRemoteTerminalCompatibility } from './compat.js'
import { installLocalTerminalFallback } from './local-terminal.js'
import { errorMessage } from './util.js'
// The SSH workspace host half is vendored so this plugin works on its own:
// remote-anywhere owns the fs/shell/subprocess/terminal seams and the mount
// routes instead of requiring the dsh-ssh-workspace bundle to load.
import { apply as applySshWorkspaceHost } from '../vendor/ssh-workspace/lib/index.js'

/** Stable Cordis plugin name. */
export const name = 'remote-anywhere'

/** Services required before the HTTP surface and tools can mount. */
export const inject = ['tools']

/** Relative order of the announcement section inside the tool-guidance band. */
const SECTION_ORDER = 156

/** Model-facing announcement. */
export const REMOTE_ANYWHERE_GUIDANCE = [
  '本机已安装 dsh-remote-anywhere 插件（远程资源管理器）：可以在 SSH 主机或本机 WSL 发行版上启动一个完整的远端 dsh，并把它的界面嵌入本地窗口。',
  '',
  '工具：remote_anywhere_targets（列出 SSH 主机与 WSL 发行版）、remote_anywhere_connect（在远端安装/启动 dsh 并返回连接 id）、',
  'remote_anywhere_status（连接状态）、remote_anywhere_disconnect（停止远端 dsh）。',
  '界面入口：左侧「远程资源管理器」面板。它负责：选择目标 → 选择远端目录 → 自动安装远端 dsh（~/.dsh/remote-bin）→ 同步本地模型/凭据/插件/技能/提示词 → 启动 `dsh --profile web` → 通过本地端口转发嵌入远端界面。',
  '',
  '注意：远端 dsh 是独立进程，会话与文件都在远端；本地 GUI 只是通过 loopback 转发显示它。',
  '首次连接需要远端有 Node.js 22/24 与 npm；安装 dsh 与安装本地插件集可能各需数十秒。',
  '远端配置会写入远端用户的 ~/.dsh（含本地 .credentials.yaml 中的模型凭据），请只在可信主机上使用。',
].join('\n')

/**
 * Mount the Remote Anywhere service, tools and browser routes.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {object} [config] - resolved plugin config.
 * @returns {void}
 */
export function apply (ctx, config = {}) {
  if (config.enabled === false) return
  const explorer = new RemoteAnywhere(ctx, config)
  const workspaceMonitor = new RemoteWorkspaceMonitor(ctx, config)

  // Mount the embedded SSH workspace host before anything tries to resolve an
  // `ssh://` path: it registers the remote fs seam, the shell/subprocess and
  // terminal patches, and the /api/dsh-ssh-workspace mount routes.
  const sshWorkspaceConfig = config.sshWorkspace ?? {}
  if (sshWorkspaceConfig.enabled !== false) {
    try {
      applySshWorkspaceHost(ctx, {
        enabled: true,
        announceToAgent: false,
        ...(sshWorkspaceConfig.engine === undefined ? {} : { engine: sshWorkspaceConfig.engine }),
      })
      ctx.logger?.info?.('remote-anywhere: embedded ssh workspace host mounted')
    } catch (error) {
      ctx.logger?.warn?.(`remote-anywhere: could not mount the embedded ssh workspace host: ${errorMessage(error)}`)
    }
  }

  void explorer.loadSettings()
  void patchRemoteTerminalCompatibility(ctx)
  installLocalTerminalFallback(ctx, config)

  if (config.announceToAgent === true) {
    try {
      const systemPrompt = ctx.get('systemPrompt')
      if (systemPrompt !== undefined && systemPrompt !== null) {
        ctx.effect(
          () => systemPrompt.section({
            name: 'plugin:dsh-remote-anywhere',
            order: SECTION_ORDER,
            text: REMOTE_ANYWHERE_GUIDANCE,
          }),
          'remote-anywhere: guidance',
        )
      }
    } catch { /* headless deployments may have no system prompt */ }
  }

  try {
    const tools = makeTools(explorer)
    for (const tool of tools) ctx.tools.register(tool)
    ctx.logger?.info?.(`remote-anywhere: registered ${tools.length} agent tools`)
  } catch (error) {
    ctx.logger?.warn?.(`remote-anywhere: could not register tools: ${error instanceof Error ? error.message : String(error)}`)
  }

  ctx.effect(() => () => { void explorer.dispose() }, 'remote-anywhere: dispose connections')
  ctx.effect(() => () => { workspaceMonitor.dispose() }, 'remote-anywhere: dispose workspace monitor')

  // The browser half needs the deployment's web server. A headless profile
  // simply never gets the HTTP surface, while the agent tools still work.
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.get('webServer')
    if (webServer === undefined || webServer === null) return
    scoped.effect(() => {
      const routes = makeRoutes(explorer, scoped, workspaceMonitor)
      const disposers = routes.map(route => webServer.register(route))
      scoped.logger?.info?.(`remote-anywhere: registered ${routes.length} HTTP routes`)
      return () => { for (const dispose of disposers) dispose() }
    }, 'remote-anywhere: routes')
  })
}

export { RemoteAnywhere }

