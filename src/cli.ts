import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { checkAssets, findAssetReferences } from "./assets.js";
import { createProject } from "./create.js";
import { diffPrefabs, inspectPrefab } from "./prefab.js";
import { parseArgs, type ParseArgsConfig } from "node:util";

import { assertBuildAllowed, createBuildArguments, resolveStartScene } from "./build.js";
import { loadConfig } from "./config.js";
import { resolveCreator } from "./creator.js";
import { CocosCliError } from "./errors.js";
import { assertEditorVersion, ensureProject, inspectProject, openProjectWindow, restartProject, stopProject } from "./lifecycle.js";
import { loadProject } from "./project.js";
import { packageManifest } from "./package-info.js";
import { launchDetached, waitForChild } from "./runner.js";

const CLI_OPTIONS = {
    project: {
        type: "string",
        short: "p",
    },
    editor: {
        type: "string",
        short: "e",
    },
    config: {
        type: "string",
        short: "c",
    },
    json: {
        type: "boolean",
    },
    wait: {
        type: "boolean",
    },
    "wait-ready": { type: "boolean" },
    foreground: { type: "boolean" },
    type: { type: "string" },
    "build-config": { type: "string" },
    "log-dest": { type: "string" },
    background: { type: "boolean" },
    "mcp-url": { type: "string" },
    "timeout-ms": { type: "string" },
    "request-timeout-ms": { type: "string" },
    "allow-unverified-editor": { type: "boolean" },
    save: { type: "boolean" },
    debug: {
        type: "boolean",
    },
    release: {
        type: "boolean",
    },
    "start-scene": {
        type: "string",
    },
    option: {
        type: "string",
        multiple: true,
    },
    "skip-guard": {
        type: "boolean",
    },
    "guard-url": {
        type: "string",
    },
    help: {
        type: "boolean",
        short: "h",
    },
    version: {
        type: "boolean",
        short: "v",
    },
} as const satisfies ParseArgsConfig["options"];

type CliValues = ReturnType<typeof parseCliArguments>["values"];
interface CliContext {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    output?: (message: string) => void;
    errorOutput?: (message: string) => void;
}

function formatHelp() {
    return `@alanwalk/cocos-cli ${packageManifest.version}

为 Funplay MCP 准备正确的 Cocos Creator 3.x 项目和连接。

用法:
  cocos create --project <目录> [--type 2d|3d]
  cocos check [--project <目录>] [--json]
  cocos asset refs <资源路径或 UUID> [--project <目录>] [--json]
  cocos prefab inspect <文件> [--project <目录>] [--json]
  cocos prefab diff <旧文件> <新文件> [--project <目录>] [--json]
  cocos info [选项]
  cocos ensure [选项]
  cocos status [选项]
  cocos doctor [选项]
  cocos stop [选项]
  cocos restart [选项]
  cocos open [选项]
  cocos build [平台] [选项]

命令:
  info     显示项目、要求的版本和实际编辑器元数据
  ensure   复用或启动目标项目，等待并验证 Funplay MCP（推荐 AI 使用）
  status   查询目标项目的进程和 MCP 状态，不启动编辑器
  doctor   检查版本、进程发现和 MCP，并输出诊断建议
  stop     通过已验证 MCP 请求正常退出，不强杀进程
  restart  正常退出目标项目后启动并等待 MCP 就绪
  open     打开编辑器，Windows 默认显示并请求焦点；--wait-ready 同时等待 MCP
  build    调用 Creator 原生命令行构建

选项:
  -p, --project <目录>       项目目录，默认从当前目录向上查找
  -e, --editor <路径>        Creator 可执行文件或安装目录
  -c, --config <文件>        CLI 配置文件
      --json                 结构化输出；open --wait 使用编辑器控制台输出
      --build-config <文件>  build 使用 Creator 构建面板导出的配置 JSON
      --log-dest <文件>      build 日志路径
      --wait                 仅 open：等待 Creator 退出，不是等待就绪
      --wait-ready           仅 open：等同 ensure，不能和 --wait 同用
      --foreground           Windows open/ensure：显示主窗口并请求焦点
      --background           Windows open/ensure：隐藏主窗口
      --mcp-url <URL>        Funplay 面板显示的完整项目 URL（只允许本机）
      --timeout-ms <毫秒>    操作总超时；ensure/restart 默认 120000，stop 15000
      --request-timeout-ms <毫秒> 单次 MCP 探测上限，默认 3000
      --save                 stop/restart 前保存当前已有路径的场景
      --allow-unverified-editor 无安装版本元数据时允许启动，连接后仍核对版本
      --debug                build 时启用 debug
      --release              build 时关闭 debug
      --start-scene <UUID>   覆盖启动场景
      --option <key=value>   追加 Creator 构建参数，可重复
      --guard-url <URL>      该地址可访问时阻止构建
      --skip-guard           跳过配置文件中的构建前检查
  -h, --help                 显示帮助
  -v, --version              显示版本

编辑器查找顺序:
  1. --editor
  2. COCOS_CREATOR_PATH
  3. 配置文件 editor.path
  4. PATH 中的 CocosCreator
  5. Windows / macOS 默认安装目录
`;
}

