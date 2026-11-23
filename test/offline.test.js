import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../dist/cli.js";
import { createBuildArguments } from "../dist/build.js";
import { createProjectFixture, createFakeCreator } from "./helpers.js";

async function command(project, ...args) {
    const lines = [];
    const exitCode = await runCli([...args, "--project", project, "--json"], { output: (line) => lines.push(line) });
    return { exitCode, data: JSON.parse(lines.join("\n")) };
}

test("create copies a Creator template, stamps a unique project UUID and refuses an existing target", async (t) => {
    const { root, cleanup } = createProjectFixture();
    t.after(cleanup);
    let executableDirectory = join(root, "install");
    let resources = join(executableDirectory, "resources");
    if (process.platform === "darwin") {
        const contents = join(root, "Creator.app", "Contents");
        executableDirectory = join(contents, "MacOS");
        resources = join(contents, "Resources");
    }
    mkdirSync(executableDirectory, { recursive: true });
    const editor = createFakeCreator(executableDirectory);
    const app = join(resources, "app");
    const template = join(resources, "templates", "empty-2d");
    mkdirSync(app, { recursive: true });
    mkdirSync(template, { recursive: true });
    writeFileSync(join(app, "package.json"), '{"version":"3.8.8"}');
    writeFileSync(join(template, "package.json"), '{"name":"empty"}');
    const project = join(root, "Game");
    const anotherProject = join(root, "Other");
    const first = await command(project, "create", "--editor", editor);
    const second = await command(anotherProject, "create", "--editor", editor);
    assert.equal(first.exitCode, 0, JSON.stringify(first.data));
    assert.equal(second.exitCode, 0, JSON.stringify(second.data));
    assert.notEqual(first.data.uuid, second.data.uuid);
    assert.ok(existsSync(join(project, "assets")));
    assert.equal(JSON.parse(readFileSync(join(project, "package.json"))).creator.version, "3.8.8");
    assert.equal((await command(project, "create", "--editor", editor)).data.error.code, "PROJECT_EXISTS");
});

test("check, asset refs, and prefab commands are read-only and resolve compressed sub-asset refs", async (t) => {
    const { root, cleanup } = createProjectFixture();
    t.after(cleanup);
    const assets = join(root, "assets");
    const uuid = "7bf9df40-4bc9-4e25-8cb0-9a500f949102";
    const asset = join(assets, "image.png");
    const prefab = join(assets, "Root.prefab");
    const changed = join(assets, "Changed.prefab");
    writeFileSync(asset, "");
    writeFileSync(asset + ".meta", JSON.stringify({ uuid, subMetas: { frame: { uuid: uuid + "@f9941" } } }));
    const objects = [
        { __type__: "cc.Prefab", data: { __id__: 1 } },
        { __type__: "cc.Node", _name: "Canvas", _children: [], _components: [{ __id__: 2 }] },
        { __type__: "cc.Sprite", node: { __id__: 1 }, _spriteFrame: { __uuid__: "7bf9d9AS8lOJYywmlAPlJEC@f9941" }, _enabled: true },
    ];
    const before = JSON.stringify(objects);
    writeFileSync(prefab, before);
    objects[2]._enabled = false;
    writeFileSync(changed, JSON.stringify(objects));

    const refs = await command(root, "asset", "refs", "db://assets/image.png");
    assert.equal(refs.exitCode, 0);
    assert.equal(refs.data.references.length, 2);
    assert.equal(refs.data.references[0].uuid, uuid + "@f9941");
    assert.equal((await command(root, "prefab", "inspect", "assets/Root.prefab")).data.root.components[0].type, "cc.Sprite");
    const diff = await command(root, "prefab", "diff", "assets/Root.prefab", "assets/Changed.prefab");
    assert.equal(diff.data.changes.length, 1);
    assert.match(diff.data.changes[0].path, /_enabled$/);
    assert.equal(readFileSync(prefab, "utf8"), before);
    const check = await command(root, "check");
    assert.equal(check.exitCode, 2);
    assert.ok(check.data.issues.some((issue) => issue.code === "MISSING_META"));
    assert.equal(check.data.unresolved.length, 0);
});

test("build honors the native config without injecting CLI defaults", (t) => {
    const { root, cleanup } = createProjectFixture();
    t.after(cleanup);
    const configPath = join(root, "native.json");
    writeFileSync(configPath, '{"platform":"wechatgame","debug":true}');
    const result = createBuildArguments({
        projectRoot: root,
        buildConfig: { platform: "web-desktop", debug: false },
        nativeConfigPath: "native.json",
    });
    assert.equal(result.buildString, "configPath=" + configPath);
    assert.equal(result.platform, "wechatgame");
    assert.equal(result.debug, true);
});
