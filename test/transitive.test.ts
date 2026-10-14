import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { TypeScriptScanner } from "../src/scanner/typescript-scanner.js";

// The same workspace locked by each package manager: packages/c depends on
// packages/b, which depends on packages/a and is-odd; packages/a depends on
// debug 4, and the root, for its development, on debug 2, so two versions of
// debug and ms are installed
const fixtures = fileURLToPath(new URL("fixtures/locks", import.meta.url));

const EXPECTED = {
    ".": ["ms@2.0.0 dev"],
    "packages/a": ["ms@2.1.2 prod"],
    "packages/b": ["debug@4.3.4 prod", "is-number@6.0.0 prod", "ms@2.1.2 prod"],
    "packages/c": ["@locks/a module packages/a prod", "debug@4.3.4 prod", "is-number@6.0.0 prod", "is-odd@3.0.1 prod", "ms@2.1.2 prod"]
};

for (const [packageManager, lockFile] of [
    ["npm", "package-lock.json"],
    ["pnpm", "pnpm-lock.yaml"],
    ["yarn1", "yarn.lock v1"],
    ["berry", "yarn.lock of Yarn Berry"],
    ["bun", "bun.lock"]
]) {
    test(`lists the dependencies the dependencies of each module pull in, as ${lockFile} installs them`, () => {
        const result = new TypeScriptScanner().scan(fixtures, packageManager);

        assert.deepEqual(
            Object.fromEntries(result.modules.map(module => [
                module.path,
                (module.dependencies ?? [])
                    .filter(dependency => dependency.transitive)
                    .map(dependency => dependency.module === undefined
                        ? `${dependency.name}@${dependency.version} ${dependency.scope}`
                        : `${dependency.name} module ${dependency.module} ${dependency.scope}`)
            ])),
            EXPECTED
        );
    });
}

test("lists no transitive dependencies without a lock file", () => {
    const result = new TypeScriptScanner().scan(fileURLToPath(new URL("fixtures", import.meta.url)), "workspace");

    assert.ok(result.modules.every(module => (module.dependencies ?? []).every(dependency => !dependency.transitive)));
});
