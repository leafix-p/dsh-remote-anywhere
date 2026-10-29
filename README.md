# DSH Remote Anywhere

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)]()
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.1--rc.2-blue)]()

**SSH / WSL remote development for DeepSeek Harness.**<br>
**简体中文** · [English](README.en.md)

把 SSH 主机或本机 WSL 发行版当作「远端开发机」：在那边安装并运行一份完整的 dsh，
本地窗口通过 loopback 端口转发显示它的界面，并把模型、凭据、插件、技能和提示词同步过去。

界面入口是左侧活动栏的「远程资源管理器」图标。功能上对标 VS Code Remote Explorer，
但执行的是**远端的 dsh**，而不是把本地工具调用转发过去。

- **WSL 目标**：不需要在 WSL 里装 sshd，直接用 `wsl.exe` + `\\wsl.localhost` 工作；
- **远端 dsh**：在远端真正跑一个 `dsh --profile web`，而不只是把工具调用转发过去。

> 想「本地对话 + 远端文件/命令」时，用现有的「远程工作区」面板（dsh-ssh-workspace）更合适：
> 那条路的会话和上下文都在本地。本插件是另一种模式——**会话、文件、命令都在远端**，
> 本地窗口只是把远端界面显示出来。

### 一句话选型

| 场景 | 推荐 |
| --- | --- |
| 远端有完整工具链 / GPU / 模型环境，希望 agent 和会话都在远端 | **本插件** |
| 只想让本地 agent 读写远端文件、跑远端命令，对话留在本地 | dsh-ssh-workspace |
| Windows 上不想给 WSL 装 sshd，直接把 WSL 当开发机 | **本插件** |

## 功能

| 能力 | 说明 |
| --- | --- |
| SSH 目标 | 读取 `$DSH_HOME/dsh-ssh.json`（与 dsh-ssh-workspace 共享，含加密密码）与 `~/.ssh/config`；支持密码、私钥、ssh-agent |
| WSL 目标 | 自动发现 `wsl.exe -l -q` 的发行版；命令走 `wsl.exe -d <distro> -- bash -lc`，文件走 `\\wsl.localhost\<distro>` |
| 远端 dsh 安装 | 首次连接在远端 `~/.dsh/remote-bin` 里用 npm 安装与本地同版本的 `@deepseek-ai/dsh`；不污染全局 npm，不需要 root |
| 远端目录 | 选择目录后注册为远端 dsh 的默认 workspace，远端 GUI 直接打开该目录 |
| 配置同步 | 模型/provider 配置（`cordis.patch.yml`）、`~/.dsh/.credentials.yaml`、插件清单、`~/.agents/skills`、`~/.dsh/skills`、`AGENTS.md` |
| 插件回退 | 本地插件集在远端安装/加载失败时，自动回退到「基础插件集 + 模型配置」，不让远端 dsh 起不来 |
| 本地嵌入 | SSH 用 ssh2 的 `forwardOut` 建一条本地随机端口隧道；WSL2 走 localhost 转发；远端 GUI 以 iframe 嵌入本地页面 |
| 连接日志 | 连接中/失败页自动显示实时日志（步骤、环境探测、安装与同步消息，token 已脱敏），可一键复制 |
| 工作区终端 | `ssh://` 工作区的侧栏终端通过本地 SSH PTY（系统 `ssh`）连接远端，输入/输出正常；要回到原生远端 PTY 可配置 `terminalMode: 'remote'` |
| 工作区状态 | `ssh://` 工作区行尾显示状态点（连接中转圈、已连接绿点、失败红点、停用灰点）；悬停显示设备、连接方式、地址、目录和最近连接日志，页面加载/悬停/点击都会触发探测 |
| 内嵌远程工作区 | 自带 `dsh-ssh-workspace` 的 host 端（vendor，MIT）：`ssh://` 工作区的挂载、文件读写、命令、终端由本插件直接提供，**不再要求安装或启用 `dsh-ssh-workspace` 插件** |
| 本地打开 | 目标卡片可直接「VS Code / 终端 / 文件」打开（自动使用远端 home）；连接就绪后顶部也可以对当前工作区执行同样操作 |
| 主机编辑 | 添加/编辑/删除 SSH 主机，密码与口令用 `$DSH_HOME/dsh-ssh.key` 做 AES-256-GCM 加密，与 dsh-ssh-workspace 兼容 |
| 目录浏览 | 连接前逐级浏览远端目录（SFTP 或 WSL 9P） |
| Agent 工具 | `remote_anywhere_targets` / `remote_anywhere_connect` / `remote_anywhere_status` / `remote_anywhere_disconnect` |

