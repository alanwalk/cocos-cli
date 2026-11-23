import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { findSingleSceneUuid, loadProject } from "../dist/project.js";

import { createProjectFixture } from "./helpers.js";

test("从子目录向上找到 Cocos 项目", (t) => {
    const fixture = createProjectFixture();
    t.after(() => fixture.cleanup());

    const project = loadProject({
        cwd: join(fixture.root, "assets", "scripts"),
    });

    assert.equal(project.root, fixture.root);
    assert.equal(project.name, "fixture-project");
    assert.equal(project.creatorVersion, "3.8.8");
});

test("显式项目目录不会错误地向上查找", (t) => {
    const fixture = createProjectFixture();
    t.after(() => fixture.cleanup());
    const childDirectory = join(fixture.root, "assets", "scripts");
    mkdirSync(childDirectory, { recursive: true });

    assert.throws(
        () =>
            loadProject({
                cwd: fixture.root,
                project: childDirectory,
            }),
        (error) => error.code === "PROJECT_NOT_FOUND",
    );
});

test("缺少 creator.version 时报告项目未找到", (t) => {
    const fixture = createProjectFixture();
    t.after(() => fixture.cleanup());
    writeFileSync(join(fixture.root, "package.json"), `${JSON.stringify({ name: "fixture-project" }, null, 2)}\n`);

    assert.throws(
        () =>
            loadProject({
                project: fixture.root,
            }),
        (error) => error.code === "PROJECT_NOT_FOUND",
    );
});

test("拒绝非 3.x Creator 版本", (t) => {
    const fixture = createProjectFixture({ version: "2.4.15" });
    t.after(() => fixture.cleanup());

    assert.throws(
        () =>
            loadProject({
                project: fixture.root,
            }),
        (error) => error.code === "UNSUPPORTED_CREATOR_VERSION",
    );
});

test("只有一个场景时自动读取启动场景 UUID", (t) => {
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

    assert.equal(findSingleSceneUuid(fixture.root), "single-scene-uuid");
});

test("多个场景时不猜测启动场景", (t) => {
    const fixture = createProjectFixture();
    t.after(() => fixture.cleanup());
    const sceneDirectory = join(fixture.root, "assets", "scenes");
    mkdirSync(sceneDirectory, { recursive: true });
    for (const sceneName of ["Main", "Login"]) {
        writeFileSync(join(sceneDirectory, `${sceneName}.scene`), "{}");
        writeFileSync(
            join(sceneDirectory, `${sceneName}.scene.meta`),
            `${JSON.stringify(
                {
                    uuid: `${sceneName}-uuid`,
                },
                null,
                2,
            )}\n`,
        );
    }

    assert.equal(findSingleSceneUuid(fixture.root), undefined);
});
