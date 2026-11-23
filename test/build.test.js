import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { assertBuildAllowed, createBuildArguments, parseBuildOptionAssignments } from "../dist/build.js";

import { createProjectFixture } from "./helpers.js";

function createBuildConfig(overrides = {}) {
    return {
        platform: "web-desktop",
        debug: true,
        options: {},
        ...overrides,
    };
}

test("生成 Creator --build 参数并读取启动场景文件", (t) => {
    const fixture = createProjectFixture();
    t.after(() => fixture.cleanup());
    writeFileSync(join(fixture.root, "start-scene.json"), `${JSON.stringify({ uuid: "scene-uuid" }, null, 2)}\n`);

    const build = createBuildArguments({
        projectRoot: fixture.root,
        buildConfig: createBuildConfig({
            startSceneFile: "start-scene.json",
            options: {
                md5Cache: false,
            },
        }),
        platform: "web-mobile",
        optionAssignments: ["inlineSpriteFrames=true"],
    });

    assert.equal(build.buildString, "platform=web-mobile;debug=true;startScene=scene-uuid;md5Cache=false;inlineSpriteFrames=true");
    assert.deepEqual(build.args, ["--project", fixture.root, "--build", build.buildString]);
});

test("--release 覆盖配置中的 debug", (t) => {
    const fixture = createProjectFixture();
    t.after(() => fixture.cleanup());

    const build = createBuildArguments({
        projectRoot: fixture.root,
        buildConfig: createBuildConfig({ debug: true }),
        release: true,
    });

    assert.equal(build.buildString, "platform=web-desktop;debug=false");
});

test("未配置启动场景时使用项目唯一的场景", (t) => {
    const fixture = createProjectFixture();
    t.after(() => fixture.cleanup());
    const sceneDirectory = join(fixture.root, "assets", "scenes");
    mkdirSync(sceneDirectory, { recursive: true });
    writeFileSync(join(sceneDirectory, "Main.scene"), "{}");
    writeFileSync(
        join(sceneDirectory, "Main.scene.meta"),
        `${JSON.stringify(
            {
                uuid: "single-scene-uuid",
            },
            null,
            2,
        )}\n`,
    );

    const build = createBuildArguments({
        projectRoot: fixture.root,
        buildConfig: createBuildConfig(),
    });

    assert.equal(build.buildString, "platform=web-desktop;debug=true;startScene=single-scene-uuid");
});

test("构建参数拒绝分号和保留键", () => {
    assert.throws(() => parseBuildOptionAssignments(["bad=one;two"]), (error) => error.code === "INVALID_BUILD_OPTION");
    assert.throws(
        () =>
            createBuildArguments({
                projectRoot: "C:\\Game",
                buildConfig: createBuildConfig(),
                optionAssignments: ["platform=web-mobile"],
            }),
        (error) => error.code === "INVALID_BUILD_OPTION",
    );
});

test("guardUrl 可访问时阻止构建，连接失败时放行", async () => {
    const config = createBuildConfig({
        guardUrl: "http://127.0.0.1:22992/health",
    });

    await assert.rejects(
        () =>
            assertBuildAllowed({
                buildConfig: config,
                fetchImpl: async () => ({ ok: true, status: 200 }),
            }),
        (error) => error.code === "BUILD_GUARDED",
    );

    await assert.doesNotReject(() =>
        assertBuildAllowed({
            buildConfig: config,
            fetchImpl: async () => {
                throw new Error("offline");
            },
        }),
    );
});
