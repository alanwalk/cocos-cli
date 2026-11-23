import assert from "node:assert/strict";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { getCreatorCandidates, resolveCreator } from "../dist/creator.js";

import { createFakeCreator, createProjectFixture } from "./helpers.js";

function createInstallation(root, name, version) {
    const directory = join(root, name);
    mkdirSync(directory, { recursive: true });
    const executable = join(directory, process.platform === "win32" ? "CocosCreator.exe" : "CocosCreator");
    writeFileSync(executable, "");
    if (process.platform !== "win32") {
        chmodSync(executable, 0o755);
    }
    if (version !== undefined) {
        writePackageVersion(directory, version);
    }
    return { directory, executable };
}

function writePackageVersion(directory, version, resourcesName = "resources") {
    const appDirectory = join(directory, resourcesName, "app");
    mkdirSync(appDirectory, { recursive: true });
    const packagePath = join(appDirectory, "package.json");
    writeFileSync(packagePath, JSON.stringify({ name: "CocosCreator", version }));
    return packagePath;
}

function writeAsar(directory, version, entryOverrides = {}) {
    const resourcesDirectory = join(directory, "resources");
    mkdirSync(resourcesDirectory, { recursive: true });
    const content = Buffer.from(JSON.stringify({ name: "CocosCreator", version }));
    const headerJson = Buffer.from(JSON.stringify({ files: { "package.json": { size: content.length, offset: "0", ...entryOverrides } } }));
    const headerSize = 8 + Math.ceil(headerJson.length / 4) * 4;
    const header = Buffer.alloc(8 + headerSize);
    header.writeUInt32LE(4, 0);
    header.writeUInt32LE(headerSize, 4);
    header.writeUInt32LE(headerSize - 4, 8);
    header.writeUInt32LE(headerJson.length, 12);
    headerJson.copy(header, 16);
    const archivePath = join(resourcesDirectory, "app.asar");
    writeFileSync(archivePath, Buffer.concat([header, content]));
    return archivePath;
}

function resolveInFixture(fixture, options = {}) {
    return resolveCreator({
        platform: process.platform,
        version: "3.8.8",
        projectRoot: fixture.root,
        cwd: fixture.root,
        env: { PATH: "" },
        ...options,
    });
}

test("Windows 默认目录按项目版本生成", () => {
    const candidates = getCreatorCandidates({
        platform: "win32",
        version: "3.8.8",
        env: {
            ProgramData: "C:\\ProgramData",
        },
        projectRoot: "C:\\Game",
        cwd: "C:\\Game",
    });

    assert.ok(
        candidates.some(
            (candidate) => candidate.path === "C:\\ProgramData\\cocos\\editors\\Creator\\3.8.8\\CocosCreator.exe" && candidate.source === "platform default",
        ),
    );
});

test("macOS 在多个安装目录中查找同一 Creator 版本", () => {
    const candidates = getCreatorCandidates({
        platform: "darwin",
        version: "3.8.8",
        env: {
            HOME: "/Users/alan",
        },
        projectRoot: "/Users/alan/Game",
        cwd: "/Users/alan/Game",
    });
    const paths = candidates.map((candidate) => candidate.path);

    assert.ok(paths.includes("/Applications/Cocos/Creator/3.8.8/CocosCreator.app/Contents/MacOS/CocosCreator"));
    assert.ok(paths.includes("/Applications/CocosCreator/Creator/3.8.8/CocosCreator.app/Contents/MacOS/CocosCreator"));
});

test("--editor 优先于环境变量", (t) => {
    const fixture = createProjectFixture();
    t.after(() => fixture.cleanup());
    const explicitEditor = createFakeCreator(fixture.root);
    const otherDirectory = join(fixture.root, "other");
    mkdirSync(otherDirectory);
    const environmentEditor = createFakeCreator(otherDirectory);

    const creator = resolveCreator({
        platform: process.platform,
        version: "3.8.8",
        projectRoot: fixture.root,
        cwd: fixture.root,
        editor: explicitEditor,
        env: {
            PATH: "",
            COCOS_CREATOR_PATH: environmentEditor,
        },
    });

    assert.equal(creator.path, explicitEditor);
    assert.equal(creator.source, "argument");
});

