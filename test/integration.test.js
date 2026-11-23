import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../bin/cocos.js", import.meta.url));
const PROTOCOL_VERSION = "2025-11-25";
const CONTEXT_KEY = "io.funplay.cocos/context";

function projectFixture(t) {
    const directory = mkdtempSync(join(tmpdir(), "cocos-cli-integration-"));
    // Exercise actual child-process argv handling with spaces in the project path.
    const root = join(directory, "Game Project");
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "integration-project", creator: { version: "3.8.8" } }, null, 2)}\n`);
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return { root, missingEditor: join(directory, "must-not-launch", process.platform === "win32" ? "CocosCreator.exe" : "CocosCreator") };
}

function projectContext(root) {
    const normalized = root.replace(/\\/g, "/");
    const identityPath = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    const id = createHash("sha256").update(`funplay-cocos-mcp:${identityPath}`).digest("hex").slice(0, 24);
    const instance = "integration-fixture-instance";
    return { project_id: id, project_path: root, instance_id: instance, expected_context: `${id}:${instance}` };
}

/** A real HTTP fixture matching Funplay v0.7.6's initialize/tool response shapes. */
async function startFunplay(t, root, options = {}) {
    const context = projectContext(root);
    const requests = [];
    const failures = [];
    const sessions = new Set();
    const initializedSessions = new Set();
    let endpoint;
    const server = http.createServer(async (request, response) => {
        try {
            assert.equal(request.method, "POST");
            assert.equal(request.url, new URL(endpoint).pathname);
            assert.equal(request.headers["mcp-protocol-version"], PROTOCOL_VERSION);
            assert.equal(request.headers.accept, "application/json, text/event-stream");
            let body = "";
            for await (const chunk of request) body += chunk;
            const rpc = JSON.parse(body);
            requests.push(rpc);
            assert.equal(rpc.jsonrpc, "2.0");
            const headers = { "Content-Type": "application/json", "MCP-Protocol-Version": PROTOCOL_VERSION };
            const reply = (result) => {
                response.writeHead(200, headers);
                response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
            };
            if (rpc.method === "initialize") {
                const session = `integration-session-${sessions.size + 1}`;
                sessions.add(session);
                headers["Mcp-Session-Id"] = session;
                reply({
                    protocolVersion: PROTOCOL_VERSION,
                    serverInfo: { name: "funplay-cocos-mcp", version: "0.7.6" },
                    funplay: { server: "funplay-cocos-mcp", projectName: "Game Project", projectIdentity: context.project_id, routingVersion: 1, context },
                    capabilities: { tools: {}, resources: {}, prompts: {} },
                });
                return;
            }
            const session = request.headers["mcp-session-id"];
            assert.ok(sessions.has(session), "Subsequent requests must retain the negotiated MCP session");
            if (rpc.method === "notifications/initialized") {
                assert.equal(rpc.id, undefined);
                initializedSessions.add(session);
                response.writeHead(202, headers);
                response.end();
                return;
            }
            assert.ok(initializedSessions.has(session));
            assert.equal(rpc.params._meta.expected_context, context.expected_context);
            assert.equal(rpc.method, "tools/call");
            assert.equal(rpc.params.arguments.expected_context, context.expected_context);
            const name = rpc.params.name;
            assert.ok(["get_project_info", "get_editor_state"].includes(name), `Readiness commands must not call mutating tools: ${name}`);
            const info = {
                extensionName: "funplay-cocos-mcp",
                version: "0.7.6",
                projectName: "Game Project",
                projectPath: root,
                projectIdentity: context.project_id,
                projectContext: context,
                cocosVersion: options.editorVersion ?? "3.8.8",
                config: { toolProfile: "core", enableSessions: true },
            };
            const data = name === "get_project_info" ? info : {
                extensionName: info.extensionName,
                version: info.version,
                projectName: info.projectName,
                projectPath: root,
                cocosVersion: info.cocosVersion,
                toolProfile: "core",
                status: { ...info, running: true, url: endpoint, packagePath: options.packagePath },
                selection: {},
                scene: { sceneName: "Main", uuid: "integration-scene", childCount: 0 },
                windows: [],
            };
            const envelope = {
                ok: true, tool: name, callId: `integration-${requests.length}`, timestamp: new Date().toISOString(),
                summary: "Integration fixture result", data, refs: [], projectContext: context,
            };
            reply({ content: [{ type: "text", text: JSON.stringify(envelope) }], structuredContent: envelope, _meta: { [CONTEXT_KEY]: context } });
        } catch (error) {
            failures.push(error.message);
            if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ error: error.message }));
        }
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    endpoint = `http://127.0.0.1:${server.address().port}/mcp/project/${context.project_id}/`;
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        assert.deepEqual(failures, [], "The CLI must use the actual Funplay HTTP protocol correctly");
    });
    return { endpoint, context, requests };
}

