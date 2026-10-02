import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/**
 * Runs the scanner as the server does: as a command with arguments.
 */
function run(...args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", main, ...args], {
        encoding: "utf8"
    });
}

test("writes the scan result to the output file", () => {
    const directory = mkdtempSync(join(tmpdir(), "graphnous-scanner-"));

    try {
        const output = join(directory, "result.json");

        const process = run("--path", directory, "--target", "app", "--output", output);

        assert.equal(process.status, 0, process.stderr);

        const result = JSON.parse(readFileSync(output, "utf8"));

        assert.equal(result.format, "graphnous-scan-result");
        assert.equal(result.target.path, "app");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("scans the repository root when no target is given", () => {
    const directory = mkdtempSync(join(tmpdir(), "graphnous-scanner-"));

    try {
        const output = join(directory, "result.json");

        assert.equal(run("--path", directory, "--output", output).status, 0);
        assert.equal(JSON.parse(readFileSync(output, "utf8")).target.path, ".");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

for (const [when, args, message] of [
    ["without --path", ["--output", "result.json"], "Missing required argument: --path"],
    ["without --output", ["--path", "."], "Missing required argument: --output"],
    ["when an argument has no value", ["--path"], "Missing value for --path"],
    ["for an unknown argument", ["--path", ".", "--output", "x", "--verbose"], "Unknown argument: --verbose"]
] as const) {
    test(`fails ${when}`, () => {
        const process = run(...args);

        assert.notEqual(process.status, 0);
        assert.ok(process.stderr.includes(message), process.stderr);
    });
}
