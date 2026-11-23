import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import test from "node:test";

import { callMcpTool, discoverMcpEndpoints, getProjectIdentity, getProjectPort, normalizeMcpEndpoint, normalizeProjectPath, probeMcp } from "../dist/mcp.js";
import { createProjectFixture } from "./helpers.js";

const PROTOCOL = "2025-11-25";
const META = "io.funplay.cocos/context";

function makeContext(root, instance = "fixture-instance") {
    const id = getProjectIdentity(root);
    return { project_id: id, project_path: root, instance_id: instance, expected_context: `${id}:${instance}` };
}

async function serve(t, handler) {
    const server = http.createServer(async (req, res) => {
        try {
            let text = "";
            for await (const chunk of req) text += chunk;
            await handler(req, res, text ? JSON.parse(text) : null);
        } catch (error) {
            if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: error.message }));
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });
    return `http://127.0.0.1:${server.address().port}`;
}

function fixture(t) {
    const project = createProjectFixture();
    t.after(project.cleanup);
    return project;
}

function funplayHandler(root, options = {}) {
    const context = options.context || makeContext(root);
    const calls = [];
    let initialized = false;
    const handler = async (req, res, rpc) => {
        calls.push({ url: req.url, headers: req.headers, rpc });
        if (options.override && await options.override(req, res, rpc)) return;
        const headers = { "Content-Type": "application/json", "MCP-Protocol-Version": PROTOCOL };
        if (rpc.method === "initialize") {
            if (options.session) headers["Mcp-Session-Id"] = "fixture-session";
            const result = { protocolVersion: PROTOCOL, serverInfo: { name: "funplay-cocos-mcp", version: "0.7.6" },
                funplay: { server: "funplay-cocos-mcp", routingVersion: 1, projectIdentity: context.project_id, context } };
            res.writeHead(200, headers);
            res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
            return;
        }
        assert.equal(req.headers["mcp-protocol-version"], PROTOCOL);
        assert.equal(req.headers.accept, "application/json, text/event-stream");
        if (options.session) assert.equal(req.headers["mcp-session-id"], "fixture-session");
        if (rpc.method === "notifications/initialized") {
            initialized = true;
            res.writeHead(202, headers);
            res.end();
            return;
        }
        assert.equal(initialized, true);
        assert.equal(rpc.params.arguments.expected_context, context.expected_context);
        assert.equal(rpc.params._meta.expected_context, context.expected_context);
        const name = rpc.params.name;
        const info = { projectPath: root, projectIdentity: context.project_id, projectContext: context, cocosVersion: options.version || "3.8.8" };
        let data = name === "get_project_info" ? info : name === "get_editor_state"
            ? { ...info, status: { ...info, running: true }, scene: { sceneName: "Main", uuid: "scene-uuid", childCount: 0 } }
            : { value: 42 };
        if (options.data) data = options.data(name, data);
        const outputContext = options.outputContext?.(name) || context;
        const envelope = { ok: true, tool: name, callId: "fixture-call", timestamp: new Date().toISOString(), data, projectContext: outputContext };
        const result = { content: [{ type: "text", text: JSON.stringify(envelope) }], _meta: { [META]: outputContext } };
        if (!options.textOnly) result.structuredContent = envelope;
        const payload = { jsonrpc: "2.0", id: rpc.id, result };
        if (options.sse) {
            res.writeHead(200, { ...headers, "Content-Type": "text/event-stream" });
            res.write(": heartbeat\r\n\r\n");
            res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\r\n\r\n`);
            res.write(`event: message\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`);
            // Leave the stream open: the client must finish after its matching response.
        } else {
            res.writeHead(200, headers);
            res.end(JSON.stringify(payload));
        }
    };
    return { handler, calls };
}

test("discovery follows Funplay project hash, fixed config and bounded collision fallback", (t) => {
    const project = fixture(t);
    const rootPath = project.root.replace(/\\/g, "/");
    const expectedId = createHash("sha256").update(`funplay-cocos-mcp:${process.platform === "win32" ? rootPath.toLowerCase() : rootPath}`).digest("hex").slice(0, 24);
    assert.equal(getProjectIdentity(project.root), expectedId);
    const urls = discoverMcpEndpoints({ projectRoot: project.root, env: {} });
    assert.equal(urls.length, 21);
    assert.equal(urls[0], `http://127.0.0.1:${getProjectPort(project.root)}/mcp/project/${expectedId}/`);
    assert.equal(Number(new URL(urls.at(-1)).port), getProjectPort(project.root) + 20);
    writeFileSync(join(project.root, "funplay-cocos-mcp.config.json"), JSON.stringify({ port: 8765 }));
    assert.equal(new URL(discoverMcpEndpoints({ projectRoot: project.root, env: {} })[0]).port, "8765");
    assert.equal(new URL(discoverMcpEndpoints({ projectRoot: project.root, env: { COCOS_MCP_PORT: "9876" } })[0]).port, "9876");
    const saved = "http://127.0.0.1:8888/mcp";
    assert.equal(discoverMcpEndpoints({ projectRoot: project.root, stateEndpoint: saved, env: {} })[0], saved);
    assert.deepEqual(discoverMcpEndpoints({ projectRoot: project.root, explicitUrl: saved, env: {} }), [saved]);
    assert.deepEqual(discoverMcpEndpoints({ projectRoot: project.root, config: { url: saved }, env: {} }), [saved]);
    assert.deepEqual(discoverMcpEndpoints({ projectRoot: project.root, config: { url: "http://127.0.0.1:1/" }, env: { COCOS_CLI_MCP_URL: saved } }), [saved]);
});

test("path normalization matches Windows case/slashes and preserves macOS case", () => {
    assert.equal(normalizeProjectPath("C:\\Games\\Demo\\..\\Test", "win32"), "c:/games/test");
    assert.equal(getProjectIdentity("C:\\Games\\Test", "win32"), getProjectIdentity("c:/games/test", "win32"));
    assert.notEqual(getProjectIdentity("/Users/Test", "darwin"), getProjectIdentity("/Users/test", "darwin"));
});

test("only loopback HTTP endpoints are accepted", () => {
    for (const url of ["https://127.0.0.1:8765/", "http://example.com/", "http://127.0.0.1.example.com/", "http://192.168.1.1/", "file:///tmp/mcp"]) {
        assert.throws(() => normalizeMcpEndpoint(url), { code: "MCP_REMOTE_ENDPOINT" });
    }
    assert.throws(() => normalizeMcpEndpoint("http://user:secret@127.0.0.1/"), { code: "MCP_INVALID_URL" });
    assert.equal(normalizeMcpEndpoint("http://[::1]:8765/mcp"), "http://[::1]:8765/mcp");
});

test("probe verifies actual Funplay envelopes, scoped path, session and version", async (t) => {
    const project = fixture(t);
    const fake = funplayHandler(project.root, { session: true });
    const base = await serve(t, fake.handler);
    const endpoint = `${base}/mcp/project/${getProjectIdentity(project.root)}/`;
    const connection = await probeMcp({ url: endpoint, projectRoot: project.root, expectedVersion: "3.8.8" });
    assert.equal(connection.ready, true, JSON.stringify(connection.error));
    assert.equal(connection.projectMatched, true);
    assert.equal(connection.editorVersion, "3.8.8");
    assert.equal(connection.sessionId, "fixture-session");
    assert.equal(connection.readiness.importsComplete, null);
    const result = await callMcpTool({ connection, name: "execute_javascript", args: { context: "editor", code: "return 42;" } });
    assert.deepEqual(result.data, { value: 42 });
    assert.ok(fake.calls.every((call) => call.url === new URL(endpoint).pathname));
});

test("simple SSE responses and text-only tool envelopes are supported", async (t) => {
    const project = fixture(t);
    const fake = funplayHandler(project.root, { sse: true, textOnly: true });
    const base = await serve(t, fake.handler);
    const connection = await probeMcp({ url: `${base}/mcp`, projectRoot: project.root, timeoutMs: 1500 });
    assert.equal(connection.ready, true, JSON.stringify(connection.error));
});

test("wrong project is rejected before any tool calls", async (t) => {
    const target = fixture(t);
    const other = fixture(t);
    const fake = funplayHandler(other.root);
    const base = await serve(t, fake.handler);
    const result = await probeMcp({ url: base, projectRoot: target.root });
    assert.equal(result.ready, false);
    assert.equal(result.reachable, true);
    assert.equal(result.projectMatched, false);
    assert.equal(result.error.code, "MCP_PROJECT_MISMATCH");
    assert.equal(fake.calls.length, 1);
});

test("forged identity hash and inconsistent get_project_info are rejected", async (t) => {
    const project = fixture(t);
    const context = makeContext(project.root);
    context.project_id = "a".repeat(24);
    context.expected_context = `${context.project_id}:${context.instance_id}`;
    const forged = await serve(t, funplayHandler(project.root, { context }).handler);
    assert.equal((await probeMcp({ url: forged, projectRoot: project.root })).error.code, "MCP_PROJECT_MISMATCH");
    const inconsistent = await serve(t, funplayHandler(project.root, { data: (name, data) => name === "get_project_info" ? { ...data, projectIdentity: "b".repeat(24) } : data }).handler);
    assert.equal((await probeMcp({ url: inconsistent, projectRoot: project.root })).error.code, "MCP_PROJECT_MISMATCH");
});

test("actual Creator version mismatch fails readiness and no scene remains explicit", async (t) => {
    const project = fixture(t);
    const old = await serve(t, funplayHandler(project.root, { version: "3.8.7" }).handler);
    const mismatch = await probeMcp({ url: old, projectRoot: project.root, expectedVersion: "3.8.8" });
    assert.equal(mismatch.error.code, "MCP_VERSION_MISMATCH");
    assert.equal(mismatch.editorVersion, "3.8.7");
    const empty = await serve(t, funplayHandler(project.root, { data: (name, data) => name === "get_editor_state" ? { ...data, scene: { error: "No active scene is loaded." } } : data }).handler);
    const result = await probeMcp({ url: empty, projectRoot: project.root });
    assert.equal(result.ready, true);
    assert.equal(result.readiness.sceneAvailable, false);
    assert.equal(result.readiness.sceneError, "No active scene is loaded.");
});

test("HTTP 200 alone and mismatched JSON-RPC ids are not readiness", async (t) => {
    const project = fixture(t);
    const html = await serve(t, (_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("ok"); });
    const result = await probeMcp({ url: html, projectRoot: project.root });
    assert.equal(result.reachable, true);
    assert.equal(result.ready, false);
    assert.equal(result.error.code, "MCP_PROTOCOL_ERROR");
    const badId = await serve(t, (_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: "wrong", result: {} })); });
    assert.equal((await probeMcp({ url: badId, projectRoot: project.root })).error.code, "MCP_PROTOCOL_ERROR");
});