/** Async execFile keeps the fixture's HTTP event loop running while the CLI waits. */
async function runCli(project, commands, extraArgs = []) {
    const env = { ...process.env };
    for (const key of ["COCOS_MCP_HOST", "COCOS_MCP_PORT", "COCOS_CLI_MCP_URL", "COCOS_CREATOR_PATH", "COCOS_CLI_DEBUG"]) delete env[key];
    const args = [cliPath, ...commands, "--json", "--project", project.root, "--editor", project.missingEditor,
        "--timeout-ms", "5000", "--request-timeout-ms", "1500", ...extraArgs];
    const result = await new Promise((resolve, reject) => {
        execFile(process.execPath, args, { cwd: project.root, env, encoding: "utf8", timeout: 12000, maxBuffer: 1024 * 1024, windowsHide: true },
            (error, stdout, stderr) => {
                if (error && (!Number.isInteger(error.code) || error.killed || error.signal)) {
                    reject(new Error(`CLI subprocess failed: ${error.message}\nstdout: ${stdout}\nstderr: ${stderr}`, { cause: error }));
                    return;
                }
                resolve({ code: error?.code ?? 0, stdout, stderr });
            });
    });
    let data;
    assert.doesNotThrow(() => { data = JSON.parse(result.stdout); }, `stdout must contain one complete JSON object: ${result.stdout}`);
    assert.equal(result.stdout, `${JSON.stringify(data, null, 2)}\n`, "stdout must contain only the JSON result, with no progress messages");
    assert.equal(result.stderr, "", "Read-only/reuse commands must not emit editor or debug logs");
    assert.equal(existsSync(project.missingEditor), false, "Tests never provide a real Creator executable");
    return { ...result, data };
}

test("integration: status --json verifies a running project without an installed editor", async (t) => {
    const project = projectFixture(t);
    const server = await startFunplay(t, project.root);
    const { code, data } = await runCli(project, ["mcp", "status"], ["--mcp-url", server.endpoint]);
    assert.equal(code, 0);
    assert.equal(data.command, "status");
    assert.equal(data.ok, true);
    assert.equal(data.ready, true);
    assert.equal(data.projectRoot, project.root);
    assert.equal(data.editor.actualVersion, "3.8.8");
    assert.equal(data.editor.versionVerified, true);
    assert.equal(data.editor.error.code, "CREATOR_NOT_FOUND");
    assert.equal(data.mcp.projectId, server.context.project_id);
    assert.equal(data.mcp.endpoint, server.endpoint);
    assert.equal(data.mcp.readiness.importsComplete, null);
    assert.equal(existsSync(join(project.root, "temp", "cocos-cli", "state.json")), false);
    assert.deepEqual(server.requests.map((request) => request.method === "tools/call" ? request.params.name : request.method),
        ["initialize", "notifications/initialized", "get_project_info", "get_editor_state"]);
});

