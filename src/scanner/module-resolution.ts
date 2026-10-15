import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript-api";

/**
 * The compiler options a tsconfig.json or jsconfig.json sets, merged into
 * those the program starts with. Unreadable configurations, and those that
 * extend one that is not there, such as a package that is not installed,
 * set what they can.
 */
export function configOptions(configPath: string, options: ts.CompilerOptions): ts.CompilerOptions {
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: () => {}
    });

    return parsed ? { ...options, ...parsed.options } : options;
}

/**
 * Resolves the imports of the program as the project does:
 *
 * 1. imports of the packages of the workspace, such as "@shop/ui", to
 *    their sources, as their package.json often points at a build that
 *    is not there;
 * 2. imports as the nearest tsconfig.json or jsconfig.json of the file
 *    resolves them, with its path aliases, such as "@/components/button",
 *    so each package of a workspace has its own;
 * 3. imports of packages it cannot resolve in the node_modules of the
 *    provided packages.
 */
export class ModuleResolver {

    private readonly configs = new Map<string, Config>();

    /** Resolves as from a file next to the node_modules of the packages. */
    private readonly fallback?: string;

    constructor(
        private readonly targetPath: string,
        private readonly options: ts.CompilerOptions,
        private readonly forced: ts.CompilerOptions,
        private readonly workspace: Map<string, string>,
        nodeModules: string | undefined,
        private readonly host: ts.ModuleResolutionHost
    ) {
        this.fallback = nodeModules === undefined ? undefined : join(dirname(nodeModules), "index.ts");
    }

    resolveModule(
        specifier: string,
        containingFile: string,
        redirected: ts.ResolvedProjectReference | undefined,
        mode: ts.ResolutionMode
    ): ts.ResolvedModuleWithFailedLookupLocations {
        const workspaceFile = this.resolveWorkspace(specifier);

        if (workspaceFile !== undefined) {
            return {
                resolvedModule: {
                    resolvedFileName: workspaceFile,
                    extension: extensionOf(workspaceFile),
                    isExternalLibraryImport: false
                }
            };
        }

        const config = this.configFor(containingFile);

        const resolved = ts.resolveModuleName(specifier, containingFile, config.options, this.host, config.modules, redirected, mode);

        if (resolved.resolvedModule || this.fallback === undefined || isRelative(specifier)) {
            return resolved;
        }

        return ts.resolveModuleName(specifier, this.fallback, config.options, this.host, config.modules, redirected, mode);
    }

    resolveTypeReference(
        name: string,
        containingFile: string,
        redirected: ts.ResolvedProjectReference | undefined,
        mode: ts.ResolutionMode
    ): ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations {
        const config = this.configFor(containingFile);
        const resolved = ts.resolveTypeReferenceDirective(name, containingFile, config.options, this.host, redirected, config.types, mode);

        if (resolved.resolvedTypeReferenceDirective || this.fallback === undefined) {
            return resolved;
        }

        return ts.resolveTypeReferenceDirective(name, this.fallback, config.options, this.host, redirected, config.types, mode);
    }

    /**
     * The options of the nearest configuration of a file in the target;
     * the program's for files outside it, such as those of packages.
     */
    private configFor(file: string): Config {
        let directory = dirname(resolve(file));

        if (!isInside(directory, this.targetPath)) {
            return this.config(undefined);
        }

        for (; ; directory = dirname(directory)) {
            for (const name of ["tsconfig.json", "jsconfig.json"]) {
                if (existsSync(join(directory, name))) {
                    return this.config(join(directory, name));
                }
            }

            if (directory === this.targetPath || dirname(directory) === directory) {
                return this.config(undefined);
            }
        }
    }

    private config(path: string | undefined): Config {
        const key = path ?? "";
        let config = this.configs.get(key);

        if (!config) {
            const options = path === undefined || path === join(this.targetPath, "tsconfig.json")
                ? this.options
                : { ...configOptions(path, this.options), ...this.forced };

            const directory = this.host.getCurrentDirectory?.() ?? this.targetPath;

            config = {
                options,
                modules: ts.createModuleResolutionCache(directory, name => name, options),
                types: ts.createTypeReferenceDirectiveResolutionCache(directory, name => name, options)
            };

            this.configs.set(key, config);
        }

        return config;
    }

