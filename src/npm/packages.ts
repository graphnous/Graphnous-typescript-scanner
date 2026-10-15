import { randomBytes } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import semver from "semver";
import ts from "typescript-api";
import type { Module } from "../generated/ScanResult.js";
import { LockedVersions } from "./lock-files.js";
import type { Npmrc } from "./npmrc.js";
import { isPackageName, NpmRegistry } from "./registry.js";
import { typeFiles } from "./tarball.js";

export interface PackageOptions {
    /** Where downloaded packages are kept, for later scans to find. */
    cache: string;
    /** Whether to download the packages missing from the cache. */
    download: boolean;
    npmrc: Npmrc;
    log: (message: string) => void;
    verbose: boolean;
}

/**
 * The packages the scanned code uses, for the program to resolve imports
 * of them: a node_modules directory with a link to each, and the @types
 * packages with global declarations, such as @types/node.
 */
export interface ProvidedPackages {
    nodeModules?: string;
    types: string[];
    dispose(): void;
}

/** Bounds the packages of a scan, against a dependency tree without end. */
const MAX_PACKAGES = 1000;

const CONCURRENCY = 8;

const NODE_BUILTINS = new Set(builtinModules.map(name => name.replace(/^node:/, "")));

interface Wanted {
    name: string;
    range?: string;
}

/**
 * Finds the type definitions of the packages the scanned code imports, and
 * those they import in turn, in the package cache, and with download in
 * the registries of the .npmrc. Packages already installed in a
 * node_modules directory of the repository are left to it.
 *
 * Only the packages the project declares in its package.json files are
 * looked for, so a name an import happens to use, such as a path alias, is
 * never asked of a registry. A package without type definitions of its own
 * is looked for as @types/<name>.
 */
export async function providePackages(
    repositoryPath: string,
    targetPath: string,
    modules: Module[],
    sourcePaths: string[],
    options: PackageOptions
): Promise<ProvidedPackages> {
    const declared = new Map<string, string>();

    for (const module of modules) {
        for (const dependency of module.dependencies ?? []) {
            if (dependency.module === undefined && !declared.has(dependency.name)) {
                declared.set(dependency.name, dependency.version ?? "latest");
            }
        }
    }

    const installed = nodeModulesOf(repositoryPath, targetPath);
    const isInstalled = (name: string) => installed.some(directory => existsSync(join(directory, name, "package.json")));

    const wanted: Wanted[] = [];
    let usesNode = declared.has("@types/node");

    for (const path of sourcePaths) {
        for (const name of importedPackages(readFileSync(join(targetPath, path), "utf8"))) {
            if (declared.has(name)) {
                wanted.push({ name, range: declared.get(name) });
            } else if (NODE_BUILTINS.has(name)) {
                usesNode = true;
            }
        }
    }

    for (const [name, range] of declared) {
        if (name.startsWith("@types/")) {
            wanted.push({ name, range });
        }
    }

    if (usesNode) {
        wanted.push({ name: "@types/node", range: declared.get("@types/node") });
    }

    const store = new PackageStore(
        options,
        LockedVersions.read(repositoryPath, targetPath),
        declared,
        isInstalled
    );

    await store.provide(wanted.filter(({ name }) => !isInstalled(name)));

    const provided = store.provided();
    // The @types packages the project declares, whose global declarations
    // the program includes, as tsc does
    const types = [...new Set([
        ...[...declared.keys()].filter(name => name.startsWith("@types/")),
        ...usesNode ? ["@types/node"] : []
    ])].map(name => name.slice("@types/".length));

    if (provided.size === 0) {
        return { types, dispose: () => {} };
    }

    // A node_modules of links to the packages in the cache, for the
    // program to resolve imports in
    const scratch = mkdtempSync(join(tmpdir(), "graphnous-packages-"));
    const nodeModules = join(scratch, "node_modules");

    for (const [name, directory] of provided) {
        const link = join(nodeModules, name);

        mkdirSync(dirname(link), { recursive: true });
        symlinkSync(directory, link, "dir");
    }

    options.log(`Packages: ${provided.size} with their type definitions`);

    return {
        nodeModules,
        types,
        dispose: () => rmSync(scratch, { recursive: true, force: true })
    };
}

/**
 * The node_modules directories from the target up to the repository root,
 * of a project that was installed.
 */
function nodeModulesOf(repositoryPath: string, targetPath: string): string[] {
    const root = resolve(repositoryPath);
    const directories: string[] = [];

    for (let directory = resolve(targetPath); ; directory = dirname(directory)) {
        if (existsSync(join(directory, "node_modules"))) {
            directories.push(join(directory, "node_modules"));
        }

        if (directory === root || relative(root, directory).startsWith("..") || dirname(directory) === directory) {
            return directories;
        }
    }
}

/**
 * The packages a file imports or refers to the types of, by their name:
 * "react" for "react-dom/client" is "react-dom", and "node:fs" is "fs".
 */
