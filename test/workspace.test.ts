import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { Method } from "../src/generated/ScanResult.js";
import { TypeScriptScanner } from "../src/scanner/typescript-scanner.js";

// A workspace whose packages import each other, by their names and with
// the path aliases of their tsconfig.json
const fixtures = fileURLToPath(new URL("fixtures", import.meta.url));

const result = new TypeScriptScanner().scan(fixtures, "workspace");

function functionOf(qualifiedName: string): Method {
    const found = result.modules
        .flatMap(module => module.files)
        .flatMap(file => file.functions ?? [])
        .find(candidate => candidate.qualifiedName === qualifiedName);

    assert.ok(found, `No function ${qualifiedName}`);

    return found;
}

function calls(qualifiedName: string): string[] {
    return (functionOf(qualifiedName).calls ?? []).map(call => `${call.target} ${call.resolved}`);
}

test("resolves imports of the packages of the workspace to their sources, where their package.json points at a build", () => {
    assert.deepEqual(calls("packages/web/src/app:app").filter(call => call.includes("packages/core")), [
        "packages/core/src/index:Store.get true",
        "packages/core/src/index:Store.constructor true",
        "packages/core/src/utils:slug true",
        "packages/core/src/index:hello true"
    ]);
});

test("names the creation of a class after its constructor, also when it inherits one from another package", () => {
    assert.ok(calls("packages/web/src/app:app").includes("packages/web/src/app:CachedStore.constructor true"));
});

test("resolves the path aliases of the tsconfig.json nearest to each file", () => {
    assert.deepEqual(calls("packages/web/src/app:app").filter(call => /components|lib/.test(call)), [
        "packages/web/src/components/button:button true",
        "packages/web/src/lib/index:lib true"
    ]);
});

test("resolves the path aliases of a tsconfig.json another extends", () => {
    assert.deepEqual(calls("packages/core/src/index:hello"), ["shared/format:format true"]);
});
