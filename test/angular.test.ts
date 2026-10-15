import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Class, Method } from "../src/generated/ScanResult.js";
import { TypeScriptScanner } from "../src/scanner/typescript-scanner.js";

// An Angular app: a component with a templateUrl, one with an inline
// template, a pipe and a directive
const fixtures = fileURLToPath(new URL("fixtures", import.meta.url));

const result = new TypeScriptScanner().scan(fixtures, "angular");

const files = result.modules.flatMap(module => module.files);

function classOf(qualifiedName: string): Class {
    const found = files.flatMap(file => file.classes ?? []).find(candidate => candidate.qualifiedName === qualifiedName);

    assert.ok(found, `No class ${qualifiedName}`);

    return found;
}

function templateOf(className: string): Method {
    const found = classOf(className).methods?.find(method => method.name === "template");

    assert.ok(found, `No template of ${className}`);

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

test("lists the template files of components", () => {
    assert.deepEqual(
        files.filter(file => file.language === "HTML").map(file => [file.path, file.sourceSet, file.lineCount]),
        [["src/app/orders/order-list.component.html", "MAIN", 14]]
    );
});

test("gives what a template file uses to the method template of its component, at its places in the file", () => {
    const template = templateOf("src/app/orders/order-list.component:OrderListComponent");

    assert.equal(template.qualifiedName, "src/app/orders/order-list.component:OrderListComponent.template");
    assert.equal(template.startLine, undefined);

    assert.deepEqual(uses(template, "calls"), [
        "METHOD src/app/orders/order-list.component:OrderListComponent.refresh 2:43",
        "CONSTRUCTOR src/app/orders/order-card.component:OrderCardComponent.constructor 4:3",
        "CONSTRUCTOR src/app/shared/highlight.directive:HighlightDirective.constructor 4:3",
        "METHOD src/app/orders/order-list.component:OrderListComponent.select 4:59",
        "METHOD src/app/shared/money.pipe:MoneyPipe.transform 5:12",
        "METHOD uppercase 5:44 unresolved",
        "METHOD src/app/orders/order-list.component:OrderListComponent.select 10:57",
        "METHOD src/app/orders/orders.service:OrdersService.find 13:9"
    ]);

    assert.deepEqual(uses(template, "fieldAccesses").filter(use => use.includes("OrderListComponent")), [
        "READ src/app/orders/order-list.component:OrderListComponent.orders 1:8",
        "READ src/app/orders/order-list.component:OrderListComponent.query 2:21",
        "WRITE src/app/orders/order-list.component:OrderListComponent.query 2:21",
        "READ src/app/orders/order-list.component:OrderListComponent.orders 3:16",
        "READ src/app/orders/order-list.component:OrderListComponent.orders 10:28",
        "READ src/app/orders/order-list.component:OrderListComponent.selected 12:6",
        "READ src/app/orders/order-list.component:OrderListComponent.service 13:9"
    ]);

    // The items of @for, *ngFor and @if as are typed
    assert.deepEqual(uses(template, "fieldAccesses").filter(use => use.includes("order:Order")), [
        "READ src/app/orders/order:Order.id 3:30",
        "READ src/app/orders/order:Order.total 5:12",
        "READ src/app/orders/order:Order.id 5:44",
        "READ src/app/orders/order:Order.total 13:9",
        "READ src/app/orders/order:Order.id 13:22"
    ]);
});

test("lists the arguments of template calls as written, and the inputs of components by name", () => {
    const calls = templateOf("src/app/orders/order-list.component:OrderListComponent").calls ?? [];

    assert.deepEqual(calls.find(call => call.target.endsWith("MoneyPipe.transform"))?.arguments, [
        { value: "order.total" },
        { value: "'EUR'" }
    ]);
    assert.deepEqual(calls.find(call => call.target.endsWith("OrderCardComponent.constructor"))?.arguments, [
        { name: "label", value: "Order" },
        { name: "order", value: "order" }
    ]);
    assert.deepEqual(calls.find(call => call.target.endsWith("select"))?.arguments, [{ value: "$event" }]);
});

test("gives what an inline template uses to the method template, at its places in the file of the component", () => {
    const template = templateOf("src/app/orders/order-card.component:OrderCardComponent");

    assert.deepEqual([template.startLine, template.startColumn], [6, 16]);
    assert.deepEqual(uses(template, "calls"), ["METHOD src/app/orders/order-card.component:OrderCardComponent.open 6:30"]);
    assert.deepEqual(uses(template, "fieldAccesses"), [
        "READ src/app/orders/order-card.component:OrderCardComponent.label 6:41",
        "READ src/app/orders/order:Order.id 6:54",
        "READ src/app/orders/order-card.component:OrderCardComponent.order 6:54"
    ]);
});
