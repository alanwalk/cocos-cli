import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { getProjectStatePaths, readProjectState, withProjectLock, writeProjectState } from "../dist/state.js";
import { createProjectFixture } from "./helpers.js";

const execFileAsync = promisify(execFile);
const stateModuleUrl = new URL("../dist/state.js", import.meta.url).href;

function fixtureFor(t) {
    const fixture = createProjectFixture();
    t.after(() => fixture.cleanup());
    return fixture;
}

async function seedLock(root, overrides = {}) {
    const paths = getProjectStatePaths(root);
    await mkdir(paths.lockDirectory, { recursive: true });
    const owner = {
        version: 1,
        token: randomUUID(),
        pid: 2147483647,
        projectRoot: paths.projectRoot,
        createdAt: new Date().toISOString(),
        ...overrides,
    };
    await writeFile(join(paths.lockDirectory, "owner.json"), JSON.stringify(owner));
    return { paths, owner };
}

test("不存在的状态返回 null；连接及停止状态保留 endpoint，允许空 PID 和时间", async (t) => {
    const fixture = fixtureFor(t);
    assert.equal(await readProjectState(fixture.root), null);
    await assert.rejects(access(join(fixture.root, "temp")), { code: "ENOENT" });
    const written = await writeProjectState(fixture.root, { endpoint: "http://127.0.0.1:8765/" });
    assert.deepEqual(written, {
        version: 1,
        projectRoot: getProjectStatePaths(fixture.root).projectRoot,
        endpoint: "http://127.0.0.1:8765/",
        pid: null,
        startedAt: null,
        editorPath: null,
    });
    assert.deepEqual(await readProjectState(fixture.root), written);
});

test("状态读写拒绝其他工程身份以及无效版本", async (t) => {
    const first = fixtureFor(t);
    const second = fixtureFor(t);
    await assert.rejects(() => writeProjectState(first.root, { projectRoot: second.root }), { code: "STATE_PROJECT_MISMATCH" });
    const secondState = await writeProjectState(second.root, {});
    const paths = getProjectStatePaths(first.root);
    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.stateFile, JSON.stringify(secondState));
    await assert.rejects(() => readProjectState(first.root), { code: "STATE_PROJECT_MISMATCH" });
    await writeFile(paths.stateFile, JSON.stringify({ ...secondState, projectRoot: first.root, version: 2 }));
    await assert.rejects(() => readProjectState(first.root), { code: "INVALID_STATE" });
});

test("并发原子写入不会暴露半个 JSON 或遗留临时文件", async (t) => {
    const fixture = fixtureFor(t);
    await writeProjectState(fixture.root, { endpoint: "http://127.0.0.1:8765/" });
    const writes = Array.from({ length: 12 }, (_, index) => writeProjectState(fixture.root, { pid: process.pid, endpoint: `http://127.0.0.1:${8765 + index}/` }));
    const reads = Array.from({ length: 20 }, async () => {
        const value = await readProjectState(fixture.root);
        assert.equal(value.version, 1);
        assert.equal(value.projectRoot, getProjectStatePaths(fixture.root).projectRoot);
    });
    await Promise.all([...writes, ...reads]);
    assert.deepEqual(await readdir(getProjectStatePaths(fixture.root).directory), ["state.json"]);
});

test("同一工程的并发操作串行执行并在完成后释放锁", async (t) => {
    const fixture = fixtureFor(t);
    let active = 0;
    let maxActive = 0;
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => withProjectLock(fixture.root, async () => {
        active += 1;
        maxActive = Math.max(active, maxActive);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return index;
    }, { pollIntervalMs: 2, timeoutMs: 1000 })));
    assert.equal(maxActive, 1);
    assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
    await assert.rejects(access(getProjectStatePaths(fixture.root).lockDirectory), { code: "ENOENT" });
});

test("三个独立 Node 进程共享工程锁，不重叠执行", async (t) => {
    const fixture = fixtureFor(t);
    const script = `
        import { withProjectLock } from ${JSON.stringify(stateModuleUrl)};
        import { open, unlink } from 'node:fs/promises';
        import { join } from 'node:path';
        const root = process.argv[1];
        for (let index = 0; index < 3; index += 1) {
            await withProjectLock(root, async () => {
                const marker = join(root, 'active-operation');
                const handle = await open(marker, 'wx');
                await handle.close();
                try { await new Promise(resolve => setTimeout(resolve, 5)); }
                finally { await unlink(marker); }
            }, { timeoutMs: 3000, pollIntervalMs: 2 });
        }
    `;
    await Promise.all(Array.from({ length: 3 }, () => execFileAsync(process.execPath, ["--input-type=module", "-e", script, fixture.root], { timeout: 5000 })));
    await assert.rejects(access(getProjectStatePaths(fixture.root).lockDirectory), { code: "ENOENT" });
});

