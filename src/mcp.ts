import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";

import { CocosCliError } from "./errors.js";
import { packageManifest } from "./package-info.js";

// Funplay Cocos MCP v0.7.6: lib/config.js, lib/project-context.js and lib/server.js.
const PROTOCOL_VERSION = "2025-11-25";
const CONTEXT_KEY = "io.funplay.cocos/context";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 3000;
let nextRequestId = 0;

function fail(code, message, details = []) {
    return new CocosCliError(message, { code, details });
}

function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function windowsPath(value) {
    return /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value);
}

export function normalizeProjectPath(projectRoot, platform = process.platform) {
    if (typeof projectRoot !== "string" || !projectRoot.trim()) {
        throw fail("MCP_INVALID_PROJECT", "MCP 项目路径不能为空。");
    }
    const windows = platform === "win32" || windowsPath(projectRoot);
    const normalized = (windows ? path.win32 : path.posix).resolve(projectRoot).replace(/\\/g, "/");
    return windows ? normalized.toLowerCase() : normalized;
}

export function getProjectIdentity(projectRoot, platform = process.platform) {
    return createHash("sha256").update(`funplay-cocos-mcp:${normalizeProjectPath(projectRoot, platform)}`).digest("hex").slice(0, 24);
}

export function getProjectPort(projectRoot, platform = process.platform) {
    return 20000 + (Number.parseInt(getProjectIdentity(projectRoot, platform).slice(0, 8), 16) % 10000);
}

function sameProjectPath(left, right) {
    if (normalizeProjectPath(left) === normalizeProjectPath(right)) return true;
    // Preserve Funplay's lexical hash, but accept a proven local symlink/case alias.
    try {
        return normalizeProjectPath(realpathSync.native(left)) === normalizeProjectPath(realpathSync.native(right));
    } catch {
        return false;
    }
}

export function normalizeMcpEndpoint(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw fail("MCP_INVALID_URL", "MCP URL 必须是完整的本机 HTTP 地址。");
    }
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const loopback = host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
    if (url.protocol !== "http:" || !loopback) {
        throw fail("MCP_REMOTE_ENDPOINT", "MCP 只允许本机 loopback HTTP 地址。", [url.origin]);
    }
    if (url.username || url.password || url.hash) {
        throw fail("MCP_INVALID_URL", "MCP URL 不接受用户名、密码或 fragment。");
    }
    return url.href;
}

function validPort(value) {
    const port = Number(value);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 8765;
}

/** Explicit URLs are authoritative; automatic discovery is bounded to Funplay's +20 fallback. */
export function discoverMcpEndpoints({ projectRoot, explicitUrl, stateEndpoint, env = process.env, config = {} }: { projectRoot: string; explicitUrl?: string; stateEndpoint?: string; env?: NodeJS.ProcessEnv; config?: { url?: string } }) {
    normalizeProjectPath(projectRoot);
    const configuredUrl = explicitUrl ?? env.COCOS_CLI_MCP_URL ?? config.url;
    if (configuredUrl !== undefined) return [normalizeMcpEndpoint(configuredUrl)];

    const endpoints = new Set();
    if (stateEndpoint) {
        try {
            endpoints.add(normalizeMcpEndpoint(stateEndpoint));
        } catch {
            // A stale/invalid saved hint must never cause a remote request.
        }
    }
    const configPath = path.resolve(projectRoot, "funplay-cocos-mcp.config.json");
    const configExists = existsSync(configPath);
    let fileConfig: Record<string, unknown> = {};
    if (configExists) {
        try {
            fileConfig = JSON.parse(readFileSync(configPath, "utf8"));
            if (!record(fileConfig)) throw new Error("配置根节点必须是对象");
        } catch (error) {
            throw fail("MCP_INVALID_CONFIG", `无法读取 Funplay MCP 配置: ${error.message}`, [configPath]);
        }
    }
    // Funplay uses a fixed port for existing config files that omit portMode.
    const mode = fileConfig.portMode === "project" || (!configExists && !env.COCOS_MCP_PORT) ? "project" : "fixed";
    let host = String(env.COCOS_MCP_HOST || fileConfig.host || "127.0.0.1");
    if (host === "0.0.0.0") host = "127.0.0.1";
    if (host === "::" || host === "[::]") host = "::1";
    const hosts = host.toLowerCase() === "localhost" ? ["127.0.0.1", "::1"] : [host];
    const roots = [projectRoot];
    try {
        const canonical = realpathSync.native(projectRoot);
        if (normalizeProjectPath(canonical) !== normalizeProjectPath(projectRoot)) roots.push(canonical);
    } catch {
        // The caller owns project validation; discovery can also be used before launch.
    }
    for (const root of roots) {
        const identity = getProjectIdentity(root);
        const port = validPort(env.COCOS_MCP_PORT || (mode === "project" ? getProjectPort(root) : fileConfig.port || 8765));
        for (let offset = 0; offset <= 20 && port + offset <= 65535; offset += 1) {
            for (const candidateHost of hosts) {
                const authority = candidateHost.includes(":") && !candidateHost.startsWith("[") ? `[${candidateHost}]` : candidateHost;
                endpoints.add(normalizeMcpEndpoint(`http://${authority}:${port + offset}/mcp/project/${identity}/`));
            }
        }
    }
    return [...endpoints];
}

