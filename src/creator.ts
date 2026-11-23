import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

import { CocosCliError } from "./errors.js";
import { readCreatorVersion } from "./editor-version.js";
import { fileExists, fileIsDirectory, fileIsFile } from "./files.js";

function getPathApi(platform) {
    return platform === "win32" ? win32 : posix;
}

function getPathDelimiter(platform) {
    return platform === "win32" ? ";" : ":";
}

function getHomeDirectory(env) {
    return env.HOME ?? env.USERPROFILE ?? homedir();
}

function expandHomeDirectory(value, env, pathApi) {
    if (value === "~") {
        return getHomeDirectory(env);
    }
    if (value.startsWith("~/") || value.startsWith("~\\")) {
        return pathApi.join(getHomeDirectory(env), value.slice(2));
    }
    return value;
}

function resolveInputPath(value, baseDirectory, env, pathApi) {
    const expanded = expandHomeDirectory(value, env, pathApi);
    return pathApi.isAbsolute(expanded) ? pathApi.normalize(expanded) : pathApi.resolve(baseDirectory, expanded);
}

function expandCreatorInput(inputPath, platform) {
    const pathApi = getPathApi(platform);
    const executableName = platform === "win32" ? "CocosCreator.exe" : "CocosCreator";
    const expandedPaths = [inputPath];

    if (!fileIsDirectory(inputPath)) {
        return expandedPaths;
    }

    if (platform === "darwin") {
        if (inputPath.endsWith(".app")) {
            expandedPaths.push(pathApi.join(inputPath, "Contents", "MacOS", "CocosCreator"));
        } else {
            expandedPaths.push(
                pathApi.join(inputPath, "CocosCreator.app", "Contents", "MacOS", "CocosCreator"),
                pathApi.join(inputPath, "Contents", "MacOS", "CocosCreator"),
                pathApi.join(inputPath, executableName),
            );
        }
    } else {
        expandedPaths.push(pathApi.join(inputPath, executableName));
    }

    return expandedPaths;
}

