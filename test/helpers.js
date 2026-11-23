import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createProjectFixture(options = {}) {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "alanwalk-cocos-cli-"));
    const version = options.version ?? "3.8.8";
    mkdirSync(join(root, "assets", "scripts"), { recursive: true });
    writeFileSync(
        join(root, "package.json"),
        `${JSON.stringify(
            {
                name: "fixture-project",
                creator: {
                    version,
                },
            },
            null,
            2,
        )}\n`,
    );

    return {
        root,
        cleanup() {
            rmSync(root, { recursive: true, force: true });
        },
    };
}

export function createFakeCreator(directory) {
    const filePath = join(directory, process.platform === "win32" ? "CocosCreator.exe" : "CocosCreator");
    writeFileSync(filePath, "");
    if (process.platform !== "win32") {
        chmodSync(filePath, 0o755);
    }
    return filePath;
}
