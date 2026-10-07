import { readdirSync } from "node:fs";
import { join, posix } from "node:path";
import type { File } from "../generated/ScanResult.js";

/**
 * Directories that hold dependencies, build output or tool caches rather
 * than sources, skipped wherever they are. Hidden directories such as .git
 * are skipped too.
 */
const IGNORED_DIRECTORIES = new Set([
    "node_modules",
    "bower_components",
    "dist",
    "build",
    "out",
    "coverage",
    "storybook-static"
]);

const TYPESCRIPT_EXTENSIONS = [".d.ts", ".d.mts", ".d.cts", ".ts", ".tsx", ".mts", ".cts"];

const JAVASCRIPT_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs"];

/**
 * Directories whose files are test code, wherever they are.
 */
const TEST_DIRECTORIES = new Set(["test", "tests", "__tests__", "__mocks__", "spec", "e2e"]);

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * The TypeScript and JavaScript files below the target, as paths relative
 * to it with forward slashes, sorted.
 */
export function sourceFiles(targetPath: string): string[] {
    return walk(targetPath)
        .filter(path => language(path) !== undefined && !path.endsWith(".min.js"))
        .sort();
}

/**
 * The directories below the target that have a package.json, as paths
 * relative to it, "." for the target itself.
 */
export function packageDirectories(targetPath: string): string[] {
    return walk(targetPath)
        .filter(path => posix.basename(path) === "package.json")
        .map(path => posix.dirname(path))
        .sort();
}

/**
 * The language of the file from its extension: TYPESCRIPT or JAVASCRIPT,
 * or undefined for other files.
 */
export function language(path: string): "TYPESCRIPT" | "JAVASCRIPT" | undefined {
    if (TYPESCRIPT_EXTENSIONS.some(extension => path.endsWith(extension))) {
        return "TYPESCRIPT";
    }

    if (JAVASCRIPT_EXTENSIONS.some(extension => path.endsWith(extension))) {
        return "JAVASCRIPT";
    }

    return undefined;
}

/**
 * The path without its extension, as qualified names start with, e.g.
 * "src/orders" for "src/orders.ts".
 */
export function withoutExtension(path: string): string {
    const extension = [...TYPESCRIPT_EXTENSIONS, ...JAVASCRIPT_EXTENSIONS]
        .find(candidate => path.endsWith(candidate));

    return extension ? path.slice(0, -extension.length) : path;
}

/**
 * Whether the file is test code: a *.test.* or *.spec.* file, or a file in
 * a test directory such as __tests__. Everything else is production code.
 */
export function sourceSet(path: string): NonNullable<File["sourceSet"]> {
    const directories = path.split("/").slice(0, -1);

    return TEST_FILE.test(path) || directories.some(directory => TEST_DIRECTORIES.has(directory))
        ? "TEST"
        : "MAIN";
}

/**
 * The module a file belongs to: the deepest module directory that contains
 * it.
 */
export function moduleOf(path: string, modulePaths: string[]): string {
    return modulePaths
        .filter(module => module === "." || path.startsWith(`${module}/`))
        .sort((a, b) => depth(b) - depth(a))[0] ?? ".";
}

function depth(modulePath: string): number {
    return modulePath === "." ? 0 : modulePath.split("/").length;
}

/**
 * Every file below the directory, skipping ignored and hidden directories.
 */
function walk(root: string, relative = "."): string[] {
    const files: string[] = [];

    let entries;

    try {
        entries = readdirSync(join(root, relative), { withFileTypes: true });
    } catch {
        return files;
    }

    for (const entry of entries) {
        const path = relative === "." ? entry.name : `${relative}/${entry.name}`;

        if (entry.isDirectory()) {
            if (!IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) {
                files.push(...walk(root, path));
            }
        } else if (entry.isFile()) {
            files.push(path);
        }
    }

    return files;
}
