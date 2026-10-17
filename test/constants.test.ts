import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { File, Method } from "../src/generated/ScanResult.js";
import { TypeScriptScanner } from "../src/scanner/typescript-scanner.js";
import { holdsSecret, namesSecret } from "../src/scanner/secrets.js";

// Constants, and the calls, decorators and JSX elements that use them
const fixtures = fileURLToPath(new URL("fixtures", import.meta.url));

const result = new TypeScriptScanner().scan(fixtures, "constants");

const files = result.modules.flatMap(module => module.files);

function fileOf(path: string): File {
    const found = files.find(file => file.path === path);

    assert.ok(found, `No file ${path}`);

    return found;
}

function methodOf(file: File, name: string): Method {
    const found = [...file.functions ?? [], ...(file.classes ?? []).flatMap(clazz => clazz.methods ?? [])]
        .find(method => method.name === name);

    assert.ok(found, `No method ${name}`);

    return found;
}

test("produces a result that matches the scan result schema", () => {
    const schemaPath = process.env.GRAPHNOUS_SCAN_RESULT_SCHEMA
        ?? fileURLToPath(new URL("../../graphnous-schemas/scan/scan-result.schema.json", import.meta.url));
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));

    assert.ok(validate(result), JSON.stringify(validate.errors, null, 2));
});

test("records the values of const variables and readonly properties", () => {
    const topics = fileOf("src/topics.ts");

    assert.deepEqual(
        Object.fromEntries((topics.variables ?? []).filter(variable => variable.constant !== undefined).map(variable => [variable.name, variable.constant])),
        {
            PREFIX: "orders.",
            CREATED: "orders.created",
            VERSIONED: "orders.created.v2",
            PARTITIONS: "9",
            ENABLED: "true",
            CHOSEN: "on",
            ROUTING_KEY: "orders.created"
        }
    );

    const channels = topics.classes?.find(clazz => clazz.name === "Channels");

    assert.deepEqual(
        channels?.fields?.map(field => [field.name, field.constant]),
        [["ORDERS", "orders.all"], ["name", "orders"], ["notReadonly", undefined]]
    );
});

test("computes the arguments of calls from constants, also of other files", () => {
    const send = methodOf(fileOf("src/publisher.ts"), "send");

    assert.deepEqual(send.calls?.map(call => [call.arguments?.[0]?.value, call.arguments?.[0]?.constant]), [
        ["CREATED", "orders.created"],
        ["Topic.Created", "orders.created"],
        ["TOPICS.created", "orders.created"],
        ["Channels.ORDERS", "orders.all"],
        ["MUTABLE.created", undefined],
        ["changing", undefined],
        ["`orders.${other}`", undefined]
    ]);

    assert.ok(send.calls?.every(call => call.arguments?.[1]?.constant === undefined));
});

test("gives decorator arguments that are constants as their values", () => {
    const send = methodOf(fileOf("src/publisher.ts"), "send");

    assert.deepEqual(send.annotations?.[0]?.arguments, { 0: "orders.created", 1: "orders.billing" });
});

test("computes JSX attributes from constants", () => {
    const routes = methodOf(fileOf("src/routes.tsx"), "Routes");
    const route = routes.calls?.find(call => call.target.endsWith("Route"));

    assert.deepEqual(route?.arguments?.map(argument => [argument.name, argument.constant]), [
        ["path", "/orders.created"],
        ["title", "Orders"],
        ["exact", undefined]
    ]);
});

test("tells secrets by their names and values", () => {
    assert.ok(namesSecret("API_KEY"));
    assert.ok(namesSecret("dbPassword"));
    assert.ok(namesSecret("client-secret"));
    assert.ok(!namesSecret("routingKey"));
    assert.ok(!namesSecret("cache.key-prefix"));

    assert.ok(holdsSecret("postgresql://app:hunter2@db/orders"));
    assert.ok(holdsSecret("username=a password=b"));
    assert.ok(!holdsSecret("postgresql://db/orders"));
    assert.ok(!holdsSecret("https://user@example.com"));
});