function assertContext(context, projectRoot: string, expectedContext?: { project_id: string; expected_context: string }) {
    if (!record(context) || typeof context.project_path !== "string"
        || !(path.isAbsolute(context.project_path) || windowsPath(context.project_path))
        || !/^[a-f0-9]{24}$/.test(context.project_id || "")
        || typeof context.instance_id !== "string" || !context.instance_id
        || context.expected_context !== `${context.project_id}:${context.instance_id}`) {
        throw fail("MCP_PROTOCOL_ERROR", "Funplay 返回的项目身份字段缺失或格式不正确。");
    }
    if (!sameProjectPath(projectRoot, context.project_path) || getProjectIdentity(context.project_path) !== context.project_id) {
        throw fail("MCP_PROJECT_MISMATCH", "MCP 连接属于其他项目，或项目路径与身份哈希不一致。", [context.project_path]);
    }
    if (expectedContext && context.project_id !== expectedContext.project_id) {
        throw fail("MCP_PROJECT_MISMATCH", "MCP 响应的项目身份发生变化。");
    }
    if (expectedContext && context.expected_context !== expectedContext.expected_context) {
        throw fail("MCP_INSTANCE_CHANGED", "Creator / Funplay 实例已重启，请重新验证连接。");
    }
}

function remoteError(payload, status) {
    const error = payload && payload.error;
    const remoteCode = record(error) ? error.data?.code || error.message : error;
    const known = {
        PROJECT_CONTEXT_MISMATCH: "MCP_PROJECT_MISMATCH",
        EDITOR_INSTANCE_CHANGED: "MCP_INSTANCE_CHANGED",
        PROJECT_CONTEXT_REQUIRED: "MCP_CONTEXT_REQUIRED",
        PROJECT_CONTEXT_UNAVAILABLE: "MCP_EDITOR_NOT_READY",
    };
    const message = record(error) ? error.message : typeof error === "string" ? error : `HTTP ${status}`;
    return fail(known[remoteCode] || (status >= 400 ? "MCP_HTTP_ERROR" : "MCP_RPC_ERROR"), `MCP 请求失败: ${message}`);
}

function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        throw fail("MCP_PROTOCOL_ERROR", "MCP 返回的内容不是有效 JSON。");
    }
}

