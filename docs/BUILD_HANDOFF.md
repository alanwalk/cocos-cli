# Creator 原生构建与产物验收

`cocos build` 使用当前项目要求的 Creator 版本，执行 `CocosCreator --project … --build …`。可以在项目编辑器关闭时运行，构建命令会启动自己的 Creator 进程。运行环境需要 Creator 支持的 GUI 会话。Funplay 用于在线编辑和预览，原生构建独立运行。 [Creator 3.8 命令行发布文档](https://docs.cocos.com/creator/3.8/manual/zh/editor/publish/publish-in-command-line.html)

## 构建输入

优先用 Creator 发布面板导出的 JSON 描述平台、场景、输出目录和平台扩展选项。将配置保存到项目根目录后，执行：

```powershell
$project = 'D:\Games\MyGame'
cocos build --project $project --build-config build-config.json --log-dest temp/build.log --timeout-ms 300000 --json
```

| 输入 | 行为 |
| --- | --- |
| `--build-config <文件>` | 向 Creator 传递原生 `configPath`。相对路径以项目根目录为基准。平台、调试模式和启动场景沿用导出的配置，除非通过相应的命令行选项显式覆盖。 |
| `--config <文件>` | 指定 CLI 的 `cocos-cli.config.json` 替代文件，可配置安装路径、`build.options`、守卫 URL 和 `build.successExitCodes`。 |
| `--option key=value` | 追加原生参数，可重复。重复键以命令行为准。`platform`、`debug` 和 `startScene` 使用各自的命令行选项。 |
| `--log-dest <文件>` | 指定 Creator 写入的构建日志，以项目根为相对基准。CLI 创建父目录。 |
| `--timeout-ms <毫秒>` | 限制 Creator 构建子进程的等待时间，达到上限后终止该进程。省略此项时等待进程退出。 |

使用 `--build-config` 时集中在此选项提供配置文件路径。若 `build.options` 或 `--option` 提供了不同的 `configPath`，CLI 会拒绝。传给 Creator 的绝对配置路径和显式日志路径需避开分号与等号，这两个字符在原生构建参数中用作分隔符。

无导出配置时，可以直接传平台和参数：

```powershell
cocos build web-desktop --project $project --release --option md5Cache=false
```

内联模式使用 CLI 的 `build` 配置和默认值。平台默认 `web-desktop`，调试默认关闭。可用 `--start-scene`、`build.startScene` 或 `build.startSceneFile` 指定启动场景。没有显式选择且项目恰好存在一个场景时，CLI 会尝试从其 `.meta` 读取 UUID。

## 读取构建结果

使用 `--json` 时，Creator 的控制台输出统一转发到 stderr。stdout 是构建结果或 CLI 错误 JSON。成功输出示例：

```json
{
    "command": "build",
    "ok": true,
    "projectRoot": "D:\\Games\\MyGame",
    "platform": "web-desktop",
    "logDest": "D:\\Games\\MyGame\\temp\\build.log",
    "exitCode": 36,
    "signal": null,
    "timedOut": false
}
```

- `exitCode` 是 Creator 原始退出码。默认成功码是 `0` 和 `36`，两者映射为 CLI 退出码 `0`。其他非零构建退出码沿用。Creator 官方定义 `32` 为参数无效、`34` 为构建过程失败。 [Creator 退出码](https://docs.cocos.com/creator/3.8/manual/zh/editor/publish/publish-in-command-line.html#进程退出码)
- 配置错误或进程启动失败时，JSON 包含 `error.code` 和诊断详情。构建进程超时或因信号退出时，结果会给出相应字段及失败状态。
- 验收时同时确认期望文件由本次构建生成。对 Web Desktop 可检查输出目录中的 `index.html` 和资源目录。对其他平台使用该平台的产物清单和设备验收。
- 同项目正被其他编辑器或构建任务写入时，应先协调运行时序。`build.guardUrl` 是可选 HTTP 探测，配置的 URL 返回 HTTP 2xx 时拒绝构建。

Windows 上已用 Creator 3.8.8 完成 Web Desktop 构建，原始退出码为 `36`，CLI 返回 `0`，并核对了 `index.html`。失败、超时和其他平台的复跑步骤见 [验证指南](VALIDATION.md#4-原生构建json-和产物)。
