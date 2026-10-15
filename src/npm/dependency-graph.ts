import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parse as parseYaml, parseAllDocuments } from "yaml";

/**
 * A package the lock file installs, with what it depends on in turn.
 */
export interface LockedPackage {
    name: string;
    version?: string;
    /** For a package of the workspace: its path, relative to the lock file. */
    workspace?: string;
    /** What it depends on, by name: the id of the package installed for it. */
    dependencies: Map<string, string>;
}

/**
 * What a package of the workspace, or the root, depends on, with the field
 * of its package.json that declares it.
 */
export interface ImporterDependency {
    id: string;
    field: "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies";
}

/**
 * The packages a lock file installs and how they depend on each other:
 * package-lock.json or npm-shrinkwrap.json (lockfileVersion 2 and 3),
 * pnpm-lock.yaml (6 and 9), yarn.lock (v1 and Berry) and bun.lock.
 */
export class DependencyGraph {

    constructor(
        /** The directory of the lock file. */
        readonly directory: string,
        private readonly packages: Map<string, LockedPackage>,
        private readonly importers: Map<string, Map<string, ImporterDependency>>,
        /** For lock files without importers: the id of a declared name and range. */
        private readonly descriptors: Map<string, string> = new Map()
    ) {
    }

    /**
     * The graph of the lock file nearest to the target, up to the
     * repository root, or undefined without one that can be read.
     */
    static read(repositoryPath: string, targetPath: string): DependencyGraph | undefined {
        const root = resolve(repositoryPath);

        for (let directory = resolve(targetPath); ; directory = dirname(directory)) {
            for (const [file, parse] of PARSERS) {
                const path = join(directory, file);

                if (existsSync(path)) {
                    try {
                        return parse(readFileSync(path, "utf8"), directory);
                    } catch {
                        return undefined;
                    }
                }
            }

            if (directory === root || relative(root, directory).startsWith("..") || dirname(directory) === directory) {
                return undefined;
            }
        }
    }

    package(id: string): LockedPackage | undefined {
        return this.packages.get(id);
    }

    /**
     * What a package of the workspace depends on, by its path relative to
     * the lock file, "." for the root; for lock files without importers,
     * the declared dependencies of its package.json, as the lock file
     * resolves their ranges.
     */
    importer(path: string, declared: Map<string, { range?: string; field: ImporterDependency["field"] }>): Map<string, ImporterDependency> {
        const importer = this.importers.get(path);

        if (importer) {
            return importer;
        }

        const result = new Map<string, ImporterDependency>();

        for (const [name, { range, field }] of declared) {
            const id = range === undefined ? undefined
                : this.descriptors.get(`${name}@${range}`) ?? this.descriptors.get(`${name}@npm:${range}`);

            if (id !== undefined) {
                result.set(name, { id, field });
            }
        }

        return result;
    }
}

type Parser = (content: string, directory: string) => DependencyGraph;

const PARSERS: [string, Parser][] = [
    ["pnpm-lock.yaml", pnpmLock],
    ["package-lock.json", npmLock],
    ["npm-shrinkwrap.json", npmLock],
    ["yarn.lock", yarnLock],
    ["bun.lock", bunLock]
];

const FIELDS = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"] as const;

// package-lock.json

interface NpmEntry {
    name?: unknown;
    version?: unknown;
    link?: unknown;
    resolved?: unknown;
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
    optionalDependencies?: Record<string, unknown>;
    peerDependencies?: Record<string, unknown>;
}

/**
 * The packages of package-lock.json by their path, such as
 * node_modules/a/node_modules/b; a dependency is the package Node finds
 * for it from there, in the nearest node_modules up.
 */
