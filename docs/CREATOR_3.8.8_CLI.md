# Cocos Creator 3.8.8 内置命令行参考

本文核对 Windows 安装版 `CocosCreator.exe` 的启动入口和 Cocos Creator 3.8 官方手册。安装版本为 3.8.8，安装路径为 `C:\ProgramData\cocos\editors\Creator\3.8.8\CocosCreator.exe`。

## `--help` 实测

直接运行 `CocosCreator.exe --help`，不传项目路径。普通 Windows 会话中，程序打印了以下启动参数，随后继续启动。等待 15 秒仍未退出，探测进程由超时机制结束。标准错误另外报告了四条 profile 加载失败信息。这里省略了本机用户名。

```text
init **** success
Arguments:
  C:\ProgramData\cocos\editors\Creator\3.8.8\CocosCreator.exe: true
  help: true
  dev: false
  home: C:\Users\<用户>\.CocosCreator
```

本机版本没有通过这次 `--help` 调用输出参数清单。以下是官方文档和安装包入口能核实的功能。启动日志会回显解析后的参数，确认某个参数有效还需要找到实际消费它的代码。

## 启动和自动化参数

| 参数 | 用途 | 依据 |
| --- | --- | --- |
| `--project <目录>` | 指定项目。只传项目路径时走常规编辑器启动并创建主窗口。缺省时走 Dashboard 启动。相对路径以当前工作目录为基准。 | 官方手册、启动和设置模块 |
| `--build "键=值;键=值"` | 加载构建所需的管理器和扩展，运行构建后退出。此分支先于常规主窗口创建逻辑。 | 官方手册、启动入口 |
| `--engine <目录>` | 为构建指定自定义引擎路径。 | 官方手册，本次未运行验证 |
| `--home <绝对目录>` | 指定 Creator 全局数据目录。安装包设置模块会检查目录是否存在，不存在时回退到默认目录。 | 安装包设置模块 |
| `--dev` | 启用编辑器开发模式，缺省时关闭。未指定有效的 `--home` 时使用带 `_Develop` 后缀的默认全局数据目录。构建的调试选项由 `debug=true` 控制。 | 安装包启动与设置模块 |
| `--metric` | 启动时向编辑器管理器传入指标开关。 | 安装包内部启动参数 |
| `--nologin` | 普通编辑器启动时向管理器传入跳过登录检查的标志。 | 安装包内部启动参数 |
| `--test [键值串]` | 启动编辑器后调用内置 tester 执行自动化任务并退出。可选的 `EDITOR_AUTO_TEST` 环境变量接收 JSON，并覆盖键值串里的同名配置。 | 安装包内部测试入口 |
| `--testScene=native\|web` | 运行原生或 Web 场景测试，测试期间临时切换全局场景引擎配置。此入口有独立退出规则，成功为 `1`，失败为 `-1`。开发模式下不会主动退出。 | 安装包内部测试入口 |

内部参数的行为来自该安装版本，自动化测试和构建均未在本次导出中执行。

## `--build` 构建参数

外层的 `--project`、`--engine`、`--build` 是 Creator 进程参数。下面这些键放入 `--build` 的同一个字符串中。包含分号的字符串要整体加引号。对于嵌套结构、复杂路径和平台配置，可从构建面板导出 JSON，再用 `configPath` 指定文件。

| 功能 | 参数 |
| --- | --- |
| 目标和阶段 | `platform` 选择目标平台，常见值如 `web-desktop`、`web-mobile`、`wechatgame`。`stage` 决定执行阶段，默认 `build`，文档另列出 `make` 和 `bundle`。平台与阶段的组合由构建扩展决定。 |
| 导入配置 | `configPath` 载入构建 JSON。同名值由命令行中明确提供的参数覆盖。 |
| 产物和日志 | `buildPath` 指定输出根目录，`outputName` 指定产物文件夹名，`name` 指定游戏名，`logDest` 指定日志路径。 |
| 场景 | `startScene` 指定启动场景 UUID，`scenes` 配置参建场景。 |
| 调试和缓存 | `debug` 启用调试构建，`md5Cache` 启用文件名缓存相关处理。 |
| 引擎与插屏 | 官方页列出 `includedModules` 和 `replaceSplashScreen`。3.8.8 的构建器类型另有 `includeModules`、`engineModulesConfigKey` 和 `useSplashScreen`。涉及这些设置时以 3.8.8 构建面板导出的键和值为准。 |
| 主包和平台设置 | `mainBundleCompressionType` 设置主包压缩，`mainBundleIsRemote` 配置远程主包，`packages` 保存各平台或构建扩展的配置。 |
| 独立 Bundle | `stage=bundle;configPath=<Bundle 配置 JSON>`。配置从 Bundle 构建面板导出。 |
| 仅构建脚本 | `buildScriptsOnly=true`。按需与目标平台、阶段等配置一起传入。 |

构建器类型还包含 Source Map、纹理压缩、远程 Bundle 脚本、构建缓存、原生代码包模式等字段。类型声明只能说明构建器接收这些配置，不能单独证明每个字段都支持以内联字符串覆盖。各平台的 `packages` 结构取决于安装的扩展。 [官方命令行发布文档](https://docs.cocos.com/creator/3.8/manual/zh/editor/publish/publish-in-command-line.html)

### PowerShell 示例

```powershell
$creator = 'C:\ProgramData\cocos\editors\Creator\3.8.8\CocosCreator.exe'
$project = 'D:\Games\MyGame'

# 打开项目的编辑器主窗口
& $creator --project $project

# 构建 Web Desktop 调试包
& $creator --project $project --build 'platform=web-desktop;debug=true'

# 用项目目录中从构建面板导出的 JSON 构建
& $creator --project $project --build "configPath=$project\build-config.json"

# 用从 Bundle 构建面板导出的 JSON 单独构建 Bundle
& $creator --project $project --build "stage=bundle;configPath=$project\bundle-build-config.json"
```

构建退出码由官方文档定义。CI 需显式识别 `36` 为成功，`32` 为参数无效，`34` 为构建过程失败。命令行构建跳过常规编辑器主窗口，官方仍要求运行环境能够访问 GUI。 [官方退出码和 Jenkins 说明](https://docs.cocos.com/creator/3.8/manual/zh/editor/publish/publish-in-command-line.html#进程退出码)

## 与工作区 `cocos-cli` 的关系

- 工作区的 `open` 调用 Creator 可执行文件并传入 `--project`。兼容构建入口再传入 Creator 的 `--build`。
- `ensure`、`status`、`doctor`、`stop` 和 `restart` 是工作区 CLI 的项目生命周期能力。
- `--foreground` 和 `--background` 由工作区 CLI 通过 Windows API 控制 Creator 主窗口。`open` 的窗口切换无需 Funplay。3.8.8 安装包启动入口里没有这两个参数对应的窗口切换逻辑。

本机核对的安装包文件包括 `app.asar!/launch/source/launch.ts`、`app.asar!/node_modules/@editor/setting/lib/browser/index.js` 和构建器的 `builtin/builder/@types/public/options.d.ts`。其中构建器类型声明位于安装包的 unpacked 目录。