test("真实已退出的测试子进程留下的锁可以恢复", async (t) => {
    const fixture = fixtureFor(t);
    const script = `
        import { withProjectLock } from ${JSON.stringify(stateModuleUrl)};
        await withProjectLock(process.argv[1], () => process.exit(0));
    `;
    await execFileAsync(process.execPath, ["--input-type=module", "-e", script, fixture.root], { timeout: 3000 });
    assert.equal(await withProjectLock(fixture.root, () => "recovered"), "recovered");
});

test("不同工程互不阻塞", async (t) => {
    const first = fixtureFor(t);
    const second = fixtureFor(t);
    let release;
    let entered;
    const entering = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const held = withProjectLock(first.root, async () => { entered(); await gate; });
    await entering;
    try {
        assert.equal(await withProjectLock(second.root, async () => "independent", { timeoutMs: 0 }), "independent");
    } finally {
        release();
        await held;
    }
});

test("活 owner 锁等待超时后保留原 owner，不误删", async (t) => {
    const fixture = fixtureFor(t);
    const { paths, owner } = await seedLock(fixture.root, { pid: process.pid });
    await assert.rejects(() => withProjectLock(fixture.root, () => assert.fail("不应进入"), { timeoutMs: 25, pollIntervalMs: 2 }), { code: "PROJECT_LOCK_TIMEOUT" });
    assert.equal(JSON.parse(await readFile(join(paths.lockDirectory, "owner.json"), "utf8")).token, owner.token);
});

test("确认 owner 已退出后恢复锁；多个恢复者也只执行一个操作", async (t) => {
    const fixture = fixtureFor(t);
    await seedLock(fixture.root);
    const probes = [];
    let active = 0;
    let maxActive = 0;
    await Promise.all(Array.from({ length: 5 }, () => withProjectLock(fixture.root, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
    }, {
        timeoutMs: 1000,
        pollIntervalMs: 2,
        isProcessAliveImpl: (pid) => { probes.push(pid); return pid === process.pid; },
    })));
    assert.ok(probes.includes(2147483647));
    assert.equal(maxActive, 1);
});

test("尚未写 owner 的新锁不会被立即回收；久未完成初始化的锁可恢复", async (t) => {
    const fixture = fixtureFor(t);
    const paths = getProjectStatePaths(fixture.root);
    await mkdir(paths.lockDirectory, { recursive: true });
    await assert.rejects(() => withProjectLock(fixture.root, () => assert.fail("不应进入"), { timeoutMs: 10, pollIntervalMs: 2 }), { code: "PROJECT_LOCK_TIMEOUT" });
    const old = new Date(Date.now() - 60000);
    await utimes(paths.lockDirectory, old, old);
    assert.equal(await withProjectLock(fixture.root, () => "recovered"), "recovered");
});

test("owner 属于其他工程时拒绝恢复", async (t) => {
    const first = fixtureFor(t);
    const second = fixtureFor(t);
    const { paths, owner } = await seedLock(first.root, { projectRoot: second.root });
    await assert.rejects(() => withProjectLock(first.root, () => assert.fail("不应进入")), { code: "PROJECT_LOCK_INVALID" });
    assert.equal(JSON.parse(await readFile(join(paths.lockDirectory, "owner.json"), "utf8")).token, owner.token);
});

test("锁被替换时拒绝删除其他 token", async (t) => {
    const fixture = fixtureFor(t);
    const paths = getProjectStatePaths(fixture.root);
    const foreignToken = randomUUID();
    await assert.rejects(() => withProjectLock(fixture.root, async () => {
        const owner = JSON.parse(await readFile(join(paths.lockDirectory, "owner.json"), "utf8"));
        await writeFile(join(paths.lockDirectory, "owner.json"), JSON.stringify({ ...owner, token: foreignToken }));
    }), { code: "PROJECT_LOCK_OWNERSHIP_LOST" });
    assert.equal(JSON.parse(await readFile(join(paths.lockDirectory, "owner.json"), "utf8")).token, foreignToken);
});

test("操作失败也释放锁，原异常保留", async (t) => {
    const fixture = fixtureFor(t);
    const expected = new Error("operation failed");
    await assert.rejects(() => withProjectLock(fixture.root, () => { throw expected; }), (error) => error === expected);
    assert.equal(await withProjectLock(fixture.root, () => "next"), "next");
});

test("拒绝 temp 或锁目录符号链接，避免路径穿越", { skip: process.platform === "win32" }, async (t) => {
    const first = fixtureFor(t);
    const second = fixtureFor(t);
    await symlink(second.root, join(first.root, "temp"), "dir");
    await assert.rejects(() => writeProjectState(first.root, {}), { code: "STATE_PATH_UNSAFE" });
    await assert.rejects(() => withProjectLock(first.root, () => assert.fail("不应进入")), { code: "STATE_PATH_UNSAFE" });
    const third = fixtureFor(t);
    const paths = getProjectStatePaths(third.root);
    await mkdir(paths.directory, { recursive: true });
    await symlink(second.root, paths.lockDirectory, "dir");
    await assert.rejects(() => withProjectLock(third.root, () => assert.fail("不应进入")), { code: "STATE_PATH_UNSAFE" });
    await assert.rejects(access(join(second.root, "owner.json")), { code: "ENOENT" });
});
