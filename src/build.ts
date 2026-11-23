import { isAbsolute, resolve } from "node:path";

import { CocosCliError } from "./errors.js";
import { readJsonFile } from "./files.js";
import { findSingleSceneUuid } from "./project.js";

const DEFAULT_PLATFORM = "web-desktop";
const DEFAULT_SUCCESS_EXIT_CODES = [0, 36];
const DEFAULT_GUARD_TIMEOUT_MS = 800;
const RESERVED_BUILD_OPTIONS = new Set(["platform", "debug", "startScene"]);

function validateBuildToken(value, label) {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new CocosCliError(`${label} 必须是非空字符串`, {
            code: "INVALID_BUILD_OPTION",
        });
    }
    if (value.includes(";")) {
        throw new CocosCliError(`${label} 不能包含分号`, {
            code: "INVALID_BUILD_OPTION",
        });
    }
    return value;
}

function readStartSceneFile(projectRoot, startSceneFile) {
    const startScenePath = isAbsolute(startSceneFile) ? startSceneFile : resolve(projectRoot, startSceneFile);
    const contents = readJsonFile(startScenePath, "startSceneFile");

    if (typeof contents === "string" && contents.trim().length > 0) {
        return contents.trim();
    }
    if (contents && typeof contents.uuid === "string" && contents.uuid.trim().length > 0) {
        return contents.uuid.trim();
    }

    throw new CocosCliError("startSceneFile 必须是 UUID 字符串，或包含 uuid 字段的对象", {
        code: "INVALID_START_SCENE",
        details: [startScenePath],
    });
}

export function resolveStartScene(options) {
    if (options.explicitStartScene) {
        return validateBuildToken(options.explicitStartScene, "--start-scene");
    }
    if (options.buildConfig.startScene) {
        return validateBuildToken(options.buildConfig.startScene, "build.startScene");
    }
    if (options.buildConfig.startSceneFile) {
        return validateBuildToken(readStartSceneFile(options.projectRoot, options.buildConfig.startSceneFile), "build.startSceneFile");
    }
    return findSingleSceneUuid(options.projectRoot);
}

function normalizeBuildValue(value, label) {
    if (typeof value === "boolean") {
        return value ? "true" : "false";
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new CocosCliError(`${label} 必须是有限数字`, {
                code: "INVALID_BUILD_OPTION",
            });
        }
        return String(value);
    }
    if (typeof value === "string") {
        return validateBuildToken(value, label);
    }
    throw new CocosCliError(`${label} 只支持字符串、数字或布尔值`, {
        code: "INVALID_BUILD_OPTION",
    });
}

export function parseBuildOptionAssignments(assignments: string[] = []) {
    const options: Record<string, string> = Object.create(null);
    for (const assignment of assignments) {
        const separatorIndex = assignment.indexOf("=");
        if (separatorIndex <= 0) {
            throw new CocosCliError(`--option 需要 key=value 格式: ${assignment}`, {
                code: "INVALID_BUILD_OPTION",
            });
        }

        const key = assignment.slice(0, separatorIndex).trim();
        const value = assignment.slice(separatorIndex + 1);
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
            throw new CocosCliError(`--option 键名无效: ${key}`, {
                code: "INVALID_BUILD_OPTION",
            });
        }
        options[key] = validateBuildToken(value, `--option ${key}`);
    }
    return options;
}

type BuildConfig = ReturnType<typeof import("./config.js").loadConfig>["config"]["build"];
interface BuildOptions {
    projectRoot: string;
    buildConfig: Partial<BuildConfig>;
    platform?: string;
    debug?: boolean;
    release?: boolean;
    startScene?: string;
    optionAssignments?: string[];
    nativeConfigPath?: string;
    logDest?: string;
}