async function readResponse(response, requestId, maxBytes, notification) {
    const declaredLength = Number(response.headers.get("content-length"));
    if (declaredLength > maxBytes) throw fail("MCP_RESPONSE_TOO_LARGE", "MCP 响应超过大小限制。");
    const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const sse = type === "text/event-stream";
    if (!notification && type !== "application/json" && !type.endsWith("+json") && !sse) {
        throw fail("MCP_PROTOCOL_ERROR", `MCP 返回了不支持的 Content-Type: ${type || "(empty)"}`);
    }
    const reader = response.body?.getReader();
    if (!reader) {
        if (notification) return null;
        throw fail("MCP_PROTOCOL_ERROR", "MCP 响应没有正文。");
    }
    const decoder = new TextDecoder();
    let bytes = 0;
    let buffer = "";
    let ended = false;
    function frameValue(frame) {
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data) return undefined;
        const value = parseJson(data);
        if (record(value) && value.jsonrpc === "2.0" && typeof value.method === "string" && value.id === undefined) return undefined;
        if (!record(value) || value.jsonrpc !== "2.0" || value.id !== requestId) {
            throw fail("MCP_PROTOCOL_ERROR", "MCP SSE 响应的 JSON-RPC id 不匹配。");
        }
        return value;
    }
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) {
                ended = true;
                buffer += decoder.decode();
                break;
            }
            bytes += chunk.value.byteLength;
            if (bytes > maxBytes) throw fail("MCP_RESPONSE_TOO_LARGE", "MCP 响应超过大小限制。");
            buffer += decoder.decode(chunk.value, { stream: true });
            if (sse) {
                let match;
                while ((match = /\r?\n\r?\n/.exec(buffer))) {
                    const frame = buffer.slice(0, match.index);
                    buffer = buffer.slice(match.index + match[0].length);
                    const value = frameValue(frame);
                    if (value !== undefined) return value;
                }
            }
        }
        if (notification && !buffer.trim()) return null;
        if (sse) {
            const value = frameValue(buffer);
            if (value !== undefined) return value;
            throw fail("MCP_PROTOCOL_ERROR", "MCP SSE 流没有返回对应的 JSON-RPC 结果。");
        }
        if (notification) return buffer.trim() ? parseJson(buffer) : null;
        return parseJson(buffer);
    } finally {
        if (!ended) await reader.cancel().catch(() => {});
    }
}

async function rpcRequest({ url, method, params, sessionId = undefined,
    timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch, maxResponseBytes = MAX_RESPONSE_BYTES, notification = false }) {
    const endpoint = normalizeMcpEndpoint(url);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw fail("MCP_TIMEOUT", "等待 MCP 响应超时。");
    if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 8 * 1024 * 1024) {
        throw fail("MCP_INVALID_LIMIT", "MCP 响应大小限制必须在 1 字节至 8 MiB 之间。");
    }
    if (sessionId !== undefined && (typeof sessionId !== "string" || !/^[\x21-\x7e]{1,1024}$/.test(sessionId))) {
        throw fail("MCP_PROTOCOL_ERROR", "MCP session id 不合法。");
    }
    const controller = new AbortController();
    let reachable = false;
    let timedOut = false;
    let timer;
    const id = notification ? undefined : `cocos-cli-${process.pid}-${++nextRequestId}`;
    const body = JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params });
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw fail("MCP_REQUEST_TOO_LARGE", "MCP 请求超过大小限制。");
    const operation = async () => {
        const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": PROTOCOL_VERSION };
        if (sessionId) headers["Mcp-Session-Id"] = sessionId;
        const response = await fetchImpl(endpoint, { method: "POST", headers, body, signal: controller.signal, redirect: "manual" });
        reachable = true;
        if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel();
            throw fail("MCP_REDIRECT_REJECTED", "MCP 不跟随 HTTP 重定向。");
        }
        const receivedProtocol = response.headers.get("mcp-protocol-version");
        if (receivedProtocol !== null && receivedProtocol !== PROTOCOL_VERSION) {
            await response.body?.cancel();
            throw fail("MCP_PROTOCOL_ERROR", `MCP 响应协议版本不匹配，要求 ${PROTOCOL_VERSION}。`);
        }
        const payload = await readResponse(response, id, maxResponseBytes, notification && response.ok);
        if (!response.ok) throw remoteError(payload, response.status);
        if (!notification) {
            if (!record(payload) || payload.jsonrpc !== "2.0" || payload.id !== id
                || (Object.hasOwn(payload, "result") === Object.hasOwn(payload, "error"))) {
                throw fail("MCP_PROTOCOL_ERROR", "MCP 返回的 JSON-RPC 响应格式或 id 不正确。");
            }
            if (payload.error) throw remoteError(payload, response.status);
        }
        return { result: payload?.result, sessionId: response.headers.get("mcp-session-id") || undefined };
    };
    try {
        return await Promise.race([
            operation(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    controller.abort();
                    reject(fail("MCP_TIMEOUT", `等待 MCP 响应超时（${Math.ceil(timeoutMs)} ms）。`));
                }, timeoutMs);
            }),
        ]);
    } catch (error) {
        const wrapped = timedOut ? fail("MCP_TIMEOUT", "等待 MCP 响应超时。")
            : error instanceof CocosCliError ? error
                : fail(reachable ? "MCP_PROTOCOL_ERROR" : "MCP_OFFLINE", `MCP ${reachable ? "响应失败" : "无法连接"}: ${error.message}`);
        wrapped.reachable = reachable;
        throw wrapped;
    } finally {
        clearTimeout(timer);
    }
}

