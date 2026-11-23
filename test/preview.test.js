import assert from "node:assert/strict";
import test from "node:test";

import { getBrowserPreviewUrl } from "../dist/preview.js";

test("preview uses Funplay's same-host browser URL", () => {
    const preview = getBrowserPreviewUrl({
        mode: "browser",
        localUrl: "http://localhost:7456/",
        url: "http://192.168.1.2:7456/",
    });
    assert.equal(preview.href, "http://localhost:7456/");
    assert.throws(() => getBrowserPreviewUrl({ mode: "gameView" }), { code: "PREVIEW_MODE_REQUIRED" });
    for (const url of ["", "http://192.168.1.2:7456/", "file:///test.html", "http://user:password@localhost:7456/"]) {
        assert.throws(() => getBrowserPreviewUrl({ mode: "browser", url }), { code: "PREVIEW_URL_UNAVAILABLE" });
    }
});
