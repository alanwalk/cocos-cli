import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { resolveCreator } from "./creator.js";
import { CocosCliError } from "./errors.js";
import { readJsonFile } from "./files.js";
import { assertEditorVersion } from "./lifecycle.js";

const PROJECT_TEMPLATES = { "2d": "empty-2d", "3d": "empty" } as const;

interface CreateOptions {
    project: string;
    cwd: string;
    editor?: string;
    env?: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    type?: string;
}

export async function createProject(options: CreateOptions) {
    const type = options.type ?? "2d";
    if (type !== "2d" && type !== "3d") {
        throw new CocosCliError("--type 必须是 2d 或 3d", { code: "INVALID_ARGUMENT" });
    }
    const projectRoot = resolve(options.cwd, options.project);
    const name = basename(projectRoot);
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        throw new CocosCliError("项目目录名只能包含字母、数字、下划线和连字符", { code: "INVALID_PROJECT_NAME" });
    }

    const assertTargetAbsent = async () => {
        try {
            await lstat(projectRoot);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
        }
        throw new CocosCliError("项目目标目录已存在", { code: "PROJECT_EXISTS", details: [projectRoot] });
    };
    await assertTargetAbsent();

    const creator = resolveCreator({
        projectRoot,
        cwd: options.cwd,
        editor: options.editor,
        env: options.env,
        platform: options.platform,
        version: "3.8.8",
    });
    assertEditorVersion(creator);
    const executableDirectory = dirname(creator.path);
    let templatesRoot = join(executableDirectory, "resources", "templates");
    if (options.platform === "darwin") {
        templatesRoot = join(dirname(executableDirectory), "Resources", "templates");
    }
    const template = PROJECT_TEMPLATES[type];
    const templatePath = join(templatesRoot, template);
    const manifest = readJsonFile(join(templatePath, "package.json"), "Creator 项目模板");
    const uuid = randomUUID();
    manifest.name = name;
    manifest.uuid = uuid;
    manifest.creator = { ...manifest.creator, version: creator.actualVersion };

    const parent = dirname(projectRoot);
    await mkdir(parent, { recursive: true });
    const staging = await mkdtemp(join(parent, ".cocos-create-"));
    const stagedProject = join(staging, "project");
    try {
        await cp(templatePath, stagedProject, { recursive: true, errorOnExist: true, force: false });
        await mkdir(join(stagedProject, "assets"), { recursive: true });
        await writeFile(join(stagedProject, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
        await assertTargetAbsent();
        await rename(stagedProject, projectRoot);
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
    return { ok: true, projectRoot, name, uuid, template, creatorVersion: creator.actualVersion };
}
