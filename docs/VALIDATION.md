# cocos 验证指南

目标版本为 **Cocos Creator 3.8.8**。此文记录当前实现的验收结果，并提供离线、构建、发布和 Funplay 工作流的复跑步骤。

## 已验证的范围

2026-11-23，在 Windows 和 Node.js v26.3.0 环境验证了以下项目。

| 验证项 | 结果 |
| --- | --- |
| `npm test` | 99 通过、0 失败、3 项按平台跳过。集成测试使用模拟 Funplay 服务和临时项目。 |
| `npm run check` | TypeScript 与 JavaScript 工具脚本检查通过。 |
| npm 包清单与 API | 确认 `bin/cocos.js`、`dist/index.js`、`dist/index.d.ts` 及离线模块在清单中，包入口可导入。 |
| 原生模板创建 | 使用 Windows 3.8.8 安装中的模板创建了 2D、3D 临时项目。 |
| 窗口切换 | 临时项目后台启动后，普通 `open` 复用同一 PID，主窗口可见且获得焦点。 |
| 静态资源检查 | 对 本地 Creator 示例项目 检查了 3,261 个资源标识，报告 0 个确定错误、0 个未解析引用。一项资源实测查到 198 处序列化引用。 |
| Prefab | 实际项目 Prefab 的节点树可读，同文件比较结果为无变化。自动测试验证字段级差异及只读行为。 |
| 原生构建 | 临时 2D 项目的 Web Desktop 构建返回 Creator `36`、CLI `0`，生成了 `index.html`。 |
| 项目级 Funplay | 已核对 本地 Creator 示例项目 的在线项目端点。Codex 在该工作区可读取项目级注册，在工作区外不加载该条目。 |

实机范围覆盖 Windows 和 Web Desktop。macOS、其他构建平台以及真实编辑器中的未保存保护、正常退出和重启作为独立验收项。自动回归覆盖了相关的协议、锁、超时和生命周期控制路径。

## 1. 从源码、tarball 和安装后的命令验证

在 CLI 源码根目录运行：

```bash
npm ci
npm test
npm run check
npm pack
npm install -g ./alanwalk-cocos-cli-1.0.0.tgz
cocos --version
cocos --help
```

使用 `npm pack` 实际输出的文件名。源码模式下也可运行 `npm run build` 后用 `node ./bin/cocos.js --help`，或编译后使用 `npm link`。`npm pack` 的 `prepack` 会运行测试与检查，`npm test` 会先编译。

验收要点：

- `cocos --help` 列出 `create`、`check`、`asset refs`、`prefab inspect`、`prefab diff`、`open` 和 `build`。
- 打包内容包含 `bin/cocos.js`、`dist/*.js` 和 `dist/*.d.ts`。包的 JavaScript 和类型入口分别为 `dist/index.js` 和 `dist/index.d.ts`。
- 在独立安装环境验证 tarball 装出的 `cocos`。使用 `npm pack --dry-run --ignore-scripts --json` 查看已编译目录的清单时，先运行一次 `npm run build`。

### npm 自动发布

`.github/workflows/npm-publish.yml` 在 GitHub Release 发布时触发。Release tag 必须与 `package.json` 一致，例如版本 `1.0.0` 对应 `v1.0.0`。Windows、macOS 和 Linux 的打包验收通过后，Ubuntu job 使用 npm Trusted Publishing 发布。正式版用 `latest`，预发布版用 `next`。

在 npm 包设置的 **Trusted Publishing** 中添加 GitHub Actions，组织或用户填写 `alanwalk`，仓库填写 `cocos-cli`，工作流文件名填写 `npm-publish.yml`，并允许 `npm publish`。如果包还未在 registry 建档，先由有权限的账号完成首次发布，再为后续版本配置此流程。 [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)

## 2. 离线创建、检查和查询

用尚不存在的 A、B 两个目录。保持目标 Creator 项目关闭，避免编辑器自动生成修复文件。

```powershell
$projectA = 'D:\Acceptance\Cocos2D'
$projectB = 'D:\Acceptance\Cocos3D'
cocos create --project $projectA --type 2d --json
cocos create --project $projectB --type 3d --json
cocos info --project $projectA --json
cocos check --project $projectA --json
```

预期 A、B 使用对应模板，`package.json` 声明 Creator `3.8.8`，项目 UUID 不相同。重复创建 A 应失败并返回 `PROJECT_EXISTS`，原目录内容应保持原样。

用已保存的测试项目或验收副本准备一个有 `.meta` 的资源、至少一个引用它的文本 Prefab、以及一份只改了单个组件字段的 Prefab 副本：

```powershell
cocos asset refs 'db://assets/ui/icon.png' --project $projectA
cocos prefab inspect 'assets/ui/Hud.prefab' --project $projectA
cocos prefab diff 'assets/ui/Hud.prefab' 'fixtures/HudChanged.prefab' --project $projectA
```

- 用全长 UUID、压缩 UUID 或带后缀的子资源 UUID 复查同一资源，核对文件和 JSON Pointer。零匹配时仍应成功。
- 用同文件比较验证 `changed: false`。用修改后的副本比较，核对预期字段与新、旧值。
- 在可丢弃副本中制造缺失或孤立 Meta、重复 UUID、错误 JSON、以及 Prefab 序列化数组中的无效 `__id__`。`check --json` 应返回退出码 `2`，`issues` 包含对应路径。仅 `unresolved` 非空时，仍按确定错误数判断退出码。
- 对只读命令前后的测试资源和 `.meta` 计算哈希，核对内容。动态字符串加载、二进制资产和展开后的外部嵌套 Prefab 需要单独验收。