test("COCOS_CREATOR_PATH 可以指向安装目录", (t) => {
    const fixture = createProjectFixture();
    t.after(() => fixture.cleanup());
    const installDirectory = join(fixture.root, "creator-install");
    mkdirSync(installDirectory);
    const executable = createFakeCreator(installDirectory);

    const creator = resolveCreator({
        platform: process.platform,
        version: "3.8.8",
        projectRoot: fixture.root,
        cwd: fixture.root,
        env: {
            PATH: "",
            COCOS_CREATOR_PATH: installDirectory,
        },
    });

    assert.equal(creator.path, executable);
    assert.equal(creator.source, "COCOS_CREATOR_PATH");
});

test("实际版本从安装元数据读取，与项目声明分开返回", (t) => {
    const fixture = createProjectFixture();
    t.after(() => fixture.cleanup());
    const editor = createInstallation(fixture.root, "creator-3.8.8", "3.8.7");
    const result = resolveInFixture(fixture, { editor: editor.executable });

    assert.equal(result.requiredVersion, "3.8.8");
    assert.equal(result.actualVersion, "3.8.7");
    assert.equal(result.versionVerified, true);
    assert.equal(result.versionMatch, false);
    assert.equal(result.versionSource, join(editor.directory, "resources", "app", "package.json"));
});

test("PATH 错版或未知版本不能挡住后续已核实的匹配版本", (t) => {
    const fixture = createProjectFixture();
    t.after(() => fixture.cleanup());
    const wrong = createInstallation(fixture.root, "wrong", "3.8.7");
    const unknown = createInstallation(fixture.root, "unknown");
    const correct = createInstallation(fixture.root, "correct", "3.8.8");
    const delimiter = process.platform === "win32" ? ";" : ":";
    const result = resolveInFixture(fixture, { env: { PATH: [wrong.directory, unknown.directory, correct.directory].join(delimiter) } });

    assert.equal(result.path, correct.executable);
    assert.equal(result.source, "PATH");
    assert.equal(result.versionVerified, true);
    assert.equal(result.versionMatch, true);
});

test("显式编辑器错版时保留错误选择，不静默改用环境变量", (t) => {
    const fixture = createProjectFixture();
    t.after(() => fixture.cleanup());
    const wrong = createInstallation(fixture.root, "wrong", "3.8.7");
    const correct = createInstallation(fixture.root, "correct", "3.8.8");
    const result = resolveInFixture(fixture, { editor: wrong.executable, env: { PATH: correct.directory, COCOS_CREATOR_PATH: correct.executable } });

    assert.equal(result.path, wrong.executable);
    assert.equal(result.source, "argument");
    assert.equal(result.versionMatch, false);
});

test("环境变量和配置错版都不会静默退回 PATH", (t) => {
    const fixture = createProjectFixture();
    t.after(() => fixture.cleanup());
    const wrong = createInstallation(fixture.root, "wrong", "3.8.7");
    const correct = createInstallation(fixture.root, "correct", "3.8.8");
    const fromEnvironment = resolveInFixture(fixture, {
        configEditor: correct.executable,
        env: { PATH: correct.directory, COCOS_CREATOR_PATH: wrong.executable },
    });
    const fromConfig = resolveInFixture(fixture, { configEditor: wrong.directory, env: { PATH: correct.directory } });

    assert.equal(fromEnvironment.source, "COCOS_CREATOR_PATH");
    assert.equal(fromEnvironment.versionMatch, false);
    assert.equal(fromConfig.source, "config");
    assert.equal(fromConfig.versionMatch, false);
});

test("显式路径不存在时不换成另一份编辑器", (t) => {
    const fixture = createProjectFixture();
    t.after(() => fixture.cleanup());
    const correct = createInstallation(fixture.root, "correct", "3.8.8");

    assert.throws(
        () => resolveInFixture(fixture, { editor: join(fixture.root, "missing"), env: { PATH: correct.directory } }),
        (error) => error.code === "CREATOR_NOT_FOUND" && error.details.some((line) => line.includes("missing")),
    );
});

test("没有元数据时不把目录名称或项目版本当作实测版本", (t) => {
    const fixture = createProjectFixture();
    t.after(() => fixture.cleanup());
    const editor = createInstallation(fixture.root, "Creator/3.8.8");
    const result = resolveInFixture(fixture, { editor: editor.executable });

    assert.equal(result.actualVersion, null);
    assert.equal(result.versionVerified, false);
    assert.equal(result.versionMatch, null);
    assert.equal(result.versionSource, null);
});

