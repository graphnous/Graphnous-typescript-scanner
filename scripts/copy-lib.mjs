// Copies TypeScript's built-in library, the lib.*.d.ts files, next to the
// bundled scanner, where the TypeScript bundled into it looks for them.

import { copyFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const source = dirname(createRequire(import.meta.url).resolve("typescript-api"));
const target = process.argv[2] ?? "build";

const files = readdirSync(source).filter(file => /^lib\..*\.d\.ts$|^lib\.d\.ts$/.test(file));

for (const file of files) {
    copyFileSync(join(source, file), join(target, file));
}

console.log(`Copied ${files.length} library files to ${target}`);
