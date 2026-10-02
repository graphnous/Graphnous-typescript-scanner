import { TypeScriptScanner } from "./scanner/typescript-scanner.js";
import { writeFileSync } from "node:fs";

function main(): void {
    const options = parseArguments(process.argv.slice(2));

    console.log("GraphNous TypeScript Scanner starting");
    console.log("Repository:", options.path);
    console.log("Target:", options.target);
    console.log("Output:", options.output);

    const scanner = new TypeScriptScanner();

    const result = scanner.scan(
        options.path,
        options.target
    );

    // Temporary
    console.log(
        "Scan completed. Modules:",
        result.modules.length
    );

    writeFileSync(
        options.output,
        JSON.stringify(result, null, 2),
        "utf8"
    );
}

function parseArguments(args: string[]): {
    path: string;
    target: string;
    output: string;
} {
    let path: string | undefined;
    let target = ".";
    let output: string | undefined;

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
        output
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

main();