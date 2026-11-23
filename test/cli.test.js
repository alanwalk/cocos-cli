import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCli as invokeCli } from "../dist/cli.js";
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

test("mcp preview accepts Edge and Chrome browser selectors", () => {
    const help = runCli(["mcp", "preview", "--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage: cocos mcp preview \[options\]/);
    assert.match(help.stdout, /choices: "edge", "chrome"/);
    const unsupported = runCli(["mcp", "preview", "--browser", "firefox", "--json"]);
    assert.equal(unsupported.status, 1);
    assert.equal(JSON.parse(unsupported.stdout).error.code, "INVALID_ARGUMENT");
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

test("Commander lists MCP lifecycle commands under mcp", () => {
    const help = runCli(["mcp", "register", "--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage: cocos mcp register/);
    assert.match(help.stdout, /--client/);
    assert.match(help.stdout, /--project/);
    for (const command of ["ensure", "status", "doctor", "preview", "stop", "restart"]) {
        const result = runCli([command, "--json"]);
        assert.equal(result.status, 1);
        assert.equal(result.stderr, "");
        assert.equal(JSON.parse(result.stdout).error.code, "INVALID_COMMAND");
    }
    for (const subcommand of ["tools", "call", "resources", "prompts"]) {
        assert.equal(runCli(["mcp", subcommand]).status, 1);
    }
});

test("ordinary open uses window handling on Windows and macOS unless configured to wait", async (t) => {
    const fixture = createProjectFixture();
    t.after(fixture.cleanup);
    mkdirSync(join(fixture.root, "temp"));
    writeFileSync(join(fixture.root, "temp", "cocos-cli"), "Block window handling before it queries processes");
    writeFileSync(join(fixture.root, "wait.json"), JSON.stringify({ open: { wait: true } }));
    const args = ["open", "--json", "--editor", join(fixture.root, "missing-editor")];

    for (const [platform, flags, expectedCode] of [
        ["darwin", [], "STATE_PATH_UNSAFE"],
        ["win32", [], "STATE_PATH_UNSAFE"],
        ["darwin", ["--foreground"], "STATE_PATH_UNSAFE"],
        ["darwin", ["--config", "wait.json"], "CREATOR_NOT_FOUND"],
        ["linux", [], "CREATOR_NOT_FOUND"],
        ["linux", ["--foreground"], "EDITOR_WINDOW_UNSUPPORTED"],
    ]) {
        const output = [];
        const code = await invokeCli([...args, ...flags], {
            cwd: fixture.root,
            platform,
            output: (message) => output.push(message),
        });
        assert.equal(code, 1);
        assert.equal(JSON.parse(output.join("\n")).error.code, expectedCode, `${platform} ${flags.join(" ")}`);
    }
});

test("Commander keeps JSON errors for invalid options and conflicts", () => {
    for (const args of [
        ["--timeout-ms", "0", "mcp", "tools", "--json"],
        ["open", "--foreground", "--background", "--json"],
        ["open", "--wait", "--foreground", "--json"],
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