## 要求

- 本地 dsh `>= 0.2.1-rc.2`（Web GUI）。
- 远端有 **Node.js 22/24** 与 **npm**；没有 Node 时插件不会尝试安装系统级运行时，而是给出明确提示。
- SSH 主机需要可从本机直连（**暂不支持 ProxyJump / ProxyCommand**）。
- WSL 需要 WSL2 的 localhost 转发（默认开启）。WSL1 也可用，只要端口能从 Windows 访问。
- 首次连接会下载 dsh 依赖并复制本地插件集，可能需要 1–3 分钟，取决于网络和 npm 缓存。
- 「VS Code」按钮需要本机安装 VS Code 及 **Remote-SSH / Remote-WSL** 扩展；「终端」需要 Windows Terminal（`wt.exe`）。
- 「文件」按钮只在 WSL 目标上出现；SSH 目标请用 VS Code，Windows 资源管理器不能直接浏览 SSH 文件。

## 安装

### 从源码安装（开发/本地）

```bash
git clone https://github.com/leafix-p/dsh-remote-anywhere.git
cd dsh-remote-anywhere
node scripts/install.mjs
```

脚本会：

1. 把本目录 link 到 `$DSH_HOME/profiles/<profile>/node_modules/dsh-remote-anywhere`；
2. 在 profile 的 `package.json` 中加入 `dsh-remote-anywhere` 依赖和 `dsh.profile.bundles` 条目；
3. 生成 `package.json.bak-<timestamp>` 备份。

然后**重启 dsh**（Web GUI 进程）。浏览器半在启动时扫描，热重载不会加载新插件。

卸载：

```bash
node scripts/install.mjs --uninstall
```

也可以手动把本包发布到 npm，然后：

```bash
dsh plugin --profile web add dsh-remote-anywhere
```

并把 `dsh-remote-anywhere` 加到 profile 的 `dsh.profile.bundles`（或者只把它的
`cordis.patch.yml` 合并到你的 profile patch——效果相同）。

## 使用

1. 打开左侧「远程资源管理器」。
2. 在 **SSH 主机** 或 **WSL 发行版** 中选一个目标，点「连接并打开」。
3. 在目录浏览器里选远端目录（默认是远端 home），按需勾选同步项，点「连接并打开」。
4. 进度页会显示：连接 → 检查环境 → 确认目录 → 准备 dsh → 同步配置 → 打开目录 → 启动 dsh → 建立本地访问。
5. 就绪后远端 dsh 的完整界面会嵌入主区域；也可以点「新标签页」单独打开。
6. 顶部「VS Code / 终端 / 文件」可直接打开本地窗口：VS Code 会以对应的 Remote-SSH / Remote-WSL 状态打开，远端终端和文件资源管理器随即可用。目标卡片上也有同名的直接入口，不需要先启动远端 dsh。
7. 右上角「断开」会停掉远端 dsh 并关闭本地隧道；连接中/失败页会自动显示可复制的实时日志，连接成功后可用顶部「日志」展开。

### 添加 SSH 主机

「添加 SSH 主机」写入 `$DSH_HOME/dsh-ssh.json`，和「远程工作区」面板共用同一份记录：