function unwrapToolResult(result, connection, name) {
    if (!record(result)) throw fail("MCP_PROTOCOL_ERROR", "MCP 工具响应不是对象。");
    assertContext(result._meta?.[CONTEXT_KEY], connection.projectRoot, connection.context);
    if (result.isError) {
        const message = result.content?.find((part) => part.type === "text")?.text || "工具返回错误";
        throw fail("MCP_TOOL_ERROR", `MCP 工具 ${name} 失败: ${String(message).slice(0, 2000)}`);
    }
    const envelope = result.structuredContent;
    if (!record(envelope) || typeof envelope.ok !== "boolean" || envelope.tool !== name || !Object.hasOwn(envelope, "data")) {
        throw fail("MCP_PROTOCOL_ERROR", `MCP 工具 ${name} 缺少有效的 Funplay structuredContent 结果。`);
    }
    assertContext(envelope.projectContext, connection.projectRoot, connection.context);
    if (!envelope.ok) throw fail("MCP_TOOL_ERROR", `MCP 工具 ${name} 返回失败。`, [envelope.summary || ""]);
    return envelope;
}

export async function callMcpTool({ connection, name, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch, maxResponseBytes = MAX_RESPONSE_BYTES }: { connection: McpConnection; name: string; args?: Record<string, unknown>; timeoutMs?: number; fetchImpl?: typeof fetch; maxResponseBytes?: number }) {
    if (!record(connection) || !connection.projectMatched || !record(connection.context)) {
        throw fail("MCP_UNVERIFIED_CONNECTION", "调用工具前必须验证 MCP 项目身份。");
    }
    assertContext(connection.context, connection.projectRoot);
    if (typeof name !== "string" || !name || !record(args)) throw fail("MCP_INVALID_ARGUMENT", "MCP 工具名和参数不合法。");
    const token = connection.context.expected_context;
    if (args.expected_context !== undefined && args.expected_context !== token) {
        throw fail("MCP_CONTEXT_MISMATCH", "工具参数的 expected_context 与已验证连接不一致。");
    }
    const response = await rpcRequest({ url: connection.endpoint, method: "tools/call",
        params: { name, arguments: { ...args, expected_context: token }, _meta: { expected_context: token } },
        sessionId: connection.sessionId, timeoutMs, fetchImpl, maxResponseBytes });
    if (response.sessionId && response.sessionId !== connection.sessionId) {
        throw fail("MCP_SESSION_CHANGED", "MCP 工具响应更改了 session id，请重新连接。");
    }
    return unwrapToolResult(response.result, connection, name);
}

function assertProjectData(data, connection, { identity = false } = {}) {
    if (!record(data) || typeof data.projectPath !== "string" || !sameProjectPath(data.projectPath, connection.projectRoot)) {
        throw fail("MCP_PROJECT_MISMATCH", "MCP 工具返回的项目路径与目标项目不一致。");
    }
    if (identity && data.projectIdentity !== connection.projectId) throw fail("MCP_PROJECT_MISMATCH", "MCP 工具返回的项目 ID 不一致。");
    if (data.projectContext) assertContext(data.projectContext, connection.projectRoot, connection.context);
    if (typeof data.cocosVersion !== "string" || !data.cocosVersion || data.cocosVersion === "unknown") {
        throw fail("MCP_VERSION_UNKNOWN", "MCP 未返回正在运行的 Creator 版本。");
    }
    const expected = connection.expectedVersion || connection.editorVersion;
    if (expected && data.cocosVersion !== expected) {
        const error = fail("MCP_VERSION_MISMATCH", `Creator 版本不匹配：期望 ${expected}，实际 ${data.cocosVersion}。`);
        error.editorVersion = data.cocosVersion;
        throw error;
    }
}

interface McpConnection {
    ready: boolean;
    reachable: boolean;
    projectMatched: boolean;
    projectRoot: string;
    endpoint: string;
    projectId?: string;
    sessionId?: string;
    protocolVersion?: string;
    context?: { project_id: string; project_path: string; instance_id: string; expected_context: string };
    projectInfo?: unknown;
    editorState?: unknown;
    editorVersion?: string;
    expectedVersion?: string;
    readiness?: { checks: string[]; sceneAvailable: boolean; sceneError: unknown; importsComplete: boolean | null; compilationComplete: boolean | null };
    error?: { code: string; message: string; details: string[] };
}

