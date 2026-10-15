import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { NPM_REGISTRY, Npmrc } from "./npm/npmrc.js";
import { providePackages } from "./npm/packages.js";
import { detectModules } from "./scanner/project.js";
import { sourceFiles } from "./scanner/source-files.js";
import { TypeScriptScanner } from "./scanner/typescript-scanner.js";

/** Where the image keeps the package cache, on a volume of its own. */
const IMAGE_NPM_CACHE = "/npm-cache";

/** Where the image takes an .npmrc from. */
const IMAGE_NPMRC = "/npm-settings/.npmrc";

interface Options {
    path: string;
    target: string;
    output: string;
    npmCache: string;
    downloadDependencies: boolean;
    npmRegistry: string;
    npmrc?: string;
    verbose: boolean;
}

async function main(): Promise<void> {
    const options = parseArguments(process.argv.slice(2));

    console.log("Graphnous TypeScript Scanner starting");
    console.log("Repository:", options.path);
    console.log("Target:", options.target);
    console.log("Output:", options.output);

    const targetPath = resolve(options.path, options.target);
    const npmrc = options.npmrc ? Npmrc.read(options.npmrc, options.npmRegistry) : Npmrc.none(options.npmRegistry);

    if (options.downloadDependencies) {
        console.log(`Downloading packages from ${npmrc.describe()}${npmrc.hasCredentials() ? ", with credentials" : ""}`);
    }

    const packages = await providePackages(
        options.path,
        targetPath,
        detectModules(targetPath, () => {}),
        sourceFiles(targetPath),
        {
            cache: options.npmCache,
            download: options.downloadDependencies,
            npmrc,
            log: message => console.log(`[Packages] ${message}`),
            verbose: options.verbose
        }
    );

    try {
        const result = new TypeScriptScanner(packages).scan(options.path, options.target);

        console.log("Scan completed. Modules:", result.modules.length);

        writeFileSync(options.output, JSON.stringify(result, null, 2), "utf8");
    } finally {
        packages.dispose();
    }
}

function parseArguments(args: string[]): Options {
    let path: string | undefined;
    let target = ".";
    let output: string | undefined;
    let npmCache: string | undefined;
    let downloadDependencies = false;
    let npmRegistry = NPM_REGISTRY;
    let npmrc: string | undefined;
    let verbose = false;

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case "--path":
                path = requireValue(args, ++i, "--path");
                break;

            case "--target":
                target = requireValue(args, ++i, "--target");
                break;

            case "--output":
                output = requireValue(args, ++i, "--output");
                break;

            case "--npm-cache":
                npmCache = requireValue(args, ++i, "--npm-cache");
                break;

            case "--download-dependencies":
                downloadDependencies = true;
                break;

            case "--npm-registry":
                npmRegistry = requireValue(args, ++i, "--npm-registry");
                break;

            case "--npmrc":
                npmrc = requireValue(args, ++i, "--npmrc");
                break;

            case "--verbose":
                verbose = true;
                break;

            default:
                throw new Error(`Unknown argument: ${args[i]}`);
        }
    }

    if (!path) {
        throw new Error("Missing required argument: --path");
    }

    if (!output) {
        throw new Error("Missing required argument: --output");
    }

    return {
        path,
        target,
        output,
        npmCache: npmCache
            ?? (existsSync(IMAGE_NPM_CACHE) ? IMAGE_NPM_CACHE : join(homedir(), ".cache", "graphnous", "npm")),
        downloadDependencies,
        npmRegistry,
        npmrc: npmrc ?? (existsSync(IMAGE_NPMRC) ? IMAGE_NPMRC : undefined),
        verbose
    };
}

function requireValue(
    args: string[],
    index: number,
    argument: string
): string {
    if (index >= args.length) {
        throw new Error(`Missing value for ${argument}`);
    }

    return args[index];
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
