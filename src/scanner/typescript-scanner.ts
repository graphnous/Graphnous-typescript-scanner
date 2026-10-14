import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript-api";
import type { File, GraphNousScanResult, Module } from "../generated/ScanResult.js";
import { detectBuildSystem, detectModules, detectNodeVersion } from "./project.js";
import { language, moduleOf, sourceFiles, sourceSet, withoutExtension } from "./source-files.js";
import { SourceParser } from "./source-parser.js";

/**
 * The packages the scanned code uses, as {@link providePackages} provides
 * them.
 */
export interface Packages {
    /** A node_modules directory to resolve imports in. */
    nodeModules?: string;
    /** The @types packages with global declarations, such as "node". */
    types: string[];
}

export class TypeScriptScanner {

    constructor(private readonly packages: Packages = { types: [] }) {
    }

    /**
     * Scans the target, a directory of the repository with a package.json:
     * its packages as modules, and the TypeScript and JavaScript files of
     * each.
     */
    scan(
        repository: string,
        target: string
    ): GraphNousScanResult {
        const targetPath = resolve(repository, target);

        const modules = detectModules(targetPath, warn);
        const paths = sourceFiles(targetPath);

        const program = createProgram(targetPath, paths, this.packages);
        const parser = new SourceParser(program);

        const modulesByPath = new Map(modules.map(module => [module.path, module]));
        const modulePaths = [...modulesByPath.keys()];

        for (const path of paths) {
            const file = this.file(targetPath, path, program, parser);

            if (file) {
                modulesByPath.get(moduleOf(path, modulePaths))!.files.push(file);
            }
        }

        // Once every file is parsed, so references resolve across files
        parser.resolve();

        for (const module of modules) {
            log(`Module ${module.path}: ${describe(module)}`);
        }

        return {
            format: "graphnous-scan-result",
            version: "2",
            target: {
                path: target,
                language: "TYPESCRIPT",
                languageVersion: detectNodeVersion(targetPath),
                ...detectBuildSystem(targetPath)
            },
            modules
        };
    }

    /**
     * The file with its declarations, or undefined with a warning when it
     * cannot be read.
     */
    private file(
        targetPath: string,
        path: string,
        program: ts.Program,
        parser: SourceParser
    ): File | undefined {
        const sourceFile = program.getSourceFile(join(targetPath, path));

        let content: Buffer;

        try {
            content = readFileSync(join(targetPath, path));
        } catch (error) {
            warn(`Skipping ${path}: could not read it (${error instanceof Error ? error.message : error})`);

            return undefined;
        }

        const file: File = {
            path,
            language: language(path),
            sourceSet: sourceSet(path),
            size: content.length,
            checksum: createHash("sha256").update(content).digest("hex"),
            lineCount: lineCount(content.toString("utf8"))
        };

        if (!sourceFile) {
            warn(`Skipping the declarations of ${path}: could not parse it`);

            return file;
        }

        try {
            parser.parse(sourceFile, withoutExtension(path), file);
        } catch (error) {
            // A file the parser cannot handle is listed without declarations
            warn(`Skipping the declarations of ${path}: could not analyse it (${error instanceof Error ? error.message : error})`);
        }

        return file;
    }
}

/**
 * A program of the files, to resolve what they refer to. It takes the
 * compiler options of the target's tsconfig.json, such as its path
 * aliases and built-in library, and resolves imports of packages in the
 * node_modules of the repository and of the provided packages.
 */
function createProgram(targetPath: string, paths: string[], packages: Packages): ts.Program {
    let options: ts.CompilerOptions = {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.Preserve,
        experimentalDecorators: true
    };

    const configPath = join(targetPath, "tsconfig.json");

    if (existsSync(configPath)) {
        const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic: () => {}
        });

        if (parsed) {
            options = { ...options, ...parsed.options };
        }
    }

    options = {
            ...options,
            allowJs: true,
            checkJs: false,
            noEmit: true,
            // The built-in library of the target's tsconfig, else the
            // newest with the DOM, so calls into it resolve
            lib: options.lib ?? (options.target === undefined ? ["lib.esnext.full.d.ts"] : undefined),
            // Packages the project declares with global declarations,
            // such as @types/node, unless the tsconfig names its own
            types: options.types ?? packages.types,
            skipLibCheck: true,
            composite: false,
            incremental: false
    };

    return ts.createProgram({
        rootNames: paths.map(path => join(targetPath, path)),
        options,
        host: compilerHost(options, packages)
    });
}

/**
 * A compiler host that resolves imports as the project does, and those it
 * cannot in the node_modules of the provided packages: those of the
 * scanned code, and those of the packages, which the package cache keeps
 * apart.
 */
function compilerHost(options: ts.CompilerOptions, packages: Packages): ts.CompilerHost {
    const host = ts.createCompilerHost(options);
    const nodeModules = packages.nodeModules;

    if (nodeModules === undefined) {
        return host;
    }

    // Resolves as from a file next to the node_modules
    const fallback = join(dirname(nodeModules), "index.ts");
    const moduleCache = ts.createModuleResolutionCache(host.getCurrentDirectory(), name => name, options);
    const typeCache = ts.createTypeReferenceDirectiveResolutionCache(host.getCurrentDirectory(), name => name, options);

    host.resolveModuleNameLiterals = (literals, containingFile, redirected, compilerOptions, sourceFile) =>
        literals.map(literal => {
            const mode = ts.getModeForUsageLocation(sourceFile, literal, compilerOptions);
            const resolved = ts.resolveModuleName(literal.text, containingFile, compilerOptions, host, moduleCache, redirected, mode);

            return resolved.resolvedModule || literal.text.startsWith(".")
                ? resolved
                : ts.resolveModuleName(literal.text, fallback, compilerOptions, host, moduleCache, redirected, mode);
        });

    host.resolveTypeReferenceDirectiveReferences = (references, containingFile, redirected, compilerOptions, sourceFile) =>
        references.map(reference => {
            const name = typeof reference === "string" ? reference : reference.fileName.toLowerCase();
            const mode = typeof reference === "string" || !sourceFile
                ? undefined
                : ts.getModeForFileReference(reference, sourceFile.impliedNodeFormat);
            const resolved = ts.resolveTypeReferenceDirective(name, containingFile, compilerOptions, host, redirected, typeCache, mode);

            return resolved.resolvedTypeReferenceDirective
                ? resolved
                : ts.resolveTypeReferenceDirective(name, fallback, compilerOptions, host, redirected, typeCache, mode);
        });

    return host;
}

/**
 * The number of lines: a file starts on line 1, and a line break at its
 * end does not start another.
 */
function lineCount(content: string): number {
    if (content.length === 0) {
        return 0;
    }

    const lines = content.split(/\r\n|\r|\n/).length;

    return /(\r\n|\r|\n)$/.test(content) ? lines - 1 : lines;
}

function describe(module: Module): string {
    const files = module.files.length;
    const tests = module.files.filter(file => file.sourceSet === "TEST").length;
    const classes = module.files.reduce((count, file) => count + (file.classes?.length ?? 0), 0);

    return `${files} ${files === 1 ? "file" : "files"}${tests > 0 ? ` (${tests} test)` : ""}, `
        + `${classes} ${classes === 1 ? "class" : "classes"}`;
}

function log(message: string): void {
    console.log(`[TypeScriptScanner] ${message}`);
}

function warn(message: string): void {
    console.warn(`[TypeScriptScanner] ${message}`);
}