test("redirects are never followed and route identity errors stay distinguishable", async (t) => {
    const project = fixture(t);
    let destinationCalls = 0;
    const destination = await serve(t, (_req, res) => { destinationCalls += 1; res.end(); });
    const redirect = await serve(t, (_req, res) => { res.writeHead(307, { Location: destination }); res.end(); });
    assert.equal((await probeMcp({ url: redirect, projectRoot: project.root })).error.code, "MCP_REDIRECT_REJECTED");
    assert.equal(destinationCalls, 0);
    const mismatch = await serve(t, (_req, res) => { res.writeHead(409, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "PROJECT_CONTEXT_MISMATCH" })); });
    assert.equal((await probeMcp({ url: mismatch, projectRoot: project.root })).error.code, "MCP_PROJECT_MISMATCH");
});

test("hung responses have a bounded timeout and response bytes are limited", async (t) => {
    const project = fixture(t);
    const slow = await serve(t, () => {});
    const start = Date.now();
    const result = await probeMcp({ url: slow, projectRoot: project.root, timeoutMs: 60 });
    assert.equal(result.error.code, "MCP_TIMEOUT");
    assert.ok(Date.now() - start < 1000);
    const huge = await serve(t, (_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: "x".repeat(2000) })); });
    assert.equal((await probeMcp({ url: huge, projectRoot: project.root, maxResponseBytes: 1000 })).error.code, "MCP_RESPONSE_TOO_LARGE");
});

