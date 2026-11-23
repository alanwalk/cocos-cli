import { constants, realpathSync, statSync } from "node:fs";
import { lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

import { CocosCliError } from "./errors.js";
import { isProcessAlive, normalizeProjectPath } from "./processes.js";

const MAX_LOCK_WAIT_MS = 3600000;
const ORPHAN_LOCK_AGE_MS = 10000;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function stateError(message: string, code: string, path: string, cause?: unknown) {
    return new CocosCliError(message, { code, details: path ? [path] : [], cause });
}

export function getProjectStatePaths(projectRoot) {
    let root;
    try {
        root = realpathSync(projectRoot);
        if (!statSync(root).isDirectory()) throw new Error("项目路径不是目录");
    } catch (error) {
        throw stateError("无法读取项目目录", "PROJECT_NOT_FOUND", String(projectRoot), error);
    }
    root = normalizeProjectPath(root);
    const directory = join(root, "temp", "cocos-cli");
    return {
        projectRoot: root,
        directory,
        stateFile: join(directory, "state.json"),
        lockDirectory: join(directory, "project.lock"),
        logFile: join(directory, "editor-startup.log"),
    };
}

async function inspectDirectory(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
        throw stateError("CLI 状态目录不能是符号链接或普通文件", "STATE_PATH_UNSAFE", path);
    }
    return info;
}

async function prepareDirectory(paths, create) {
    for (const path of [join(paths.projectRoot, "temp"), paths.directory]) {
        if (create) {
            try {
                await mkdir(path, { mode: 0o700 });
            } catch (error) {
                if (error.code !== "EEXIST") throw error;
            }
        }
        try {
            await inspectDirectory(path);
        } catch (error) {
            if (!create && error.code === "ENOENT") return false;
            throw error;
        }
    }
    return true;
}

export async function prepareProjectStateDirectory(projectRoot: string) {
    const paths = getProjectStatePaths(projectRoot);
    await prepareDirectory(paths, true);
    return paths.directory;
}

async function readJson(path) {
    let handle;
    try {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isFile() || info.size > 65536) {
            throw stateError("CLI 状态文件不安全或过大", "STATE_PATH_UNSAFE", path);
        }
        handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        if (!(await handle.stat()).isFile()) throw stateError("CLI 状态文件不是普通文件", "STATE_PATH_UNSAFE", path);
        const parsed = JSON.parse(await handle.readFile("utf8"));
        if (parsed === null) throw stateError("CLI 状态文件内容不能为 null", "INVALID_STATE", path);
        return parsed;
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    } finally {
        await handle?.close();
    }
}

function isWindowsSharingError(error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(code);
}

async function atomicWriteJson(path, value) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    let handle;
    try {
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        // Windows can briefly deny replacement while an independent reader has the file open.
        for (let attempt = 0; ; attempt += 1) {
            try {
                await rename(temporary, path);
                break;
            } catch (error) {
                if (attempt >= 5 || !isWindowsSharingError(error)) throw error;
                await wait(20 * (attempt + 1));
            }
        }
    } finally {
        await handle?.close();
        await unlink(temporary).catch((error) => {
            if (error.code !== "ENOENT") throw error;
        });
    }
}

function validateState(raw, paths) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.version !== 1) {
        throw stateError("不支持的 CLI 状态格式", "INVALID_STATE", paths.stateFile);
    }
    if (typeof raw.projectRoot !== "string" || !isAbsolute(raw.projectRoot)
        || normalizeProjectPath(raw.projectRoot) !== paths.projectRoot) {
        throw stateError("CLI 状态文件属于其他项目", "STATE_PROJECT_MISMATCH", paths.stateFile);
    }
    if (raw.pid !== null && (!Number.isSafeInteger(raw.pid) || raw.pid <= 0 || raw.pid > 2147483647)) {
        throw stateError("CLI 状态中的 PID 无效", "INVALID_STATE", paths.stateFile);
    }
    if (raw.endpoint !== null) {
        let url;
        try {
            url = new URL(raw.endpoint);
        } catch {
            throw stateError("CLI 状态中的 endpoint 无效", "INVALID_STATE", paths.stateFile);
        }
        if (typeof raw.endpoint !== "string" || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
            throw stateError("CLI 状态中的 endpoint 必须是 HTTP 地址", "INVALID_STATE", paths.stateFile);
        }
    }
    if (raw.startedAt !== null && (typeof raw.startedAt !== "string" || !Number.isFinite(Date.parse(raw.startedAt)))) {
        throw stateError("CLI 状态中的启动时间无效", "INVALID_STATE", paths.stateFile);
    }
    if (raw.editorPath !== null && (typeof raw.editorPath !== "string" || !isAbsolute(raw.editorPath) || raw.editorPath.includes("\0"))) {
        throw stateError("CLI 状态中的编辑器路径无效", "INVALID_STATE", paths.stateFile);
    }
    return {
        version: 1,
        projectRoot: paths.projectRoot,
        endpoint: raw.endpoint,
        pid: raw.pid,
        startedAt: raw.startedAt,
        editorPath: raw.editorPath,
    };
}