- 密码认证：密码加密保存；
- 私钥认证：填写私钥路径，口令可留空；
- SSH Agent：留空地址则使用 `SSH_AUTH_SOCK` / Pageant；
- `~/.ssh/config` 里的 Host 是只读回退，插件不会修改那个文件。

首次连接会记录主机密钥指纹（TOFU）；指纹变化会拒绝连接并提示。

## 同步了什么

连接时默认同步（可在「设置」或连接对话框中逐项关闭）：

| 本地来源 | 远端落点 | 说明 |
| --- | --- | --- |
| `$DSH_HOME/profiles/<profile>/package.json` | `~/.dsh/profiles/web/package.json` | 本地路径依赖与本插件本身会被剔除；`npm install` 失败会自动回退 |
| `$DSH_HOME/profiles/<profile>/cordis.patch.yml` | `~/.dsh/profiles/web/cordis.patch.yml` | 模型、provider、主题等配置 |
| `$DSH_HOME/.credentials.yaml` | `~/.dsh/.credentials.yaml` | API Key；权限 600 |
| `$DSH_HOME/AGENTS.md`、`~/.agents/AGENTS.md` | 同名路径 | 全局提示词 |
| `~/.agents/skills/**` | `~/.agents/skills/**` | 技能；跳过符号链接与 `node_modules` |
| `$DSH_HOME/skills/**` | `~/.dsh/skills/**` | 同上 |
| 所选远端目录 | 远端 workspace registry | 注册为默认 workspace，远端 GUI 直接打开 |

**插件回退**：远端 `npm install` 失败或 `dsh --profile web --dump-config` 失败时，插件会写入
一份基础插件清单（`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`）和筛选后的模型补丁，
保证远端 dsh 仍能启动；界面会显示「基础插件集」与原因。

## 安全模型

- 本地 HTTP 接口：仅 loopback、校验 `Host` 头、POST 要求 `application/json`；与 dsh-ssh-workspace 同一套围栏。
- 远端 dsh 只绑 `127.0.0.1`，通过 SSH 隧道或 WSL localhost 访问；启动 URL 带一次性 token。
- 日志中的 token 会被替换为 `***`。
- 主机密钥采用 TOFU；与已记录指纹不一致时拒绝连接。
- **模型凭据会被复制到远端** `~/.dsh/.credentials.yaml`——只对可信主机使用；可在连接时关闭「同步模型凭据」。
- 远端 dsh 以远端登录用户的完整权限运行，不受本地文件沙箱约束。

## 实现概要

```
本地 dsh（Web GUI）
  ├─ 浏览器半：sidebar.panellist + main 页面
  └─ Host 半
       ├─ targets: dsh-ssh.json / ~/.ssh/config / wsl.exe
       ├─ SSH transport: ssh2（exec / SFTP / forwardOut）
       ├─ WSL transport: wsl.exe（exec）+ \\wsl.localhost（文件）
       ├─ bootstrap: ~/.dsh/remote-bin 下 npm 安装 dsh，写 dsh-wrap.mjs
       ├─ sync: 配置 / 凭据 / 插件 / 技能 / 提示词
       └─ run: 远端 dsh 前台进程 + 本地隧道（生命周期绑定连接对象）
```

远端 dsh 的进程生命周期与传输通道绑定：SSH 用一条常开 exec 通道，WSL 用常驻的
`wsl.exe` 子进程。连接对象断开时通道关闭，远端进程随之结束；不写 nohup、不依赖远端 PID 文件。

### 目录结构

```
dsh-remote-anywhere/
  package.json          # dsh.bundle.patch + dsh.client 声明
  cordis.patch.yml      # bundle 行（config）
  lib/index.js          # Host 插件入口：routes / tools / guidance
  lib/remote.js         # 目标、连接状态机、连接流程
  lib/store.js          # dsh-ssh.json 共享存储 + ~/.ssh/config + WSL 发现
  lib/ssh.js            # ssh2 transport（exec / sftp / forward）
  lib/wsl.js            # wsl.exe + UNC transport
  lib/sync.js           # 安装 dsh、同步配置、注册 workspace、启动远端 dsh
  lib/launcher.js       # VS Code / 终端 / 资源管理器本地启动
  lib/routes.js         # 本地 HTTP API
  lib/tools.js          # Agent 工具
  lib/client.js         # 浏览器半（无构建步骤）
  scripts/install.mjs   # 本地安装/卸载
```

