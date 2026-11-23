import { setTimeout as delay } from "node:timers/promises";

import { resolveCreator } from "./creator.js";
import { assertWindowMode, setEditorWindow } from "./editor-window.js";
import { CocosCliError } from "./errors.js";
import { callMcpTool, discoverMcpEndpoints, probeMcp } from "./mcp.js";
import { isProcessAlive, listCreatorProcesses, normalizeProjectPath } from "./processes.js";
import { launchDetached } from "./runner.js";
import { getProjectStatePaths, readProjectState, withProjectLock, writeProjectState } from "./state.js";

const DEFAULTS = {
    resolveCreator,
    callMcpTool,
    discoverMcpEndpoints,
    probeMcp,
    listCreatorProcesses,
    isProcessAlive,
    launchDetached,
    setEditorWindow,
    readProjectState,
    writeProjectState,
    withProjectLock,
    delay,
    now: Date.now,
};

interface LifecycleOptions {
    project: Pick<ReturnType<typeof import("./project.js").loadProject>, "root" | "name" | "creatorVersion">;
    config?: Partial<ReturnType<typeof import("./config.js").loadConfig>["config"]>;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    editor?: string;
    mcpUrl?: string;
    timeoutMs?: number;
    stopTimeoutMs?: number;
    requestTimeoutMs?: number;
    pollIntervalMs?: number;
    allowUnverifiedEditor?: boolean;
    save?: boolean;
    windowMode?: import("./editor-window.js").WindowMode;
    log?: (message: string) => void;
    dependencies?: Partial<typeof DEFAULTS>;
}
function dependencies(options: LifecycleOptions) {
    return { ...DEFAULTS, ...options.dependencies };
}

function error(code, message, details = []) {
    return new CocosCliError(message, { code, details });
}

function sameProject(left, right, platform) {
    return Boolean(left && right && normalizeProjectPath(left, { platform }) === normalizeProjectPath(right, { platform }));
}

function settings(options: LifecycleOptions) {
    return {
        timeoutMs: options.timeoutMs ?? options.config?.lifecycle?.timeoutMs ?? 120000,
        stopTimeoutMs: options.stopTimeoutMs ?? options.timeoutMs ?? options.config?.lifecycle?.stopTimeoutMs ?? 15000,
        requestTimeoutMs: options.requestTimeoutMs ?? options.config?.mcp?.requestTimeoutMs ?? 3000,
        pollIntervalMs: options.pollIntervalMs ?? options.config?.lifecycle?.pollIntervalMs ?? 750,
    };
}

function editorOptions(options: LifecycleOptions) {
    return {
        projectRoot: options.project.root,
        cwd: options.cwd ?? options.project.root,
        version: options.project.creatorVersion,
        editor: options.editor,
        configEditor: options.config?.editor?.path,
        env: options.env ?? process.env,
        platform: options.platform ?? process.platform,
    };
}

function describeEditor(creator, project) {
    return {
        requiredVersion: project.creatorVersion,
        actualVersion: creator?.actualVersion ?? null,
        versionVerified: creator?.versionVerified ?? false,
        versionMatch: creator?.versionMatch ?? null,
        path: creator?.path ?? null,
        source: creator?.source ?? null,
        versionSource: creator?.versionSource ?? null,
    };
}

export function assertEditorVersion(creator: ReturnType<typeof resolveCreator>, options: { allowUnverified?: boolean } = {}) {
    if (creator.versionMatch === false) {
        throw error("CREATOR_VERSION_MISMATCH", `项目要求 Creator ${creator.requiredVersion}，实际找到 ${creator.actualVersion}`, [creator.path]);
    }
    if (!creator.versionVerified && !options.allowUnverified) {
        throw error("CREATOR_VERSION_UNVERIFIED", "无法从安装元数据核验 Creator 版本，未启动编辑器", [
            creator.path,
            "请用 --editor 指向完整 Creator 安装；仅在已自行核对版本时使用 --allow-unverified-editor。MCP 连接后仍会核对实际版本。",
        ]);
    }
}