function parseCliArguments(argv: string[]) {
    let parsed: ReturnType<typeof parseArgs<{ options: typeof CLI_OPTIONS; strict: true; allowPositionals: true }>>;
    try {
        parsed = parseArgs({
            args: argv,
            options: CLI_OPTIONS,
            allowPositionals: true,
            strict: true,
        });
    } catch (error) {
        throw new CocosCliError(`参数错误: ${error.message}`, {
            cause: error,
            code: "INVALID_ARGUMENT",
        });
    }

    const [command, ...args] = parsed.positionals;
    if (!parsed.values.help && !parsed.values.version) {
        const [action] = args;
        let valid = args.length === 0;
        let invalidMessage = `${command} 不接受位置参数：${args.join(" ")}`;
        if (command === "build") valid = args.length <= 1;
        if (command === "asset") valid = action === "refs" && args.length === 2;
        if (command === "prefab") {
            valid = (action === "inspect" && args.length === 2) || (action === "diff" && args.length === 3);
        }
        if (["build", "asset", "prefab"].includes(command)) invalidMessage = `${command} 的位置参数有误，请查看 cocos --help`;
        if (!valid) throw new CocosCliError(invalidMessage, { code: "INVALID_ARGUMENT" });
    }
    if (parsed.values.type !== undefined && command !== "create") {
        throw new CocosCliError("--type 仅用于 create", { code: "INVALID_ARGUMENT" });
    }
    if ((parsed.values["build-config"] !== undefined || parsed.values["log-dest"] !== undefined) && command !== "build") {
        throw new CocosCliError("--build-config / --log-dest 仅用于 build", { code: "INVALID_ARGUMENT" });
    }
    if (parsed.values.debug && parsed.values.release) {
        throw new CocosCliError("--debug 与 --release 不能同时使用", {
            code: "INVALID_ARGUMENT",
        });
    }
    if (parsed.values.wait && parsed.values["wait-ready"]) {
        throw new CocosCliError("--wait 等待退出，--wait-ready 等待连接就绪，不能同时使用", { code: "INVALID_ARGUMENT" });
    }
    const controlsWindow = parsed.values.foreground || parsed.values.background;
    if (parsed.values.foreground && parsed.values.background) {
        throw new CocosCliError("--foreground 与 --background 不能同时使用", { code: "INVALID_ARGUMENT" });
    }
    if (controlsWindow && (!["open", "ensure"].includes(command) || parsed.values.wait)) {
        throw new CocosCliError("--foreground / --background 仅用于 open / ensure，不能和 --wait 同用", { code: "INVALID_ARGUMENT" });
    }
    for (const key of ["timeout-ms", "request-timeout-ms"] as const) {
        const value = parsed.values[key];
        if (value !== undefined && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0 || Number(value) > 3600000)) {
            throw new CocosCliError(`--${key} 必须是 1 到 3600000 的整数`, { code: "INVALID_ARGUMENT" });
        }
    }
    if ((parsed.values.wait || parsed.values["wait-ready"]) && command !== "open") {
        throw new CocosCliError("--wait / --wait-ready 仅用于 open；ensure 默认等待 MCP 就绪", { code: "INVALID_ARGUMENT" });
    }
    if (parsed.values.save && !["stop", "restart"].includes(command)) {
        throw new CocosCliError("--save 仅用于 stop / restart", { code: "INVALID_ARGUMENT" });
    }
    if (parsed.values.json && command === "open" && parsed.values.wait) {
        throw new CocosCliError("open --wait 不支持 --json", { code: "INVALID_ARGUMENT" });
    }

    return {
        command,
        args,
        values: parsed.values,
    };
}

