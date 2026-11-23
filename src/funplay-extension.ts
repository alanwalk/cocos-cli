import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";

import { CocosCliError } from "./errors.js";
import { readJsonFile } from "./files.js";
import { getProjectStatePaths, withProjectLock } from "./state.js";

const EXTENSION = "funplay-cocos-mcp";
const REPOSITORY = "FunplayAI/funplay-cocos-mcp";
const LATEST = "https://api.github.com/repos/" + REPOSITORY + "/releases/latest";
const MAX_ZIP_BYTES = 16 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
const VERSION = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

interface ExtensionOptions {
    project: { root: string; creatorVersion: string };
    operation: "setup" | "update";
    global?: boolean;
    timeoutMs?: number;
    homeDirectory?: string;
    fetchImpl?: typeof fetch;
}

function fail(code: string, message: string, details?: string[]) {
    return new CocosCliError(message, { code, details });
}

async function inspectPath(file: string) {
    try {
        return await lstat(file);
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
}

async function ensureDirectory(file: string) {
    await mkdir(file, { recursive: true });
    const info = await lstat(file);
    if (!info.isDirectory() || info.isSymbolicLink()) {
        throw fail("FUNPLAY_UNSAFE_PATH", "Funplay 安装路径必须是真实目录", [file]);
    }
}

function canUpgrade(current: string, latest: string) {
    const currentParts = VERSION.exec(current);
    const latestParts = VERSION.exec(latest);
    if (!currentParts || !latestParts) throw fail("FUNPLAY_INVALID_VERSION", "无法比较 Funplay 版本", [current, latest]);
    for (let index = 1; index <= 3; index += 1) {
        const difference = Number(latestParts[index]) - Number(currentParts[index]);
        if (difference !== 0) return difference > 0;
    }
    return Boolean(currentParts[4]);
}

async function download(url: string, limit: number, fetchImpl: typeof fetch, signal: AbortSignal) {
    const response = await fetchImpl(url, { signal, headers: { "User-Agent": "cocos-cli", Accept: "*/*" } });
    if (!response.ok || !response.body) {
        throw fail("FUNPLAY_DOWNLOAD_FAILED", "下载 Funplay 官方 Release 失败", [url, "HTTP " + response.status]);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            received += chunk.value.length;
            if (received > limit) throw fail("FUNPLAY_RELEASE_TOO_LARGE", "Funplay Release 文件超过大小限制", [url]);
            chunks.push(chunk.value);
        }
    } finally {
        await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks, received);
}

async function prepareRelease(version: string, archive: Buffer, staging: string) {
    let total = 0;
    let count = 0;
    const prefix = EXTENSION + "/";
    const files = unzipSync(archive, {
        filter(entry) {
            const name = entry.name;
            if (name === prefix) return false;
            const relative = name.slice(prefix.length).replace(/\/$/, "");
            const segments = relative.split("/");
            if (!name.startsWith(prefix) || /[\\:\x00]/.test(name)
                || segments.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part) || part.toLowerCase() === ".git")) {
                throw fail("FUNPLAY_INVALID_ARCHIVE", "Release ZIP 包含不安全或不受支持的路径", [name]);
            }
            total += entry.originalSize;
            count += 1;
            if (total > MAX_UNPACKED_BYTES || count > 4000) {
                throw fail("FUNPLAY_RELEASE_TOO_LARGE", "Funplay Release 超过解压限制");
            }
            return !name.endsWith("/");
        },
    });

    const manifestPath = prefix + "package.json";
    if (!files[manifestPath]) throw fail("FUNPLAY_INVALID_ARCHIVE", "Release 缺少 Funplay package.json");
    const manifest = JSON.parse(Buffer.from(files[manifestPath]).toString("utf8"));
    if (manifest.name !== EXTENSION || manifest.version !== version || manifest.main !== "browser.js" || !files[prefix + "browser.js"]) {
        throw fail("FUNPLAY_INVALID_ARCHIVE", "Release 的扩展名称、版本或入口与预期不符");
    }
    for (const [name, content] of Object.entries(files)) {
        const file = join(staging, name.slice(prefix.length));
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content, { flag: "wx" });
    }
}