async function inspectConnections(options: LifecycleOptions, dep, state, deadline) {
    const timing = settings(options);
    const endpoints = dep.discoverMcpEndpoints({
        projectRoot: options.project.root,
        explicitUrl: options.mcpUrl,
        stateEndpoint: state?.endpoint,
        env: options.env ?? process.env,
        config: options.config?.mcp ?? {},
    });
    const attempts = [];
    // Only Funplay's configured fallback candidates, four requests at a time.
    // Never treat an unrelated HTTP listener as a ready editor.
    for (let index = 0; index < endpoints.length; index += 4) {
        const remaining = deadline - dep.now();
        if (remaining <= 0) break;
        const batch = await Promise.all(endpoints.slice(index, index + 4).map((url) => dep.probeMcp({
            url,
            projectRoot: options.project.root,
            expectedVersion: options.project.creatorVersion,
            timeoutMs: Math.max(1, Math.min(timing.requestTimeoutMs, remaining)),
        })));
        attempts.push(...batch);
        const ready = batch.find((result) => result.ready);
        if (ready) return { connection: ready, attempts, endpoints };
    }
    return { connection: null, attempts, endpoints };
}

function relevantConnectionError(attempts) {
    return attempts.find((item) => item.projectMatched && item.error)
        ?? attempts.find((item) => item.reachable && item.error)
        ?? attempts.find((item) => item.error)
        ?? null;
}

async function inspect(options: LifecycleOptions, dep, deadline) {
    const state = await dep.readProjectState(options.project.root);
    const [connections, processResult] = await Promise.all([
        inspectConnections(options, dep, state, deadline),
        dep.listCreatorProcesses({ platform: options.platform, env: options.env, timeoutMs: Math.max(1, Math.min(5000, deadline - dep.now())) }),
    ]);
    const matchingProcesses = processResult.processes.filter((item) => sameProject(item.projectRoot, options.project.root, options.platform));
    const unknownProcesses = processResult.processes.filter((item) => !item.projectRoot);
    return { ...connections, processResult, matchingProcesses, unknownProcesses, state };
}

function resultSnapshot(options: LifecycleOptions, inspected, creator = null) {
    const connection = inspected.connection;
    const failure = relevantConnectionError(inspected.attempts);
    return {
        ok: Boolean(connection),
        ready: Boolean(connection),
        projectRoot: options.project.root,
        projectName: options.project.name,
        editor: {
            ...describeEditor(creator, options.project),
            installedVersion: creator?.actualVersion ?? null,
            installationVersionMatch: creator?.versionMatch ?? null,
            ...(connection ? { actualVersion: connection.editorVersion, versionVerified: true, versionMatch: true } : {}),
        },
        process: {
            running: Boolean(connection) || inspected.matchingProcesses.length > 0,
            pids: inspected.matchingProcesses.map((item) => item.pid),
            unknownProjectPids: inspected.unknownProcesses.map((item) => item.pid),
            discoverySupported: inspected.processResult.supported,
            discoveryError: inspected.processResult.error ?? null,
        },
        mcp: {
            ready: Boolean(connection),
            reachable: inspected.attempts.some((item) => item.reachable),
            endpoint: connection?.endpoint ?? failure?.endpoint ?? null,
            projectId: connection?.projectId ?? null,
            editorVersion: connection?.editorVersion ?? failure?.editorVersion ?? null,
            readiness: connection?.readiness ?? null,
            error: connection ? null : failure?.error ?? { code: "MCP_NOT_FOUND", message: "没有找到目标项目的 Funplay MCP 服务" },
        },
        nextSteps: connection ? [] : [
            "确认 Funplay 已安装并启用自动启动。",
            "若使用自定义端口，用 --mcp-url 指定 Funplay 面板显示的完整项目 URL。",
        ],
    };
}

export async function inspectProject(options: LifecycleOptions) {
    const dep = dependencies(options);
    const timing = settings(options);
    const inspected = await inspect(options, dep, dep.now() + (options.timeoutMs ?? 10000));
    let creator = null;
    let creatorError = null;
    try {
        creator = dep.resolveCreator(editorOptions(options));
    } catch (caught) {
        creatorError = { code: caught.code ?? "CREATOR_NOT_FOUND", message: caught.message, details: caught.details ?? [] };
    }
    const result = resultSnapshot(options, inspected, creator);
    return {
        ...result,
        editor: { ...result.editor, error: creatorError },
        requestTimeoutMs: timing.requestTimeoutMs,
    };
}

function assertNoFatalConnectionError(options: LifecycleOptions, inspected) {
    const explicit = options.mcpUrl ?? (options.env ?? process.env).COCOS_CLI_MCP_URL ?? options.config?.mcp?.url;
    const fatal = inspected.attempts.find((item) => item.error && (
        (item.projectMatched && /VERSION|CONTEXT|INSTANCE/.test(item.error.code))
        || (explicit && item.reachable && /PROJECT|VERSION|CONTEXT|INSTANCE/.test(item.error.code))
        || /INVALID_URL|UNSAFE|REMOTE|REDIRECT/.test(item.error.code)
    ));
    if (fatal) throw error(fatal.error.code, fatal.error.message, [fatal.endpoint ?? ""]);
}