test("tool response identity pins detect Creator restarts", async (t) => {
    const project = fixture(t);
    const fake = funplayHandler(project.root, { outputContext: (name) => name === "execute_javascript" ? makeContext(project.root, "restarted-instance") : undefined });
    const base = await serve(t, fake.handler);
    const connection = await probeMcp({ url: base, projectRoot: project.root });
    assert.equal(connection.ready, true);
    await assert.rejects(callMcpTool({ connection, name: "execute_javascript", args: { context: "editor", code: "return 42;" } }), { code: "MCP_INSTANCE_CHANGED" });
    await assert.rejects(callMcpTool({ connection, name: "execute_javascript", args: { expected_context: "wrong" } }), { code: "MCP_CONTEXT_MISMATCH" });
});

test("offline endpoint and invalid endpoint remain distinct", async (t) => {
    const project = fixture(t);
    const server = http.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    const offline = await probeMcp({ url: `http://127.0.0.1:${port}`, projectRoot: project.root });
    assert.equal(offline.error.code, "MCP_OFFLINE");
    assert.equal(offline.reachable, false);
    const remote = await probeMcp({ url: "http://example.com/", projectRoot: project.root });
    assert.equal(remote.error.code, "MCP_REMOTE_ENDPOINT");
    assert.equal(remote.reachable, false);
});
