import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Class, File, GraphNousScanResult, Method } from "../src/generated/ScanResult.js";
import { normalizeVersion } from "../src/scanner/project.js";
import { TypeScriptScanner } from "../src/scanner/typescript-scanner.js";

// The schema the server reads scan results with: in graphnous-schemas next
// to this folder, or where GRAPHNOUS_SCAN_RESULT_SCHEMA says, such as in CI
const schemaPath =
    process.env.GRAPHNOUS_SCAN_RESULT_SCHEMA ??
    fileURLToPath(new URL("../../graphnous-schemas/scan/scan-result.schema.json", import.meta.url));

// A pnpm workspace with a package in packages/ui
const fixtures = fileURLToPath(new URL("fixtures", import.meta.url));

const result = new TypeScriptScanner().scan(fixtures, "shop");

function validator() {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);

    return ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));
}

function file(path: string): File {
    const found = result.modules.flatMap(module => module.files).find(candidate => candidate.path === path);

    assert.ok(found, `No file ${path}`);

    return found;
}

function find<T extends { qualifiedName?: string }>(items: T[] | undefined, qualifiedName: string): T {
    const found = items?.find(item => item.qualifiedName === qualifiedName);

    assert.ok(found, `No ${qualifiedName} in ${JSON.stringify(items?.map(item => item.qualifiedName))}`);

    return found;
}

const orders = file("src/orders.ts");
const order = find(orders.classes, "src/orders:Order");
const orderService = find(orders.classes, "src/orders:OrderService");

function targets(method: Method, kind: "calls" | "fieldAccesses" | "typeUses"): string[] {
    return (method[kind] ?? []).map(reference => `${"kind" in reference ? reference.kind : reference.access} ${reference.target}`);
}

test("produces a result that matches the scan result schema", () => {
    const validate = validator();

    assert.ok(validate(result), JSON.stringify(validate.errors, null, 2));
});

test("produces a result that matches the schema for a target without sources", () => {
    const validate = validator();
    const empty = new TypeScriptScanner().scan("/repository", "packages/app");

    assert.ok(validate(empty), JSON.stringify(validate.errors, null, 2));
});

test("describes the scanned target", () => {
    assert.deepEqual(result.target, {
        path: "shop",
        language: "TYPESCRIPT",
        languageVersion: "20",
        buildSystem: "PNPM",
        buildSystemVersion: "9.1.0"
    } satisfies GraphNousScanResult["target"]);
});

test("detects each package as a module, with its dependencies", () => {
    assert.deepEqual(
        result.modules.map(module => [module.path, module.name, module.files.map(file => file.path)]),
        [
            [".", "shop", ["src/index.ts", "src/logging.js", "src/orders.test.ts", "src/orders.ts"]],
            ["packages/ui", "@shop/ui", ["packages/ui/src/Button.tsx"]]
        ]
    );

    assert.deepEqual(result.modules[1].dependencies, [
        { name: "shop", scope: "prod", version: "workspace:*", module: "." },
        { name: "react", scope: "prod", version: "^19.0.0" }
    ]);
});

test("describes files", () => {
    assert.equal(orders.language, "TYPESCRIPT");
    assert.equal(orders.sourceSet, "MAIN");
    assert.equal(orders.lineCount, 78);
    assert.match(orders.checksum ?? "", /^[0-9a-f]{64}$/);

    assert.equal(file("src/logging.js").language, "JAVASCRIPT");
    assert.equal(file("src/orders.test.ts").sourceSet, "TEST");

    assert.deepEqual(
        file("src/index.ts").imports?.map(({ name, wildcard }) => ({ name, wildcard })),
        [{ name: "./orders", wildcard: true }, { name: "./logging", wildcard: undefined }]
    );
});

test("lists classes, interfaces, enums and type aliases", () => {
    assert.deepEqual(
        orders.classes?.map(declaration => [declaration.name, declaration.kind]),
        [["Status", "ENUM"], ["Repository", "INTERFACE"], ["OrderId", "TYPE_ALIAS"], ["Order", "CLASS"], ["OrderService", "CLASS"]]
    );

    assert.deepEqual(find(orders.classes, "src/orders:Status").enumConstants?.map(constant => constant.qualifiedName), [
        "src/orders:Status.OPEN",
        "src/orders:Status.CLOSED"
    ]);

    assert.deepEqual(find(orders.classes, "src/orders:OrderId").aliasedType, { name: "string" });
    assert.deepEqual(find(orders.classes, "src/orders:Repository").typeParameters, ["T"]);

    assert.deepEqual(
        { startLine: order.startLine, endLine: order.endLine, startColumn: order.startColumn, endColumn: order.endColumn },
        { startLine: 15, endLine: 32, startColumn: 1, endColumn: 1 }
    );
});

test("lists fields, including parameter properties and accessors", () => {
    assert.deepEqual(
        order.fields?.map(field => [field.qualifiedName, field.type?.name, field.modifiers]),
        [
            ["src/orders:Order.items", "string[]", ["PRIVATE"]],
            ["src/orders:Order.id", "OrderId", ["READONLY"]],
            ["src/orders:Order.status", "Status", ["PUBLIC"]],
            ["src/orders:Order.total", "number", undefined]
        ]
    );

    assert.deepEqual(find(order.fields, "src/orders:Order.id").type?.references, ["src/orders:OrderId"]);
});