async function finishEnsure(options: LifecycleOptions, dep, inspected, creator, launchedPid, deadline) {
    const pid = launchedPid && dep.isProcessAlive(launchedPid) ? launchedPid : inspected.matchingProcesses[0]?.pid ?? null;
    await dep.writeProjectState(options.project.root, {
        endpoint: inspected.connection.endpoint,
        pid,
        editorPath: creator?.path ?? inspected.state?.editorPath ?? null,
        startedAt: launchedPid ? new Date(dep.now()).toISOString() : inspected.state?.startedAt ?? null,
    });
    const result = { ...resultSnapshot(options, inspected, creator), launched: Boolean(launchedPid), reused: !launchedPid, pid };
    if (options.windowMode) {
        if ((launchedPid === null || pid !== launchedPid) && inspected.matchingProcesses.length !== 1) {
            throw error("EDITOR_WINDOW_PROCESS_UNKNOWN", "无法唯一确认目标项目的 Creator 进程，未切换窗口");
        }
        const window = await dep.setEditorWindow({
            pid,
            mode: options.windowMode,
            timeoutMs: deadline - dep.now(),
            env: options.env,
        });
        return { ...result, window };
    }
    return result;
}

async function ensureUnlocked(options: LifecycleOptions, dep, deadline) {
    let inspected = await inspect(options, dep, deadline);
    assertNoFatalConnectionError(options, inspected);
    if (inspected.connection) {
        return finishEnsure(options, dep, inspected, null, null, deadline);
    }
    let creator = null;
    let launchedPid = null;
    if (!inspected.matchingProcesses.length) {
        if (inspected.unknownProcesses.length) {
            throw error("EDITOR_PROJECT_UNKNOWN", "有 Creator 进程无法确定项目路径，未重复启动编辑器", [
                `PID: ${inspected.unknownProcesses.map((item) => item.pid).join(", ")}`,
                "确认这些编辑器的项目与 MCP 状态，或正常关闭无关实例后重试。",
            ]);
        }
        if (!inspected.processResult.supported || inspected.processResult.error) {
            throw error("PROCESS_DISCOVERY_UNAVAILABLE", "无法确认目标项目是否已经运行，未重复启动 Creator", [
                String(inspected.processResult.error?.message ?? inspected.processResult.error ?? "进程查询不可用"),
                "请修复系统进程查询，或先打开目标项目并让 MCP 服务就绪。",
            ]);
        }
        creator = dep.resolveCreator(editorOptions(options));
        const allowUnverified = options.allowUnverifiedEditor ?? options.config?.editor?.allowUnverifiedVersion ?? false;
        assertEditorVersion(creator, { allowUnverified });
        if (dep.now() >= deadline) throw error("EDITOR_READY_TIMEOUT", "启动等待已超时，未启动新的 Creator 进程");
        options.log?.(`启动 Creator ${creator.actualVersion ?? "（版本待 MCP 核验）"}：${options.project.root}`);
        launchedPid = await dep.launchDetached(creator.path, ["--project", options.project.root], {
            cwd: options.project.root,
            env: options.env,
            logFile: getProjectStatePaths(options.project.root).logFile,
            windowsHide: options.windowMode === "background",
        });
        await dep.writeProjectState(options.project.root, {
            pid: launchedPid,
            editorPath: creator.path,
            endpoint: inspected.state?.endpoint ?? null,
            startedAt: new Date(dep.now()).toISOString(),
        });
    } else {
        options.log?.("目标项目已有 Creator 进程，等待其 MCP 服务就绪。");
    }
    while (dep.now() < deadline) {
        await dep.delay(Math.min(settings(options).pollIntervalMs, Math.max(1, deadline - dep.now())));
        inspected = await inspect(options, dep, deadline);
        assertNoFatalConnectionError(options, inspected);
        if (inspected.connection) {
            return finishEnsure(options, dep, inspected, creator, launchedPid, deadline);
        }
        // Never respawn in a loop: a failed/closed editor remains a clear error.
        if (launchedPid && !dep.isProcessAlive(launchedPid) && !inspected.matchingProcesses.length) {
            throw error("CREATOR_EXITED_BEFORE_READY", "Creator 在 MCP 就绪前退出", [getProjectStatePaths(options.project.root).logFile]);
        }
    }
    const lastError = relevantConnectionError(inspected.attempts)?.error;
    throw error("EDITOR_READY_TIMEOUT", "等待目标项目的 Funplay MCP 就绪超时；未强制关闭编辑器", [
        ...(lastError ? [`${lastError.code}: ${lastError.message}`] : []),
        getProjectStatePaths(options.project.root).logFile,
        "检查 Creator 窗口中的登录、资源导入、插件启用或错误提示；可用 --mcp-url 指定面板中的实际 URL。",
    ]);
}

