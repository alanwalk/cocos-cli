import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const directory of ["bin", "src", "scripts", "test"]) {
    for (const name of readdirSync(join(root, directory)).filter((item) => item.endsWith(".js"))) {
        const result = spawnSync(process.execPath, ["--check", join(root, directory, name)], { stdio: "inherit" });
        if (result.status !== 0 || result.error) {
            process.exitCode = result.status ?? 1;
            if (result.error) console.error(result.error.message);
        }
    }
}