test("仅发现错版时返回实际错版供调用者拒绝启动", (t) => {
    const fixture = createProjectFixture();
    t.after(() => fixture.cleanup());
    const wrong = createInstallation(fixture.root, "wrong", "3.8.6");
    const result = resolveInFixture(fixture, { env: { PATH: wrong.directory, ProgramData: fixture.root }, version: "3.299.0" });

    assert.equal(result.actualVersion, "3.8.6");
    assert.equal(result.versionMatch, false);
});

test("ASAR 根 package.json 可用于核验版本", (t) => {
    const fixture = createProjectFixture();
    t.after(() => fixture.cleanup());
    const editor = createInstallation(fixture.root, "asar");
    const archivePath = writeAsar(editor.directory, "3.8.8");
    const result = resolveInFixture(fixture, { editor: editor.executable });

    assert.equal(result.actualVersion, "3.8.8");
    assert.equal(result.versionMatch, true);
    assert.equal(result.versionSource, `${archivePath}!/package.json`);
});

test("未打包 app 元数据优先于 app.asar", (t) => {
    const fixture = createProjectFixture();
    t.after(() => fixture.cleanup());
    const editor = createInstallation(fixture.root, "both", "3.8.7");
    writeAsar(editor.directory, "3.8.8");
    const result = resolveInFixture(fixture, { editor: editor.executable });

    assert.equal(result.actualVersion, "3.8.7");
    assert.equal(result.versionSource, join(editor.directory, "resources", "app", "package.json"));
});

test("ASAR 超大偏移、超大元数据与截断头安全降为未知", (t) => {
    const fixture = createProjectFixture();
    t.after(() => fixture.cleanup());
    const unsafeOffset = createInstallation(fixture.root, "unsafe-offset");
    writeAsar(unsafeOffset.directory, "3.8.8", { offset: "9007199254740993" });
    const oversized = createInstallation(fixture.root, "oversized-entry");
    writeAsar(oversized.directory, "3.8.8", { size: 1024 * 1024 + 1 });
    const truncated = createInstallation(fixture.root, "truncated");
    mkdirSync(join(truncated.directory, "resources"));
    const prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(0xfffffffc, 4);
    writeFileSync(join(truncated.directory, "resources", "app.asar"), prefix);

    for (const editor of [unsafeOffset, oversized, truncated]) {
        const result = resolveInFixture(fixture, { editor: editor.executable });
        assert.equal(result.actualVersion, null);
        assert.equal(result.versionVerified, false);
    }
});

test("无效 package JSON 不会退回项目 package.json", (t) => {
    const fixture = createProjectFixture();
    t.after(() => fixture.cleanup());
    const editor = createInstallation(fixture.root, "bad-json", "3.8.8");
    writeFileSync(join(editor.directory, "resources", "app", "package.json"), "not json");
    const result = resolveInFixture(fixture, { editor: editor.executable });

    assert.equal(result.actualVersion, null);
    assert.equal(result.versionMatch, null);
});

test("macOS 读取安装包 Info.plist，应用 package 元数据优先", { skip: process.platform === "win32" }, (t) => {
    const fixture = createProjectFixture();
    t.after(() => fixture.cleanup());
    const contents = join(fixture.root, "CocosCreator.app", "Contents");
    const editor = createInstallation(contents, "MacOS");
    const plistPath = join(contents, "Info.plist");
    writeFileSync(plistPath, '<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>3.8.7</string><key>CFBundleVersion</key><string>121518</string></dict></plist>');
    const fromPlist = resolveInFixture(fixture, { platform: "darwin", editor: editor.executable });
    assert.equal(fromPlist.actualVersion, "3.8.7");
    assert.equal(fromPlist.versionSource, `${plistPath}#CFBundleShortVersionString`);

    const packagePath = writePackageVersion(contents, "3.8.8", "Resources");
    const fromPackage = resolveInFixture(fixture, { platform: "darwin", editor: editor.executable });
    assert.equal(fromPackage.actualVersion, "3.8.8");
    assert.equal(fromPackage.versionSource, packagePath);
});

test("PATH 可执行文件是符号链接时读取实际安装位置元数据", { skip: process.platform === "win32" }, (t) => {
    const fixture = createProjectFixture();
    t.after(() => fixture.cleanup());
    const editor = createInstallation(fixture.root, "installation", "3.8.8");
    const binDirectory = join(fixture.root, "bin");
    mkdirSync(binDirectory);
    symlinkSync(editor.executable, join(binDirectory, "CocosCreator"));
    const result = resolveInFixture(fixture, { env: { PATH: binDirectory } });

    assert.equal(result.path, join(binDirectory, "CocosCreator"));
    assert.equal(result.actualVersion, "3.8.8");
});
