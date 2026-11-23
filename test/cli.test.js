import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createFakeCreator, createProjectFixture } from "./helpers.js";

const cliPath = fileURLToPath(new URL("../bin/cocos.js", import.meta.url));

function runCli(args, options = {}) {
    return spawnSync(process.execPath, [cliPath, ...args], {
        cwd: options.cwd,
        encoding: "utf8",
    });
}

test("--version 输出包名和版本", () => {
    const result = runCli(["--version"]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /^@alanwalk\/cocos-cli 1\.0\.0/m);
});

test("--help 列出核心命令", () => {
    const result = runCli(["--help"]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /cocos info/);
    assert.match(result.stdout, /cocos open/);
    assert.match(result.stdout, /cocos build/);
});

test("info 拒绝多余的位置参数", () => {
    const result = runCli(["info", "unexpected"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /info 不接受位置参数/);
});

test("info --json 返回项目和编辑器信息", (t) => {
    const fixture = createProjectFixture();
    t.after(() => fixture.cleanup());
    const editorPath = createFakeCreator(fixture.root);
    writeFileSync(join(fixture.root, "start-scene.json"), `${JSON.stringify({ uuid: "scene-uuid" }, null, 2)}\n`);
    writeFileSync(
        join(fixture.root, "cocos-cli.config.json"),
        `${JSON.stringify(
            {
                build: {
                    startSceneFile: "start-scene.json",
                },
            },
            null,
            2,
        )}\n`,
    );

    const result = runCli(["info", "--json", "--project", fixture.root, "--editor", editorPath]);

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.projectRoot, fixture.root);
    assert.equal(parsed.creatorVersion, "3.8.8");
    assert.equal(parsed.editorPath, editorPath);
    assert.equal(parsed.startScene, "scene-uuid");
});