test("integration: repeated ensure --json reuses MCP and writes a verified endpoint receipt", async (t) => {
    const project = projectFixture(t);
    const server = await startFunplay(t, project.root);
    const first = await runCli(project, ["mcp", "ensure"], ["--mcp-url", server.endpoint]);
    assert.equal(first.code, 0);
    assert.equal(first.data.reused, true);
    assert.equal(first.data.launched, false);
    const stateFile = join(project.root, "temp", "cocos-cli", "state.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.endpoint, server.endpoint);
    assert.equal(state.editorPath, null);
    assert.equal(state.startedAt, null);
    // The second process discovers the saved endpoint without --mcp-url.
    const second = await runCli(project, ["mcp", "ensure"]);
    assert.equal(second.code, 0);
    assert.equal(second.data.reused, true);
    assert.equal(second.data.launched, false);
    assert.equal(second.data.mcp.endpoint, server.endpoint);
    assert.equal(existsSync(join(project.root, "temp", "cocos-cli", "project.lock")), false);
    assert.equal(existsSync(join(project.root, "temp", "cocos-cli", "editor-startup.log")), false);
    assert.equal(server.requests.filter((request) => request.method === "initialize").length, 2);
});

test("integration: doctor --json reads the configured endpoint and reports the live version", async (t) => {
    const project = projectFixture(t);
    const server = await startFunplay(t, project.root);
    writeFileSync(join(project.root, "cocos-cli.config.json"), `${JSON.stringify({ mcp: { url: server.endpoint } })}\n`);
    const { code, data } = await runCli(project, ["mcp", "doctor"]);
    assert.equal(code, 0);
    assert.equal(data.command, "doctor");
    assert.equal(data.ready, true);
    assert.equal(data.editor.requiredVersion, "3.8.8");
    assert.equal(data.editor.actualVersion, "3.8.8");
    assert.equal(data.mcp.endpoint, server.endpoint);
    assert.deepEqual(data.nextSteps, []);
});

test("integration: ensure --json rejects an explicit endpoint serving another project", async (t) => {
    const target = projectFixture(t);
    const other = projectFixture(t);
    const server = await startFunplay(t, other.root);
    const { code, data } = await runCli(target, ["mcp", "ensure"], ["--mcp-url", server.endpoint]);
    assert.equal(code, 1);
    assert.equal(data.ok, false);
    assert.equal(data.error.code, "MCP_PROJECT_MISMATCH");
    assert.deepEqual(server.requests.map((request) => request.method), ["initialize"]);
    assert.equal(existsSync(join(target.root, "temp", "cocos-cli", "state.json")), false);
    assert.equal(existsSync(join(target.root, "temp", "cocos-cli", "project.lock")), false);
    assert.equal(existsSync(join(target.root, "temp", "cocos-cli", "editor-startup.log")), false);
});

test("integration: offline status --json returns exit 2 and a machine-readable diagnosis", async (t) => {
    const project = projectFixture(t);
    const reservation = http.createServer();
    await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const endpoint = `http://127.0.0.1:${port}/mcp/project/${projectContext(project.root).project_id}/`;
    const { code, data } = await runCli(project, ["mcp", "status"], ["--mcp-url", endpoint]);
    assert.equal(code, 2);
    assert.equal(data.command, "status");
    assert.equal(data.ok, false);
    assert.equal(data.ready, false);
    assert.equal(data.mcp.reachable, false);
    assert.equal(data.mcp.error.code, "MCP_OFFLINE");
    assert.ok(data.nextSteps.length > 0);
    assert.equal(existsSync(join(project.root, "temp", "cocos-cli", "state.json")), false);
});

test("integration: doctor --json rejects the wrong running Creator version", async (t) => {
    const project = projectFixture(t);
    const server = await startFunplay(t, project.root, { editorVersion: "3.8.7" });
    const { code, data } = await runCli(project, ["mcp", "doctor"], ["--mcp-url", server.endpoint]);
    assert.equal(code, 2);
    assert.equal(data.ready, false);
    assert.equal(data.editor.requiredVersion, "3.8.8");
    assert.equal(data.mcp.editorVersion, "3.8.7");
    assert.equal(data.mcp.error.code, "MCP_VERSION_MISMATCH");
    assert.equal(server.requests.some((request) => request.params?.name === "get_editor_state"), false);
});

test("integration: register rejects an endpoint that belongs to a different project", async (t) => {
    const target = projectFixture(t);
    const wrong = projectFixture(t);
    const server = await startFunplay(t, wrong.root);
    const result = await runCli(target, ["mcp", "register", "--client", "codex"], ["--mcp-url", server.endpoint]);
    assert.equal(result.code, 1);
    assert.equal(result.data.error.code, "MCP_PROJECT_MISMATCH");
    assert.deepEqual(server.requests.map((request) => request.method), ["initialize"]);
    assert.equal(existsSync(join(target.root, ".codex")), false);
    assert.equal(existsSync(join(target.root, ".agents")), false);
});

test("integration: register writes the project config and installs only missing Skills", async (t) => {
    const project = projectFixture(t);
    const packagePath = join(project.root, "extensions", "funplay-cocos-mcp");
    const lib = join(packagePath, "lib");
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(packagePath, "package.json"), JSON.stringify({ name: "funplay-cocos-mcp", version: "0.7.6" }));
    writeFileSync(join(lib, "atomic-file.js"), [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const readOptionalText = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;',
        'function writeTextIfUnchanged(file, text, old) {',
        '  if (readOptionalText(file) !== old) throw Error("changed");',
        '  fs.mkdirSync(path.dirname(file), { recursive: true });',
        '  fs.writeFileSync(file, text);',
        '}',
        'module.exports = { readOptionalText, writeTextIfUnchanged };',
    ].join("\n"));
    writeFileSync(join(lib, "client-config.js"), [
        'const { join } = require("node:path");',
        'const { getProjectIdentity } = require("./identity.js");',
        'const { readOptionalText, writeTextIfUnchanged } = require("./atomic-file.js");',
        'function buildTargets(config, options) {',
        '  const projectIdentity = getProjectIdentity(config.projectPath);',
        '  const url = "http://" + config.host + ":" + config.port + "/mcp/project/" + projectIdentity + "/";',
        '  return [{ id: "codex", configPath: join(options.homePath, ".codex", "config.toml"), url, projectIdentity }];',
        '}',
        'function configureTarget(config, id, options) {',
        '  const target = buildTargets(config, options)[0];',
        '  const prior = readOptionalText(target.configPath);',
        '  if (!prior?.includes(target.url)) writeTextIfUnchanged(target.configPath, (prior || "") + "[mcp_servers.funplay]\\nurl = " + JSON.stringify(target.url) + "\\n", prior);',
        '  return { ...target, serverName: "funplay" };',
        '}',
        'module.exports = { buildTargets, configureTarget };',
    ].join("\n"));
    writeFileSync(join(lib, "identity.js"), "exports.getProjectIdentity = () => " + JSON.stringify(projectContext(project.root).project_id));
    writeFileSync(join(lib, "project-skills.js"), [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const names = ["funplay-cocos-mcp-workflow", "funplay-cocos-ui-composition"];',
        'const file = (root, name) => path.join(root, ".agents", "skills", name, "SKILL.md");',
        'exports.getProjectSkillsState = (root) => ({ supported: true, builtIns: names.map(skillName => ({ skillName, status: fs.existsSync(file(root, skillName)) ? "modified" : "missing" })) });',
        'exports.updateBuiltInProjectSkill = (root, { skillName }) => {',
        '  if (skillName === names[1] && fs.existsSync(path.join(root, "fail-skill"))) throw Error("fixture Skill failure");',
        '  const destination = file(root, skillName);',
        '  fs.mkdirSync(path.dirname(destination), { recursive: true });',
        '  fs.writeFileSync(destination, "fixture", { flag: "wx" });',
        '  return { installed: true };',
        '};',
    ].join("\n"));
    const server = await startFunplay(t, project.root, { packagePath });
    const args = ["mcp", "register", "--client", "codex"];
    const extra = ["--mcp-url", server.endpoint];
    const target = join(project.root, ".codex", "config.toml");
    mkdirSync(join(project.root, ".codex"));
    writeFileSync(target, 'model = "kept"\n');
    const failureMarker = join(project.root, "fail-skill");
    writeFileSync(failureMarker, "fixture");
    const first = await runCli(project, args, extra);
    assert.equal(first.code, 1, first.stdout);
    assert.equal(first.data.configured, true);
    assert.equal(first.data.configPath, target);
    assert.equal(first.data.skills.installed.length, 1);
    assert.equal(first.data.skills.failed[0].skillName, "funplay-cocos-ui-composition");
    unlinkSync(failureMarker);
    assert.ok(readFileSync(target, "utf8").startsWith('model = "kept"\n'));
    assert.ok(readFileSync(target, "utf8").includes(server.endpoint));
    const workflow = join(project.root, ".agents", "skills", "funplay-cocos-mcp-workflow", "SKILL.md");
    writeFileSync(workflow, "user edits");
    const again = await runCli(project, args, extra);
    assert.equal(again.code, 0, again.stdout);
    assert.equal(again.data.skills.preserved.length, 1);
    assert.deepEqual(again.data.skills.installed, ["funplay-cocos-ui-composition"]);
    assert.equal(readFileSync(workflow, "utf8"), "user edits");
});
