// Generates src/generated/ScanResult.ts from the published scan result schema.
// Pass a URL or a local path to generate from another copy of the schema.
import { readFile, writeFile } from "node:fs/promises";
import { compile } from "json-schema-to-typescript";

const source =
    process.argv[2] ?? "https://graphnous.github.io/graphnous-schemas/schema/scan/scan-result.schema.json";
const output = new URL("../src/generated/ScanResult.ts", import.meta.url);

async function readSchema(source) {
    if (!/^https?:\/\//.test(source)) {
        return JSON.parse(await readFile(source, "utf8"));
    }
    const response = await fetch(source);
    if (!response.ok) {
        throw new Error(`Fetching ${source} failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
}

const schema = await readSchema(source);
await writeFile(output, await compile(schema, "ScanResult"));
console.log(`Generated ${output.pathname} from ${source}`);