/** Read-only readiness probe; does not claim that all imports/compilation have finished. */
export async function probeMcp({ url, projectRoot, expectedVersion, timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch, maxResponseBytes = MAX_RESPONSE_BYTES }: { url: string; projectRoot: string; expectedVersion?: string; timeoutMs?: number; fetchImpl?: typeof fetch; maxResponseBytes?: number }): Promise<McpConnection> {
    const connection: McpConnection = { ready: false, reachable: false, projectMatched: false, projectRoot, endpoint: url };
    const deadline = Date.now() + timeoutMs;
    const remaining = () => Math.max(0, deadline - Date.now());
    try {
        connection.endpoint = normalizeMcpEndpoint(url);
        normalizeProjectPath(projectRoot);
        const response = await rpcRequest({ url: connection.endpoint, method: "initialize", params: {
            protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "cocos-cli", version: packageManifest.version },
        }, timeoutMs: remaining(), fetchImpl, maxResponseBytes });
        connection.reachable = true;
        const initialized = response.result;
        if (!record(initialized) || initialized.funplay?.server !== "funplay-cocos-mcp" || initialized.funplay?.routingVersion !== 1) {
            throw fail("MCP_PROTOCOL_ERROR", "端点没有返回受支持的 Funplay MCP initialize 响应。");
        }
        if (initialized.protocolVersion !== PROTOCOL_VERSION) {
            throw fail("MCP_PROTOCOL_ERROR", `Funplay MCP 初始化协议版本不匹配，要求 ${PROTOCOL_VERSION}。`);
        }
        const context = initialized.funplay.context;
        assertContext(context, projectRoot);
        if (initialized.funplay.projectIdentity !== context.project_id) throw fail("MCP_PROJECT_MISMATCH", "initialize 返回了冲突的项目 ID。");
        const scope = /^\/mcp\/project\/([^/]+)\/?$/.exec(new URL(connection.endpoint).pathname);
        if (scope && decodeURIComponent(scope[1]) !== context.project_id) throw fail("MCP_PROJECT_MISMATCH", "MCP URL 的项目 ID 与响应不一致。");
        Object.assign(connection, { projectMatched: true, projectId: context.project_id, context,
            sessionId: response.sessionId, protocolVersion: initialized.protocolVersion,
            serverInfo: initialized.serverInfo, expectedVersion: expectedVersion || undefined });
        await rpcRequest({ url: connection.endpoint, method: "notifications/initialized", params: {},
            sessionId: connection.sessionId, notification: true,
            timeoutMs: remaining(), fetchImpl, maxResponseBytes });
        const info = await callMcpTool({ connection, name: "get_project_info", timeoutMs: remaining(), fetchImpl, maxResponseBytes });
        assertProjectData(info.data, connection, { identity: true });
        assertContext(info.data.projectContext, projectRoot, context);
        connection.projectInfo = info.data;
        connection.editorVersion = info.data.cocosVersion;
        const state = await callMcpTool({ connection, name: "get_editor_state", timeoutMs: remaining(), fetchImpl, maxResponseBytes });
        assertProjectData(state.data, connection);
        if (!record(state.data.status) || state.data.status.running !== true) throw fail("MCP_EDITOR_NOT_READY", "Funplay 未报告编辑器服务正在运行。");
        assertProjectData(state.data.status, connection, { identity: true });
        assertContext(state.data.status.projectContext, projectRoot, context);
        connection.editorState = state.data;
        connection.readiness = {
            checks: ["initialize", "get_project_info", "get_editor_state"],
            sceneAvailable: Boolean(state.data.scene && !state.data.scene.error),
            sceneError: state.data.scene?.error || null,
            importsComplete: null,
            compilationComplete: null,
        };
        connection.ready = true;
    } catch (error) {
        connection.reachable ||= error.reachable === true;
        if (error.editorVersion) connection.editorVersion = error.editorVersion;
        if (error.code === "MCP_PROJECT_MISMATCH") connection.projectMatched = false;
        connection.error = { code: error.code || "MCP_PROTOCOL_ERROR", message: error.message, details: error.details || [] };
    }
    return connection;
}
