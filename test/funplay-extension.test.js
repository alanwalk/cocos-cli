import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";

import { manageFunplayExtension } from "../dist/funplay-extension.js";
import { createProjectFixture } from "./helpers.js";

function fakeRelease(version, { wrongChecksum = false, extra = {} } = {}) {
    const name = "Funplay.CocosMcp.v" + version + ".zip";
    const archive = zipSync({
        "funplay-cocos-mcp/package.json": strToU8(JSON.stringify({ name: "funplay-cocos-mcp", version, main: "browser.js" })),
        "funplay-cocos-mcp/browser.js": strToU8("version " + version),
        ...extra,
    });
    const checksum = wrongChecksum ? "0".repeat(64) : createHash("sha256").update(archive).digest("hex");
    return async (url) => {
        if (url.endsWith("/latest")) return Response.json({ tag_name: "v" + version, prerelease: false, draft: false });
        if (url.endsWith("/SHA256SUMS.txt")) return new Response(checksum + "  " + name + "\n");
        assert.ok(url.endsWith("/" + name));
        return new Response(archive);
    };
}

test("setup installs locally and update verifies, upgrades and keeps a backup", async (t) => {
    const fixture = createProjectFixture();
    t.after(fixture.cleanup);
    const project = { root: fixture.root, creatorVersion: "3.8.8" };
    const first = await manageFunplayExtension({ project, operation: "setup", fetchImpl: fakeRelease("0.7.1") });
    const entry = join(first.extensionPath, "browser.js");
    assert.equal(readFileSync(entry, "utf8"), "version 0.7.1");
    const alreadyInstalled = await manageFunplayExtension({ project, operation: "setup", fetchImpl: () => assert.fail("must not fetch") });
    assert.equal(alreadyInstalled.changed, false);

    await assert.rejects(manageFunplayExtension({
        project, operation: "update", fetchImpl: fakeRelease("0.7.6", { wrongChecksum: true }),
    }), { code: "FUNPLAY_CHECKSUM_MISMATCH" });
    await assert.rejects(manageFunplayExtension({
        project, operation: "update", fetchImpl: fakeRelease("0.7.6", {
            extra: { "funplay-cocos-mcp/../escaped.js": strToU8("unsafe") },
        }),
    }), { code: "FUNPLAY_INVALID_ARCHIVE" });
    assert.equal(readFileSync(entry, "utf8"), "version 0.7.1");
    const updated = await manageFunplayExtension({ project, operation: "update", fetchImpl: fakeRelease("0.7.6") });
    assert.equal(updated.previousVersion, "0.7.1");
    assert.equal(readFileSync(entry, "utf8"), "version 0.7.6");
    assert.equal(readFileSync(join(updated.backupPath, "browser.js"), "utf8"), "version 0.7.1");
    const older = await manageFunplayExtension({ project, operation: "update", fetchImpl: fakeRelease("0.7.2") });
    assert.equal(older.changed, false);
    assert.equal(older.version, "0.7.6");
    writeFileSync(join(updated.extensionPath, ".git"), "gitdir: somewhere");
    await assert.rejects(manageFunplayExtension({
        project, operation: "update", fetchImpl: () => assert.fail("must not fetch"),
    }), { code: "FUNPLAY_GIT_INSTALLATION" });
});

test("global setup uses the declared Creator version and reports a project installation that takes priority", async (t) => {
    const fixture = createProjectFixture({ version: "3.8.7" });
    t.after(fixture.cleanup);
    const homeDirectory = join(fixture.root, "home");
    mkdirSync(homeDirectory);
    const project = { root: fixture.root, creatorVersion: "3.8.7" };
    const local = await manageFunplayExtension({ project, operation: "setup", fetchImpl: fakeRelease("0.7.6") });
    const result = await manageFunplayExtension({
        project, operation: "setup", global: true, homeDirectory, fetchImpl: fakeRelease("0.7.6"),
    });
    assert.equal(result.extensionPath, join(homeDirectory, ".CocosCreator", "builtin-extensions", "3.8.7", "funplay-cocos-mcp"));
    assert.equal(result.projectOverridePath, local.extensionPath);
});
