import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { TypeScriptScanner } from "../src/scanner/typescript-scanner.js";

// The schema the server reads scan results with: in graphnous-schemas next
// to this folder, or where GRAPHNOUS_SCAN_RESULT_SCHEMA says, such as in CI
const schemaPath =
    process.env.GRAPHNOUS_SCAN_RESULT_SCHEMA ??
    fileURLToPath(new URL("../../graphnous-schemas/scan/scan-result.schema.json", import.meta.url));

function validator() {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);

    return ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));
}

test("produces a result that matches the scan result schema", () => {
    const validate = validator();

    const result = new TypeScriptScanner().scan("/repository", "packages/app");

    assert.ok(validate(result), JSON.stringify(validate.errors, null, 2));
});

test("describes the scanned target", () => {
    const result = new TypeScriptScanner().scan("/repository", "packages/app");

    assert.equal(result.target.path, "packages/app");
    assert.equal(result.target.language, "TYPESCRIPT");
    assert.equal(result.target.buildSystem, "NPM");
});
