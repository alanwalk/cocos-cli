import { resolve } from "node:path";

import { CocosCliError } from "./errors.js";
import { fileExists, readJsonFile } from "./files.js";

export const CONFIG_FILE_NAME = "cocos-cli.config.json";

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRecord(value, fieldName) {
    if (value === undefined) {
        return {};
    }
    if (!isRecord(value)) {
        throw new CocosCliError(`${fieldName} 必须是对象`, {
            code: "INVALID_CONFIG",
        });
    }
    return value;
}

function assertOptionalString(value, fieldName) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new CocosCliError(`${fieldName} 必须是非空字符串`, {
            code: "INVALID_CONFIG",
        });
    }
    return value;
}

function assertOptionalBoolean(value, fieldName) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "boolean") {
        throw new CocosCliError(`${fieldName} 必须是布尔值`, {
            code: "INVALID_CONFIG",
        });
    }
    return value;
}

function assertOptionalPositiveInteger(value, fieldName) {
    if (value === undefined) {
        return undefined;
    }
    if (!Number.isInteger(value) || value <= 0) {
        throw new CocosCliError(`${fieldName} 必须是正整数`, {
            code: "INVALID_CONFIG",
        });
    }
    return value;
}

function normalizeStartSceneFields(build) {
    const startScene = assertOptionalString(build.startScene, "build.startScene");
    const startSceneFile = assertOptionalString(build.startSceneFile, "build.startSceneFile");
    if (startScene && startSceneFile) {
        throw new CocosCliError("build.startScene 与 build.startSceneFile 只能配置一个", {
            code: "INVALID_CONFIG",
        });
    }
    return { startScene, startSceneFile };
}

function normalizeBuildOptions(value) {
    if (value === undefined) {
        return {};
    }
    if (!isRecord(value)) {
        throw new CocosCliError("build.options 必须是对象", {
            code: "INVALID_CONFIG",
        });
    }

    const normalizedOptions = {};
    for (const [key, optionValue] of Object.entries(value)) {
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
            throw new CocosCliError(`build.options 包含无效键名: ${key}`, {
                code: "INVALID_CONFIG",
            });
        }
        if (!["string", "number", "boolean"].includes(typeof optionValue)) {
            throw new CocosCliError(`build.options.${key} 只支持字符串、数字或布尔值`, {
                code: "INVALID_CONFIG",
            });
        }
        normalizedOptions[key] = optionValue;
    }
    return normalizedOptions;
}

function normalizeSuccessExitCodes(value) {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value) || value.length === 0 || value.some((code) => !Number.isInteger(code))) {
        throw new CocosCliError("build.successExitCodes 必须是非空整数数组", {
            code: "INVALID_CONFIG",
        });
    }
    return [...value];
}

function normalizeConfig(rawConfig) {
    if (!isRecord(rawConfig)) {
        throw new CocosCliError("配置文件根节点必须是对象", {
            code: "INVALID_CONFIG",
        });
    }

    const editor = assertRecord(rawConfig.editor, "editor");
    const build = assertRecord(rawConfig.build, "build");
    const open = assertRecord(rawConfig.open, "open");
    const mcp = assertRecord(rawConfig.mcp, "mcp");
    const lifecycle = assertRecord(rawConfig.lifecycle, "lifecycle");
    const { startScene, startSceneFile } = normalizeStartSceneFields(build);

    return {
        editor: {
            path: assertOptionalString(editor.path, "editor.path"),
            allowUnverifiedVersion: assertOptionalBoolean(editor.allowUnverifiedVersion, "editor.allowUnverifiedVersion") ?? false,
        },
        build: {
            platform: assertOptionalString(build.platform, "build.platform"),
            debug: assertOptionalBoolean(build.debug, "build.debug"),
            startScene,
            startSceneFile,
            options: normalizeBuildOptions(build.options),
            guardUrl: assertOptionalString(build.guardUrl, "build.guardUrl"),
            guardMessage: assertOptionalString(build.guardMessage, "build.guardMessage"),
            guardTimeoutMs: assertOptionalPositiveInteger(build.guardTimeoutMs, "build.guardTimeoutMs"),
            successExitCodes: normalizeSuccessExitCodes(build.successExitCodes),
        },
        open: {
            wait: assertOptionalBoolean(open.wait, "open.wait"),
        },
        mcp: {
            url: assertOptionalString(mcp.url, "mcp.url"),
            requestTimeoutMs: assertOptionalPositiveInteger(mcp.requestTimeoutMs, "mcp.requestTimeoutMs") ?? 3000,
        },
        lifecycle: {
            timeoutMs: assertOptionalPositiveInteger(lifecycle.timeoutMs, "lifecycle.timeoutMs") ?? 120000,
            stopTimeoutMs: assertOptionalPositiveInteger(lifecycle.stopTimeoutMs, "lifecycle.stopTimeoutMs") ?? 15000,
            pollIntervalMs: assertOptionalPositiveInteger(lifecycle.pollIntervalMs, "lifecycle.pollIntervalMs") ?? 750,
        },
    };
}

export function loadConfig(options: { projectRoot: string; configPath?: string }) {
    const projectRoot = options.projectRoot;
    const explicitConfigPath = options.configPath;
    const configPath = explicitConfigPath ? resolve(projectRoot, explicitConfigPath) : resolve(projectRoot, CONFIG_FILE_NAME);

    if (!fileExists(configPath)) {
        if (explicitConfigPath) {
            throw new CocosCliError(`配置文件不存在: ${configPath}`, {
                code: "CONFIG_NOT_FOUND",
            });
        }
        return {
            path: null,
            config: normalizeConfig({}),
        };
    }

    const rawConfig = readJsonFile(configPath, "cocos-cli 配置");
    return {
        path: configPath,
        config: normalizeConfig(rawConfig),
    };
}
