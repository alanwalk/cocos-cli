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
    assert.match(result.stdout, /^  info\b/m);
    assert.match(result.stdout, /^  open\b/m);
    assert.match(result.stdout, /^  build\b/m);
    assert.match(result.stdout, /^  mcp\b/m);
    assert.doesNotMatch(result.stdout, /^  ensure\b/m);
});

test("info 拒绝多余的位置参数", () => {
    const result = runCli(["info", "unexpected"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /too many arguments for .*info/);
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

test("Commander generates nested help and rejects the removed MCP entry points", () => {
    const help = runCli(["mcp", "register", "--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage: cocos mcp register/);
    assert.match(help.stdout, /--client/);
    assert.match(help.stdout, /--project/);
    for (const oldCommand of ["ensure", "status", "doctor", "stop", "restart"]) {
        const result = runCli([oldCommand, "--json"]);
        assert.equal(result.status, 1);
        assert.equal(result.stderr, "");
        assert.equal(JSON.parse(result.stdout).error.code, "INVALID_COMMAND");
    }
    for (const subcommand of ["tools", "call", "resources", "prompts"]) {
        assert.equal(runCli(["mcp", subcommand]).status, 1);
    }
    const open = runCli(["open", "--wait-ready", "--json"]);
    assert.equal(open.status, 1);
    assert.equal(JSON.parse(open.stdout).error.code, "INVALID_ARGUMENT");
});

test("Commander keeps JSON errors for invalid options and conflicts", () => {
    for (const args of [
        ["--timeout-ms", "0", "mcp", "tools", "--json"],
        ["open", "--foreground", "--background", "--json"],
        ["build", "--debug", "--release", "--json"],
        ["mcp", "register", "--json"],
        ["mcp", "register", "--client", "invalid", "--json"],
    ]) {
        const result = runCli(args);
        assert.equal(result.status, 1);
        assert.equal(result.stderr, "");
        assert.equal(JSON.parse(result.stdout).error.code, "INVALID_ARGUMENT");
    }
});
