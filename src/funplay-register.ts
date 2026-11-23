import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { CocosCliError } from "./errors.js";
import { callMcpTool, type probeMcp } from "./mcp.js";
import { getProjectStatePaths, withProjectLock } from "./state.js";

const CLIENTS = {
    codex: { upstream: "codex", config: ".codex/config.toml" },
    "claude-code": { upstream: "claude_code", writer: "codebuddy", config: ".mcp.json" },
    cursor: { upstream: "cursor", config: ".cursor/mcp.json" },
    vscode: { upstream: "vscode", config: ".vscode/mcp.json" },
    kiro: { upstream: "kiro", config: ".kiro/settings/mcp.json" },
    qoder: { upstream: "qoder", config: ".qoder/settings.json" },
    "kimi-code": { upstream: "kimi", config: ".kimi-code/mcp.json" },
    opencode: { upstream: "opencode", config: "opencode.jsonc" },
    trae: { upstream: "trae", config: ".trae/mcp.json", projectOnly: true },
    codebuddy: { upstream: "codebuddy", config: ".mcp.json", projectOnly: true },
    dsh: { upstream: "deepseek_harness", config: ".dsh/funplay-cocos-mcp.patch.json", projectOnly: true },
} satisfies Record<string, Client>;
interface Client { upstream: string; config: string; writer?: string; projectOnly?: boolean }
export const FUNPLAY_CLIENTS = Object.keys(CLIENTS);
export type FunplayClient = keyof typeof CLIENTS;
type Scope = "project" | "user";
type Connection = Awaited<ReturnType<typeof probeMcp>>;
type Registration = { serverName: string; projectIdentity: string; configPath: string; url: string };
type Config = { projectPath: string; host: string; port: number; clientConfigEntries?: Record<string, Registration> };
interface ClientConfig {
    buildTargets: (config: Config, options?: WriterOptions) => { id: string; configPath: string; url?: string; entry?: { url?: string } }[];
    configureTarget: (config: Config, id: string, options?: WriterOptions) => Registration & { launchCommand?: string; restartHint?: string };
}
interface WriterOptions { homePath?: string; env?: NodeJS.ProcessEnv }
interface SkillApi {
    getProjectSkillsState: (root: string, options: { clientId: string }) => {
        supported: boolean; error?: string; builtIns: { skillName: string; status: string }[];
    };
    updateBuiltInProjectSkill: (root: string, options: { clientId: string; skillName: string; onlyIfMissing: true; extensionVersion: string }) => {
        installed: boolean;
    };
}

function fail(code: string, message: string, details?: string[]) {
    return new CocosCliError(message, { code, details });
}

function realPath(path: string) {
    try {
        return realpathSync.native(path);
    } catch (error) {
        if (error.code === "ENOENT") return undefined;
        throw error;
    }
}

// The installed helper may follow config symlinks. Reject redirections on paths this CLI writes.
function assertContained(root: string, target: string) {
    const suffix = relative(root, target);
    if (!suffix || isAbsolute(suffix) || suffix.split(sep)[0] === "..") {
        throw fail("FUNPLAY_UNSAFE_CONFIG_PATH", "MCP 配置路径超出预期目录", [target]);
    }
    let current = root;
    for (const part of suffix.split(sep)) {
        current = join(current, part);
        try {
            const entry = lstatSync(current);
            const expectedType = current === target ? entry.isFile() : entry.isDirectory();
            if (entry.isSymbolicLink() || !expectedType) {
                throw fail("FUNPLAY_UNSAFE_CONFIG_PATH", "MCP 配置路径包含符号链接或无效文件类型", [current]);
            }
        } catch (error) {
            if (error.code === "ENOENT") return;
            throw error;
        }
    }
}

