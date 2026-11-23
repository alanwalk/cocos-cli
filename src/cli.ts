import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { checkAssets, findAssetReferences } from "./assets.js";
import { createProject } from "./create.js";
import { diffPrefabs, inspectPrefab } from "./prefab.js";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";

import { assertBuildAllowed, createBuildArguments, resolveStartScene } from "./build.js";
import { loadConfig } from "./config.js";
import { resolveCreator } from "./creator.js";
import { CocosCliError } from "./errors.js";
import { manageFunplayExtension } from "./funplay-extension.js";
import { assertEditorVersion, connectProjectMcp, ensureProject, inspectProject, openProjectWindow, restartProject, stopProject } from "./lifecycle.js";
import { FUNPLAY_CLIENTS, registerFunplay, type FunplayClient } from "./funplay-register.js";
import { loadProject } from "./project.js";
import { packageManifest } from "./package-info.js";
import { launchDetached, waitForChild } from "./runner.js";

interface CliValues {
    project?: string;
    editor?: string;
    config?: string;
    json?: boolean;
    global?: boolean;
    wait?: boolean;
    foreground?: boolean;
    background?: boolean;
    type?: string;
    buildConfig?: string;
    logDest?: string;
    mcpUrl?: string;
    client?: FunplayClient;
    scope?: "project" | "user";
    timeoutMs?: number;
    requestTimeoutMs?: number;
    allowUnverifiedEditor?: boolean;
    save?: boolean;
    debug?: boolean;
    release?: boolean;
    startScene?: string;
    option?: string[];
    skipGuard?: boolean;
    guardUrl?: string;
}

interface CliContext {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    output?: (message: string) => void;
    errorOutput?: (message: string) => void;
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
        explicitStartScene: values.startScene,
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
    if (values.wait && values.json) throw new CocosCliError("open --wait 不支持 --json", { code: "INVALID_ARGUMENT" });
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
    if (values.guardUrl) {
        buildConfig.guardUrl = values.guardUrl;
    }
    await assertBuildAllowed({
        buildConfig,
        skipGuard: values.skipGuard,
    });
    const build = createBuildArguments({
        projectRoot: context.project.root,
        buildConfig,
        platform,
        debug: values.debug,
        release: values.release,
        startScene: values.startScene,
        optionAssignments: values.option ?? [],
        nativeConfigPath: values.buildConfig,
        logDest: values.logDest,
    });

