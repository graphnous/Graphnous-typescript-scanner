import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript-api";
import type { File, GraphNousScanResult, Module } from "../generated/ScanResult.js";
import { detectBuildSystem, detectModules, detectNodeVersion } from "./project.js";
import { language, moduleOf, sourceFiles, sourceSet, withoutExtension } from "./source-files.js";
import { DependencyGraph } from "../npm/dependency-graph.js";
import { addTransitiveDependencies } from "../npm/transitive-dependencies.js";
import { angularTemplates, type TemplateCheck } from "./angular-templates.js";
import { configOptions, ModuleResolver } from "./module-resolution.js";
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
        const graph = DependencyGraph.read(repository, targetPath);

        if (graph) {
            addTransitiveDependencies(modules, targetPath, graph);
        }
        const paths = sourceFiles(targetPath);

        // The packages of the workspace by name, to resolve imports of
        // them to their sources
        const workspace = new Map(modules
            .filter(module => module.name !== undefined && declaredName(join(targetPath, module.path)) === module.name)
            .map(module => [module.name!, join(targetPath, module.path)]));

        // Angular templates, as generated code the program checks
        const angular = angularTemplates(targetPath, paths);
        const generated = new Map(angular.checks.map(check => [check.generatedFile, check.generatedText]));

        const program = createProgram(targetPath, paths, this.packages, workspace, generated);
        const parser = new SourceParser(program);

        const modulesByPath = new Map(modules.map(module => [module.path, module]));
        const modulePaths = [...modulesByPath.keys()];

        for (const path of paths) {
            const file = this.file(targetPath, path, program, parser);

            if (file) {
                modulesByPath.get(moduleOf(path, modulePaths))!.files.push(file);
            }
        }

        for (const check of angular.checks) {
            const generatedFile = program.getSourceFile(check.generatedFile);

            if (generatedFile) {
                parser.template(check, generatedFile, positionsIn(targetPath, check.template, program));
            }
        }

        for (const path of angular.templateFiles) {
            const file = this.templateFile(targetPath, path);

            if (file) {
                modulesByPath.get(moduleOf(path, modulePaths))!.files.push(file);
            }
        }

        // Once every file is parsed, so references resolve across files
        parser.resolve();

        for (const module of modules) {
            module.files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
        }

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
     * A template of Angular components, listed as a file of its own; what
     * it uses is the components', see {@link SourceParser.template}.
     */
    private templateFile(targetPath: string, path: string): File | undefined {
        let content: Buffer;

        try {
            content = readFileSync(join(targetPath, path));
        } catch {
            return undefined;
        }

        return {
            path,
            language: "HTML",
            sourceSet: sourceSet(path),
            size: content.length,
            checksum: createHash("sha256").update(content).digest("hex"),
            lineCount: lineCount(content.toString("utf8"))
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
 * aliases and built-in library, and resolves imports as
 * {@link ModuleResolver} does.
 */
function createProgram(
    targetPath: string,
    paths: string[],
    packages: Packages,
    workspace: Map<string, string>,
    generated: Map<string, string>
): ts.Program {
    let options: ts.CompilerOptions = {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.Preserve,
        experimentalDecorators: true
    };

    const configPath = ["tsconfig.json", "jsconfig.json"].map(name => join(targetPath, name)).find(path => existsSync(path));

    if (configPath) {
        options = configOptions(configPath, options);
    }

    // What the program needs whatever the configuration says
    const forced: ts.CompilerOptions = {
        allowJs: true,
        checkJs: false,
        noEmit: true,
        skipLibCheck: true,
        composite: false,
        incremental: false
    };

    options = {
            ...options,
            ...forced,
            checkJs: false,
            noEmit: true,
            // The built-in library of the target's tsconfig, else the
            // newest with the DOM, so calls into it resolve
            lib: options.lib ?? (options.target === undefined ? ["lib.esnext.full.d.ts"] : undefined),
            // Packages the project declares with global declarations,
            // such as @types/node, unless the tsconfig names its own
            types: options.types ?? packages.types
    };

    return ts.createProgram({
        rootNames: [...paths.map(path => join(targetPath, path)), ...generated.keys()],
        options,
        host: compilerHost(targetPath, options, forced, packages, workspace, generated)
    });
}

/**
 * A compiler host that resolves imports with a {@link ModuleResolver}.
 */
function compilerHost(
    targetPath: string,
    options: ts.CompilerOptions,
    forced: ts.CompilerOptions,
    packages: Packages,
    workspace: Map<string, string>,
    generated: Map<string, string>
): ts.CompilerHost {
    const host = ts.createCompilerHost(options);

    // The generated files, which are not on disk
    const getSourceFile = host.getSourceFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    const readFile = host.readFile.bind(host);

    host.getSourceFile = (fileName, languageVersion, ...rest) => {
        const text = generated.get(fileName);

        return text === undefined
            ? getSourceFile(fileName, languageVersion, ...rest)
            : ts.createSourceFile(fileName, text, languageVersion, true);
    };
    host.fileExists = fileName => generated.has(fileName) || fileExists(fileName);
    host.readFile = fileName => generated.get(fileName) ?? readFile(fileName);

    const resolver = new ModuleResolver(targetPath, options, forced, workspace, packages.nodeModules, host);

    host.resolveModuleNameLiterals = (literals, containingFile, redirected, compilerOptions, sourceFile) =>
        literals.map(literal => resolver.resolveModule(
            literal.text,
            containingFile,
            redirected,
            ts.getModeForUsageLocation(sourceFile, literal, compilerOptions)
        ));

    host.resolveTypeReferenceDirectiveReferences = (references, containingFile, redirected, _compilerOptions, sourceFile) =>
        references.map(reference => resolver.resolveTypeReference(
            typeof reference === "string" ? reference : reference.fileName.toLowerCase(),
            containingFile,
            redirected,
            typeof reference === "string" || !sourceFile
                ? undefined
                : ts.getModeForFileReference(reference, sourceFile.impliedNodeFormat)
        ));

    return host;
}

/**
 * The name the package.json of a directory declares.
 */
function declaredName(directory: string): string | undefined {
    try {
        const name = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name;

        return typeof name === "string" ? name : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The line and column of an offset in a template: in its own file, or for
 * an inline template in the file of the component.
 */
function positionsIn(
    targetPath: string,
    template: TemplateCheck["template"],
    program: ts.Program
): (offset: number) => { line: number; column: number } {
    const text = template.external
        ? template.text
        : program.getSourceFile(join(targetPath, template.path))?.text ?? "";

    const lineStarts = [0];

    for (let index = 0; index < text.length; index++) {
        if (text[index] === "\n") {
            lineStarts.push(index + 1);
        }
    }

    return offset => {
        const position = offset + template.offset;
        let line = 0;

        while (line + 1 < lineStarts.length && lineStarts[line + 1] <= position) {
            line++;
        }

        return { line: line + 1, column: position - lineStarts[line] + 1 };
    };
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
