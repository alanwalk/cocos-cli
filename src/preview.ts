import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { closeSync, openSync, writeSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { CocosCliError } from "./errors.js";
import { fileIsFile } from "./files.js";
import { prepareProjectStateDirectory } from "./state.js";

export const PREVIEW_BROWSERS = ["edge", "chrome"] as const;
type BrowserName = typeof PREVIEW_BROWSERS[number];
type Browser = { name: BrowserName; path: string };
type StopReason = "tab-closed" | "left-preview" | "interrupted";
type DebugTab = { id: string; type: string; url: string; webSocketDebuggerUrl?: string };
type LogEntry = { kind: string; text: string; source?: string };

const BROWSERS = {
    edge: {
        windows: ["Microsoft", "Edge", "Application", "msedge.exe"],
        mac: "Microsoft Edge",
        linux: ["microsoft-edge", "microsoft-edge-stable"],
    },
    chrome: {
        windows: ["Google", "Chrome", "Application", "chrome.exe"],
        mac: "Google Chrome",
        linux: ["google-chrome", "google-chrome-stable"],
    },
};
const MAX_LOG_BYTES = 8 * 1024 * 1024;

export function resolvePreviewBrowser(browser: BrowserName | undefined, { platform, env }: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv }): Browser {
    const preferred: BrowserName[] = platform === "win32" ? ["edge", "chrome"] : ["chrome", "edge"];
    const pathEntries = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
    for (const name of browser ? [browser] : preferred) {
        const entry = BROWSERS[name];
        let candidates: string[] = [];
        if (platform === "win32") {
            const installRoots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(Boolean);
            candidates = installRoots.map(root => join(root, ...entry.windows));
            candidates.push(...pathEntries.map(root => join(root, entry.windows.at(-1))));
        } else if (platform === "darwin") {
            candidates.push(join("/Applications", entry.mac + ".app", "Contents", "MacOS", entry.mac));
        } else if (platform === "linux") {
            for (const executable of entry.linux) {
                candidates.push(...pathEntries.map(root => join(root, executable)));
            }
        }
        const path = candidates.find(fileIsFile);
        if (path) return { name, path: resolve(path) };
    }
    throw new CocosCliError(browser ? "找不到已安装的 " + browser : "找不到已安装的 Chrome 或 Edge", { code: "PREVIEW_BROWSER_NOT_FOUND" });
}

export function getBrowserPreviewUrl(data: { mode?: string; localUrl?: string; url?: string } | null) {
    if (data?.mode !== "browser") {
        throw new CocosCliError("请在 Creator 预览工具栏选择浏览器预览模式", { code: "PREVIEW_MODE_REQUIRED" });
    }
    const address = data.localUrl || data.url || "";
    const url = URL.canParse(address) ? new URL(address) : null;
    if (!url || !["http:", "https:"].includes(url.protocol) ||
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) {
        throw new CocosCliError("Funplay 未返回可用的本机浏览器预览地址", { code: "PREVIEW_URL_UNAVAILABLE" });
    }
    return url;
}