## 3. 普通 open、窗口显隐和 Funplay

Windows 上用任一临时项目运行：

```powershell
cocos open --project $projectA --background --json
cocos open --project $projectA --json
cocos open --project $projectA --background --json
```

核对后台启动后 `window.visible: false`，普通 `open` 返回 `reused: true` 且 `window.visible: true`，三次输出的 PID 相同。记录 `window.focused`，焦点获取由系统决定。在 Funplay 离线时复跑这组命令，窗口操作也应可用。需要等待编辑器退出时单测 `open --wait`。

启用该项目的 Funplay 服务后，执行：

```powershell
cocos mcp ensure --project $projectA --json
cocos mcp status --project $projectA --json
cocos mcp doctor --project $projectA --json
```

- 冷启动和重复 `ensure` 分别检查 `launched` 与 `reused`。双终端同时启动同一项目时，检查只出现一个 Creator 实例。`status` / `doctor` 在 MCP 未就绪时应返回 `2`。
- 核对 `mcp.endpoint` 和返回的目标项目、实际 Creator 版本、项目 ID。给 A 显式指定 B 的 `--mcp-url` 时应拒绝。给冷启动指定已知不同版本的安装时也应拒绝。
- 关闭临时项目的 Funplay 服务及其自动启动配置后验证 `ensure --timeout-ms 15000 --request-timeout-ms 1000 --json`。确认到期返回，并保持仍在运行的 Creator。恢复服务后，`ensure` 应能复用实例。
- 在目标项目的 `.codex/config.toml` 配置项目 URL。分别在项目目录和项目外运行 `codex mcp list`，核对项目级注册作用域。用该工作区的新聊天检查 Funplay 工具可用性及项目路径。

### 安装、更新与注册

在临时 Creator 项目验证 `cocos mcp setup`、`setup --global`、`update`。全局路径应匹配该项目声明的 Creator 版本。核对 SHA256 失败时原扩展保持完好，成功更新时可从返回的 `backupPath` 找到旧扩展。测试全局安装时使用隔离的用户目录。

连接就绪后运行 `cocos mcp register --client codex --skills --json`。核对项目级 `.codex/config.toml` 的 URL，以及 `.agents/skills` 下的两套 Skill 和引用文件。对其他客户端重复相同检查，核对对应文件而非 Codex 路径。再次执行应保留既有 Skill 和其他 MCP 服务。

用错误项目端点验证注册被拒绝。用已有本地改动的 Skill 验证重跑保持原文。完成注册并重新加载客户端后，通过 Agent 的 Funplay 工具只读核验项目身份。

就绪表示已验证编辑器服务。场景载入、导入、脚本编译和构建的结果各自记录。

## 4. 原生构建、JSON 和产物

空白模板工程需要先准备并保存一个场景。用 Creator 3.8.8 的构建面板导出 Web Desktop 配置，在临时项目根目录保存为 `build-config.json`，选择可区分本次构建的输出目录，然后关闭该项目的编辑器：

```powershell
cocos build --project $projectA --build-config build-config.json --log-dest temp/build.log --timeout-ms 300000 --json
$buildExit = $LASTEXITCODE
```

记录原始结果和 CLI 退出码。成功验收至少核对以下内容：

- stdout 是单个 JSON，Creator 控制台日志走 stderr。结果 `ok: true`、`timedOut: false`，平台是 `web-desktop`。
- 默认成功组合是 Creator 原始 `exitCode: 36`、CLI 退出码 `0`。`logDest` 指向本次日志。
- 确认预期目录产生了本次的 `index.html` 和资源文件。可通过空输出目录或构建前后文件时间／哈希区分已有产物。
- 复跑时可以加 `--debug` 或 `--release` 验证显式覆盖。补测缺失或无效的配置、原生构建失败及超时，记录错误、实际退出码和有无产物。超时结果应为 `timedOut: true`、`ok: false`。

构建参数和失败定位见 [原生构建说明](BUILD_HANDOFF.md)。

## 5. 安全退出与重启

在无需保留的临时项目中测试。MCP 就绪后，先创建一处未保存的场景修改：

- 分别运行 `cocos mcp stop --project $projectA --json` 和 `cocos mcp restart --project $projectA --json`。预期拒绝退出，记录编辑器仍在运行、未启动重复进程。
- 场景已有路径时加 `--save`，核对保存结果。首次保存时观察路径选择交互。MCP 离线时，核对 `MCP_REQUIRED_FOR_SAFE_STOP`。
- 场景保存后，`stop` 应完成正常退出，第二次执行应返回 `alreadyStopped: true`。用 `restart` 记录旧、新实例及 PID，确认先退出再启动，新 MCP 仍属于同一项目。
- 关闭被扩展或弹窗阻止时，观察 CLI 的报错和超时。用 `status` 与窗口状态确认实际结果。

## 验收记录

每项记录 CLI 版本、Creator 实际版本、操作系统、命令、退出码、原始 JSON 和相关日志。Funplay MCP 用例另记录 Funplay 版本和项目端点。编辑器启动和锁诊断位于项目的 `temp/cocos-cli/`，构建日志使用 `--log-dest` 指定的位置。记录平台时以实际运行和产物核验为准。
