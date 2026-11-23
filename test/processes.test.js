import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isProcessAlive, listCreatorProcesses, normalizeProjectPath, parseProjectFromCommandLine, splitWindowsCommandLine } from "../dist/processes.js";
import { launchDetached } from "../dist/runner.js";

test("Windows 解析引号、空格、等号和尾部反斜杠", () => {
    const command = '"C:\\Program Files\\Cocos\\CocosCreator.exe" --project "C:\\Games\\My Game" --log-level 4';
    assert.equal(parseProjectFromCommandLine(command, { platform: "win32" }), "c:\\games\\my game");
    assert.equal(parseProjectFromCommandLine('CocosCreator.exe --project="D:\\Games\\Other Game"', { platform: "win32" }), "d:\\games\\other game");
    assert.deepEqual(splitWindowsCommandLine('CocosCreator.exe --project C:\\Game\\ --debug'), ["CocosCreator.exe", "--project", "C:\\Game\\", "--debug"]);
    assert.deepEqual(splitWindowsCommandLine('"C:\\Program Files\\Creator.exe" "one\\\\" "a\\\"b"'), ["C:\\Program Files\\Creator.exe", "one\\", 'a"b']);
});

test("macOS 解析 shell 引号以及 ps 丢失引号的工程空格", () => {
    assert.equal(parseProjectFromCommandLine("/Applications/CocosCreator --project '/Users/alan/My Game' --debug", { platform: "darwin" }), "/Users/alan/My Game");
    assert.equal(parseProjectFromCommandLine('/Applications/CocosCreator --project="/Users/alan/My Game" --debug', { platform: "darwin" }), "/Users/alan/My Game");
    assert.equal(parseProjectFromCommandLine("/Applications/CocosCreator --project /Users/alan/My Game --debug", { platform: "darwin" }), "/Users/alan/My Game");
    assert.equal(parseProjectFromCommandLine("/Applications/CocosCreator --project /Users/alan/My\\ Game", { platform: "darwin" }), "/Users/alan/My Game");
});

test("拒绝相对工程、重复工程参数与未闭合的 POSIX 引号", () => {
    assert.equal(parseProjectFromCommandLine("CocosCreator --project ../game", { platform: "darwin" }), undefined);
    assert.equal(parseProjectFromCommandLine("CocosCreator --project /one --project=/two", { platform: "darwin" }), undefined);
    assert.equal(parseProjectFromCommandLine('CocosCreator --project "/missing quote', { platform: "darwin" }), undefined);
    assert.equal(parseProjectFromCommandLine("CocosCreator --project"), undefined);
    assert.equal(parseProjectFromCommandLine("CocosCreator --project-id=/one"), undefined);
});

test("工程路径正规化不会把不同工程混为一体", () => {
    assert.equal(normalizeProjectPath("C:/Games/My Game/../My Game/", { platform: "win32" }), "c:\\games\\my game");
    assert.notEqual(normalizeProjectPath("C:/Games/One", { platform: "win32" }), normalizeProjectPath("C:/Games/Two", { platform: "win32" }));
    assert.equal(normalizeProjectPath("/games/one/../two/", { platform: "darwin" }), "/games/two");
});

test("Windows CIM 查询仅保留 Creator 主进程，保留权限不足时的未知工程", async () => {
    const calls = [];
    const env = { PATH: "a path with ; shell characters" };
    const result = await listCreatorProcesses({
        platform: "win32",
        env,
        execFileImpl: async (...args) => {
            calls.push(args);
            return { stdout: JSON.stringify([
                { ProcessId: 101, ExecutablePath: "C:\\Cocos\\CocosCreator.exe", CommandLine: 'CocosCreator.exe --project "C:\\Games\\One"' },
                { ProcessId: 102, ExecutablePath: "C:\\Cocos\\CocosCreator.exe", CommandLine: 'CocosCreator.exe --project "C:\\Games\\Two"' },
                { ProcessId: 103, ExecutablePath: "C:\\Cocos\\CocosCreator.exe", CommandLine: "CocosCreator.exe --type=renderer" },
                { ProcessId: 104, ExecutablePath: null, CommandLine: null },
                { ProcessId: 105, ExecutablePath: "C:\\Other.exe", CommandLine: "Other.exe --project C:\\Games\\One" },
            ]) };
        },
    });
    assert.equal(result.supported, true);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.processes.map(({ pid, projectRoot }) => ({ pid, projectRoot })), [
        { pid: 101, projectRoot: "c:\\games\\one" },
        { pid: 102, projectRoot: "c:\\games\\two" },
        { pid: 104, projectRoot: undefined },
    ]);
    assert.equal(calls[0][0], "powershell.exe");
    assert.match(calls[0][1].at(-1), /Get-CimInstance Win32_Process/);
    assert.match(calls[0][1].at(-1), /Name = 'CocosCreator.exe'/);
    assert.equal(calls[0][2].shell, false);
    assert.equal(calls[0][2].env, env);
    assert.doesNotMatch(calls[0][1].at(-1), /a path with/);
});