function sanitizeLog(value: string) {
    return value
        .replace(/\bBearer\s+[A-Za-z0-9_.~+/=-]+/gi, "Bearer [redacted]")
        .replace(/([?&](?:access_token|refresh_token|id_token|token|ticket|session|password|secret|code|key)=)[^&#\s]*/gi, "$1[redacted]")
        .replace(/(["']?(?:accessToken|refreshToken|access_token|refresh_token|id_token|authorization|password|secret|sessionToken|token|apiKey)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, "$1[redacted]")
        .slice(0, 2200);
}

async function findInitialTab(profile: string, signal: AbortSignal) {
    while (!signal.aborted) {
        const activePort = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(error => {
            if (error.code !== "ENOENT") throw error;
            return "";
        });
        const port = activePort.split(/\r?\n/, 1)[0];
        if (/^\d{1,5}$/.test(port)) {
            const endpoint = new URL("http://127.0.0.1:" + port);
            const response = await fetch(new URL("/json/list", endpoint), { signal });
            if (!response.ok) throw new Error("浏览器未能列出标签页（HTTP " + response.status + "）");
            const targets: DebugTab[] = await response.json();
            const pages = targets.filter(target => target.type === "page");
            const tab = pages[0];
            if (pages.length === 1 && tab.url === "about:blank" && tab.webSocketDebuggerUrl) {
                const socketUrl = new URL(tab.webSocketDebuggerUrl);
                if (socketUrl.protocol !== "ws:" || socketUrl.host !== endpoint.host ||
                    socketUrl.pathname !== "/devtools/page/" + tab.id) {
                    throw new Error("浏览器返回的标签页调试地址与本机端口不匹配");
                }
                return socketUrl;
            }
        }
        await delay(100, undefined, { signal });
    }
    signal.throwIfAborted();
}

interface DevToolsResponse {
    id: number;
    error?: { message: string };
    result?: { errorText?: string };
}

type DevToolsEvent =
    | { method: "Page.frameNavigated"; params: { frame: { url: string; parentId?: string } } }
    | { method: "Runtime.consoleAPICalled"; params: {
        type: string;
        args: { value?: unknown; description?: string; type: string }[];
        stackTrace?: { callFrames: { url: string; lineNumber: number }[] };
    } }
    | { method: "Runtime.exceptionThrown"; params: {
        exceptionDetails: { exception?: { description?: string }; text: string; url?: string };
    } }
    | { method: "Log.entryAdded"; params: { entry: { source: string; level: string; text: string; url?: string } } };

async function watchTab(socket: WebSocket, url: URL, startup: AbortSignal, interrupt: AbortSignal, writeLog: (entry: LogEntry) => void, onStart: () => void) {
    await once(socket, "open", { signal: startup });
    let finish: (reason: StopReason | Error) => void;
    const finished = new Promise<StopReason | Error>(resolve => { finish = resolve; });
    const interrupted = () => finish("interrupted");
    const closed = () => finish("tab-closed");
    interrupt.addEventListener("abort", interrupted, { once: true });
    socket.addEventListener("close", closed, { once: true });
    const pending = new Map<number, (message: DevToolsResponse) => void>();
    let id = 0;
    let active = false;

    function receive(event: MessageEvent<string>) {
        try {
            const message: DevToolsResponse | DevToolsEvent = JSON.parse(event.data);
            if ("id" in message) {
                pending.get(message.id)?.(message);
                return;
            }
            if (!active) return;
            const { method, params } = message;
            if (method === "Page.frameNavigated" && !params.frame.parentId && new URL(params.frame.url).origin !== url.origin) {
                active = false;
                finish("left-preview");
            } else if (method === "Runtime.consoleAPICalled") {
                const text = params.args.map(argument => argument.value ?? argument.description ?? argument.type).join(" ");
                const frame = params.stackTrace?.callFrames?.[0];
                const source = frame?.url && (frame.url + ":" + (frame.lineNumber + 1));
                writeLog({ kind: "console." + params.type, text, source });
            } else if (method === "Runtime.exceptionThrown") {
                const details = params.exceptionDetails;
                writeLog({ kind: "exception", text: details.exception?.description ?? details.text, source: details.url });
            } else if (method === "Log.entryAdded" && params.entry.source === "network" && params.entry.level === "error") {
                writeLog({ kind: "network.error", text: params.entry.text, source: params.entry.url });
            }
        } catch (error) {
            active = false;
            finish(error);
        }
    }

    async function send(method: string, params: Record<string, unknown> = {}) {
        startup.throwIfAborted();
        const commandId = ++id;
        let abort: () => void;
        const response = new Promise<DevToolsResponse>((resolve, reject) => {
            pending.set(commandId, resolve);
            abort = () => reject(startup.reason);
            startup.addEventListener("abort", abort, { once: true });
        });
        try {
            socket.send(JSON.stringify({ id: commandId, method, params }));
            const outcome = await Promise.race([response, finished]);
            if (typeof outcome === "string") throw new Error("浏览器在预览打开前结束：" + outcome);
            if (outcome instanceof Error) throw outcome;
            if (outcome.error) throw new Error(method + "：" + outcome.error.message);
            return outcome.result;
        } finally {
            pending.delete(commandId);
            startup.removeEventListener("abort", abort);
        }
    }

    socket.addEventListener("message", receive);
    try {
        await send("Runtime.enable");
        await send("Log.enable");
        await send("Page.enable");
        await send("Page.bringToFront");
        active = true;
        const navigation = await send("Page.navigate", { url: url.href });
        if (navigation?.errorText) throw new Error(navigation.errorText);
        onStart();
        const stopped = await finished;
        if (stopped instanceof Error) throw stopped;
        return stopped;
    } finally {
        interrupt.removeEventListener("abort", interrupted);
        socket.removeEventListener("message", receive);
        socket.removeEventListener("close", closed);
    }
}

interface CaptureOptions {
    projectRoot: string;
    url: URL;
    browser: Browser;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
    onStart: (path: string) => void;
    onCleanupError: (path: string) => void;
}

export async function capturePreviewLogs({ projectRoot, url, browser, env, timeoutMs = 15000, onStart, onCleanupError }: CaptureOptions) {
    if (typeof WebSocket !== "function") {
        throw new CocosCliError("预览日志采集需要 Node.js 22 或支持内置 WebSocket 的 Node.js", { code: "PREVIEW_WEBSOCKET_UNAVAILABLE" });
    }
    const directory = await prepareProjectStateDirectory(projectRoot);
    const logPath = join(directory, "preview-" + randomUUID() + ".jsonl");
    const log = openSync(logPath, "wx", 0o600);
    const interrupt = new AbortController();
    const interrupted = () => interrupt.abort();
    process.once("SIGINT", interrupted);
    process.once("SIGTERM", interrupted);
    let child: ReturnType<typeof spawn>;
    let exited: Promise<void>;
    let socket: WebSocket;
    let profile: string;
    let temp: string;
    let bytes = 0;
    let entries = 0;
    let dropped = 0;
    let reason: StopReason;
    try {
        temp = await realpath(tmpdir());
        profile = await mkdtemp(join(temp, "cocos-preview-"));
        const startup = AbortSignal.any([interrupt.signal, AbortSignal.timeout(timeoutMs)]);
        const browserExit = new AbortController();
        child = spawn(browser.path, [
            "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
            "--disable-background-mode", "--new-window", "--user-data-dir=" + profile, "about:blank",
        ], { env, windowsHide: false, stdio: "ignore" });
        exited = new Promise(resolve => {
            child.once("exit", () => {
                browserExit.abort(new Error("浏览器已经退出"));
                resolve();
            });
            child.once("error", error => {
                browserExit.abort(error);
                resolve();
            });
        });
        const connect = AbortSignal.any([startup, browserExit.signal]);
        const socketUrl = await findInitialTab(profile, connect);
        socket = new WebSocket(socketUrl);
        const writeLog = (entry: LogEntry) => {
            const line = JSON.stringify({
                at: new Date().toISOString(), kind: entry.kind, text: sanitizeLog(entry.text),
                source: entry.source && sanitizeLog(entry.source),
            }) + "\n";
            const length = Buffer.byteLength(line);
            if (bytes + length > MAX_LOG_BYTES) {
                dropped++;
                return;
            }
            writeSync(log, line, undefined, "utf8");
            bytes += length;
            entries++;
        };
        reason = await watchTab(socket, url, connect, interrupt.signal, writeLog, () => onStart(logPath));
    } catch (error) {
        if (!interrupt.signal.aborted) {
            throw new CocosCliError("预览日志采集失败", {
                code: "PREVIEW_CAPTURE_FAILED", cause: error, details: [String(error.message ?? error), logPath],
            });
        }
        reason = "interrupted";
    } finally {
        process.removeListener("SIGINT", interrupted);
        process.removeListener("SIGTERM", interrupted);
        closeSync(log);
        if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ id: 0, method: "Browser.close" }));
            await Promise.race([exited, delay(1500, undefined, { ref: false })]);
        }
        if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
        if (child?.pid && child.exitCode === null && !child.signalCode) {
            child.kill();
            await Promise.race([exited, delay(1500, undefined, { ref: false })]);
        }
        if (profile) {
            try {
                const actual = await realpath(profile);
                if (actual !== profile || dirname(actual) !== temp) throw new Error("临时浏览器目录已变化");
                await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
            } catch {
                onCleanupError(profile);
            }
        }
    }
    return { logPath, entries, dropped, reason };
}
