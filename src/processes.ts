import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROCESS_QUERY_TIMEOUT_MS = 5000;
const WINDOWS_PROCESS_QUERY = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter \"Name = 'CocosCreator.exe'\" | Select-Object ProcessId, ExecutablePath, CommandLine)",
].join("; ");

/** Normalize project identity; only the host platform resolves filesystem symlinks. */
export function normalizeProjectPath(value: string, options: { platform?: NodeJS.Platform; cwd?: string } = {}) {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
        throw new TypeError("项目路径必须是非空字符串");
    }
    const platform = options.platform ?? process.platform;
    const pathApi = platform === "win32" ? win32 : posix;
    let normalized = pathApi.resolve(options.cwd ?? process.cwd(), value);
    if (platform === process.platform) {
        try {
            normalized = realpathSync.native(normalized);
        } catch {
            // A process may still reference a project that has been moved/deleted.
        }
    }
    normalized = pathApi.normalize(normalized);
    const root = pathApi.parse(normalized).root;
    while (normalized.length > root.length && /[\\/]$/.test(normalized)) {
        normalized = normalized.slice(0, -1);
    }
    return platform === "win32" ? normalized.toLowerCase() : normalized;
}

// Windows command lines use backslashes-before-quotes rules, not shell quoting.
export function splitWindowsCommandLine(commandLine) {
    const tokens = [];
    let index = 0;
    while (index < commandLine.length) {
        while (/\s/.test(commandLine[index] ?? "") && index < commandLine.length) index += 1;
        if (index >= commandLine.length) break;
        let value = "";
        let quoted = false;
        while (index < commandLine.length) {
            if (!quoted && /\s/.test(commandLine[index])) break;
            let backslashes = 0;
            while (commandLine[index] === "\\") {
                backslashes += 1;
                index += 1;
            }
            if (commandLine[index] === '"') {
                value += "\\".repeat(Math.floor(backslashes / 2));
                if (backslashes % 2) {
                    value += '"';
                } else if (quoted && commandLine[index + 1] === '"') {
                    value += '"';
                    index += 1;
                } else {
                    quoted = !quoted;
                }
                index += 1;
                continue;
            }
            value += "\\".repeat(backslashes);
            if (index >= commandLine.length) break;
            if (!quoted && /\s/.test(commandLine[index])) break;
            value += commandLine[index];
            index += 1;
        }
        tokens.push(value);
    }
    return tokens;
}

function splitPosixCommandLine(commandLine) {
    const tokens = [];
    let value = "";
    let quote = null;
    let quoted = false;
    let started = false;
    for (let index = 0; index < commandLine.length; index += 1) {
        const character = commandLine[index];
        if (!quote && /\s/.test(character)) {
            if (started) tokens.push({ value, quoted });
            value = "";
            started = false;
            quoted = false;
            continue;
        }
        started = true;
        if (character === "\\" && quote !== "'") {
            const next = commandLine[index + 1];
            if (next !== undefined && (!quote || ['"', "\\", "$", "`", "\n"].includes(next))) {
                value += next;
                index += 1;
                quoted = true;
                continue;
            }
        }
        if (character === "'" || character === '"') {
            if (quote === character) {
                quote = null;
                quoted = true;
                continue;
            }
            if (!quote) {
                quote = character;
                quoted = true;
                continue;
            }
        }
        value += character;
    }
    if (quote) return []; // Do not guess identities from a truncated/ambiguous quote.
    if (started) tokens.push({ value, quoted });
    return tokens;
}

function commandTokens(commandLine, platform) {
    return platform === "win32"
        ? splitWindowsCommandLine(commandLine).map((value) => ({ value, quoted: true }))
        : splitPosixCommandLine(commandLine);
}

/** ps does not preserve argv quoting; an unquoted project extends to the next option. */
export function parseProjectFromCommandLine(commandLine: string, options: { platform?: NodeJS.Platform } = {}) {
    if (typeof commandLine !== "string") return undefined;
    const platform = options.platform ?? process.platform;
    const pathApi = platform === "win32" ? win32 : posix;
    const tokens = commandTokens(commandLine, platform);
    const projects = [];
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        let candidate;
        let quoted;
        if (token.value === "--project") {
            const next = tokens[++index];
            if (!next) return undefined;
            candidate = next.value;
            quoted = next.quoted;
        } else if (token.value.startsWith("--project=")) {
            candidate = token.value.slice("--project=".length);
            quoted = token.quoted;
        } else {
            continue;
        }
        if (!quoted && platform !== "win32") {
            while (tokens[index + 1] && !tokens[index + 1].value.startsWith("-")) {
                candidate += ` ${tokens[++index].value}`;
            }
        }
        // A process's cwd is unknown; resolving relative paths against ours is unsafe.
        if (!candidate || !pathApi.isAbsolute(candidate) || candidate.includes("\0")) return undefined;
        projects.push(normalizeProjectPath(candidate, { platform }));
    }
    return projects.length === 1 ? projects[0] : undefined;
}