async function loadActiveFunplay(connection: Connection, home: string, timeoutMs?: number) {
    const state = connection.editorState as { version?: string; status?: { packagePath?: unknown } } | undefined;
    const version = connection.editorVersion;
    if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version ?? "")) {
        throw fail("FUNPLAY_PACKAGE_UNKNOWN", "无法根据在线 Creator 版本识别 Funplay 安装目录");
    }

    let reportedPath = state?.status?.packagePath;
    // Funplay 0.7.6 exposes packagePath in script context rather than get_editor_state.
    if (reportedPath === undefined || reportedPath === null) {
        try {
            const result = await callMcpTool({
                connection,
                name: "execute_javascript",
                args: { context: "editor", code: "function run({ context }) { return { packagePath: context.packagePath }; }" },
                timeoutMs,
            });
            reportedPath = result.data?.packagePath;
        } catch (error) {
            if (!(error instanceof CocosCliError) || error.code !== "MCP_TOOL_ERROR") throw error;
            throw fail("FUNPLAY_PACKAGE_UNKNOWN", "Funplay 状态缺少安装目录，且无法通过 execute_javascript 读取，请确认工具已启用", [error.message]);
        }
    }
    if (typeof reportedPath !== "string" || !isAbsolute(reportedPath)) {
        throw fail("FUNPLAY_PACKAGE_UNKNOWN", "在线 Funplay 未提供可识别的安装目录");
    }
    const active = realPath(reportedPath);
    const candidates = [
        join(connection.context.project_path, "extensions", "funplay-cocos-mcp"),
        join(home, ".CocosCreator", "builtin-extensions", version, "funplay-cocos-mcp"),
    ];
    if (!active || !candidates.some((path) => realPath(path) === active)) {
        throw fail("FUNPLAY_PACKAGE_UNKNOWN", "在线 Funplay 安装不在目标项目或对应 Creator 的全局目录", [reportedPath]);
    }
    const require = createRequire(join(active, "package.json"));
    const manifest = require("./package.json");
    if (manifest.name !== "funplay-cocos-mcp" || typeof manifest.version !== "string") {
        throw fail("FUNPLAY_INVALID_INSTALLATION", "安装目录不是可识别的 Funplay 扩展");
    }
    if (state?.version && manifest.version !== state.version) {
        throw fail("FUNPLAY_PACKAGE_VERSION_MISMATCH", "磁盘中的 Funplay 版本与运行中的扩展不一致，请重开项目后再注册", [active]);
    }
    return {
        version: String(manifest.version),
        config: require("./lib/client-config.js") as ClientConfig,
        skills: require("./lib/project-skills.js") as SkillApi,
        readText: require("./lib/atomic-file.js").readOptionalText as (path: string) => string | null,
        writeText: require("./lib/atomic-file.js").writeTextIfUnchanged as (path: string, text: string, previous: string | null) => void,
    };
}

function readProjectRegistrationConfig(text: string | null, path: string, connection: Connection) {
    if (text === null) {
        const state = connection.editorState as { status?: { portMode?: unknown; requestedPort?: number } } | undefined;
        const status = state?.status;
        if (status?.portMode === "fixed") {
            const port = status.requestedPort;
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
                throw fail("FUNPLAY_INVALID_PROJECT_CONFIG", "无法确认 Funplay 的固定端口", [path]);
            }
            return { portMode: "fixed", port, clientConfigEntries: {} as Record<string, Registration> };
        }
        // Funplay treats an existing file without portMode as a legacy fixed-port config.
        return { portMode: "project", clientConfigEntries: {} as Record<string, Registration> };
    }

    try {
        const previous = JSON.parse(text) as { clientConfigEntries?: Record<string, Registration> };
        if (!previous || typeof previous !== "object" || Array.isArray(previous)) throw Error("配置根节点必须是对象");
        const entries = previous.clientConfigEntries;
        if (entries !== undefined && (!entries || typeof entries !== "object" || Array.isArray(entries))) {
            throw Error("clientConfigEntries 必须是对象");
        }
        return { ...previous, clientConfigEntries: entries ?? {} };
    } catch (error) {
        throw fail("FUNPLAY_INVALID_PROJECT_CONFIG", "无法安全合并 Funplay 项目配置", [path, error.message]);
    }
}

