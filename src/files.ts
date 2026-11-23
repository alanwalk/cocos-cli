import { existsSync, readFileSync, statSync } from "node:fs";

import { CocosCliError } from "./errors.js";

export function fileExists(filePath: string) {
    return existsSync(filePath);
}

export function fileIsDirectory(filePath: string) {
    try {
        return statSync(filePath).isDirectory();
    } catch {
        return false;
    }
}

export function fileIsFile(filePath: string) {
    try {
        return statSync(filePath).isFile();
    } catch {
        return false;
    }
}

export function readJsonFile(filePath: string, label = filePath) {
    let content;
    try {
        content = readFileSync(filePath, "utf8");
    } catch (error) {
        throw new CocosCliError(`无法读取 ${label}`, {
            cause: error,
            code: "FILE_READ_FAILED",
            details: [filePath],
        });
    }

    try {
        return JSON.parse(content.replace(/^\uFEFF/, ""));
    } catch (error) {
        throw new CocosCliError(`${label} 不是有效的 JSON`, {
            cause: error,
            code: "JSON_PARSE_FAILED",
            details: [filePath],
        });
    }
}