export async function ensureProject(options: LifecycleOptions) {
    assertWindowMode(options.windowMode, options.platform);
    const dep = dependencies(options);
    const timeoutMs = settings(options).timeoutMs;
    const deadline = dep.now() + timeoutMs;
    return dep.withProjectLock(options.project.root, () => ensureUnlocked(options, dep, deadline), { timeoutMs });
}

export async function openProjectWindow(options: LifecycleOptions) {
    assertWindowMode(options.windowMode, options.platform);
    const dep = dependencies(options);
    const { timeoutMs } = settings(options);
    const deadline = dep.now() + timeoutMs;
    return dep.withProjectLock(options.project.root, async () => {
        const processResult = await dep.listCreatorProcesses({
            platform: options.platform,
            env: options.env,
            timeoutMs: Math.max(1, Math.min(5000, deadline - dep.now())),
        });
        if (!processResult.supported || processResult.error) {
            throw error("PROCESS_DISCOVERY_UNAVAILABLE", "无法确认目标项目是否已经运行", [processResult.error].filter(Boolean));
        }
        const matches = processResult.processes.filter((item) => sameProject(item.projectRoot, options.project.root, options.platform));
        if (matches.length > 1 || (!matches.length && processResult.processes.some((item) => !item.projectRoot))) {
            throw error("EDITOR_WINDOW_PROCESS_UNKNOWN", "无法唯一确认目标项目的 Creator 进程，未切换窗口或重复启动");
        }
        let pid = matches[0]?.pid;
        const reused = Boolean(pid);
        if (dep.now() >= deadline) throw error("EDITOR_WINDOW_TIMEOUT", "等待目标项目的窗口切换超时");
        if (!reused) {
            const creator = dep.resolveCreator(editorOptions(options));
            assertEditorVersion(creator, { allowUnverified: true });
            pid = await dep.launchDetached(creator.path, ["--project", options.project.root], {
                cwd: options.project.root,
                env: options.env,
                windowsHide: options.windowMode === "background",
            });
        }
        const window = await dep.setEditorWindow({
            pid,
            mode: options.windowMode,
            timeoutMs: deadline - dep.now(),
            env: options.env,
        });
        return { ok: true, projectRoot: options.project.root, pid, reused, launched: !reused, window };
    }, { timeoutMs });
}

// Runs only through a freshly verified Funplay connection. Normal App.quit()
// consults editor extensions; this does not kill a PID or suppress save prompts.
export const STOP_EDITOR_SCRIPT = `
async function run({ Editor, args, path, fs }) {
    const normalize = (value) => {
        const resolved = fs.realpathSync.native(path.resolve(value)).replace(/[\\\\/]+$/, '');
        return require('node:process').platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    const expired = () => Number.isFinite(args.deadlineAt) && Date.now() >= args.deadlineAt;
    if (expired()) return { quitScheduled: false, reason: 'STOP_REQUEST_EXPIRED' };
    if (normalize(Editor.Project.path) !== normalize(args.projectRoot)) throw new Error('PROJECT_CHANGED');
    if (Editor.App.version !== args.expectedVersion) throw new Error('EDITOR_VERSION_CHANGED');
    if (typeof Editor.App.quit !== 'function') throw new Error('EDITOR_QUIT_UNAVAILABLE');
    let dirty = await Editor.Message.request('scene', 'query-dirty');
    if (expired()) return { quitScheduled: false, reason: 'STOP_REQUEST_EXPIRED' };
    if (typeof dirty !== 'boolean') throw new Error('SCENE_DIRTY_STATE_UNKNOWN');
    if (dirty && !args.save) return { quitScheduled: false, reason: 'SCENE_DIRTY' };
    if (dirty) {
        await Editor.Message.request('scene', 'save-scene');
        dirty = await Editor.Message.request('scene', 'query-dirty');
        if (dirty !== false) return { quitScheduled: false, reason: 'SCENE_NOT_SAVED' };
    }
    if (expired()) return { quitScheduled: false, reason: 'STOP_REQUEST_EXPIRED' };
    const pid = require('node:process').pid;
    setTimeout(() => {
        if (!expired() && normalize(Editor.Project.path) === normalize(args.projectRoot) && Editor.App.version === args.expectedVersion) Editor.App.quit();
    }, 150);
    return { quitScheduled: true, pid, sceneSaved: Boolean(args.save) };
}`;

