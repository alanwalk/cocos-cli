import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { assertEditorVersion, ensureProject, inspectProject, openProjectWindow, restartProject, stopProject, STOP_EDITOR_SCRIPT } from "../dist/lifecycle.js";
import { getProjectIdentity } from "../dist/mcp.js";
import { readProjectState } from "../dist/state.js";
import { createProjectFixture } from "./helpers.js";

function harness(t, overrides = {}) {
    const fixture = createProjectFixture();
    t.after(fixture.cleanup);
    const state = { running: false, ready: false, launches: 0, toolCalls: [], alive: true };
    const endpoint = `http://127.0.0.1:29991/mcp/project/${getProjectIdentity(fixture.root)}/`;
    const creator = {
        path: path.join(fixture.root, "CocosCreator"),
        source: "argument",
        requiredVersion: "3.8.8",
        actualVersion: "3.8.8",
        versionVerified: true,
        versionMatch: true,
    };
    const deps = {
        discoverMcpEndpoints: () => [endpoint],
        probeMcp: async () => state.ready ? {
            ready: true, reachable: true, projectMatched: true, projectRoot: fixture.root,
            projectId: getProjectIdentity(fixture.root), endpoint, editorVersion: "3.8.8",
            readiness: { importsComplete: null, scriptsCompiled: null },
        } : { ready: false, reachable: false, projectMatched: false, endpoint, error: { code: "MCP_OFFLINE", message: "offline" } },
        listCreatorProcesses: async () => ({ supported: true, processes: state.running ? [{ pid: 4242, projectRoot: fixture.root, executable: creator.path }] : [] }),
        resolveCreator: () => creator,
        launchDetached: async () => {
            state.launches += 1;
            state.running = true;
            state.ready = true;
            return 4242;
        },
        isProcessAlive: () => state.alive,
        captureForegroundWindow: async () => "1234",
        callMcpTool: async (request) => {
            state.toolCalls.push(request);
            state.running = false;
            state.ready = false;
            state.alive = false;
            return { ok: true, data: { quitScheduled: true, pid: 4242 } };
        },
        ...overrides,
    };
    const options = {
        project: { root: fixture.root, name: "fixture", creatorVersion: "3.8.8" },
        config: {}, env: {}, timeoutMs: 1500, requestTimeoutMs: 1000, pollIntervalMs: 5,
        dependencies: deps,
    };
    return { fixture, state, creator, options, deps, endpoint };
}

test("ensure reuses a verified existing project without resolving or launching an editor", async (t) => {
    const h = harness(t);
    h.state.running = true;
    h.state.ready = true;
    h.deps.resolveCreator = () => { throw new Error("must not resolve"); };
    const result = await ensureProject(h.options);
    assert.equal(result.ready, true);
    assert.equal(result.reused, true);
    assert.equal(result.launched, false);
    assert.equal(h.state.launches, 0);
    assert.equal(h.state.toolCalls.length, 0);
    assert.equal((await readProjectState(h.fixture.root)).endpoint, h.endpoint);
});

test("ensure uses the native window controller after verifying the target MCP", async (t) => {
    const h = harness(t);
    h.options.platform = "win32";
    h.deps.setEditorWindow = async ({ pid, mode, previousForeground }) => {
        assert.equal(pid, 4242);
        assert.equal(h.state.ready, true);
        assert.equal(previousForeground, mode === "background" ? "1234" : null);
        return { mode, visible: true, focused: false, frontmost: false };
    };

    const background = await ensureProject({ ...h.options, windowMode: "background" });
    const foreground = await ensureProject({ ...h.options, windowMode: "foreground" });

    assert.equal(background.launched, true);
    assert.equal(foreground.reused, true);
    assert.equal(h.state.launches, 1);
    assert.deepEqual(background.window, { mode: "background", visible: true, focused: false, frontmost: false });
    assert.deepEqual(foreground.window, { mode: "foreground", visible: true, focused: false, frontmost: false });
    assert.equal(h.state.toolCalls.length, 0);
});