## 限制

- **ProxyJump / ProxyCommand 不支持**：连接前就会明确拒绝。
- **远端必须有 Node 22/24 + npm**：插件不下载 Node 运行时，也不调用 sudo/系统包管理器。
- **一个目标同时只允许一个远端 dsh 连接**：多个连接会争用同一个 `~/.dsh`，插件会复用现有连接或提示先断开。
- **远端 GUI 是完整的独立界面**：它自带侧栏与会话列表；本地窗口是它的宿主，不是把远端会话合并进本地会话列表。
  对话、文件、命令都在远端，本地只负责显示与端口转发。
- **首次安装 dsh/插件较慢**：之后 npm 缓存会快很多；网络受限可设置 npm registry（设置页）。
- **WSL 可用性在连接时才判定**：目标列表不再为每个发行版启动 shell，因此极少数不可用发行版会在连接时报错。
- **远端 dsh 不随本地热重载更新**：改了本地配置后需「断开 → 重新连接」让远端进程读到新配置。
- **不自动更新远端 dsh**：版本默认跟随本地；改版本可在设置里填具体版本，下次连接会重装。
- **本地接口只接受 loopback 访问**：如果 DSH Web GUI 通过反向代理/公网域名打开，远程资源管理器的 API 会拒绝（403）；请在本机 `127.0.0.1` / `localhost` 打开 GUI。
- **VS Code Remote-SSH 的非 22 端口**需要 `~/.ssh/config` 里有对应的 Host 别名（HostName / User / Port）；插件会明确提示。
- **Windows 资源管理器不能浏览 SSH 文件**：SSH 目标请用 VS Code 打开，它的左侧就是远端资源管理器。
- **工作区终端的 SSH 认证**：`ssh://` 工作区终端使用系统 `ssh`，需要 `~/.ssh` 里的密钥/agent 能登录该主机；密码认证的主机会在终端里提示输入密码。

## 排查

| 现象 | 处理 |
| --- | --- |
| 面板不出现 | 确认 profile `package.json` 的 `dsh.profile.bundles` 含 `dsh-remote-anywhere`，并重启 dsh |
| 连接提示 Node 版本过低 | 远端升级到 Node 22/24（推荐 24） |
| 远端 dsh 安装失败 | 看连接日志；可设置 npm registry；确认远端 npm 可访问 registry |
| 插件同步失败但能打开 | 已回退基础插件集；按日志中的 npm 错误修远端依赖，或关闭「同步本地插件集」 |
| SSH 连接失败 | 检查主机/端口/认证方式；ProxyJump 主机请改直连；主机密钥变化用「忘记主机密钥」后重试 |
| WSL 打开后 404/拒绝连接 | 确认 WSL2 `localhostForwarding=true`，或改用 `wsl-ubuntu` 这种 SSH 目标 |
| 远端界面白屏 | 点「新标签页」排除 iframe 限制；看连接日志中远端 dsh 是否报错 |

## 开发

无构建步骤：`lib/client.js` 是手写的 DSH client module（`window.__ModuleLoader__.load`），
`lib/*.js` 是普通 ESM。改完 Host 半需重启 dsh；改浏览器半也建议重启（模块扫描有缓存）。

工具注册沿用 DSH 的 `{ name, description, parameters, output, execute }` 形状；参数 spec 由
`lib/tools.js` 内部的小型 `defineTool` 转成 JSON Schema，不额外依赖 `@deepseek-ai/dsh-tools`。

## License

MIT