async function stopUnlocked(options: LifecycleOptions, dep, deadline) {
    const inspected = await inspect(options, dep, deadline);
    assertNoFatalConnectionError(options, inspected);
    if (!inspected.connection) {
        if (inspected.processResult.supported && !inspected.processResult.error && !inspected.matchingProcesses.length && !inspected.unknownProcesses.length) {
            return { ok: true, stopped: true, alreadyStopped: true, projectRoot: options.project.root };
        }
        throw error("MCP_REQUIRED_FOR_SAFE_STOP", "目标项目的 MCP 不可用，无法核验未保存状态并正常退出 Creator", [
            "请在 Creator 中保存并关闭该项目；此工具不会强制结束未知或无响应的进程。",
        ]);
    }
    const callTimeoutMs = Math.min(settings(options).requestTimeoutMs, deadline - dep.now());
    if (callTimeoutMs < 500) throw error("EDITOR_STOP_TIMEOUT", "剩余时间不足以正常退出，未发送退出请求");
    const response = await dep.callMcpTool({
        connection: inspected.connection,
        name: "execute_javascript",
        args: {
            context: "editor",
            code: STOP_EDITOR_SCRIPT,
            args: { projectRoot: options.project.root, expectedVersion: options.project.creatorVersion, save: Boolean(options.save), deadlineAt: dep.now() + callTimeoutMs - 100 },
        },
        timeoutMs: callTimeoutMs,
    });
    const outcome = response.data;
    if (!outcome?.quitScheduled) {
        throw error(outcome?.reason ?? "EDITOR_QUIT_REFUSED", "Creator 尚未退出：存在未保存场景或无法确认保存完成", [
            "先保存场景；若已有保存路径，可使用 --save。新场景的首次保存可能需要在编辑器中选择路径。",
        ]);
    }
    if (!Number.isInteger(outcome.pid) || outcome.pid <= 0) throw error("INVALID_EDITOR_PID", "编辑器没有返回有效的进程身份");
    while (dep.now() < deadline) {
        if (!dep.isProcessAlive(outcome.pid)) {
            await dep.writeProjectState(options.project.root, {
                pid: null,
                startedAt: null,
                editorPath: inspected.state?.editorPath ?? null,
                endpoint: inspected.connection.endpoint,
            });
            return { ok: true, stopped: true, alreadyStopped: false, projectRoot: options.project.root, pid: outcome.pid };
        }
        await dep.delay(Math.min(settings(options).pollIntervalMs, Math.max(1, deadline - dep.now())));
    }
    throw error("EDITOR_STOP_TIMEOUT", "Creator 尚未退出，可能有保存提示或扩展阻止关闭；未强制终止", [
        "检查编辑器窗口后再重试。restart 不会在旧进程仍运行时启动新实例。",
    ]);
}

export async function stopProject(options: LifecycleOptions) {
    const dep = dependencies(options);
    const timeoutMs = settings(options).stopTimeoutMs;
    const deadline = dep.now() + timeoutMs;
    return dep.withProjectLock(options.project.root, () => stopUnlocked(options, dep, deadline), { timeoutMs });
}

export async function restartProject(options: LifecycleOptions) {
    const dep = dependencies(options);
    const timing = settings(options);
    const deadline = dep.now() + timing.timeoutMs;
    return dep.withProjectLock(options.project.root, async () => {
        // Verify the replacement before closing a perfectly usable editor.
        const creator = dep.resolveCreator(editorOptions(options));
        assertEditorVersion(creator, { allowUnverified: options.allowUnverifiedEditor ?? options.config?.editor?.allowUnverifiedVersion ?? false });
        const stopped = await stopUnlocked(options, dep, Math.min(deadline, dep.now() + timing.stopTimeoutMs));
        const ready = await ensureUnlocked(options, dep, deadline);
        return { ...ready, restarted: true, previousPid: stopped.pid ?? null };
    }, { timeoutMs: timing.timeoutMs });
}
