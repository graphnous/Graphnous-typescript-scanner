import type { GraphNousScanResult } from "../generated/ScanResult.js";

export class TypeScriptScanner {

    scan(
        repository: string,
        target: string
    ): GraphNousScanResult {
        console.log(
            "[TypeScriptScanner] Repository:",
            repository
        );

        console.log(
            "[TypeScriptScanner] Target:",
            target
        );

        return {
            format: "graphnous-scan-result",
            version: "2",
            target: {
                path: target,
                language: "TYPESCRIPT",
                buildSystem: "NPM",
                languageVersion: '1',
                buildSystemVersion: '1'
            },
            modules: []
        };
    }
}