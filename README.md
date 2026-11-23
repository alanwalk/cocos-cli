# cocos-cli

Cocos Creator 项目的命令行工具，提供**离线资源检查、原生构建和 Funplay MCP 接入**。主要验收版本为 Creator 3.8.8。

### npm 安装

```bash
npm install -g @alanwalk/cocos-cli
cocos --version
```

也可以用 npx 直接运行：

```bash
npx @alanwalk/cocos-cli --version
```

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `cocos create --project <新目录> --type 2d` | 用本机 Creator 3.8.8 模板创建项目，支持 `2d` 和 `3d`。 |
| `cocos info` | 查看项目和编辑器版本。 |
| `cocos open [--foreground]` | 打开 Creator 项目。Windows 和 macOS 默认显示主窗口且不请求焦点，等同于 `--background`。显式传 `--foreground` 可请求焦点。 |
| `cocos check` | 检查 Meta、重复 UUID 和无效序列化引用。 |
| `cocos asset refs <路径或UUID>` | 查找磁盘文本资源中的序列化引用。 |
| `cocos prefab inspect <文件>` / `cocos prefab diff <旧文件> <新文件>` | 只读查看 Prefab 结构或比较字段。 |
| `cocos build --build-config <导出的JSON> --json` | 使用 Creator 原生命令构建。运行机器需要 Creator 支持的 GUI 环境。 |
| `cocos mcp status` / `doctor` / `stop` / `restart` | 查看状态、诊断连接、正常退出或重启。 |

省略 `--project` 时，CLI 从当前目录向上查找 Creator 项目。显式指定安装位置用 `--editor`。运行 `cocos --help` 或 `cocos <子命令> --help` 查看完整参数。

## MCP

场景编辑、资源管理和预览等 MCP 能力由 [Funplay Cocos MCP](https://github.com/FunplayAI/funplay-cocos-mcp) 提供。`cocos mcp` 负责扩展安装、编辑器生命周期和客户端注册。

| 命令 | 用途 |
| --- | --- |
| `cocos mcp setup [--global]` | 安装 Funplay 扩展。 |
| `cocos mcp update [--global]` | 更新已安装的 Funplay 扩展。 |
| `cocos mcp ensure` | 启动或复用 Creator，等待 MCP 就绪。 |
| `cocos mcp register --client <客户端> [--skills]` | 注册客户端 MCP，可同时安装 Funplay Skills。 |
| `cocos mcp status` | 查看目标项目的编辑器和 MCP 状态。 |
| `cocos mcp doctor` | 诊断 Creator 版本、进程和 MCP 连接。 |
| `cocos mcp preview [--browser edge\|chrome]` | 在独立浏览器窗口打开当前场景，采集该标签页的运行日志。 |
| `cocos mcp stop [--save]` | 正常退出 Creator，可先保存场景。 |
| `cocos mcp restart [--save]` | 正常重启 Creator，可先保存场景。 |

### 浏览器预览日志

先打开目标 Creator 项目并确认 Funplay MCP 在线，在预览工具栏选择浏览器模式，再运行：

```powershell
cocos mcp preview --project C:\Workspace\evo-cocos --browser edge
```

命令需要本机安装 Edge 或 Chrome，以及支持内置 WebSocket 的 Node.js（推荐 22 或更高版本）。省略 `--browser` 会自动查找浏览器，Windows 优先 Edge，macOS 和 Linux 优先 Chrome。

CLI 使用临时浏览器配置，只打开一个游戏标签页。Console、未捕获的脚本异常和浏览器报告的网络错误实时写入项目的 `temp/cocos-cli/preview-*.jsonl`，单次上限 8 MiB。关闭测试标签页或按 Ctrl+C 即可结束，日志会保留。`--json` 在结束时输出日志路径、记录数和停止原因，采集提示走 stderr。

## 参考

- [变更记录](CHANGELOG.md)
- [验收步骤](docs/VALIDATION.md)
- [原生构建](docs/BUILD_HANDOFF.md)
- [Creator 3.8.8 命令行参考](docs/CREATOR_3.8.8_CLI.md)