test("macOS 先从 comm 精确筛选 Creator，再按 PID 查询 args", async () => {
    const calls = [];
    const result = await listCreatorProcesses({
        platform: "darwin",
        execFileImpl: async (...args) => {
            calls.push(args);
            if (calls.length === 1) return { stdout: [
                " 201 /Applications/Cocos Suite/CocosCreator.app/Contents/MacOS/CocosCreator",
                " 202 /Applications/CocosCreator Helper",
                " 203 /usr/bin/node",
                " 204 /Applications/CocosCreator.app/Contents/MacOS/CocosCreator",
                " 205 /Applications/CocosCreator.app/Contents/MacOS/CocosCreator",
            ].join("\n") };
            return { stdout: [
                " 201 /Applications/Cocos Suite/CocosCreator.app/Contents/MacOS/CocosCreator --project /Users/alan/My Game --debug",
                " 204 /Applications/CocosCreator.app/Contents/MacOS/CocosCreator --type=renderer",
            ].join("\n") };
        },
    });
    assert.deepEqual(calls[1][1], ["-ww", "-p", "201,204,205", "-o", "pid=,args="]);
    assert.deepEqual(result.processes.map(({ pid }) => pid), [201, 205]);
    assert.equal(result.processes[0].projectRoot, "/Users/alan/My Game");
    assert.equal(result.processes[0].executable, "/Applications/Cocos Suite/CocosCreator.app/Contents/MacOS/CocosCreator");
    assert.equal(result.processes[1].projectRoot, undefined);
});

test("Linux 没有 Creator 时不做第二次查询；查询失败不能伪装成成功空列表", async () => {
    let calls = 0;
    assert.deepEqual(await listCreatorProcesses({
        platform: "linux",
        execFileImpl: async () => {
            calls += 1;
            return { stdout: "123 node\n456 bash\n" };
        },
    }), { supported: true, processes: [] });
    assert.equal(calls, 1);
    const failed = await listCreatorProcesses({ platform: "linux", execFileImpl: async () => { throw new Error("permission denied"); } });
    assert.equal(failed.supported, true);
    assert.match(failed.error, /permission denied/);
    const unsupported = await listCreatorProcesses({ platform: "unsupported", execFileImpl: async () => assert.fail("不应执行") });
    assert.equal(unsupported.supported, false);
});

test("两次 ps 查询共用总预算，耗尽后不再查询或报告成功空列表", async (t) => {
    let clock = 1000;
    t.mock.method(Date, "now", () => clock);
    const budgets = [];
    const result = await listCreatorProcesses({
        platform: "linux",
        timeoutMs: 50,
        execFileImpl: async (_command, _args, options) => {
            budgets.push(options.timeout);
            if (budgets.length === 1) {
                clock += 30;
                return { stdout: "201 CocosCreator\n" };
            }
            clock += 5;
            return { stdout: "201 CocosCreator --project /games/one\n" };
        },
    });
    assert.deepEqual(budgets, [50, 20]);
    assert.equal(result.error, undefined);
    assert.equal(result.processes[0].projectRoot, "/games/one");

    for (const stdout of ["201 CocosCreator\n", ""]) {
        let calls = 0;
        const expired = await listCreatorProcesses({
            platform: "linux",
            timeoutMs: 50,
            execFileImpl: async () => {
                calls += 1;
                clock += 50;
                return { stdout };
            },
        });
        assert.equal(calls, 1);
        assert.equal(expired.supported, true);
        assert.match(expired.error, /查询超时.*总预算 50ms 已耗尽/);
    }
});

test("进程存活探测只接受正 PID", () => {
    assert.equal(isProcessAlive(process.pid), true);
    for (const pid of [0, -1, NaN, "1", 1.5, 2147483648]) assert.equal(isProcessAlive(pid), false);
});

test("detached 启动可记录 stdout/stderr 并保留 PID 返回值", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "cocos-cli-launch-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const logFile = join(directory, "nested", "startup.log");
    const pid = await launchDetached(process.execPath, ["-e", "console.log('stdout marker'); console.error('stderr marker')"], { logFile });
    assert.equal(typeof pid, "number");
    const deadline = Date.now() + 3000;
    let log = "";
    while (Date.now() < deadline) {
        log = await readFile(logFile, "utf8");
        if (log.includes("stderr marker")) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(log, /stdout marker/);
    assert.match(log, /stderr marker/);
});

test("detached 启动错误包含日志路径而不会吞掉异常", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "cocos-cli-launch-error-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const logFile = join(directory, "startup.log");
    await assert.rejects(() => launchDetached(join(directory, "missing-editor"), [], { logFile }), (error) => {
        assert.equal(error.code, "CREATOR_START_FAILED");
        assert.ok(error.details.includes(`启动日志: ${logFile}`));
        return true;
    });
});