test("lists methods, constructors and accessors", () => {
    assert.deepEqual(
        order.methods?.map(method => [method.qualifiedName, method.kind]),
        [
            ["src/orders:Order.constructor", "CONSTRUCTOR"],
            ["src/orders:Order.total.get", "METHOD"],
            ["src/orders:Order.total.set", "METHOD"],
            ["src/orders:Order.add", "METHOD"]
        ]
    );
});

test("lists an overloaded method once, as its implementation", () => {
    const open = find(orderService.methods, "src/orders:OrderService.open");

    assert.equal(orderService.methods?.filter(method => method.name === "open").length, 1);
    assert.deepEqual(open.modifiers, ["ASYNC"]);
    assert.deepEqual(open.returnType, { name: "Promise<Order>", references: ["Promise", "src/orders:Order"] });
});

test("lists decorators as annotations", () => {
    assert.deepEqual(
        orderService.annotations?.map(({ name, qualifiedName, arguments: values }) => ({ name, qualifiedName, values })),
        [{ name: "service", qualifiedName: "src/orders:service", values: { value: "orders" } }]
    );
});

test("resolves calls across files, and leaves others as written", () => {
    assert.deepEqual(targets(find(orderService.methods, "src/orders:OrderService.open"), "calls"), [
        "METHOD src/orders:Repository.find",
        "METHOD String",
        "CONSTRUCTOR src/orders:Order.constructor",
        "METHOD String",
        "METHOD src/logging:log",
        "METHOD src/orders:Repository.save"
    ]);

    assert.deepEqual(
        find(orderService.methods, "src/orders:OrderService.open").calls?.map(call => call.resolved),
        [true, false, true, false, true, true]
    );
});

test("lists method references", () => {
    assert.deepEqual(targets(find(orderService.methods, "src/orders:OrderService.close"), "calls"), [
        "METHOD [order].forEach",
        "METHOD_REFERENCE src/orders:OrderService.notify"
    ]);
});

test("lists field accesses by how they use the field", () => {
    assert.deepEqual(targets(find(orderService.methods, "src/orders:OrderService.open"), "fieldAccesses"), [
        "READ_WRITE src/orders:OrderService.count",
        "READ src/orders:OrderService.repository",
        "READ src/orders:Order.status",
        "READ src/orders:Status.CLOSED",
        "READ src/orders:OrderService.repository"
    ]);

    assert.deepEqual(targets(find(orderService.methods, "src/orders:OrderService.close"), "fieldAccesses"), [
        "WRITE src/orders:Order.status",
        "READ src/orders:Status.CLOSED"
    ]);
});

test("lists type uses in bodies", () => {
    assert.deepEqual(targets(find(orderService.methods, "src/orders:OrderService.open"), "typeUses"), [
        "LOCAL_VARIABLE src/orders:Order"
    ]);
});

test("lists local classes under the class whose method declares them", () => {
    const notification: Class = find(orderService.classes, "src/orders:OrderService.notify.Notification");

    assert.equal(notification.nesting, "LOCAL");
    assert.equal(notification.enclosingMethod, "src/orders:OrderService.notify");

    assert.deepEqual(targets(find(orderService.methods, "src/orders:OrderService.notify"), "calls"), [
        "CONSTRUCTOR src/orders:OrderService.notify.Notification.constructor"
    ]);
});

test("lists functions and variables of a file", () => {
    assert.deepEqual(orders.functions?.map(method => [method.qualifiedName, method.kind, method.modifiers]), [
        ["src/orders:service", "FUNCTION", undefined],
        ["src/orders:createService", "FUNCTION", ["EXPORT"]]
    ]);

    assert.deepEqual(orders.variables?.map(field => [field.qualifiedName, field.modifiers]), [
        ["src/orders:DEFAULT_STATUS", ["EXPORT", "CONST"]],
        ["src/orders:MAX_ITEMS", ["EXPORT", "CONST"]],
        ["src/orders:MIN_ITEMS", ["EXPORT", "CONST"]]
    ]);
});

test("lists rendered components as calls", () => {
    const orderButton = find(file("packages/ui/src/Button.tsx").functions, "packages/ui/src/Button:OrderButton");

    assert.deepEqual(targets(orderButton, "calls"), ["METHOD packages/ui/src/Button:Button"]);
    assert.deepEqual(targets(orderButton, "fieldAccesses"), ["READ src/orders:Order.id"]);
});

for (const [range, version] of [
    ["20.11.1", "20.11.1"],
    ["v20.11.1", "20.11.1"],
    ["18.x", "18"],
    ["^20.11.0", "20"],
    [">=18.0.0", "18"],
    ["~20.11.0", "20.11"],
    ["^18 || ^20", "18"],
    ["lts/*", undefined],
    ["<20", undefined]
] as const) {
    test(`reads Node version ${range} as ${version}`, () => {
        assert.equal(normalizeVersion(range), version);
    });
}