export async function readProjectState(projectRoot) {
    const paths = getProjectStatePaths(projectRoot);
    if (!await prepareDirectory(paths, false)) return null;
    try {
        const raw = await readJson(paths.stateFile);
        return raw === null ? null : validateState(raw, paths);
    } catch (error) {
        if (error instanceof CocosCliError) throw error;
        throw stateError("无法读取 CLI 状态文件", "INVALID_STATE", paths.stateFile, error);
    }
}

export async function writeProjectState(projectRoot, state) {
    const paths = getProjectStatePaths(projectRoot);
    const record = validateState({
        version: 1,
        projectRoot: paths.projectRoot,
        endpoint: null,
        pid: null,
        startedAt: null,
        editorPath: null,
        ...state,
    }, paths);
    await prepareDirectory(paths, true);
    try {
        const existing = await lstat(paths.stateFile).catch((error) => {
            if (error.code === "ENOENT") return null;
            throw error;
        });
        if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
            throw stateError("CLI 状态文件不能是符号链接或目录", "STATE_PATH_UNSAFE", paths.stateFile);
        }
        await atomicWriteJson(paths.stateFile, record);
        return record;
    } catch (error) {
        if (error instanceof CocosCliError) throw error;
        throw stateError("无法写入 CLI 状态文件", "STATE_WRITE_FAILED", paths.stateFile, error);
    }
}