    if (!values.json) {
        options.output(`构建 ${context.project.name} -> ${build.platform ?? "配置指定"}`);
        options.output(`编辑器: ${context.creator.path}`);
        options.output(`参数: ${build.buildString}`);
    }
    if (values.logDest !== undefined && build.logDest) mkdirSync(dirname(build.logDest), { recursive: true });
    const result = await waitForChild(context.creator.path, build.args, {
        cwd: context.project.root,
        env: options.env,
        timeoutMs: values.timeoutMs,
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
        mcpUrl: values.mcpUrl,
        timeoutMs: values.timeoutMs,
        requestTimeoutMs: values.requestTimeoutMs,
        allowUnverifiedEditor: values.allowUnverifiedEditor,
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

const MCP_LIFECYCLE = {
    ensure: ensureProject,
    status: inspectProject,
    doctor: inspectProject,
    stop: stopProject,
    restart: restartProject,
};

type LifecycleCommand = keyof typeof MCP_LIFECYCLE;

function parseTimeout(value: string) {
    const milliseconds = Number(value);
    if (!/^\d+$/.test(value) || milliseconds < 1 || milliseconds > 3600000) {
        throw new InvalidArgumentError("必须是 1 到 3600000 的整数");
    }
    return milliseconds;
}

async function runLifecycle(command: LifecycleCommand, options: Required<CliContext>, values: CliValues) {
    const lifecycleOptions = makeLifecycleOptions(options, values);
    const result = { command, ...(await MCP_LIFECYCLE[command](lifecycleOptions)) };
    if (values.json) options.output(JSON.stringify(result, null, 2));
    else printLifecycleResult(command, result, options.output);
    return result.ok ? 0 : 2;
}

function registerCommands(options: Required<CliContext>, setExitCode: (code: number) => void) {
    const program = new Command("cocos")
        .description("在终端管理 Cocos Creator 项目、资源、构建和 Funplay MCP")
        .version(`${packageManifest.name} ${packageManifest.version}`, "-v, --version", "显示版本")
        .helpOption("-h, --help", "显示帮助")
        .configureHelp({ showGlobalOptions: true })
        .configureOutput({
            writeOut: (text) => options.output(text.replace(/\r?\n$/, "")),
            writeErr: () => {},
        })
        .exitOverride()
        .option("-p, --project <目录>", "目标项目目录")
        .option("-e, --editor <路径>", "Creator 可执行文件或安装目录")
        .option("-c, --config <文件>", "CLI 配置文件")
        .option("--json", "以 JSON 输出结果和错误")
        .option("--mcp-url <URL>", "Funplay 的本机项目 URL")
        .option("--timeout-ms <毫秒>", "操作总超时", parseTimeout)
        .option("--request-timeout-ms <毫秒>", "单次 MCP 请求超时", parseTimeout);

    type Handler = (values: CliValues, args: string[]) => number | Promise<number>;
    function action(command: Command, handler: Handler) {
        command.action(async () => {
            const values = command.optsWithGlobals<CliValues>();
            setExitCode(await handler(values, command.processedArgs));
        });
    }

    const create = program.command("create").description("从 Creator 模板创建项目")
        .addOption(new Option("--type <类型>", "项目模板类型").choices(["2d", "3d"]));
    action(create, async (values) => {
        const { project, editor, type } = values;
        if (!project) throw new CocosCliError("create 需要 --project", { code: "INVALID_ARGUMENT" });
        const result = await createProject({ ...options, project, editor, type });
        if (values.json) options.output(JSON.stringify(result, null, 2));
        else options.output(`已创建 Creator ${result.creatorVersion} 项目：${result.projectRoot}`);
        return 0;
    });

    action(program.command("check").description("检查项目资源和 Meta"), (values) => {
        const project = loadProject({ cwd: options.cwd, project: values.project });
        const result = checkAssets(project.root);
        options.output(JSON.stringify(result, null, 2));
        return result.ok ? 0 : 2;
    });

    const asset = program.command("asset").description("查询项目资源");
    action(asset.command("refs <路径或UUID>").description("查找序列化资源引用"), (values, [target]) => {
        const project = loadProject({ cwd: options.cwd, project: values.project });
        options.output(JSON.stringify(findAssetReferences(project.root, target), null, 2));
        return 0;
    });

    const prefab = program.command("prefab").description("只读检查 Prefab");
    action(prefab.command("inspect <文件>").description("查看节点和组件"), (values, [file]) => {
        const project = loadProject({ cwd: options.cwd, project: values.project });
        options.output(JSON.stringify(inspectPrefab(project.root, file), null, 2));
        return 0;
    });
    action(prefab.command("diff <旧文件> <新文件>").description("比较节点和组件字段"), (values, [left, right]) => {
        const project = loadProject({ cwd: options.cwd, project: values.project });
        options.output(JSON.stringify(diffPrefabs(project.root, left, right), null, 2));
        return 0;
    });

    const info = program.command("info").description("查看项目和 Creator 版本")
        .option("--start-scene <UUID>", "覆盖启动场景");
    action(info, (values) => runInfo(options, values));

    const open = program.command("open").description("打开或显示 Creator 主窗口")
        .addOption(new Option("--wait", "等待 Creator 退出").conflicts(["foreground", "background"]));
    addWindowOptions(open);
    action(open, (values) => runOpen(options, values));

    const build = program.command("build [平台]").description("调用 Creator 原生命令行构建")
        .option("--build-config <文件>", "Creator 构建面板导出的 JSON")
        .option("--log-dest <文件>", "Creator 构建日志路径")
        .addOption(new Option("--debug", "启用调试构建").conflicts("release"))
        .option("--release", "关闭调试构建")
        .option("--start-scene <UUID>", "覆盖启动场景")
        .option("--option <key=value>", "追加 Creator 构建参数，可重复", (value, previous: string[]) => [...previous, value], [])
        .option("--guard-url <URL>", "此地址可访问时阻止构建")
        .option("--skip-guard", "跳过构建前 HTTP 检查");
    action(build, (values, [platform]) => runBuild(options, values, platform));

    const mcp = program.command("mcp").description("连接目标 Creator 项目的 Funplay MCP");
    mcp.action(() => mcp.outputHelp());
    for (const operation of ["setup", "update"] as const) {
        const description = operation === "setup" ? "安装最新稳定版 Funplay" : "从 GitHub 更新已安装的 Funplay";
        const command = mcp.command(operation).description(description)
            .option("--global", "安装到项目所用 Creator 版本的全局扩展目录");
        action(command, async (values) => {
            const project = loadProject({ cwd: options.cwd, project: values.project });
            const result = await manageFunplayExtension({ project, operation, global: values.global, timeoutMs: values.timeoutMs });
            if (values.json) {
                options.output(JSON.stringify({ command: "mcp " + operation, ...result }, null, 2));
            } else {
                const state = result.changed ? "已安装" : "已存在";
                options.output(`Funplay ${result.version} ${state}：${result.extensionPath}`);
                if (result.projectOverridePath) options.output(`当前项目优先加载项目副本：${result.projectOverridePath}`);
                if (result.backupPath) options.output(`原扩展备份：${result.backupPath}`);
                if (result.changed) options.output("在 Creator 中打开或重开目标项目以加载扩展。");
            }
            return 0;
        });
    }
    const ensure = mcp.command("ensure").description("启动或复用 Creator，并等待 MCP 就绪")
        .option("--allow-unverified-editor", "允许尝试启动未核验版本的安装");
    addWindowOptions(ensure);
    action(ensure, (values) => runLifecycle("ensure", options, values));
    action(mcp.command("status").description("查看目标项目进程和 MCP 状态"), (values) => runLifecycle("status", options, values));
    action(mcp.command("doctor").description("诊断 Creator 版本、进程和 MCP"), (values) => runLifecycle("doctor", options, values));
    const stop = mcp.command("stop").description("通过 Funplay 请求 Creator 正常退出")
        .option("--save", "退出前保存当前场景");
    action(stop, (values) => runLifecycle("stop", options, values));
    const restart = mcp.command("restart").description("正常退出并重新启动 Creator")
        .option("--save", "退出前保存当前场景")
        .option("--allow-unverified-editor", "允许尝试启动未核验版本的安装");
    action(restart, (values) => runLifecycle("restart", options, values));

    const register = mcp.command("register").description("注册 Agent MCP 并补齐 Funplay Skills")
        .addOption(new Option("--client <客户端>", "选择客户端").choices(FUNPLAY_CLIENTS).makeOptionMandatory())
        .addOption(new Option("--scope <作用域>", "客户端配置作用域").choices(["project", "user"]).default("project"));
    action(register, async (values) => {
        const { connection, timeoutMs } = await connectProjectMcp(makeLifecycleOptions(options, values));
        const result = await registerFunplay({ connection, timeoutMs, clientId: values.client, scope: values.scope });
        if (values.json) {
            options.output(JSON.stringify({ command: "mcp register", ...result }, null, 2));
        } else {
            options.output(`MCP 已注册：${result.configPath}`);
            options.output(`Funplay 项目配置：${result.projectConfigPath}`);
            options.output(`Funplay Skills：安装 ${result.skills.installed.length}，保留 ${result.skills.preserved.length}。`);
            for (const failure of result.skills.failed) options.errorOutput(`Skill ${failure.skillName} 安装失败：${failure.message}`);
            if (result.launchCommand) options.output(result.launchCommand);
            else options.output("在目标项目中重新加载客户端以启用 Funplay 工具。");
        }
        return result.ok ? 0 : 1;
    });
    return program;
}

function addWindowOptions(command: Command) {
    command.addOption(new Option("--foreground", "Windows：显示主窗口并请求焦点").conflicts("background"))
        .option("--background", "Windows：隐藏主窗口");
}

export async function runCli(argv: string[], context: CliContext = {}) {
    const options = {
        cwd: context.cwd ?? process.cwd(),
        env: context.env ?? process.env,
        platform: context.platform ?? process.platform,
        output: context.output ?? console.log,
        errorOutput: context.errorOutput ?? console.error,
    };

    let exitCode = 0;
    const program = registerCommands(options, (code) => { exitCode = code; });
    try {
        if (argv.length === 0) program.outputHelp();
        else await program.parseAsync(argv, { from: "user" });
        return exitCode;
    } catch (caught) {
        let error = caught;
        if (caught instanceof CommanderError) {
            if (caught.exitCode === 0) return 0;
            const code = caught.code === "commander.unknownCommand" ? "INVALID_COMMAND" : "INVALID_ARGUMENT";
            const message = caught.code === "commander.help" ? "缺少子命令，请使用 --help 查看用法" : caught.message.replace(/^error: /, "");
            error = new CocosCliError(message, { code });
        }
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