test("background and foreground open share a Creator without probing MCP", async (t) => {
    const h = harness(t);
    h.options.platform = "win32";
    h.deps.probeMcp = async () => assert.fail("open must not probe MCP");
    const launch = h.deps.launchDetached;
    h.deps.launchDetached = async (command, args, options) => {
        assert.equal(options.windowsHide, true);
        return launch(command, args, options);
    };
    const windowRequests = [];
    h.deps.setEditorWindow = async ({ pid, mode, backgroundStartup, keepInBackground }) => {
        assert.equal(pid, 4242);
        windowRequests.push({ mode, backgroundStartup, keepInBackground });
        return { mode, visible: true, focused: false, frontmost: false };
    };

    const background = await openProjectWindow({ ...h.options, windowMode: "background" });
    const reused = await openProjectWindow({ ...h.options, windowMode: "background" });
    const foreground = await openProjectWindow({ ...h.options, windowMode: "foreground" });
    assert.equal(background.launched, true);
    assert.equal(background.window.visible, true);
    assert.equal(reused.reused, true);
    assert.equal(foreground.reused, true);
    assert.equal(h.state.launches, 1);
    assert.equal(foreground.window.visible, true);
    assert.equal(h.state.toolCalls.length, 0);
    assert.deepEqual(windowRequests, [
        { mode: "background", backgroundStartup: true, keepInBackground: true },
        { mode: "background", backgroundStartup: false, keepInBackground: true },
        { mode: "foreground", backgroundStartup: false, keepInBackground: false },
    ]);
});

test("macOS background and explicit foreground opens reuse the same Creator", async (t) => {
    const h = harness(t);
    h.options.platform = "darwin";
    h.deps.probeMcp = async () => assert.fail("open must not probe MCP");
    const windowRequests = [];
    h.deps.captureForegroundWindow = async () => {
        assert.equal(h.state.running, false);
        return "1234";
    };
    h.deps.setEditorWindow = async ({ pid, mode, previousForeground }) => {
        assert.equal(pid, 4242);
        windowRequests.push({ mode, previousForeground });
        const frontmost = mode === "foreground";
        return { mode, visible: true, focused: frontmost ? null : false, frontmost };
    };

    const options = { ...h.options, windowMode: "background" };
    const first = await openProjectWindow(options);
    const second = await openProjectWindow(options);
    const foreground = await openProjectWindow({ ...options, windowMode: "foreground" });
    assert.equal(first.launched, true);
    assert.equal(second.reused, true);
    assert.equal(foreground.reused, true);
    assert.equal(h.state.launches, 1);
    assert.equal(second.pid, first.pid);
    assert.equal(foreground.pid, first.pid);
    assert.deepEqual(windowRequests, [
        { mode: "background", previousForeground: "1234" },
        { mode: "background", previousForeground: null },
        { mode: "foreground", previousForeground: null },
    ]);
    assert.deepEqual(second.window, { mode: "background", visible: true, focused: false, frontmost: false });
    assert.deepEqual(foreground.window, { mode: "foreground", visible: true, focused: null, frontmost: true });
});

test("concurrent ensure calls launch only once and the next call reuses MCP", async (t) => {
    const h = harness(t);
    const [left, right] = await Promise.all([ensureProject(h.options), ensureProject(h.options)]);
    assert.equal(h.state.launches, 1);
    assert.equal(left.ready && right.ready, true);
    assert.equal(Number(left.launched) + Number(right.launched), 1);
    assert.equal(Number(left.reused) + Number(right.reused), 1);
});

test("existing Creator is waited for instead of launched a second time", async (t) => {
    const h = harness(t);
    h.state.running = true;
    let probes = 0;
    const baseProbe = h.deps.probeMcp;
    h.deps.probeMcp = async (request) => {
        probes += 1;
        if (probes === 2) h.state.ready = true;
        return baseProbe(request);
    };
    const result = await ensureProject(h.options);
    assert.equal(result.reused, true);
    assert.equal(h.state.launches, 0);
});

test("an explicit endpoint for another project prevents launch and tool calls", async (t) => {
    const h = harness(t);
    h.options.mcpUrl = h.endpoint;
    h.deps.probeMcp = async () => ({ ready: false, reachable: true, projectMatched: false, endpoint: h.endpoint, error: { code: "MCP_PROJECT_MISMATCH", message: "wrong project" } });
    await assert.rejects(ensureProject(h.options), { code: "MCP_PROJECT_MISMATCH" });
    assert.equal(h.state.launches, 0);
    assert.equal(h.state.toolCalls.length, 0);
});

test("an actual installation mismatch is rejected before Creator launch", async (t) => {
    const h = harness(t);
    h.creator.actualVersion = "3.8.7";
    h.creator.versionMatch = false;
    await assert.rejects(ensureProject(h.options), { code: "CREATOR_VERSION_MISMATCH" });
    assert.equal(h.state.launches, 0);
});

