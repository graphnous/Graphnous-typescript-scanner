import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Dependency, Module, ScanTarget } from "../generated/ScanResult.js";
import { packageDirectories } from "./source-files.js";

/**
 * The Node version reported when the target names none, as the server
 * does.
 */
export const DEFAULT_NODE_VERSION = "24";

/**
 * The dependency fields of a package.json, with the scope their
 * dependencies get: npm's own names for them, as in npm install --omit=dev.
 */
const DEPENDENCY_SCOPES: Record<string, string> = {
    dependencies: "prod",
    devDependencies: "dev",
    peerDependencies: "peer",
    optionalDependencies: "optional"
};

interface PackageJson {
    name?: unknown;
    packageManager?: unknown;
    engines?: { node?: unknown };
    [field: string]: unknown;
}

/**
 * The modules of the target: one for each package.json in it, such as the
 * packages of a workspace, and always one for the target itself. Their
 * paths are relative to the target, "." for the target.
 */
export function detectModules(
    targetPath: string,
    warn: (message: string) => void
): Module[] {
    const directories = packageDirectories(targetPath);

    if (!directories.includes(".")) {
        directories.unshift(".");
    }

    const packages = directories.map(directory => ({
        directory,
        packageJson: readPackageJson(join(targetPath, directory), warn)
    }));

    // Packages of the target by name, so a dependency on another one of
    // them refers to its module
    const modulesByName = new Map<string, string>();

    for (const { directory, packageJson } of packages) {
        if (typeof packageJson?.name === "string") {
            modulesByName.set(packageJson.name, directory);
        }
    }

    return packages.map(({ directory, packageJson }) => {
        const name = typeof packageJson?.name === "string"
            ? packageJson.name
            : basename(join(targetPath, directory));

        const module: Module = {
            name,
            path: directory,
            files: []
        };

        const dependencies = packageJson ? readDependencies(packageJson, modulesByName) : [];

        if (dependencies.length > 0) {
            module.dependencies = dependencies;
        }

        return module;
    });
}

function readDependencies(
    packageJson: PackageJson,
    modulesByName: Map<string, string>
): Dependency[] {
    const dependencies: Dependency[] = [];

    for (const [field, scope] of Object.entries(DEPENDENCY_SCOPES)) {
        const declared = packageJson[field];

        if (!declared || typeof declared !== "object") {
            continue;
        }

        for (const [name, version] of Object.entries(declared)) {
            const dependency: Dependency = { name, scope };

            if (typeof version === "string") {
                dependency.version = version;
            }

            const module = modulesByName.get(name);

            if (module !== undefined) {
                dependency.module = module;
            }

            dependencies.push(dependency);
        }
    }

    return dependencies;
}

/**
 * The package manager of the target, from the packageManager field of its
 * package.json, e.g. "pnpm@9.1.0", or else from its lock file. npm when
 * neither names one.
 */
export function detectBuildSystem(
    targetPath: string
): Pick<ScanTarget, "buildSystem" | "buildSystemVersion"> {
    const packageManager = readPackageJson(targetPath, () => {})?.packageManager;

    if (typeof packageManager === "string") {
        const [name, version] = packageManager.split("@");
        const buildSystem = BUILD_SYSTEMS[name];

        if (buildSystem) {
            // Without the hash that may follow, e.g. "9.1.0+sha512.abc"
            const plainVersion = version?.split("+")[0];

            return plainVersion
                ? { buildSystem, buildSystemVersion: plainVersion }
                : { buildSystem };
        }
    }

    for (const [lockFile, buildSystem] of LOCK_FILES) {
        if (existsSync(join(targetPath, lockFile))) {
            return { buildSystem };
        }
    }

    return { buildSystem: "NPM" };
}

const BUILD_SYSTEMS: Record<string, ScanTarget["buildSystem"]> = {
    npm: "NPM",
    pnpm: "PNPM",
    yarn: "YARN",
    bun: "BUN"
};

const LOCK_FILES: [string, ScanTarget["buildSystem"]][] = [
    ["pnpm-lock.yaml", "PNPM"],
    ["yarn.lock", "YARN"],
    ["bun.lock", "BUN"],
    ["bun.lockb", "BUN"],
    ["package-lock.json", "NPM"]
];

/**
 * The Node version of the target, as the server detects it: from .nvmrc,
 * .node-version or the engines field of its package.json, and the default
 * version when none of them names one.
 */
export function detectNodeVersion(targetPath: string): string {
    for (const file of [".nvmrc", ".node-version"]) {
        const path = join(targetPath, file);

        if (existsSync(path)) {
            const version = normalizeVersion(readFileSync(path, "utf8").trim());

            if (version) {
                return version;
            }
        }
    }

    const node = readPackageJson(targetPath, () => {})?.engines?.node;

    if (typeof node === "string") {
        const version = normalizeVersion(node);

        if (version) {
            return version;
        }
    }

    return DEFAULT_NODE_VERSION;
}

const COMPARATOR = /^(<=|>=|<|>|=|\^|~)?v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/;

/**
 * Turns a version or semver range into a version, or undefined when it
 * has no lower bound to pick (such as lts/*, * or <20):
 * 20.11.1 and v20.11.1 become 20.11.1, 18.x becomes 18, ^20.11.0 and
 * >=20 become 20, ~20.11.0 becomes 20.11, and of ^18 || ^20 the first
 * alternative counts.
 */
export function normalizeVersion(version: string): string | undefined {
    const alternative = version.split("||")[0].trim();

    for (const comparator of alternative.split(/\s+/)) {
        const match = COMPARATOR.exec(comparator);

        if (!match) {
            continue;
        }

        const [, operator = "", major, minor, patch] = match;

        if (operator.startsWith("<")) {
            continue;
        }

        const isNumber = (part: string | undefined): part is string => part !== undefined && /^\d+$/.test(part);

        switch (operator) {
            case "^":
            case ">":
            case ">=":
                return major;
            case "~":
                return isNumber(minor) ? `${major}.${minor}` : major;
            default:
                if (!isNumber(minor)) {
                    return major;
                }

                return isNumber(patch) ? `${major}.${minor}.${patch}` : `${major}.${minor}`;
        }
    }

    return undefined;
}

/**
 * The package.json in the directory, or undefined when there is none or it
 * cannot be read, with a warning for the latter.
 */
function readPackageJson(
    directory: string,
    warn: (message: string) => void
): PackageJson | undefined {
    const path = join(directory, "package.json");

    if (!existsSync(path)) {
        return undefined;
    }

    try {
        const packageJson = JSON.parse(readFileSync(path, "utf8"));

        return packageJson && typeof packageJson === "object" ? packageJson : undefined;
    } catch (error) {
        warn(`Could not read ${path}: ${error instanceof Error ? error.message : error}`);

        return undefined;
    }
}