export async function manageFunplayExtension(options: ExtensionOptions) {
    const scope = options.global ? "global" : "project";
    const { creatorVersion, root } = options.project;
    if (!VERSION.test(creatorVersion)) throw fail("FUNPLAY_INVALID_VERSION", "项目声明的 Creator 版本无效");
    const creatorHome = join(options.homeDirectory ?? homedir(), ".CocosCreator");
    let lockRoot = root;
    let extensions = join(root, "extensions");
    if (options.global) {
        await ensureDirectory(creatorHome);
        const builtins = join(creatorHome, "builtin-extensions");
        await ensureDirectory(builtins);
        extensions = join(builtins, creatorVersion);
        lockRoot = creatorHome;
    }
    const extensionPath = join(extensions, EXTENSION);
    const started = Date.now();
    const timeoutMs = options.timeoutMs ?? 120000;
    const signal = AbortSignal.timeout(timeoutMs);
    const fetchImpl = options.fetchImpl ?? fetch;

    return withProjectLock(lockRoot, async () => {
        await ensureDirectory(extensions);
        const localPath = join(root, "extensions", EXTENSION);
        const localManifest = options.global ? await inspectPath(join(localPath, "package.json")) : null;
        const projectOverridePath = localManifest?.isFile() ? localPath : null;
        const result = { ok: true, scope, creatorVersion, projectRoot: root, extensionPath, projectOverridePath };
        const installed = await inspectPath(extensionPath);
        if (installed && (!installed.isDirectory() || installed.isSymbolicLink())) {
            throw fail("FUNPLAY_UNSAFE_PATH", "Funplay 安装路径必须是真实目录", [extensionPath]);
        }
        const emptyPlaceholder = installed !== null && (await readdir(extensionPath)).length === 0;
        let previousVersion: string | null = null;
        if (installed && !emptyPlaceholder) {
            const packagePath = join(extensionPath, "package.json");
            if (!(await inspectPath(packagePath))?.isFile()) {
                throw fail("FUNPLAY_INVALID_INSTALLATION", "Funplay 目录内已有文件，但缺少有效的 package.json，已保留原目录", [extensionPath]);
            }
            const manifest = readJsonFile(packagePath, "Funplay 扩展配置");
            if (manifest?.name !== EXTENSION || !VERSION.test(manifest.version ?? "")) {
                throw fail("FUNPLAY_INVALID_INSTALLATION", "安装目录不是可识别的 Funplay 扩展", [packagePath]);
            }
            previousVersion = manifest.version;
            if (options.operation === "setup") {
                return { ...result, changed: false, version: previousVersion, backupPath: null };
            }
            if (await inspectPath(join(extensionPath, ".git"))) {
                throw fail("FUNPLAY_GIT_INSTALLATION", "该扩展是 Git 工作副本，请使用 git 更新", [extensionPath]);
            }
        } else if (options.operation === "update") {
            throw fail("FUNPLAY_NOT_INSTALLED", "未找到 Funplay。请先使用 cocos mcp setup 安装", [extensionPath]);
        }

        const release = JSON.parse((await download(LATEST, 512 * 1024, fetchImpl, signal)).toString("utf8"));
        const tag = typeof release?.tag_name === "string" ? release.tag_name : "";
        const version = tag.slice(1);
        const parts = VERSION.exec(version);
        if (!tag.startsWith("v") || !parts || parts[4] || release.prerelease || release.draft) {
            throw fail("FUNPLAY_INVALID_RELEASE", "GitHub 未返回可识别的 Funplay 稳定版");
        }
        if (previousVersion && !canUpgrade(previousVersion, version)) {
            return { ...result, changed: false, version: previousVersion, latestVersion: version, backupPath: null };
        }

        const zipName = "Funplay.CocosMcp." + tag + ".zip";
        const base = "https://github.com/" + REPOSITORY + "/releases/download/" + encodeURIComponent(tag) + "/";
        const [manifest, archive] = await Promise.all([
            download(base + "SHA256SUMS.txt", 64 * 1024, fetchImpl, signal),
            download(base + zipName, MAX_ZIP_BYTES, fetchImpl, signal),
        ]);
        const expected = manifest.toString("utf8").split(/\r?\n/).map((line) => /^([a-f\d]{64})\s+\*?(.+)$/i.exec(line))
            .filter((line) => line?.[2] === zipName);
        const actual = createHash("sha256").update(archive).digest("hex");
        if (expected.length !== 1 || expected[0][1].toLowerCase() !== actual) {
            throw fail("FUNPLAY_CHECKSUM_MISMATCH", "Funplay Release 的 SHA256 校验失败", [zipName]);
        }

        const { directory } = getProjectStatePaths(lockRoot);
        const staging = await mkdtemp(join(directory, "funplay-stage-"));
        let backupPath: string | null = null;
        let removedPlaceholder = false;
        try {
            await prepareRelease(version, archive, staging);
            signal.throwIfAborted();
            if (installed) {
                const current = await lstat(extensionPath);
                if (current.dev !== installed.dev || current.ino !== installed.ino || current.mtimeMs !== installed.mtimeMs) {
                    throw fail("FUNPLAY_INSTALLATION_CHANGED", "安装目录在下载时发生变化，请重新执行命令", [extensionPath]);
                }
                if (emptyPlaceholder) {
                    // Git may leave an uninitialized submodule as an empty directory.
                    await rmdir(extensionPath);
                    removedPlaceholder = true;
                } else {
                    const backupRoot = await mkdtemp(join(directory, "funplay-backup-"));
                    backupPath = join(backupRoot, EXTENSION);
                    await rename(extensionPath, backupPath);
                }
            } else if (await inspectPath(extensionPath)) {
                throw fail("FUNPLAY_INSTALLATION_CHANGED", "安装目录在下载时发生变化，请重新执行命令", [extensionPath]);
            }

            try {
                await rename(staging, extensionPath);
            } catch (error) {
                if (backupPath) {
                    try {
                        await rename(backupPath, extensionPath);
                    } catch {
                        throw fail("FUNPLAY_RESTORE_FAILED", "更新失败且无法恢复原扩展", [backupPath, extensionPath]);
                    }
                } else if (removedPlaceholder) {
                    await mkdir(extensionPath).catch((restoreError) => {
                        if (restoreError.code !== "EEXIST") {
                            throw fail("FUNPLAY_RESTORE_FAILED", "安装失败且无法恢复空目录", [extensionPath]);
                        }
                    });
                }
                throw error;
            }
            return { ...result, changed: true, version, previousVersion, backupPath, reopenRequired: true };
        } finally {
            await rm(staging, { recursive: true, force: true });
        }
    }, { timeoutMs: Math.max(0, timeoutMs - (Date.now() - started)) });
}