function npmLock(content: string, directory: string): DependencyGraph {
    const lock = JSON.parse(content) as { packages?: Record<string, NpmEntry> };
    const entries = lock.packages ?? {};
    const packages = new Map<string, LockedPackage>();
    const importers = new Map<string, Map<string, ImporterDependency>>();

    const find = (from: string, name: string): string | undefined => {
        for (let base = from; ; ) {
            const candidate = base === "" ? `node_modules/${name}` : `${base}/node_modules/${name}`;

            if (entries[candidate]) {
                return candidate;
            }

            if (base === "") {
                return undefined;
            }

            const index = base.lastIndexOf("/node_modules/");

            base = index >= 0 ? base.slice(0, index) : "";
        }
    };

    for (const [path, entry] of Object.entries(entries)) {
        const index = path.lastIndexOf("node_modules/");

        if (index < 0) {
            // The root, "", or a package of the workspace, "packages/web"
            const dependencies = new Map<string, ImporterDependency>();

            for (const field of FIELDS) {
                for (const name of Object.keys(entry[field] ?? {})) {
                    const id = find(path, name);

                    if (id !== undefined && !dependencies.has(name)) {
                        dependencies.set(name, { id, field });
                    }
                }
            }

            importers.set(path === "" ? "." : path, dependencies);
            continue;
        }

        const name = typeof entry.name === "string" ? entry.name : path.slice(index + "node_modules/".length);

        if (entry.link === true) {
            packages.set(path, {
                name,
                workspace: typeof entry.resolved === "string" ? entry.resolved : undefined,
                dependencies: new Map()
            });
            continue;
        }

        const dependencies = new Map<string, string>();

        for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
            for (const dependency of Object.keys(entry[field] ?? {})) {
                const id = find(path, dependency);

                if (id !== undefined) {
                    dependencies.set(dependency, id);
                }
            }
        }

        packages.set(path, {
            name,
            version: typeof entry.version === "string" ? entry.version : undefined,
            dependencies
        });
    }

    return new DependencyGraph(directory, packages, importers);
}

// pnpm-lock.yaml

type PnpmDependencies = Record<string, string | { version?: string; specifier?: string }>;

/**
 * The packages of pnpm-lock.yaml by their key, name@version with the peers
 * they were installed with, such as react-dom@18.3.1(react@18.3.1): in
 * snapshots for lockfileVersion 9, in packages, with a leading slash, for
 * 6. Importers are the packages of the workspace by their path.
 */