    /**
     * The source file an import of a package of the workspace, or of a path
     * in it such as "@shop/ui/button", refers to: what its package.json
     * exports, types or main names, preferring the source a build path
     * such as dist/index.js is built from, then src/index and index.
     */
    private resolveWorkspace(specifier: string): string | undefined {
        if (isRelative(specifier) || this.workspace.size === 0) {
            return undefined;
        }

        const parts = specifier.split("/");
        const nameLength = specifier.startsWith("@") ? 2 : 1;
        const directory = this.workspace.get(parts.slice(0, nameLength).join("/"));

        if (directory === undefined) {
            return undefined;
        }

        const subpath = parts.slice(nameLength).join("/");
        const packageJson = readJson(join(directory, "package.json"));
        const candidates = [
            ...exportTargets(packageJson.exports, subpath === "" ? "." : `./${subpath}`),
            ...subpath === ""
                ? [packageJson.types, packageJson.typings, packageJson.module, packageJson.main, ...SOURCE_DIRECTORIES.map(source => `${source}/index`), "index"]
                : [...SOURCE_DIRECTORIES.map(source => `${source}/${subpath}`), subpath]
        ].filter((candidate): candidate is string => typeof candidate === "string");

        for (const candidate of candidates) {
            for (const path of sources(candidate)) {
                const file = existingFile(resolve(directory, path));

                if (file !== undefined && isInside(file, directory)) {
                    return file;
                }
            }
        }

        return undefined;
    }
}

interface Config {
    options: ts.CompilerOptions;
    modules: ts.ModuleResolutionCache;
    types: ts.TypeReferenceDirectiveResolutionCache;
}

/** Directories builds are written to, whose sources are in src or source. */
const BUILD_DIRECTORIES = /^(\.\/)?(dist|distribution|build|lib|out|esm|cjs|types)\//;

/** Directories packages keep their sources in. */
const SOURCE_DIRECTORIES = ["src", "source"];

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * The paths a target of a package.json may be built from: the source in
 * src of a path in a build directory first, then the path itself, without
 * the extension of the build; in source for packages that keep them there.
 */
function sources(target: string): string[] {
    const path = target.replace(/\.d\.[cm]?ts$|\.[cm]?[jt]sx?$/, "");

    return BUILD_DIRECTORIES.test(path)
        ? [...SOURCE_DIRECTORIES.map(source => path.replace(BUILD_DIRECTORIES, `${source}/`)), path]
        : [path];
}

/** The file of a path without its extension, or of its index. */
function existingFile(path: string): string | undefined {
    for (const candidate of [
        ...SOURCE_EXTENSIONS.map(extension => path + extension),
        ...SOURCE_EXTENSIONS.map(extension => join(path, `index${extension}`))
    ]) {
        if (isFile(candidate)) {
            return candidate;
        }
    }

    return undefined;
}

/**
 * The targets the exports of a package.json name for a path, in the order
 * of their conditions, such as types, import and default; "./*" patterns
 * are filled in with what they match.
 */
function exportTargets(exports: unknown, path: string): string[] {
    if (exports === undefined || exports === null) {
        return [];
    }

    const isSubpaths = typeof exports === "object" && !Array.isArray(exports)
        && Object.keys(exports).some(key => key.startsWith("."));

    if (!isSubpaths) {
        return path === "." ? strings(exports) : [];
    }

    const entries = Object.entries(exports as Record<string, unknown>);
    const exact = entries.find(([key]) => key === path);

    if (exact) {
        return strings(exact[1]);
    }

    for (const [key, value] of entries) {
        const star = key.indexOf("*");

        if (star >= 0 && path.startsWith(key.slice(0, star)) && path.endsWith(key.slice(star + 1))) {
            const match = path.slice(star, path.length - (key.length - star - 1));

            return strings(value).map(target => target.replace("*", match));
        }
    }

    return [];
}

function strings(value: unknown): string[] {
    if (typeof value === "string") {
        return [value];
    }

    if (Array.isArray(value)) {
        return value.flatMap(strings);
    }

    if (typeof value === "object" && value !== null) {
        return Object.values(value).flatMap(strings);
    }

    return [];
}

function extensionOf(file: string): ts.Extension {
    for (const extension of [ts.Extension.Dts, ts.Extension.Dmts, ts.Extension.Dcts]) {
        if (file.endsWith(extension)) {
            return extension;
        }
    }

    const match = /\.[cm]?[jt]sx?$/.exec(file);

    return (match?.[0] ?? ts.Extension.Ts) as ts.Extension;
}

function isRelative(specifier: string): boolean {
    return specifier.startsWith("./") || specifier.startsWith("../") || specifier === "." || specifier === ".." || specifier.startsWith("/");
}

function isInside(path: string, directory: string): boolean {
    const relation = relative(directory, path);

    return relation === "" || (!relation.startsWith("..") && !relation.startsWith(sep) && !/^[A-Za-z]:/.test(relation));
}

function isFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

function readJson(path: string): Record<string, unknown> {
    try {
        const value = JSON.parse(readFileSync(path, "utf8"));

        return typeof value === "object" && value !== null ? value : {};
    } catch {
        return {};
    }
}
