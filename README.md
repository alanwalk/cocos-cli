# @alanwalk/cocos-cli

命令名为 `cocos`。面向 **Cocos Creator 3.8.8**，提供离线项目创建、资源检查、原生构建和编辑器生命周期管理。也可识别其他 Creator 3.x 项目，并按项目声明的版本核对安装。

- Creator 关闭时，用 `create`、`check`、`asset refs` 和 `prefab inspect / diff` 处理项目文件。四类命令都可脱离 Funplay 运行。
- 构建用 `cocos build`。命令启动 Creator 的原生构建进程，需要可用的 GUI 环境。
- 进入编辑器工作流时，运行 `cocos ensure --json`。确认 `ready: true` 后，通过当前项目的 Funplay MCP 操作场景、资源和预览。

## 安装

运行需要 **Node.js 20 或更高版本**。npm 包包含已编译的 JavaScript 和类型声明，运行时无需安装 TypeScript。

从源码构建和本地使用：

```bash
npm ci
npm run build
node ./bin/cocos.js --help
```

将已构建的源码链接到当前机器的 npm 命令目录：

```bash
npm link
cocos --version
```

生成供其他机器安装的 tarball：

```bash
npm ci
npm pack
npm install -g ./alanwalk-cocos-cli-1.0.0.tgz
cocos --version
```

`npm pack` 自动执行 `prepack`，运行测试、TypeScript 检查并生成 `dist/`。安装时使用当前 `npm pack` 输出的实际文件名。`bin/cocos.js` 是命令入口，`dist/index.js` 和 `dist/index.d.ts` 分别是 npm 包的 JavaScript 和类型入口。

## 快速开始

以下路径以 PowerShell 为例。`create` 要求显式给出目标目录。其他项目命令省略 `--project` 时，从当前目录向上查找带 `creator.version` 的 `package.json`；显式指定时只检查该目录。

```powershell
$project = 'D:\Games\MyGame'
cocos create --project $project --type 2d --json
cocos check --project $project
cocos open --project $project
```

安装并启用项目的 Funplay 扩展后，用 `ensure` 验证实际连接：

```powershell
cocos ensure --project $project --json
cocos status --project $project --json
```

## 离线项目与资源

| 命令 | 行为 |
| --- | --- |
| `create --project <目录> [--type 2d\|3d]` | 使用本机 Creator 3.8.8 的空白模板。默认 `2d`，目标目录必须不存在。生成独立项目 UUID、`creator.version` 和 `assets/`。 |
| `check` | 扫描 `assets/` 下的文件、目录和 `.meta`。报告缺失或孤立的 Meta、无效 JSON、重复 UUID、空序列化对象和无效的 `__id__` 引用。 |
| `asset refs <路径或 UUID>` | 按资源路径、`db://assets/…`、完整或压缩 UUID 查询序列化引用，支持带后缀的子资源 UUID。每条结果提供文件和 JSON Pointer。 |
| `prefab inspect <文件>` | 只读查看文本 Prefab 的根节点、子节点、组件和字段。 |
| `prefab diff <旧文件> <新文件>` | 只读比较两份文本 Prefab。按节点路径和组件类型匹配，同名节点使用同级序号区分。 |

```powershell
cocos asset refs 'db://assets/ui/icon.png' --project $project
cocos prefab inspect 'assets/ui/Hud.prefab' --project $project
cocos prefab diff 'old.prefab' 'new.prefab' --project $project
```

资源与 Prefab 的相对路径以项目根目录为基准。`check`、`asset refs` 和 `prefab inspect / diff` 正常执行时始终输出 JSON。`check` 把确定的错误放在 `issues`，把当前磁盘索引无法解析的引用放在 `unresolved`；后者可能包含内置或外部资源。静态扫描范围是支持的文本资源中的序列化引用，动态字符串加载和二进制资源需要另行验证。Prefab 查询查看当前文件，嵌套实例保留序列化记录。

## 原生构建

日常构建和 CI 可以使用 Creator 发布面板导出的 JSON：

```powershell
cocos build --project $project --build-config build-config.json --log-dest temp/build.log --timeout-ms 300000 --json
```

