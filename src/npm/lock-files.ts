import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import semver from "semver";

/**
 * The versions of packages the lock files of the project pin: those next to
 * the target, and up to the repository root for the lock file of a
 * workspace. package-lock.json, npm-shrinkwrap.json, pnpm-lock.yaml,
 * yarn.lock and bun.lock are read.
 */
export class LockedVersions {

    private constructor(private readonly versions: Map<string, Set<string>>) {
    }

    static none(): LockedVersions {
        return new LockedVersions(new Map());
    }

    static read(repositoryPath: string, targetPath: string): LockedVersions {
        const versions = new Map<string, Set<string>>();
        const add = (name: string, version: string) => {
            if (semver.valid(version)) {
                versions.set(name, (versions.get(name) ?? new Set()).add(version));
            }
        };

        for (const directory of upTo(targetPath, repositoryPath)) {
            for (const [file, parse] of PARSERS) {
                const path = join(directory, file);

                if (existsSync(path)) {
                    try {
                        parse(readFileSync(path, "utf8"), add);
                    } catch {
                        // A lock file that cannot be read pins nothing
                    }
                }
            }
        }

        return new LockedVersions(versions);
    }

    /**
     * The newest locked version of the package the range allows; for a
     * range that is not semver, such as a tag or an alias, the version
     * when only one is locked.
     */
    pick(name: string, range: string | undefined): string | undefined {
        const locked = [...this.versions.get(name) ?? []];

        if (locked.length === 0) {
            return undefined;
        }

        if (range !== undefined && semver.validRange(range) !== null) {
            return semver.maxSatisfying(locked, range) ?? undefined;
        }

        return locked.length === 1 ? locked[0] : semver.rsort(locked)[0];
    }
}

type Parser = (content: string, add: (name: string, version: string) => void) => void;

const PARSERS: [string, Parser][] = [
    ["package-lock.json", npmLock],
    ["npm-shrinkwrap.json", npmLock],
    ["pnpm-lock.yaml", pnpmLock],
    ["yarn.lock", yarnLock],
    ["bun.lock", bunLock]
];

/**
 * The directories from the target up to the repository root.
 */
function upTo(targetPath: string, repositoryPath: string): string[] {
    const root = resolve(repositoryPath);
    const directories: string[] = [];

    for (let directory = resolve(targetPath); ; directory = dirname(directory)) {
        directories.push(directory);

        if (directory === root || relative(root, directory).startsWith("..") || dirname(directory) === directory) {
            return directories;
        }
    }
}

function npmLock(content: string, add: (name: string, version: string) => void): void {
    const lock = JSON.parse(content) as {
        packages?: Record<string, { version?: unknown; name?: unknown; link?: unknown }>;
        dependencies?: Record<string, NpmV1Dependency>;
    };

    for (const [path, entry] of Object.entries(lock.packages ?? {})) {
        const index = path.lastIndexOf("node_modules/");

        if (index >= 0 && entry.link !== true && typeof entry.version === "string") {
            add(typeof entry.name === "string" ? entry.name : path.slice(index + "node_modules/".length), entry.version);
        }
    }

    const visit = (dependencies: Record<string, NpmV1Dependency> | undefined) => {
        for (const [name, dependency] of Object.entries(dependencies ?? {})) {
            if (typeof dependency.version === "string") {
                add(name, dependency.version);
            }

            visit(dependency.dependencies);
        }
    };

    visit(lock.dependencies);
}

interface NpmV1Dependency {
    version?: unknown;
    dependencies?: Record<string, NpmV1Dependency>;
}

/**
 * The keys of the packages of pnpm-lock.yaml: /name@1.0.0 (v6),
 * name@1.0.0 (v9) and /name/1.0.0 (v5), with peers after the version in
 * parentheses or an underscore.
 */
function pnpmLock(content: string, add: (name: string, version: string) => void): void {
    for (const line of content.split(/\r?\n/)) {
        const match = /^ {2}['"]?\/?((?:@[^/@\s'"]+\/)?[^/@\s'"()]+)@(\d[^('"\s:_]*)/.exec(line)
            ?? /^ {2}\/((?:@[^/\s]+\/)?[^/\s]+)\/(\d[^('"\s:_]*)/.exec(line);

        if (match) {
            add(match[1], match[2]);
        }
    }
}

/**
 * The entries of yarn.lock, "name@^1.0.0, name@~1.1.0:" in v1 and
 * "name@npm:^1.0.0": in Berry, each with its version on a line below.
 */
function yarnLock(content: string, add: (name: string, version: string) => void): void {
    let names: string[] = [];

    for (const line of content.split(/\r?\n/)) {
        if (/^\S.*:$/.test(line) && !line.startsWith("#") && !line.startsWith("__metadata")) {
            names = line.slice(0, -1).split(/,\s*/).map(descriptor => {
                const unquoted = descriptor.trim().replace(/^"|"$/g, "");
                const at = unquoted.indexOf("@", 1);

                return at > 0 ? unquoted.slice(0, at) : unquoted;
            });
            continue;
        }

        const version = /^ {2}version:? "?([^"\s]+)"?$/.exec(line);

        if (version) {
            for (const name of new Set(names)) {
                add(name, version[1]);
            }
        }
    }
}

/**
 * The packages of bun.lock, "name": ["name@1.0.0", ...].
 */
function bunLock(content: string, add: (name: string, version: string) => void): void {
    for (const match of content.matchAll(/"((?:@[^"/@]+\/)?[^"/@]+)": \["\1@(\d[^"]*)"/g)) {
        add(match[1], match[2]);
    }
}