function sameDirectory(left, right) {
    return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

async function readLockOwner(paths, directory = paths.lockDirectory) {
    const raw = await readJson(join(directory, "owner.json"));
    if (raw === null) return null;
    if (raw.version !== 1 || typeof raw.token !== "string" || !/^[0-9a-f-]{36}$/.test(raw.token)
        || !Number.isSafeInteger(raw.pid) || raw.pid <= 0 || raw.pid > 2147483647
        || typeof raw.projectRoot !== "string" || !isAbsolute(raw.projectRoot)
        || normalizeProjectPath(raw.projectRoot) !== paths.projectRoot) {
        throw stateError("项目锁身份无效，拒绝清除", "PROJECT_LOCK_INVALID", paths.lockDirectory);
    }
    return raw;
}

async function removeKnownLockFiles(directory) {
    // Never recursively delete a directory from a PID/state file.
    await unlink(join(directory, "owner.json")).catch((error) => {
        if (error.code !== "ENOENT") throw error;
    });
    await rmdir(join(directory, "reclaim")).catch((error) => {
        if (error.code !== "ENOENT") throw error;
    });
    await rmdir(directory);
}

async function recoverDeadOwner(paths, options) {
    let info;
    let owner;
    try {
        info = await inspectDirectory(paths.lockDirectory);
        owner = await readLockOwner(paths);
    } catch (error) {
        if (error.code === "ENOENT") return true;
        if (isWindowsSharingError(error)) return false;
        throw error;
    }
    if (owner ? options.isProcessAliveImpl(owner.pid) : Date.now() - info.mtimeMs < options.orphanAfterMs) return false;

    // Only one reclaimer may detach this lock. Keep its marker inside the lock,
    // so renaming the lock also atomically removes the marker from the live path.
    const claim = join(paths.lockDirectory, "reclaim");
    try {
        await mkdir(claim, { mode: 0o700 });
    } catch (error) {
        if (["EEXIST", "ENOENT"].includes(error.code) || isWindowsSharingError(error)) return false;
        throw error;
    }
    const claimInfo = await lstat(claim).catch(() => null);
    let detached = false;
    try {
        const currentInfo = await inspectDirectory(paths.lockDirectory);
        const currentOwner = await readLockOwner(paths);
        if (!sameDirectory(info, currentInfo) || currentOwner?.token !== owner?.token) return false;
        if (currentOwner && options.isProcessAliveImpl(currentOwner.pid)) return false;
        const abandoned = join(paths.directory, `.stale-lock-${randomUUID()}`);
        await rename(paths.lockDirectory, abandoned);
        detached = true;
        // Cleanup failure cannot remove the new live lock; retain unexpected files.
        await removeKnownLockFiles(abandoned).catch(() => {});
        return true;
    } catch (error) {
        if (error.code === "ENOENT" || isWindowsSharingError(error)) return false;
        throw error;
    } finally {
        if (!detached) {
            // A new lock may now occupy the original path. Remove only the
            // exact empty claim directory that this recovery attempt created.
            const current = await lstat(claim).catch(() => null);
            if (claimInfo && current && sameDirectory(claimInfo, current)) await rmdir(claim).catch(() => {});
        }
    }
}

async function releaseLock(paths, token) {
    await inspectDirectory(paths.lockDirectory);
    const owner = await readLockOwner(paths);
    if (owner?.token !== token || owner.pid !== process.pid) {
        throw stateError("项目锁已被替换，拒绝清除其他持有者的锁", "PROJECT_LOCK_OWNERSHIP_LOST", paths.lockDirectory);
    }
    await unlink(join(paths.lockDirectory, "owner.json"));
    await rmdir(paths.lockDirectory);
}

/** Serialize a project's lifecycle commands; wait is bounded to at most one hour. */
export async function withProjectLock<T>(projectRoot: string, action: () => Promise<T> | T, options: { timeoutMs?: number; pollIntervalMs?: number; orphanAfterMs?: number; isProcessAliveImpl?: typeof isProcessAlive } = {}) {
    if (typeof action !== "function") throw new TypeError("项目锁需要一个回调函数");
    const requestedTimeout = options.timeoutMs ?? 3000;
    const pollIntervalMs = options.pollIntervalMs ?? 50;
    const orphanAfterMs = options.orphanAfterMs ?? ORPHAN_LOCK_AGE_MS;
    if (!Number.isFinite(requestedTimeout) || requestedTimeout < 0
        || !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0 || pollIntervalMs > 1000
        || !Number.isFinite(orphanAfterMs) || orphanAfterMs < 0) {
        throw new TypeError("项目锁等待参数无效");
    }
    const paths = getProjectStatePaths(projectRoot);
    await prepareDirectory(paths, true);
    const token = randomUUID();
    const owner = { version: 1, token, pid: process.pid, projectRoot: paths.projectRoot, createdAt: new Date().toISOString() };
    const deadline = Date.now() + Math.min(requestedTimeout, MAX_LOCK_WAIT_MS);
    while (true) {
        try {
            await mkdir(paths.lockDirectory, { mode: 0o700 });
        } catch (error) {
            if (error.code === "EEXIST") {
                if (await recoverDeadOwner(paths, { isProcessAliveImpl: options.isProcessAliveImpl ?? isProcessAlive, orphanAfterMs })) continue;
            } else if (!isWindowsSharingError(error)) {
                throw error;
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw stateError("等待项目操作锁超时；另一个命令可能正在启动或停止 Creator", "PROJECT_LOCK_TIMEOUT", paths.lockDirectory);
            }
            await wait(Math.min(pollIntervalMs, remaining));
            continue;
        }
        try {
            await atomicWriteJson(join(paths.lockDirectory, "owner.json"), owner);
        } catch (error) {
            // The directory was created by us; only remove it if still empty.
            await rmdir(paths.lockDirectory).catch(() => {});
            throw error;
        }
        break;
    }
    let actionError;
    try {
        return await action();
    } catch (error) {
        actionError = error;
        throw error;
    } finally {
        try {
            await releaseLock(paths, token);
        } catch (error) {
            if (!actionError) throw error;
            if (actionError && typeof actionError === "object") actionError.lockReleaseError = error;
        }
    }
}
