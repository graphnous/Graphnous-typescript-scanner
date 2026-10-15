import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { File, Method } from "../src/generated/ScanResult.js";
import { TypeScriptScanner } from "../src/scanner/typescript-scanner.js";

// A Vue app of <script setup> components, one using the other
const fixtures = fileURLToPath(new URL("fixtures", import.meta.url));

const result = new TypeScriptScanner().scan(fixtures, "vue");

const files = result.modules.flatMap(module => module.files);

function fileOf(path: string): File {
    const found = files.find(file => file.path === path);

    assert.ok(found, `No file ${path}`);

    return found;
}

function componentOf(path: string): Method {
    const found = fileOf(path).functions?.find(method => method.name === "default");

    assert.ok(found, `No component in ${path}`);

    return found;
}

function uses(method: Method, kind: "calls" | "fieldAccesses"): string[] {
    return (method[kind] ?? []).map(use =>
        `${"kind" in use ? use.kind : use.access} ${use.target} ${use.startLine}:${use.startColumn}${use.resolved === false ? " unresolved" : ""}`);
}

test("produces a result that matches the scan result schema", () => {
    const schemaPath = process.env.GRAPHNOUS_SCAN_RESULT_SCHEMA
        ?? fileURLToPath(new URL("../../graphnous-schemas/scan/scan-result.schema.json", import.meta.url));
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));

    assert.ok(validate(result), JSON.stringify(validate.errors, null, 2));
});

test("lists a single-file component as a file, with its script's declarations and the component as its function default", () => {
    const list = fileOf("src/components/OrderList.vue");

    assert.equal(list.language, "VUE");
    assert.deepEqual(list.imports?.map(anImport => anImport.name), ["vue", "./OrderCard.vue", "@/orders", "@/types"]);
    assert.deepEqual(list.functions?.map(method => [method.qualifiedName, method.kind, method.startLine]), [
        ["src/components/OrderList:default", "FUNCTION", 19],
        ["src/components/OrderList:select", "FUNCTION", 11],
        ["src/components/OrderList:refresh", "FUNCTION", 15]
    ]);
    assert.deepEqual(list.variables?.map(variable => variable.qualifiedName), [
        "src/components/OrderList:props",
        "src/components/OrderList:query",
        "src/components/OrderList:selected"
    ]);
});

test("gives what the template uses to the component, at its places in the .vue file", () => {
    const list = componentOf("src/components/OrderList.vue");

    assert.deepEqual(uses(list, "calls"), [
        "METHOD_REFERENCE src/components/OrderList:refresh 20:40",
        "METHOD src/components/OrderList:select 22:66",
        "METHOD src/orders:formatTotal 23:48",
        "METHOD src/components/OrderCard:default 26:3",
        "METHOD_REFERENCE src/components/OrderList:select 26:74",
        "METHOD src/components/OrderCard:default 27:3"
    ]);

    // v-model reads and writes; the items of v-for are typed
    assert.deepEqual(uses(list, "fieldAccesses"), [
        "READ src/components/OrderList:query 20:19",
        "WRITE src/components/OrderList:query 20:19",
        "READ src/types:Order.id 22:48",
        "READ src/types:Customer.name 23:22",
        "READ src/types:Order.customer 23:22",
        "READ src/components/OrderList:selected 26:20",
        "READ src/components/OrderList:selected 26:38",
        "READ src/components/OrderList:props 27:31"
    ]);
});

test("lists the props of a component a template uses as named arguments", () => {
    const calls = componentOf("src/components/OrderList.vue").calls ?? [];

    assert.deepEqual(calls.filter(call => call.target === "src/components/OrderCard:default").map(call => call.arguments), [
        [{ name: "order", value: "selected" }, { name: "label", value: "\"Selected\"" }, { name: "@select", value: "select" }],
        [{ name: "order", value: "order" }, { name: "label", value: "\"All\"" }]
    ]);
});

test("types the props of defineProps in the template", () => {
    const card = componentOf("src/components/OrderCard.vue");

    assert.deepEqual(uses(card, "calls"), ["METHOD src/components/OrderCard:emit 9:29"]);
    assert.deepEqual(uses(card, "fieldAccesses"), ["READ src/types:Order.id 9:68"]);
});