function loadProjectContext(options: Required<CliContext>, values: CliValues) {
    const project = loadProject({
        cwd: options.cwd,
        project: values.project,
    });
    const configResult = loadConfig({
        projectRoot: project.root,
        configPath: values.config,
    });
    return { project, configResult };
}

function loadCommandContext(options: Required<CliContext>, values: CliValues, context = loadProjectContext(options, values)) {
    const { project, configResult } = context;
    const creator = resolveCreator({
        projectRoot: project.root,
        cwd: options.cwd,
        env: options.env,
        platform: options.platform,
        version: project.creatorVersion,
        editor: values.editor,
        configEditor: configResult.config.editor.path,
    });

    return {
        project,
        configResult,
        creator,
    };
}

function createInfoResult(context, values) {
    const startScene = resolveStartScene({
        projectRoot: context.project.root,
        buildConfig: context.configResult.config.build,
        explicitStartScene: values["start-scene"],
    });

    return {
        package: packageManifest.name,
        packageVersion: packageManifest.version,
        projectName: context.project.name,
        projectRoot: context.project.root,
        creatorVersion: context.project.creatorVersion,
        actualCreatorVersion: context.creator.actualVersion,
        editorVersionVerified: context.creator.versionVerified,
        editorVersionMatch: context.creator.versionMatch,
        editorVersionSource: context.creator.versionSource,
        editorPath: context.creator.path,
        editorSource: context.creator.source,
        configFile: context.configResult.path,
        startScene: startScene ?? null,
    };
}

function printInfo(result, output) {
    output(`项目: ${result.projectName}`);
    output(`目录: ${result.projectRoot}`);
    output(`Creator: ${result.creatorVersion}`);
    output(`安装版本: ${result.actualCreatorVersion ?? "无法核验"}${result.editorVersionMatch === false ? "（与项目不匹配）" : ""}`);
    output(`编辑器: ${result.editorPath}`);
    output(`来源: ${result.editorSource}`);
    output(`配置: ${result.configFile ?? "未使用配置文件"}`);
    output(`启动场景: ${result.startScene ?? "未配置"}`);
}

async function runInfo(options: Required<CliContext>, values: CliValues) {
    const context = loadCommandContext(options, values);
    const result = createInfoResult(context, values);
    if (values.json) {
        options.output(JSON.stringify(result, null, 2));
    } else {
        printInfo(result, options.output);
    }
    return 0;
}

async function runOpen(options: Required<CliContext>, values: CliValues) {
    if (values["wait-ready"]) return runLifecycle("ensure", options, values);
    const projectContext = loadProjectContext(options, values);
    const lifecycleOptions = makeLifecycleOptions(options, values, projectContext);
    const waitForExit = values.wait ?? lifecycleOptions.config.open.wait ?? false;
    if (options.platform === "win32" && !waitForExit && !lifecycleOptions.windowMode) {
        lifecycleOptions.windowMode = "foreground";
    }
    if (lifecycleOptions.windowMode) {
        const result = await openProjectWindow(lifecycleOptions);
        if (values.json) {
            options.output(JSON.stringify({ command: "open", ...result }, null, 2));
        } else {
            options.output(`项目: ${result.projectRoot}`);
            if (result.launched) options.output(`已启动 Creator (PID ${result.pid})`);
            printWindowResult(result.window, options.output);
        }
        return 0;
    }
    const context = loadCommandContext(options, values, projectContext);
    assertEditorVersion(context.creator, { allowUnverified: true });
    if (values.json && waitForExit) {
        throw new CocosCliError("配置启用了 open.wait，不能与 --json 同用", { code: "INVALID_ARGUMENT" });
    }
    const args = ["--project", context.project.root];

    if (!values.json) {
        options.output(`打开 ${context.project.name}，项目要求 Creator ${context.project.creatorVersion}`);
        options.output(`编辑器: ${context.creator.path}`);
    }

    if (!waitForExit) {
        const pid = await launchDetached(context.creator.path, args, {
            cwd: context.project.root,
            env: options.env,
        });
        if (values.json) options.output(JSON.stringify({ command: "open", ok: true, projectRoot: context.project.root, launched: true, pid }, null, 2));
        else options.output(`Creator 已启动 (PID ${pid})`);
        return 0;
    }

    const result = await waitForChild(context.creator.path, args, {
        cwd: context.project.root,
        env: options.env,
        windowsHide: false,
    });
    return result.code ?? 1;
}