function pnpmLock(content: string, directory: string): DependencyGraph {
    // pnpm 10 writes the lock file of its configuration dependencies first,
    // as a document of its own; the project's has the most importers
    const documents = parseAllDocuments(content, { maxAliasCount: -1 } as never)
        .map(document => document.toJS({ maxAliasCount: -1 }) as { importers?: object } | null)
        .filter(document => document !== null && typeof document === "object");

    const lock = documents.reduce((best, document) =>
        Object.keys(document?.importers ?? {}).length > Object.keys(best?.importers ?? {}).length ? document : best,
    documents[0]) as {
        importers?: Record<string, Record<string, PnpmDependencies>>;
        snapshots?: Record<string, Record<string, PnpmDependencies>>;
        packages?: Record<string, Record<string, PnpmDependencies>>;
        dependencies?: PnpmDependencies;
        devDependencies?: PnpmDependencies;
        optionalDependencies?: PnpmDependencies;
    };

    const packages = new Map<string, LockedPackage>();
    const importers = new Map<string, Map<string, ImporterDependency>>();
    const v6 = lock.snapshots === undefined;
    const keyOf = (name: string, version: string) => v6 ? `/${name}@${version}` : `${name}@${version}`;

    const idOf = (name: string, version: string, from: string): string | undefined => {
        if (version.startsWith("link:")) {
            const workspace = relative(directory, resolve(directory, from, version.slice("link:".length))) || ".";
            const id = `link:${workspace}`;

            packages.set(id, { name, workspace, dependencies: new Map() });

            return id;
        }

        // An alias, such as string-width-cjs: string-width@4.2.3
        const alias = /^(@?[^@]+)@(\d.*)$/.exec(version);

        return alias ? keyOf(alias[1], alias[2]) : keyOf(name, version);
    };

    const versionOf = (value: PnpmDependencies[string]) => typeof value === "string" ? value : value.version;

    const importerOf = (fields: Record<string, PnpmDependencies | undefined>, path: string) => {
        const dependencies = new Map<string, ImporterDependency>();

        for (const field of FIELDS) {
            for (const [name, value] of Object.entries(fields[field] ?? {})) {
                const version = versionOf(value);
                const id = version === undefined ? undefined : idOf(name, version, path);

                if (id !== undefined && !dependencies.has(name)) {
                    dependencies.set(name, { id, field });
                }
            }
        }

        importers.set(path, dependencies);
    };

    if (lock.importers) {
        for (const [path, fields] of Object.entries(lock.importers)) {
            importerOf(fields, path);
        }
    } else {
        importerOf(lock as Record<string, PnpmDependencies>, ".");
    }

    for (const [key, entry] of Object.entries((v6 ? lock.packages : lock.snapshots) ?? {})) {
        const match = /^\/?(@?[^@]+)@([^(]+)/.exec(key);

        if (!match) {
            continue;
        }

        const dependencies = new Map<string, string>();

        for (const field of ["dependencies", "optionalDependencies"] as const) {
            for (const [name, value] of Object.entries(entry?.[field] ?? {})) {
                const version = versionOf(value);
                const id = version === undefined ? undefined : idOf(name, version, ".");

                if (id !== undefined) {
                    dependencies.set(name, id);
                }
            }
        }

        packages.set(key, { name: match[1], version: match[2], dependencies });
    }

    return new DependencyGraph(directory, packages, importers);
}

// yarn.lock

/**
 * The entries of yarn.lock, by the descriptors they resolve, name@range in
 * v1 and name@npm:range in Berry; Berry lists the packages of the
 * workspace as name@workspace:path.
 */
function yarnLock(content: string, directory: string): DependencyGraph {
    const entries = content.includes("__metadata:") ? berryEntries(content) : v1Entries(content);
    const packages = new Map<string, LockedPackage>();
    const importers = new Map<string, Map<string, ImporterDependency>>();
    const descriptors = new Map<string, string>();

    for (const [index, entry] of entries.entries()) {
        for (const descriptor of entry.descriptors) {
            descriptors.set(descriptor, String(index));
        }
    }

    const idOf = (name: string, range: string) =>
        descriptors.get(`${name}@${range}`) ?? descriptors.get(`${name}@npm:${range}`);

    for (const [index, entry] of entries.entries()) {
        const name = nameOf(entry.descriptors[0]);
        const workspace = entry.descriptors
            .map(descriptor => /@workspace:(.*)$/.exec(descriptor)?.[1])
            .find(path => path !== undefined);
        const dependencies = new Map<string, string>();

        for (const [dependency, range] of Object.entries(entry.dependencies)) {
            const id = idOf(dependency, range);

            if (id !== undefined) {
                dependencies.set(dependency, id);
            }
        }

        if (workspace !== undefined) {
            // Which field declares each is in the package.json, not here
            importers.set(workspace, new Map([...dependencies].map(([dependency, id]) => [
                dependency,
                { id, field: "dependencies" }
            ])));
        }

        packages.set(String(index), { name, version: entry.version, workspace, dependencies });
    }

    return new DependencyGraph(directory, packages, importers, descriptors);
}

interface YarnEntry {
    descriptors: string[];
    version?: string;
    dependencies: Record<string, string>;
}

function v1Entries(content: string): YarnEntry[] {
    const entries: YarnEntry[] = [];
    let entry: YarnEntry | undefined;
    let section: string | undefined;

    for (const line of content.split(/\r?\n/)) {
        if (line.startsWith("#") || line.trim() === "") {
            continue;
        }

        if (/^\S.*:$/.test(line)) {
            entry = {
                descriptors: line.slice(0, -1).split(/,\s*/).map(descriptor => unquote(descriptor.trim())),
                dependencies: {}
            };
            entries.push(entry);
            section = undefined;
            continue;
        }

        if (!entry) {
            continue;
        }

        const field = /^ {2}(\w+):?\s*(.*)$/.exec(line);

        if (field) {
            section = field[2] === "" ? field[1] : undefined;

            if (field[1] === "version") {
                entry.version = unquote(field[2]);
            }

            continue;
        }

        const dependency = /^ {4}("?[^\s"]+"?)\s+(.+)$/.exec(line);

        if (dependency && (section === "dependencies" || section === "optionalDependencies")) {
            entry.dependencies[unquote(dependency[1])] = unquote(dependency[2]);
        }
    }

    return entries;
}

function berryEntries(content: string): YarnEntry[] {
    const lock = parseYaml(content) as Record<string, {
        version?: unknown;
        dependencies?: Record<string, unknown>;
        optionalDependencies?: Record<string, unknown>;
        dependenciesMeta?: unknown;
    }>;

    return Object.entries(lock)
        .filter(([key]) => key !== "__metadata")
        .map(([key, value]) => ({
            descriptors: key.split(/,\s*/).map(descriptor => descriptor.trim()),
            version: typeof value?.version === "string" ? value.version : undefined,
            dependencies: Object.fromEntries(Object.entries({ ...value?.optionalDependencies, ...value?.dependencies })
                .filter((dependency): dependency is [string, string] => typeof dependency[1] === "string"))
        }));
}

function nameOf(descriptor: string): string {
    const at = descriptor.indexOf("@", 1);

    return at > 0 ? descriptor.slice(0, at) : descriptor;
}

function unquote(value: string): string {
    return value.replace(/^"|"$/g, "");
}

// bun.lock

/**
 * The packages of bun.lock by their key, the name, or for one installed
 * under another the path of names, such as a/b; a dependency is the
 * package found for it from there, as in node_modules.
 */
function bunLock(content: string, directory: string): DependencyGraph {
    // JSON with trailing commas
    const lock = JSON.parse(content.replace(/,(\s*[}\]])/g, "$1")) as {
        workspaces?: Record<string, Record<string, Record<string, string> | string | undefined>>;
        packages?: Record<string, unknown[]>;
    };

    const entries = lock.packages ?? {};
    const packages = new Map<string, LockedPackage>();
    const importers = new Map<string, Map<string, ImporterDependency>>();

    const find = (from: string[], name: string): string | undefined => {
        for (let depth = from.length; depth >= 0; depth--) {
            const key = [...from.slice(0, depth), name].join("/");

            if (entries[key]) {
                return key;
            }
        }

        return undefined;
    };

    for (const [path, fields] of Object.entries(lock.workspaces ?? {})) {
        const dependencies = new Map<string, ImporterDependency>();

        // A package of the workspace that needs another version than the
        // root's has it under its name, as @shop/ui/react
        const from = path !== "" && typeof fields.name === "string" ? [fields.name] : [];

        for (const field of FIELDS) {
            const declared = fields[field];

            for (const name of typeof declared === "object" ? Object.keys(declared) : []) {
                const id = find(from, name);

                if (id !== undefined && !dependencies.has(name)) {
                    dependencies.set(name, { id, field });
                }
            }
        }

        importers.set(path === "" ? "." : path, dependencies);
    }

    for (const [key, entry] of Object.entries(entries)) {
        const [resolution, , info] = entry as [unknown, unknown, Record<string, Record<string, string>> | undefined];

        if (typeof resolution !== "string") {
            continue;
        }

        const at = resolution.indexOf("@", 1);
        const name = resolution.slice(0, at);
        const version = resolution.slice(at + 1);
        const workspace = version.startsWith("workspace:") ? version.slice("workspace:".length) : undefined;
        const path = names(key);
        const dependencies = new Map<string, string>();

        for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
            for (const dependency of Object.keys(info?.[field] ?? {})) {
                const id = find(path, dependency);

                if (id !== undefined) {
                    dependencies.set(dependency, id);
                }
            }
        }

        packages.set(key, workspace === undefined
            ? { name, version, dependencies }
            : { name, workspace, dependencies: new Map() });
    }

    return new DependencyGraph(directory, packages, importers);
}

/** The names of a path of packages, such as @a/b/c as @a/b and c. */
function names(key: string): string[] {
    const parts = key.split("/");
    const result: string[] = [];

    for (let index = 0; index < parts.length; index++) {
        result.push(parts[index].startsWith("@") ? `${parts[index]}/${parts[++index]}` : parts[index]);
    }

    return result;
}