export function createBuildArguments(options: BuildOptions) {
    const buildValues = new Map<string, string>();
    let configPath: string | undefined;
    let configuredLogDest: string | undefined;
    let platform: string | undefined;
    let debug: boolean | undefined;
    let startScene: string | undefined;
    if (options.nativeConfigPath !== undefined) {
        configPath = validateBuildToken(resolve(options.projectRoot, options.nativeConfigPath), "--build-config");
        if (configPath.includes("=")) throw new CocosCliError("--build-config 路径不能包含等号", { code: "INVALID_BUILD_OPTION" });
        const nativeConfig = readJsonFile(configPath, "Creator 构建配置");
        if (!nativeConfig || typeof nativeConfig !== "object" || Array.isArray(nativeConfig)) {
            throw new CocosCliError("Creator 构建配置必须是 JSON 对象", { code: "INVALID_BUILD_OPTION" });
        }
        buildValues.set("configPath", configPath);
        platform = options.platform;
        if (!platform && typeof nativeConfig.platform === "string") platform = nativeConfig.platform;
        if (typeof nativeConfig.debug === "boolean") debug = nativeConfig.debug;
        if (typeof nativeConfig.startScene === "string") startScene = nativeConfig.startScene;
        if (typeof nativeConfig.logDest === "string") configuredLogDest = nativeConfig.logDest;
        if (options.platform) buildValues.set("platform", validateBuildToken(options.platform, "platform"));
        if (options.startScene) {
            startScene = validateBuildToken(options.startScene, "--start-scene");
            buildValues.set("startScene", startScene);
        }
    } else {
        platform = validateBuildToken(options.platform || options.buildConfig.platform || DEFAULT_PLATFORM, "platform");
        debug = options.buildConfig.debug ?? false;
        startScene = resolveStartScene({
            projectRoot: options.projectRoot,
            buildConfig: options.buildConfig,
            explicitStartScene: options.startScene,
        });
        buildValues.set("platform", platform);
    }
    if (options.debug) debug = true;
    if (options.release) debug = false;
    if (options.nativeConfigPath === undefined || options.debug || options.release) {
        buildValues.set("debug", debug ? "true" : "false");
    }
    if (options.nativeConfigPath === undefined && startScene) buildValues.set("startScene", startScene);
    const extraOptions = parseBuildOptionAssignments(options.optionAssignments);

    for (const [key, value] of Object.entries(options.buildConfig.options ?? {})) {
        if (RESERVED_BUILD_OPTIONS.has(key)) {
            throw new CocosCliError(`build.options 不能覆盖保留参数 ${key}`, {
                code: "INVALID_BUILD_OPTION",
            });
        }
        buildValues.set(key, normalizeBuildValue(value, `build.options.${key}`));
    }
    for (const [key, value] of Object.entries(extraOptions)) {
        if (RESERVED_BUILD_OPTIONS.has(key)) {
            throw new CocosCliError(`--option 不能覆盖保留参数 ${key}`, {
                code: "INVALID_BUILD_OPTION",
            });
        }
        buildValues.set(key, value);
    }

    if (configPath !== undefined && buildValues.get("configPath") !== configPath) {
        throw new CocosCliError("--build-config 不能与 --option configPath 或 build.options.configPath 同时使用", { code: "INVALID_BUILD_OPTION" });
    }
    if (options.logDest !== undefined) {
        const logDest = validateBuildToken(resolve(options.projectRoot, options.logDest), "--log-dest");
        if (logDest.includes("=")) throw new CocosCliError("--log-dest 路径不能包含等号", { code: "INVALID_BUILD_OPTION" });
        buildValues.set("logDest", logDest);
    }
    const buildString = Array.from(buildValues, ([key, value]) => `${key}=${value}`).join(";");
    return {
        args: ["--project", options.projectRoot, "--build", buildString],
        buildString,
        logDest: buildValues.get("logDest") ?? configuredLogDest ?? null,
        platform: platform ?? null,
        debug,
        startScene,
        successExitCodes: options.buildConfig.successExitCodes ?? DEFAULT_SUCCESS_EXIT_CODES,
    };
}

export async function assertBuildAllowed(options) {
    if (options.skipGuard || !options.buildConfig.guardUrl) {
        return;
    }

    const timeoutMs = options.buildConfig.guardTimeoutMs ?? DEFAULT_GUARD_TIMEOUT_MS;
    let response;
    try {
        const fetchImpl = options.fetchImpl ?? globalThis.fetch;
        response = await fetchImpl(options.buildConfig.guardUrl, {
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch {
        return;
    }

    if (response.ok) {
        throw new CocosCliError(options.buildConfig.guardMessage ?? "构建检查未通过", {
            code: "BUILD_GUARDED",
            details: [`${options.buildConfig.guardUrl} 返回 ${response.status}`],
        });
    }
}