function isCreatorMainProcess(executable, commandLine, platform) {
    const pathApi = platform === "win32" ? win32 : posix;
    const expected = platform === "win32" ? "cocoscreator.exe" : "CocosCreator";
    const basename = pathApi.basename(executable);
    if ((platform === "win32" ? basename.toLowerCase() : basename) !== expected) return false;
    return !commandTokens(commandLine, platform).some(({ value }) => value === "--type" || value.startsWith("--type="));
}

function processRecord(pid, executable, commandLine, platform) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || !isCreatorMainProcess(executable, commandLine, platform)) return null;
    const projectRoot = parseProjectFromCommandLine(commandLine, { platform });
    return { pid, executable, commandLine, ...(projectRoot ? { projectRoot } : {}) };
}

/** timeoutMs is a total query budget. execFileImpl is async (command, args, options) => { stdout, stderr }. */
interface CreatorProcess { pid: number; executable: string; commandLine: string; projectRoot?: string }
interface ProcessDiscovery { processes: CreatorProcess[]; supported: boolean; error?: string }

export async function listCreatorProcesses(options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; timeoutMs?: number; execFileImpl?: typeof execFileAsync } = {}): Promise<ProcessDiscovery> {
    const platform = options.platform ?? process.platform;
    if (!["win32", "darwin", "linux"].includes(platform)) {
        return { processes: [], supported: false, error: `当前平台不支持 Creator 进程发现: ${platform}` };
    }
    const run = options.execFileImpl ?? execFileAsync;
    const timeoutMs = options.timeoutMs ?? PROCESS_QUERY_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const executionOptions = {
        env: options.env ?? process.env,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        shell: false,
    };
    const remainingBudget = () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`Creator 进程查询超时（总预算 ${timeoutMs}ms 已耗尽）`);
        return Math.max(1, Math.floor(remaining));
    };
    const runQuery = async (command, args) => {
        let result;
        try {
            result = await run(command, args, { ...executionOptions, timeout: remainingBudget() });
        } catch (error) {
            remainingBudget();
            throw error;
        }
        // Custom executors may ignore timeout. Late output cannot prove absence.
        remainingBudget();
        return result;
    };
    const complete = (processes) => {
        remainingBudget();
        return { processes, supported: true };
    };
    try {
        if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("进程查询 timeoutMs 必须是非负有限数字");
        if (platform === "win32") {
            const { stdout } = await runQuery("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_QUERY]);
            const output = String(stdout ?? "").replace(/^\uFEFF/, "").trim();
            const parsed = output ? JSON.parse(output) : [];
            const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
            const processes = rows.map((row) => processRecord(
                Number(row.ProcessId),
                typeof row.ExecutablePath === "string" ? row.ExecutablePath : "CocosCreator.exe",
                typeof row.CommandLine === "string" ? row.CommandLine : "",
                platform,
            )).filter(Boolean);
            return complete(processes);
        }

        // Keep executable identity separate from args: paths can contain spaces.
        const { stdout: identities } = await runQuery("ps", ["-axo", "pid=,comm="]);
        const executables = new Map();
        for (const line of String(identities ?? "").split(/\r?\n/)) {
            const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
            if (match && posix.basename(match[2]) === "CocosCreator") {
                const pid = Number(match[1]);
                if (Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647) executables.set(pid, match[2]);
            }
        }
        if (executables.size === 0) return complete([]);
        const { stdout: argumentsOutput } = await runQuery("ps", ["-ww", "-p", [...executables.keys()].join(","), "-o", "pid=,args="]);
        const processes = [];
        const seen = new Set();
        for (const line of String(argumentsOutput ?? "").split(/\r?\n/)) {
            const match = /^\s*(\d+)\s+(.*)$/.exec(line);
            if (!match) continue;
            const pid = Number(match[1]);
            if (!executables.has(pid)) continue;
            seen.add(pid);
            const record = processRecord(pid, executables.get(pid), match[2], platform);
            if (record) processes.push(record);
        }
        // Preserve uninspectable Creator PIDs so callers cannot mistake them for absence.
        for (const [pid, executable] of executables) {
            if (!seen.has(pid)) processes.push({ pid, executable, commandLine: "" });
        }
        return complete(processes);
    } catch (error) {
        return { processes: [], supported: true, error: `无法查询 Creator 进程: ${error.message}` };
    }
}

/** Signal zero is only a liveness probe; this module never terminates a process. */
export function isProcessAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // An inaccessible process is still alive; never reclaim its lock.
        return error.code !== "ESRCH";
    }
}