export function importedPackages(content: string): Set<string> {
    const info = ts.preProcessFile(content, true, true);
    const names = new Set<string>();

    for (const reference of [...info.importedFiles, ...info.typeReferenceDirectives]) {
        const name = packageName(reference.fileName);

        if (name !== undefined) {
            names.add(name);
        }
    }

    return names;
}

function packageName(specifier: string): string | undefined {
    if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#") || /^[a-z]+:\/\//i.test(specifier)) {
        return undefined;
    }

    const bare = specifier.replace(/^node:/, "");
    const parts = bare.split("/");
    const name = bare.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];

    return isPackageName(name) ? name : undefined;
}

/**
 * The name of the @types package of a package: @types/react for react, and
 * @types/babel__core for @babel/core.
 */
export function typesPackageOf(name: string): string {
    return `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;
}

/**
 * The package cache: a directory per version, such as
 * react@19.1.0/node_modules/react, with the package.json and type
 * definitions of the package.
 */
class PackageStore {

    private readonly directories = new Map<string, string>();

    private readonly seen = new Set<string>();

    private readonly registry: NpmRegistry;

    constructor(
        private readonly options: PackageOptions,
        private readonly locked: LockedVersions,
        private readonly declared: Map<string, string>,
        private readonly isInstalled: (name: string) => boolean
    ) {
        this.registry = new NpmRegistry(options.npmrc);
    }

    provided(): Map<string, string> {
        return this.directories;
    }

    async provide(wanted: Wanted[]): Promise<void> {
        let queue = wanted;

        while (queue.length > 0) {
            const next: Wanted[] = [];
            const batch = queue.filter(({ name }) => {
                if (this.seen.has(name) || this.seen.size >= MAX_PACKAGES) {
                    return false;
                }

                this.seen.add(name);
                return true;
            });

            for (let index = 0; index < batch.length; index += CONCURRENCY) {
                await Promise.all(batch.slice(index, index + CONCURRENCY).map(async package_ => {
                    next.push(...await this.providePackage(package_));
                }));
            }

            queue = next;
        }
    }

    /**
     * Provides the package, and returns the packages its type definitions
     * import in turn.
     */
    private async providePackage({ name, range }: Wanted): Promise<Wanted[]> {
        const directory = await this.directoryOf(name, range);

        if (!directory) {
            if (this.options.verbose) {
                this.options.log(`Package ${name}@${range ?? "latest"}: not found`);
            }

            // Not for a package outside the registry, such as a file: one
            return name.startsWith("@types/") || registryRange(range) === undefined
                ? []
                : [{ name: typesPackageOf(name), range: this.typesRange(name, undefined) }];
        }

        this.directories.set(name, directory);

        const packageJson = readJson(join(directory, "package.json"));
        const dependencies: Record<string, string> = {
            ...stringValues(packageJson.peerDependencies),
            ...stringValues(packageJson.optionalDependencies),
            ...stringValues(packageJson.dependencies)
        };

        const definitions = definitionFiles(directory);
        const wanted: Wanted[] = [];

        if (definitions.length === 0 && !name.startsWith("@types/")) {
            wanted.push({ name: typesPackageOf(name), range: this.typesRange(name, packageJson.version) });
        }

        const imported = new Set<string>();

        for (const file of definitions) {
            for (const dependency of importedPackages(readFileSync(file, "utf8"))) {
                imported.add(dependency);
            }
        }

        for (const dependency of imported) {
            if (dependency === name || this.isInstalled(dependency)) {
                continue;
            }

            if (NODE_BUILTINS.has(dependency) && !(dependency in dependencies)) {
                wanted.push({ name: "@types/node", range: this.declared.get("@types/node") });
            } else if (this.declared.has(dependency)) {
                // The project's own version of a peer, such as react
                wanted.push({ name: dependency, range: this.declared.get(dependency) });
            } else if (dependency in dependencies) {
                wanted.push({ name: dependency, range: dependencies[dependency] });
            } else if (typesPackageOf(dependency) in dependencies) {
                // @types/express imports express-serve-static-core, and
                // depends on @types/express-serve-static-core
                wanted.push({ name: typesPackageOf(dependency), range: dependencies[typesPackageOf(dependency)] });
            }
        }

        if (this.options.verbose) {
            this.options.log(`Package ${name}: ${relative(this.options.cache, directory)}`);
        }

        return wanted;
    }

    /**
     * The range of the @types package of a package: the project's when it
     * declares it, else the major version of the package.
     */
    private typesRange(name: string, version: unknown): string | undefined {
        const declared = this.declared.get(typesPackageOf(name));

        if (declared !== undefined) {
            return declared;
        }

        const major = typeof version === "string" ? semver.parse(version)?.major : undefined;

        return major === undefined ? undefined : `${major}`;
    }

    /**
     * The directory of a version of the package the range allows: the
     * version the lock files pin, else the newest in the cache, else the
     * one the registry picks when downloading.
     */
    private async directoryOf(name: string, range: string | undefined): Promise<string | undefined> {
        if (!isPackageName(name)) {
            return undefined;
        }

        const semverRange = range !== undefined && semver.validRange(range) !== null ? range : undefined;
        const locked = this.locked.pick(name, range);

        if (locked !== undefined && existsSync(this.path(name, locked))) {
            return this.path(name, locked);
        }

        const cached = this.cachedVersions(name);
        const fromCache = locked === undefined
            ? semver.maxSatisfying(cached, semverRange ?? "*")
            : undefined;

        if (fromCache) {
            return this.path(name, fromCache);
        }

        if (!this.options.download) {
            return undefined;
        }

        // Not for ranges outside the registry, such as file:, git and
        // workspace: ones
        const asked = locked ?? registryRange(range);

        if (asked === undefined) {
            return undefined;
        }

        const version = await this.registry.resolve(name, asked)
            ?? (locked !== undefined && registryRange(range) !== undefined ? await this.registry.resolve(name, registryRange(range)!) : undefined);

        if (!version) {
            return undefined;
        }

        const path = this.path(name, version.version);

        if (existsSync(path)) {
            return path;
        }

        const tarball = await this.registry.tarball(version);

        if (!tarball) {
            this.options.log(`Package ${name}@${version.version}: could not download it, or its checksum does not match`);
            return undefined;
        }

        let files: Map<string, Buffer>;

        try {
            files = typeFiles(tarball);
        } catch {
            this.options.log(`Package ${name}@${version.version}: could not read its tarball`);
            return undefined;
        }

        this.write(name, version.version, files);

        return path;
    }

    private cachedVersions(name: string): string[] {
        const prefix = `${flat(name)}@`;

        try {
            return readdirSync(this.options.cache)
                .filter(entry => entry.startsWith(prefix))
                .map(entry => entry.slice(prefix.length))
                .filter(version => semver.valid(version) !== null && existsSync(this.path(name, version)));
        } catch {
            return [];
        }
    }

    private path(name: string, version: string): string {
        return join(this.options.cache, `${flat(name)}@${version}`, "node_modules", name);
    }

    /**
     * Writes the files of a version to the cache, whole or not at all, so
     * another scan sharing the cache never reads a version half written.
     */
    private write(name: string, version: string, files: Map<string, Buffer>): void {
        mkdirSync(this.options.cache, { recursive: true });

        const temporary = join(this.options.cache, `.${flat(name)}@${version}.${process.pid}.${randomBytes(4).toString("hex")}.part`);
        const packageDirectory = join(temporary, "node_modules", name);

        try {
            for (const [path, content] of files) {
                const file = resolve(packageDirectory, path);

                if (!file.startsWith(packageDirectory + sep)) {
                    continue;
                }

                mkdirSync(dirname(file), { recursive: true });
                writeFileSync(file, content);
            }

            if (!files.has("package.json")) {
                mkdirSync(packageDirectory, { recursive: true });
                writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ name, version }));
            }

            try {
                renameSync(temporary, join(this.options.cache, `${flat(name)}@${version}`));
            } catch (error) {
                // Another scan wrote it first
                if (!existsSync(this.path(name, version))) {
                    throw error;
                }
            }
        } finally {
            rmSync(temporary, { recursive: true, force: true });
        }
    }
}

/**
 * What to ask the registry for a range of a package.json: the range or
 * dist-tag, latest for none, and nothing for those the registry does not
 * serve, such as file:, link:, workspace:, git and URL ones, and npm:
 * aliases.
 */
function registryRange(range: string | undefined): string | undefined {
    if (range === undefined || range === "" || range === "*") {
        return "latest";
    }

    if (semver.validRange(range) !== null) {
        return range;
    }

    return /^[A-Za-z][\w.-]*$/.test(range) ? range : undefined;
}

/** A package name as one directory name: @types/node as @types+node. */
function flat(name: string): string {
    return name.replace("/", "+");
}

function definitionFiles(directory: string): string[] {
    const files: string[] = [];

    const visit = (current: string) => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const path = join(current, entry.name);

            if (entry.isDirectory() && entry.name !== "node_modules") {
                visit(path);
            } else if (entry.isFile() && /\.d\.[cm]?ts$/.test(entry.name)) {
                files.push(path);
            }
        }
    };

    visit(directory);

    return files;
}

function readJson(path: string): Record<string, unknown> {
    try {
        const value = JSON.parse(readFileSync(path, "utf8"));

        return typeof value === "object" && value !== null ? value : {};
    } catch {
        return {};
    }
}

function stringValues(value: unknown): Record<string, string> {
    if (typeof value !== "object" || value === null) {
        return {};
    }

    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