export async function registerFunplay({ connection, clientId, scope, timeoutMs, homeDirectory = homedir() }: {
    connection: Connection; clientId: FunplayClient; scope: Scope; timeoutMs?: number; homeDirectory?: string;
}) {
    if (!connection.ready || !connection.context) throw fail("MCP_UNVERIFIED_CONNECTION", "请先验证目标项目的在线 Funplay");
    const client: Client = CLIENTS[clientId];
    if (!client) throw fail("INVALID_ARGUMENT", "未知 MCP 客户端", [clientId]);
    if (scope === "user" && (client.projectOnly || clientId === "claude-code")) {
        throw fail("FUNPLAY_SCOPE_UNSUPPORTED", "该客户端使用项目级注册", [clientId]);
    }

    const projectPath = connection.context.project_path;
    const physicalRoot = realpathSync.native(projectPath);
    const endpoint = new URL(connection.endpoint);
    const scopedPath = "/mcp/project/" + connection.projectId + "/";
    if (endpoint.pathname.replace(/\/$/, "") + "/" !== scopedPath || endpoint.search) {
        throw fail("FUNPLAY_SCOPED_URL_REQUIRED", "注册需要目标项目的完整 Funplay URL", [connection.endpoint]);
    }
    endpoint.pathname = scopedPath;
    const config: Config = { projectPath, host: endpoint.hostname.replace(/^\[|\]$/g, ""), port: Number(endpoint.port || 80) };
    const funplay = await loadActiveFunplay(connection, homeDirectory, timeoutMs);
    return withProjectLock(physicalRoot, () => {
        const skillOptions = { clientId: client.upstream };
        const skillsState = funplay.skills.getProjectSkillsState(projectPath, skillOptions);
        if (!skillsState.supported || skillsState.error || !Array.isArray(skillsState.builtIns)) {
            throw fail("FUNPLAY_SKILLS_UNAVAILABLE", skillsState.error || "当前 Funplay 版本没有该客户端的 Skill 安装支持", [clientId]);
        }

        const projectConfigPath = join(projectPath, "funplay-cocos-mcp.config.json");
        assertContained(projectPath, projectConfigPath);
        const projectConfigBefore = funplay.readText(projectConfigPath);
        const projectConfig = readProjectRegistrationConfig(projectConfigBefore, projectConfigPath, connection);
        const previousClientEntry = projectConfig.clientConfigEntries[client.upstream];

        const { directory } = getProjectStatePaths(physicalRoot);
        const receiptPath = join(directory, "funplay-registrations.json");
        assertContained(directory, receiptPath);
        const receiptBefore = funplay.readText(receiptPath);
        const receipts: Record<string, Registration> = receiptBefore ? JSON.parse(receiptBefore) : {};
        if (!receipts || typeof receipts !== "object" || Array.isArray(receipts)) {
            throw fail("FUNPLAY_INVALID_REGISTRATION_STATE", "MCP 注册记录不是 JSON 对象", [receiptPath]);
        }
        const key = clientId + ":" + scope;
        const staging = mkdtempSync(join(directory, "funplay-register-"));
        let registration: ReturnType<ClientConfig["configureTarget"]>;
        try {
            let configPath = join(projectPath, client.config);
            let writer = client.writer ?? client.upstream;
            let writerOptions: WriterOptions = { homePath: staging, env: {} };
            if (scope === "project") assertContained(projectPath, configPath);
            if (scope === "project" && clientId === "opencode" && funplay.readText(configPath) === null) {
                const json = join(projectPath, "opencode.json");
                assertContained(projectPath, json);
                if (funplay.readText(json) !== null) configPath = json;
            }
            if (scope === "user") {
                writer = client.upstream;
                writerOptions = { homePath: homeDirectory };
            }
            const destination = funplay.config.buildTargets(config, writerOptions).find((target) => target.id === writer);
            if (!destination) throw fail("FUNPLAY_CLIENT_UNAVAILABLE", "当前 Funplay 版本未提供客户端配置逻辑", [clientId]);
            const proposedUrl = destination.url ?? destination.entry?.url;
            if (!proposedUrl || new URL(proposedUrl).href !== endpoint.href) {
                throw fail("FUNPLAY_REGISTRATION_MISMATCH", "Funplay 生成了不同于已验证项目的端点");
            }
            if (scope === "user") configPath = destination.configPath;
            if (scope === "project") assertContained(projectPath, configPath);
            const before = funplay.readText(configPath);

            // Reuse the same writer and merge rules, even when the project's target differs from its default.
            if (destination.configPath !== configPath) {
                assertContained(staging, destination.configPath);
                if (before !== null) {
                    mkdirSync(dirname(destination.configPath), { recursive: true });
                    writeFileSync(destination.configPath, before, { flag: "wx" });
                }
            }
            const previous = [receipts[key], previousClientEntry].find((entry) => entry?.configPath === configPath);
            if (previous) {
                config.clientConfigEntries = { [writer]: { ...previous, configPath: destination.configPath } };
            }
            registration = funplay.config.configureTarget(config, writer, writerOptions);
            if (new URL(registration.url).href !== endpoint.href || registration.configPath !== destination.configPath) {
                throw fail("FUNPLAY_REGISTRATION_MISMATCH", "Funplay 返回的注册地址与已验证端点不一致");
            }
            if (destination.configPath !== configPath) {
                const updated = funplay.readText(destination.configPath);
                if (updated === null) throw fail("FUNPLAY_CONFIG_MISSING", "Funplay 未生成客户端配置");
                assertContained(projectPath, configPath);
                if (updated !== before) funplay.writeText(configPath, updated, before);
            }
            registration.configPath = configPath;
            receipts[key] = registration;
            const receiptAfter = JSON.stringify(receipts, null, 2) + "\n";
            if (receiptAfter !== receiptBefore) funplay.writeText(receiptPath, receiptAfter, receiptBefore);

            const { serverName, url, projectIdentity } = registration;
            const clientEntry = { ...previousClientEntry, serverName, url, configPath, projectIdentity };
            if (JSON.stringify(clientEntry) !== JSON.stringify(previousClientEntry)) {
                projectConfig.clientConfigEntries[client.upstream] = clientEntry;
                assertContained(projectPath, projectConfigPath);
                try {
                    funplay.writeText(projectConfigPath, JSON.stringify(projectConfig, null, 2) + "\n", projectConfigBefore);
                } catch (error) {
                    throw fail("FUNPLAY_PROJECT_CONFIG_WRITE_FAILED", "客户端 MCP 已写入，但 Funplay 项目配置写入失败，请重试 register", [projectConfigPath, error.message]);
                }
            }
        } finally {
            rmSync(staging, { recursive: true, force: true });
        }

        const installed: string[] = [];
        const preserved: string[] = [];
        const failed: { skillName: string; message: string }[] = [];
        for (const skill of skillsState.builtIns) {
            if (skill.status !== "missing") {
                preserved.push(skill.skillName);
                continue;
            }
            try {
                const result = funplay.skills.updateBuiltInProjectSkill(projectPath, {
                    ...skillOptions, skillName: skill.skillName, onlyIfMissing: true, extensionVersion: funplay.version,
                });
                (result.installed ? installed : preserved).push(skill.skillName);
            } catch (error) {
                failed.push({ skillName: skill.skillName, message: String(error.message ?? error) });
            }
        }
        return {
            ok: failed.length === 0, configured: true, client: clientId, scope, projectRoot: projectPath, projectConfigPath,
            ...registration, skills: { installed, preserved, failed },
        };
    });
}