async function runBuild(options: Required<CliContext>, values: CliValues, platform) {
    const context = loadCommandContext(options, values);
    assertEditorVersion(context.creator, { allowUnverified: true });
    const buildConfig = {
        ...context.configResult.config.build,
    };
    if (values["guard-url"]) {
        buildConfig.guardUrl = values["guard-url"];
    }
    await assertBuildAllowed({
        buildConfig,
        skipGuard: values["skip-guard"],
    });
    const build = createBuildArguments({
        projectRoot: context.project.root,
        buildConfig,
        platform,
        debug: values.debug,
        release: values.release,
        startScene: values["start-scene"],
        optionAssignments: values.option ?? [],
        nativeConfigPath: values["build-config"],
        logDest: values["log-dest"],
    });

    if (!values.json) {
        options.output(`构建 ${context.project.name} -> ${build.platform ?? "配置指定"}`);
        options.output(`编辑器: ${context.creator.path}`);
        options.output(`参数: ${build.buildString}`);
    }
    const timeoutMs = values["timeout-ms"] === undefined ? undefined : Number(values["timeout-ms"]);
    if (values["log-dest"] !== undefined && build.logDest) mkdirSync(dirname(build.logDest), { recursive: true });
    const result = await waitForChild(context.creator.path, build.args, {
        cwd: context.project.root,
        env: options.env,
        timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
        forwardOutput: { stdout: values.json ? process.stderr : process.stdout, stderr: process.stderr },
    });
    const ok = !result.timedOut && !result.signal && build.successExitCodes.includes(result.code);
    if (values.json) {
        options.output(JSON.stringify({
            command: "build", ok, projectRoot: context.project.root, platform: build.platform,
            logDest: build.logDest, exitCode: result.code, signal: result.signal, timedOut: result.timedOut,
        }, null, 2));
    } else if (result.timedOut) {
        options.errorOutput("Creator 构建超时");
    } else if (result.signal) {
        options.errorOutput(`Creator 被信号 ${result.signal} 终止`);
    }
    if (ok) return 0;
    return result.code || 1;
}

function makeLifecycleOptions(options: Required<CliContext>, values: CliValues, context = loadProjectContext(options, values)) {
    let windowMode: "foreground" | "background" | undefined;
    if (values.foreground) windowMode = "foreground";
    if (values.background) windowMode = "background";
    return {
        project: context.project,
        config: context.configResult.config,
        cwd: options.cwd,
        env: options.env,
        platform: options.platform,
        editor: values.editor,
        mcpUrl: values["mcp-url"],
        timeoutMs: values["timeout-ms"] === undefined ? undefined : Number(values["timeout-ms"]),
        requestTimeoutMs: values["request-timeout-ms"] === undefined ? undefined : Number(values["request-timeout-ms"]),
        allowUnverifiedEditor: values["allow-unverified-editor"],
        save: values.save,
        windowMode,
        log: options.errorOutput,
    };
}

function printWindowResult(window, output) {
    if (window.mode === "background") output("Creator 主窗口已隐藏。");
    if (window.mode === "foreground") {
        output(window.focused ? "Creator 主窗口已显示并获得焦点。" : "Creator 主窗口已显示，当前未获得焦点。");
    }
}

function printLifecycleResult(command, result, output) {
    output(`项目: ${result.projectRoot}`);
    if (result.stopped) {
        output(result.alreadyStopped ? "目标项目没有运行中的 Creator。" : "Creator 已正常退出。");
        return;
    }
    output(`状态: ${result.ready ? "MCP 已就绪" : "尚未就绪"}`);
    output(`Creator: 要求 ${result.editor.requiredVersion}，实际 ${result.editor.actualVersion ?? "未知"}`);
    if (result.mcp.endpoint) output(`MCP: ${result.mcp.endpoint}`);
    if (result.launched) output(`已启动 Creator${result.pid ? ` (PID ${result.pid})` : ""}`);
    if (result.reused) output("已复用目标项目的 MCP 实例。");
    if (result.window) printWindowResult(result.window, output);
    if (result.mcp.error) output(`MCP 诊断: ${result.mcp.error.code}: ${result.mcp.error.message}`);
    if (result.editor.error) output(`编辑器诊断: ${result.editor.error.message}`);
    if (result.process.discoveryError) output(`进程诊断: ${JSON.stringify(result.process.discoveryError)}`);
    if (command === "doctor" || !result.ready) for (const step of result.nextSteps ?? []) output(`建议: ${step}`);
}