function isExecutableFile(filePath, platform) {
    if (!fileExists(filePath) || !fileIsFile(filePath)) {
        return false;
    }
    if (platform === "win32") {
        return true;
    }

    try {
        accessSync(filePath, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function addCandidate(candidates, seenPaths, path, source) {
    if (!path || seenPaths.has(path)) {
        return;
    }
    seenPaths.add(path);
    candidates.push({ path, source });
}

interface CreatorOptions {
    projectRoot?: string;
    cwd?: string;
    editor?: string;
    configEditor?: string;
    version: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
}

export function getCreatorCandidates(options: CreatorOptions) {
    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    const pathApi = getPathApi(platform);
    const projectRoot = options.projectRoot ?? options.cwd ?? process.cwd();
    const cwd = options.cwd ?? projectRoot;
    const version = options.version;
    const candidates = [];
    const seenPaths = new Set();

    if (options.editor) {
        const editorPath = resolveInputPath(options.editor, cwd, env, pathApi);
        for (const candidatePath of expandCreatorInput(editorPath, platform)) {
            addCandidate(candidates, seenPaths, candidatePath, "argument");
        }
    }

    if (env.COCOS_CREATOR_PATH) {
        const editorPath = resolveInputPath(env.COCOS_CREATOR_PATH, cwd, env, pathApi);
        for (const candidatePath of expandCreatorInput(editorPath, platform)) {
            addCandidate(candidates, seenPaths, candidatePath, "COCOS_CREATOR_PATH");
        }
    }

    if (options.configEditor) {
        const editorPath = resolveInputPath(options.configEditor, projectRoot, env, pathApi);
        for (const candidatePath of expandCreatorInput(editorPath, platform)) {
            addCandidate(candidates, seenPaths, candidatePath, "config");
        }
    }

    const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
    const executableNames = platform === "win32" ? ["CocosCreator.exe", "CocosCreator"] : ["CocosCreator"];
    for (const directory of pathValue.split(getPathDelimiter(platform))) {
        const normalizedDirectory = directory.replace(/^"(.*)"$/, "$1").trim();
        if (!normalizedDirectory) {
            continue;
        }
        for (const executableName of executableNames) {
            addCandidate(candidates, seenPaths, pathApi.join(normalizedDirectory, executableName), "PATH");
        }
    }

    if (platform === "win32") {
        const programData = env.ProgramData ?? env.PROGRAMDATA ?? "C:\\ProgramData";
        addCandidate(candidates, seenPaths, pathApi.join(programData, "cocos", "editors", "Creator", version, "CocosCreator.exe"), "platform default");

        const localAppData = env.LOCALAPPDATA ?? env.LocalAppData;
        if (localAppData) {
            addCandidate(
                candidates,
                seenPaths,
                pathApi.join(localAppData, "CocosDashboard", "resources", ".editors", "Creator", version, "CocosCreator.exe"),
                "platform default",
            );
        }

        addCandidate(candidates, seenPaths, pathApi.join("C:\\CocosDashboard", "resources", ".editors", "Creator", version, "CocosCreator.exe"), "platform default");
    } else if (platform === "darwin") {
        const homeDirectory = getHomeDirectory(env);
        const macExecutable = pathApi.join("CocosCreator.app", "Contents", "MacOS", "CocosCreator");
        addCandidate(candidates, seenPaths, pathApi.join("/Applications/Cocos/Creator", version, macExecutable), "platform default");
        addCandidate(candidates, seenPaths, pathApi.join("/Applications/CocosCreator/Creator", version, macExecutable), "platform default");
        addCandidate(candidates, seenPaths, pathApi.join(homeDirectory, "Applications/Cocos/Creator", version, macExecutable), "platform default");
    }

    return candidates;
}

export function resolveCreator(options: CreatorOptions) {
    const platform = options.platform ?? process.platform;
    if (typeof options.version !== "string" || options.version.length === 0) {
        throw new CocosCliError("缺少项目声明的 Cocos Creator 版本", {
            code: "CREATOR_VERSION_MISSING",
        });
    }
    const allCandidates = getCreatorCandidates(options);
    const env = options.env ?? process.env;
    let explicitSource = null;
    if (options.editor) {
        explicitSource = "argument";
    } else if (env.COCOS_CREATOR_PATH) {
        explicitSource = "COCOS_CREATOR_PATH";
    } else if (options.configEditor) {
        explicitSource = "config";
    }
    const candidates = explicitSource ? allCandidates.filter((candidate) => candidate.source === explicitSource) : allCandidates;
    let unknownVersion = null;
    let mismatchedVersion = null;

    for (const candidate of candidates) {
        if (!isExecutableFile(candidate.path, platform)) {
            continue;
        }
        const metadata = readCreatorVersion(candidate.path, { platform });
        const result = {
            path: candidate.path,
            source: candidate.source,
            version: options.version,
            requiredVersion: options.version,
            actualVersion: metadata.actualVersion,
            versionVerified: metadata.actualVersion !== null,
            versionSource: metadata.versionSource,
            versionMatch: metadata.actualVersion === null ? null : metadata.actualVersion === options.version,
        };
        // An explicit selection must stay visible even when it is wrong or
        // unverifiable; callers can report it and enforce their launch policy.
        if (explicitSource || result.versionMatch === true) {
            return result;
        }
        if (result.versionMatch === null && unknownVersion === null) {
            unknownVersion = result;
        } else if (result.versionMatch === false && mismatchedVersion === null) {
            mismatchedVersion = result;
        }
    }
    if (unknownVersion !== null) {
        return unknownVersion;
    }
    if (mismatchedVersion !== null) {
        return mismatchedVersion;
    }

    throw new CocosCliError(`未找到 Cocos Creator ${options.version} 可执行文件`, {
        code: "CREATOR_NOT_FOUND",
        details: [
            `当前平台: ${platform}`,
            "使用 --editor <路径> 或 COCOS_CREATOR_PATH 指定安装位置。",
            "已检查:",
            ...candidates.map((candidate) => `- ${candidate.path} (${candidate.source})`),
        ],
    });
}