- `--build-config` 指向 **Creator 导出的构建配置**。默认沿用该文件的平台、调试模式和启动场景。可用平台位置参数、`--debug` / `--release`、`--start-scene` 或 `--option key=value` 显式覆盖对应参数。
- `--config` 指向 **本 CLI 的配置**。`build.options` 仍会传入原生构建，重复的键以 `--option` 为准。使用 `--build-config` 时统一由该参数指定原生配置文件。
- `--build-config` 和 `--log-dest` 的相对路径以项目根目录为基准。`--log-dest` 的父目录由 CLI 创建。`--timeout-ms` 限制本次 Creator 构建进程，省略时等待进程退出。
- `--json` 将 Creator 控制台输出转到 stderr，stdout 返回 `ok`、`projectRoot`、`platform`、`logDest`、原始 `exitCode`、`signal` 和 `timedOut`。构建平台或日志位置未从调用参数解析出来时，对应字段可能为 `null`。

也可以直接用内联参数：

```powershell
cocos build web-desktop --project $project --release
cocos build web-mobile --project $project --start-scene "你的场景UUID" --option md5Cache=false
```

内联模式的平台默认是 `web-desktop`，可以通过 `build.platform` 设置。项目恰好有一个带 UUID 的场景时，CLI 可将它用作启动场景。多个场景可通过 `--start-scene`、`build.startScene` 或 `build.startSceneFile` 指定，后两个配置字段互斥。

若配置了 `build.guardUrl`，返回 HTTP 2xx 会阻止构建，连接失败或超时后继续。`--skip-guard` 可跳过这个 HTTP 检查。构建期间应避免对同一项目并行写入。原生命令、日志与产物核验见 [原生构建说明](docs/BUILD_HANDOFF.md)。

## 打开编辑器和连接 Funplay

| 命令 | 行为 |
| --- | --- |
| `open` | Windows 按项目定位或启动 Creator，默认显示或恢复主窗口并请求焦点。普通 `open` 无需 MCP。 |
| `info` | 读取项目声明、Creator 安装路径和版本元数据。 |
| `ensure` | 复用目标项目，或启动 Creator 一次，然后验证 Funplay 是否就绪。 |
| `status` / `doctor` | 只读检查进程、版本和 MCP，`doctor` 额外输出诊断建议。 |
| `stop` / `restart` | 通过已验证的 Funplay 请求当前实例正常退出。`restart` 先预检替代安装，确认旧实例退出后才启动新实例。 |

```powershell
cocos open --project $project
cocos open --project $project --background --json
cocos open --project $project --wait-ready --json
cocos stop --project $project --json
cocos restart --project $project --save --json
```

- `--foreground` 和 `--background` 是 Windows 窗口选项，用于 `open` 和 `ensure`。两者互斥。实际焦点由操作系统决定，JSON 中 `window.visible` 和 `window.focused` 分别记录可见与焦点状态。
- `open --wait` 等待 Creator **退出**，沿用子进程退出码和控制台输出。`open --wait-ready` 等同 `ensure`，等待 **MCP 就绪**。`--wait` 与 `--wait-ready`、显隐参数和 `--json` 互斥。
- `ready: true` 表示已完成 Funplay 握手，并核验项目路径、项目 ID、实例上下文、实际 Creator 版本和编辑器服务状态。资源导入、脚本编译和构建分别验证。`mcp.readiness.sceneAvailable` 单独记录场景查询是否可用。
- 已发现目标进程时，`ensure` 等待该实例。进程查询无法排除重复实例时会报错。就绪超时后会保留仍运行的 Creator，便于查看启动日志。
- `stop` 和 `restart` 遇到未保存场景时会拒绝退出。`--save` 请求保存当前场景，确认保存后再请求退出。首次保存可能出现路径选择窗口，其他扩展或对话框也可能阻止退出。

### Codex 项目级配置

在可信项目的 `.codex/config.toml` 中添加 Funplay 的 Streamable HTTP 入口。可从 Funplay 面板或 `cocos ensure --json` 的 `mcp.endpoint` 获取完整 URL。在项目目录写入下面的配置，并替换为自己的完整 URL。