test("unknown installation metadata needs explicit opt-in, never bypasses a known mismatch", async (t) => {
    const h = harness(t);
    Object.assign(h.creator, { actualVersion: null, versionVerified: false, versionMatch: null });
    await assert.rejects(ensureProject(h.options), { code: "CREATOR_VERSION_UNVERIFIED" });
    const result = await ensureProject({ ...h.options, allowUnverifiedEditor: true });
    assert.equal(result.ready, true);
    assert.equal(result.editor.actualVersion, "3.8.8");
    assert.throws(() => assertEditorVersion({ ...h.creator, actualVersion: "3.8.7", versionMatch: false }, { allowUnverified: true }), { code: "CREATOR_VERSION_MISMATCH" });
});

test("MCP actual version mismatch blocks reuse even when project matches", async (t) => {
    const h = harness(t);
    h.deps.probeMcp = async () => ({ ready: false, reachable: true, projectMatched: true, editorVersion: "3.8.7", error: { code: "MCP_VERSION_MISMATCH", message: "wrong version" } });
    await assert.rejects(ensureProject(h.options), { code: "MCP_VERSION_MISMATCH" });
    assert.equal(h.state.launches, 0);
});

test("unknown process discovery cannot become permission to start a duplicate", async (t) => {
    const h = harness(t);
    h.deps.listCreatorProcesses = async () => ({ supported: true, processes: [], error: { message: "CIM unavailable" } });
    await assert.rejects(ensureProject(h.options), { code: "PROCESS_DISCOVERY_UNAVAILABLE" });
    assert.equal(h.state.launches, 0);
});

test("a Creator process with unreadable project arguments prevents duplicate launch and false stopped status", async (t) => {
    const h = harness(t);
    h.deps.listCreatorProcesses = async () => ({ supported: true, processes: [{ pid: 9988, executable: h.creator.path, commandLine: "CocosCreator" }] });
    await assert.rejects(ensureProject(h.options), { code: "EDITOR_PROJECT_UNKNOWN" });
    await assert.rejects(stopProject(h.options), { code: "MCP_REQUIRED_FOR_SAFE_STOP" });
    assert.equal(h.state.launches, 0);
});

test("readiness timeout preserves the started process and never respawns", async (t) => {
    const h = harness(t);
    h.options.timeoutMs = 50;
    let now = Date.now();
    h.deps.now = () => now;
    h.deps.delay = async (milliseconds) => { now += milliseconds; };
    const launch = h.deps.launchDetached;
    h.deps.launchDetached = async (...args) => {
        const pid = await launch(...args);
        h.state.ready = false;
        return pid;
    };
    await assert.rejects(ensureProject(h.options), { code: "EDITOR_READY_TIMEOUT" });
    assert.equal(h.state.launches, 1);
    assert.equal(h.state.running, true);
    assert.equal((await readProjectState(h.fixture.root)).pid, 4242);
});

test("Creator early exit is a startup failure instead of an endless relaunch", async (t) => {
    const h = harness(t);
    h.deps.launchDetached = async () => { h.state.launches += 1; return 4242; };
    h.deps.isProcessAlive = () => false;
    await assert.rejects(ensureProject(h.options), { code: "CREATOR_EXITED_BEFORE_READY" });
    assert.equal(h.state.launches, 1);
});

test("status never starts a process and exposes offline state", async (t) => {
    const h = harness(t);
    const result = await inspectProject(h.options);
    assert.equal(result.ok, false);
    assert.equal(result.mcp.error.code, "MCP_OFFLINE");
    assert.equal(h.state.launches, 0);
});

test("stop does not terminate an unresponsive editor with no verified MCP", async (t) => {
    const h = harness(t);
    h.state.running = true;
    await assert.rejects(stopProject(h.options), { code: "MCP_REQUIRED_FOR_SAFE_STOP" });
    assert.equal(h.state.toolCalls.length, 0);
});

test("stop is idempotent for a project that is already stopped", async (t) => {
    const h = harness(t);
    const result = await stopProject(h.options);
    assert.equal(result.alreadyStopped, true);
    assert.equal(h.state.toolCalls.length, 0);
});

