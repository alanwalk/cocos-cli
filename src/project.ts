import { basename, dirname, extname, join, resolve } from "node:path";
import { readdirSync } from "node:fs";

import { CocosCliError } from "./errors.js";
import { fileExists, fileIsDirectory, readJsonFile } from "./files.js";

const CREATOR_3_VERSION = /^3\.\d+\.\d+(?:[-+].*)?$/;

function requireDirectory(directory) {
    if (!fileExists(directory) || !fileIsDirectory(directory)) {
        throw new CocosCliError(`项目目录不存在: ${directory}`, {
            code: "PROJECT_NOT_FOUND",
        });
    }
}

function readCocosProject(directory) {
    const packageJsonPath = resolve(directory, "package.json");
    if (!fileExists(packageJsonPath)) {
        return null;
    }

    const manifest = readJsonFile(packageJsonPath, "项目 package.json");
    const creatorVersion = manifest?.creator?.version;
    if (typeof creatorVersion !== "string" || creatorVersion.trim().length === 0) {
        return null;
    }

    if (!CREATOR_3_VERSION.test(creatorVersion)) {
        throw new CocosCliError(`仅支持 Cocos Creator 3.x，当前声明版本为 ${creatorVersion}`, {
            code: "UNSUPPORTED_CREATOR_VERSION",
            details: [packageJsonPath],
        });
    }

    return {
        root: resolve(directory),
        manifest,
        packageJsonPath,
        creatorVersion,
    };
}

export function findCocosProject(startDirectory: string, options: { searchParents?: boolean } = {}) {
    const searchParents = options.searchParents ?? true;
    let current = resolve(startDirectory);
    requireDirectory(current);

    while (true) {
        const project = readCocosProject(current);
        if (project) {
            return project;
        }

        if (!searchParents) {
            break;
        }

        const parent = dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }

    throw new CocosCliError("未找到 Cocos Creator 3.x 项目", {
        code: "PROJECT_NOT_FOUND",
        details: [`请从项目目录运行，或使用 --project 指定目录。起点: ${resolve(startDirectory)}`],
    });
}

export function loadProject(options: { cwd?: string; project?: string } = {}) {
    const cwd = options.cwd ?? process.cwd();
    const projectPath = options.project;
    const explicitProject = typeof projectPath === "string" && projectPath.length > 0;
    const startDirectory = explicitProject ? resolve(cwd, projectPath) : cwd;
    const project = findCocosProject(startDirectory, { searchParents: !explicitProject });

    return {
        ...project,
        name: typeof project.manifest.name === "string" && project.manifest.name.length > 0 ? project.manifest.name : basename(project.root),
    };
}

function findSceneFiles(directory) {
    const sceneFiles = [];
    let entries;
    try {
        entries = readdirSync(directory, { withFileTypes: true });
    } catch {
        return sceneFiles;
    }

    for (const entry of entries) {
        const entryPath = join(directory, entry.name);
        if (entry.isDirectory()) {
            sceneFiles.push(...findSceneFiles(entryPath));
        } else if (entry.isFile() && extname(entry.name) === ".scene") {
            sceneFiles.push(entryPath);
        }
    }
    return sceneFiles;
}

export function findSingleSceneUuid(projectRoot) {
    const sceneFiles = findSceneFiles(join(projectRoot, "assets"));
    if (sceneFiles.length !== 1) {
        return undefined;
    }

    const sceneFile = sceneFiles[0];
    const metaFile = `${sceneFile}.meta`;
    if (!fileExists(metaFile)) {
        return undefined;
    }

    const meta = readJsonFile(metaFile, "场景 meta");
    if (typeof meta.uuid !== "string" || meta.uuid.trim().length === 0) {
        return undefined;
    }
    return meta.uuid.trim();
}