```toml
[mcp_servers.funplay]
url = "http://127.0.0.1:<实际端口>/mcp/project/<实际项目ID>/"
```

在 Codex 打开并信任该项目，启动新聊天以加载项目配置。客户端使用该端点完成自己的 MCP 握手。

## CLI 配置与诊断

项目根目录可放置 `cocos-cli.config.json`。以下为示例，所有字段可按需配置：

```json
{
    "editor": { "path": "D:/Cocos/Creator/3.8.8/CocosCreator.exe", "allowUnverifiedVersion": false },
    "mcp": { "requestTimeoutMs": 3000 },
    "lifecycle": { "timeoutMs": 120000, "stopTimeoutMs": 15000, "pollIntervalMs": 750 },
    "open": { "wait": false },
    "build": { "platform": "web-desktop", "debug": false, "options": { "md5Cache": false } }
}
```

- Creator 安装查找顺序是 `--editor`、`COCOS_CREATOR_PATH`、配置 `editor.path`、`PATH`、平台默认目录。`--editor` 可指向可执行文件、安装目录或 macOS `.app`。命令行相对安装路径以当前目录为准，配置中的相对安装路径以及相对 `--config` 以项目根目录为准。
- `create` 要求可核验的 3.8.8 安装。`ensure/restart` 默认要求安装版本可核验，`--allow-unverified-editor` 允许尝试启动并在 MCP 连接后核验实际版本。`open/build` 允许安装元数据未知。已知版本不匹配时，CLI 拒绝启动该安装。
- MCP 完整 URL 优先级是 `--mcp-url`、`COCOS_CLI_MCP_URL`、配置 `mcp.url`。自动发现会尝试上次端点，再按 Funplay 项目配置、基础端口和回退端口查找。CLI 连接本机 loopback HTTP，并验证目标项目及实例。
- `ensure/restart` 默认总预算 120 秒，`stop` 为 15 秒，`status/doctor` 为 10 秒，单次 MCP 请求默认 3 秒。Windows 窗口操作使用项目生命周期预算。`--timeout-ms` 和 `--request-timeout-ms` 的命令行范围为 1–3600000 毫秒。
- 项目状态和锁位于 `temp/cocos-cli/state.json` 和 `temp/cocos-cli/project.lock/`。`ensure/restart` 新启动进程的日志位于 `temp/cocos-cli/editor-startup.log`。`status/doctor` 只读检查，现有状态记录仅作为实时探测的线索。

| CLI 退出码 | 含义 |
| --- | --- |
| `0` | 命令成功。`asset refs` 零匹配、`prefab diff` 存在变化也属于成功。 |
| `1` | 参数、配置、连接、启动或执行失败。构建超时和子进程信号退出也走失败路径。 |
| `2` | `check` 发现确定的错误，或 `status/doctor` 检查完成但目标 MCP 未就绪。 |
| Creator 构建退出码 | `build` 默认把原始 `0` 或 `36` 转成 CLI `0`，其他非零构建退出码沿用。可用 `build.successExitCodes` 配置成功码。 |

## 源码和验证

主要逻辑在 `src/*.ts`。`npm run build` 生成 `dist/`，`npm test` 先编译再运行自动回归，`npm run check` 执行 TypeScript 检查和 JavaScript 工具脚本语法检查。

```typescript
import { ensureProject, loadConfig, loadProject } from "@alanwalk/cocos-cli";

const project = loadProject({ project: "D:/Games/MyGame" });
const { config } = loadConfig({ projectRoot: project.root });
const result = await ensureProject({ project, config });
console.log(result.ready, result.mcp.endpoint);
```

Windows 的 Creator 3.8.8 已实测 2D/3D 项目创建、后台窗口恢复、离线资源查询和原生 Web Desktop 构建。已验证的结果和复跑步骤见 [验证文档](docs/VALIDATION.md)。Creator 内置命令另见 [3.8.8 原生命令行参考](docs/CREATOR_3.8.8_CLI.md)，历史变更见 [CHANGELOG.md](CHANGELOG.md)。