async function runLifecycle(command, options: Required<CliContext>, values: CliValues) {
    const lifecycleOptions = makeLifecycleOptions(options, values);
    const operation = {
        ensure: ensureProject,
        status: inspectProject,
        doctor: inspectProject,
        stop: stopProject,
        restart: restartProject,
    }[command];
    const result = { command, ...(await operation(lifecycleOptions)) };
    if (values.json) options.output(JSON.stringify(result, null, 2));
    else printLifecycleResult(command, result, options.output);
    return result.ok ? 0 : 2;
}

export async function runCli(argv: string[], context: CliContext = {}) {
    const options = {
        cwd: context.cwd ?? process.cwd(),
        env: context.env ?? process.env,
        platform: context.platform ?? process.platform,
        output: context.output ?? console.log,
        errorOutput: context.errorOutput ?? console.error,
    };

    try {
        const parsed = parseCliArguments(argv);
        if (parsed.values.version) {
            options.output(`${packageManifest.name} ${packageManifest.version}`);
            return 0;
        }
        if (parsed.values.help || !parsed.command) {
            options.output(formatHelp());
            return 0;
        }

        if (parsed.command === "create") {
            const { project, editor, type } = parsed.values;
            if (!project) throw new CocosCliError("create 需要 --project", { code: "INVALID_ARGUMENT" });
            const result = await createProject({ ...options, project, editor, type });
            if (parsed.values.json) options.output(JSON.stringify(result, null, 2));
            else options.output(`已创建 Creator ${result.creatorVersion} 项目：${result.projectRoot}`);
            return 0;
        }
        if (["check", "asset", "prefab"].includes(parsed.command)) {
            const project = loadProject({ cwd: options.cwd, project: parsed.values.project });
            const [action, file, comparison] = parsed.args;
            if (parsed.command === "check") {
                const result = checkAssets(project.root);
                options.output(JSON.stringify(result, null, 2));
                return result.ok ? 0 : 2;
            }
            if (parsed.command === "asset") {
                options.output(JSON.stringify(findAssetReferences(project.root, file), null, 2));
                return 0;
            }
            const result = action === "inspect"
                ? inspectPrefab(project.root, file)
                : diffPrefabs(project.root, file, comparison);
            options.output(JSON.stringify(result, null, 2));
            return 0;
        }
        if (parsed.command === "info") {
            return await runInfo(options, parsed.values);
        }
        if (["ensure", "status", "doctor", "stop", "restart"].includes(parsed.command)) {
            return await runLifecycle(parsed.command, options, parsed.values);
        }
        if (parsed.command === "open") {
            return await runOpen(options, parsed.values);
        }
        if (parsed.command === "build") {
            return await runBuild(options, parsed.values, parsed.args[0]);
        }

        throw new CocosCliError(`未知命令: ${parsed.command}`, {
            code: "INVALID_COMMAND",
            details: ["可用命令: create, check, asset, prefab, info, ensure, status, doctor, stop, restart, open, build"],
        });
    } catch (error) {
        if (argv.includes("--json")) {
            options.output(JSON.stringify({
                ok: false,
                error: { code: error.code ?? "COCOS_CLI_ERROR", message: error.message ?? String(error), details: error.details ?? [] },
            }, null, 2));
            return 1;
        }
        if (error instanceof CocosCliError) {
            options.errorOutput(`cocos: ${error.message}`);
            for (const detail of error.details) {
                options.errorOutput(`  ${detail}`);
            }
            if (options.env.COCOS_CLI_DEBUG === "1" && error.cause) {
                options.errorOutput(error.cause instanceof Error ? error.cause.stack ?? error.cause.message : String(error.cause));
            }
            return 1;
        }

        options.errorOutput(`cocos: ${error instanceof Error ? error.message : String(error)}`);
        if (options.env.COCOS_CLI_DEBUG === "1" && error instanceof Error) {
            options.errorOutput(error.stack ?? error.message);
        }
        return 1;
    }
}
