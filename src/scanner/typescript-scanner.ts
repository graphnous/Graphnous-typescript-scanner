import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript-api";
import type { File, GraphNousScanResult, Module } from "../generated/ScanResult.js";
import { detectBuildSystem, detectModules, detectNodeVersion } from "./project.js";
import { language, moduleOf, sourceFiles, sourceSet, withoutExtension } from "./source-files.js";
import { SourceParser } from "./source-parser.js";

export class TypeScriptScanner {

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

        const program = createProgram(targetPath, paths);
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
 * aliases, but leaves out the standard library and dependencies: only
 * references to the target's own declarations resolve.
 */
function createProgram(targetPath: string, paths: string[]): ts.Program {
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

    return ts.createProgram(
        paths.map(path => join(targetPath, path)),
        {
            ...options,
            allowJs: true,
            checkJs: false,
            noEmit: true,
            noLib: true,
            noResolve: true,
            types: [],
            skipLibCheck: true,
            composite: false,
            incremental: false
        }
    );
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