test("stop refuses unsaved scenes and does not advance restart", async (t) => {
    const h = harness(t);
    h.state.running = true;
    h.state.ready = true;
    h.deps.callMcpTool = async () => ({ data: { quitScheduled: false, reason: "SCENE_DIRTY" } });
    await assert.rejects(restartProject(h.options), { code: "SCENE_DIRTY" });
    assert.equal(h.state.launches, 0);
});

test("normal stop uses verified editor RPC and clears only process state", async (t) => {
    const h = harness(t);
    h.state.running = true;
    h.state.ready = true;
    const result = await stopProject({ ...h.options, save: true });
    assert.equal(result.stopped, true);
    assert.equal(h.state.toolCalls[0].name, "execute_javascript");
    assert.equal(h.state.toolCalls[0].args.args.save, true);
    const state = await readProjectState(h.fixture.root);
    assert.equal(state.pid, null);
    assert.equal(state.endpoint, h.endpoint);
});

test("restart never launches while normal quit is still blocked", async (t) => {
    const h = harness(t);
    h.state.running = true;
    h.state.ready = true;
    h.deps.callMcpTool = async () => ({ data: { quitScheduled: true, pid: 4242 } });
    await assert.rejects(restartProject({ ...h.options, timeoutMs: 550 }), { code: "EDITOR_STOP_TIMEOUT" });
    assert.equal(h.state.launches, 0);
});

test("normal restart stops then launches once and verifies new readiness", async (t) => {
    const h = harness(t);
    h.state.running = true;
    h.state.ready = true;
    const launch = h.deps.launchDetached;
    h.deps.launchDetached = async (...args) => { h.state.alive = true; return launch(...args); };
    const result = await restartProject(h.options);
    assert.equal(result.restarted, true);
    assert.equal(result.ready, true);
    assert.equal(h.state.launches, 1);
});

test("restart checks the replacement editor before closing a working instance", async (t) => {
    const h = harness(t);
    h.state.running = true;
    h.state.ready = true;
    h.creator.actualVersion = "3.8.7";
    h.creator.versionMatch = false;
    await assert.rejects(restartProject(h.options), { code: "CREATOR_VERSION_MISMATCH" });
    assert.equal(h.state.toolCalls.length, 0);
    assert.equal(h.state.running, true);
});

test("an expired stop budget never sends a quit RPC", async (t) => {
    const h = harness(t);
    h.state.ready = true;
    let now = 0;
    h.deps.now = () => now;
    h.deps.listCreatorProcesses = async () => {
        now = 2000;
        return { supported: true, processes: [{ pid: 4242, projectRoot: h.fixture.root }] };
    };
    await assert.rejects(stopProject({ ...h.options, timeoutMs: 1000 }), { code: "EDITOR_STOP_TIMEOUT" });
    assert.equal(h.state.toolCalls.length, 0);
});

test("stop script checks dirty state, saves when requested and schedules normal App.quit", async (t) => {
    const fixture = createProjectFixture();
    t.after(fixture.cleanup);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const runner = new AsyncFunction("Editor", "args", "path", "fs", "require", "setTimeout", `${STOP_EDITOR_SCRIPT}\nreturn run({ Editor, args, path, fs });`);
    let dirty = true;
    let quitCount = 0;
    let scheduled;
    const calls = [];
    const Editor = {
        Project: { path: fixture.root },
        App: { version: "3.8.8", quit: () => { quitCount += 1; } },
        Message: { request: async (_channel, name) => {
            calls.push(name);
            if (name === "query-dirty") return dirty;
            if (name === "save-scene") { dirty = false; return true; }
            throw new Error("unexpected message");
        } },
    };
    const args = { projectRoot: fixture.root, expectedVersion: "3.8.8", save: false };
    const requireProcess = () => ({ pid: 12345, platform: process.platform });
    const schedule = (callback) => { scheduled = callback; };
    const refused = await runner(Editor, args, path, fs, requireProcess, schedule);
    assert.equal(refused.reason, "SCENE_DIRTY");
    assert.equal(scheduled, undefined);
    const result = await runner(Editor, { ...args, save: true }, path, fs, requireProcess, schedule);
    assert.equal(result.quitScheduled, true);
    assert.deepEqual(calls, ["query-dirty", "query-dirty", "save-scene", "query-dirty"]);
    assert.equal(quitCount, 0);
    scheduled();
    assert.equal(quitCount, 1);
    const expired = await runner(Editor, { ...args, deadlineAt: Date.now() - 1 }, path, fs, requireProcess, schedule);
    assert.equal(expired.reason, "STOP_REQUEST_EXPIRED");
});
