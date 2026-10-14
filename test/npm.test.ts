import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Method } from "../src/generated/ScanResult.js";
import { LockedVersions } from "../src/npm/lock-files.js";
import { Npmrc } from "../src/npm/npmrc.js";
import { providePackages, typesPackageOf } from "../src/npm/packages.js";
import { typeFiles } from "../src/npm/tarball.js";
import { detectModules } from "../src/scanner/project.js";
import { sourceFiles } from "../src/scanner/source-files.js";
import { TypeScriptScanner } from "../src/scanner/typescript-scanner.js";

const ENVIRONMENT: Record<string, string> = { NPM_TOKEN: "secret-token", NEXUS_PASSWORD: "cGFzc3dvcmQ=" };

// .npmrc

test("reads the registries and credentials of an npmrc", () => {
    const npmrc = Npmrc.parse(`
        # The company registry
        registry=https://npm.example.com/repository/npm/
        @acme:registry=https://npm.pkg.github.com
        //npm.pkg.github.com/:_authToken=\${NPM_TOKEN}
        //npm.example.com/repository/:username=scanner
        //npm.example.com/repository/:_password=\${NEXUS_PASSWORD}
        always-auth=true
    `, undefined, name => ENVIRONMENT[name]);

    assert.equal(npmrc.registryOf("react"), "https://npm.example.com/repository/npm/");
    assert.equal(npmrc.registryOf("@acme/ui"), "https://npm.pkg.github.com/");
    assert.equal(npmrc.registryOf("@other/ui"), "https://npm.example.com/repository/npm/");

    assert.deepEqual(npmrc.headersFor("https://npm.pkg.github.com/@acme%2fui"), { Authorization: "Bearer secret-token" });
    assert.deepEqual(npmrc.headersFor("https://npm.example.com/repository/npm/react"), {
        Authorization: `Basic ${Buffer.from("scanner:password").toString("base64")}`
    });

    // Not for other hosts, nor other paths of the host
    assert.deepEqual(npmrc.headersFor("https://storage.example.com/repository/npm/react.tgz"), {});
    assert.deepEqual(npmrc.headersFor("https://npm.example.com/other/react"), {});
});

test("takes a token without a registry for the default registry, and keeps variables that are not set", () => {
    const npmrc = Npmrc.parse("_authToken=${MISSING}\n", "https://registry.example.com", name => ENVIRONMENT[name]);

    assert.deepEqual(npmrc.headersFor("https://registry.example.com/react"), { Authorization: "Bearer ${MISSING}" });
    assert.deepEqual(npmrc.headersFor("https://registry.npmjs.org/react"), {});
});

// Tarballs

test("keeps the type definitions and package.json files of a tarball, and nothing outside it", () => {
    const files = typeFiles(tarball({
        "package/package.json": "{}",
        "package/index.js": "module.exports = 1",
        "package/index.d.ts": "export {}",
        "package/lib/client.d.mts": "export {}",
        "package/../escape.d.ts": "export {}",
        "/absolute.d.ts": "export {}"
    }));

    assert.deepEqual([...files.keys()].sort(), ["index.d.ts", "lib/client.d.mts", "package.json"]);
});

// Lock files

test("reads the versions the lock files pin", () => {
    const directory = mkdtempSync(join(tmpdir(), "graphnous-lock-"));

    try {
        write(directory, {
            "package-lock.json": JSON.stringify({
                lockfileVersion: 3,
                packages: {
                    "": { name: "app" },
                    "node_modules/react": { version: "18.3.1" },
                    "node_modules/@types/react": { version: "18.3.3" },
                    "node_modules/a/node_modules/react": { version: "17.0.2" },
                    "node_modules/local": { link: true }
                }
            }),
            "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\npackages:\n\n  express@5.1.0:\n    resolution: {}\n\n  '@scope/pkg@1.2.3(react@18.3.1)':\n    resolution: {}\n",
            "yarn.lock": "# yarn lockfile v1\n\n\"lodash@^4.17.0\", lodash@^4.17.21:\n  version \"4.17.21\"\n\n\"zod@npm:^3.22.0\":\n  version: 3.23.8\n",
            "bun.lock": "{\n  \"packages\": {\n    \"hono\": [\"hono@4.6.1\", \"\", {}, \"sha512-x\"],\n  }\n}\n"
        });

        const locked = LockedVersions.read(directory, directory);

        assert.equal(locked.pick("react", "^18.0.0"), "18.3.1");
        assert.equal(locked.pick("react", "^17.0.0"), "17.0.2");
        assert.equal(locked.pick("@types/react", "^18"), "18.3.3");
        assert.equal(locked.pick("express", "^5.0.0"), "5.1.0");
        assert.equal(locked.pick("@scope/pkg", "*"), "1.2.3");
        assert.equal(locked.pick("lodash", "^4.17.0"), "4.17.21");
        assert.equal(locked.pick("zod", "^3.22.0"), "3.23.8");
        assert.equal(locked.pick("hono", "^4"), "4.6.1");
        assert.equal(locked.pick("react", "^19.0.0"), undefined);
        assert.equal(locked.pick("local", undefined), undefined);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("names @types packages after the package", () => {
    assert.equal(typesPackageOf("react"), "@types/react");
    assert.equal(typesPackageOf("@babel/core"), "@types/babel__core");
});

// Downloading

interface Registry {
    url: string;
    storage: string;
    requests: string[];
    authorizations: Map<string, string | undefined>;
    close(): Promise<void>;
}

/**
 * A registry with:
 * - greeter 1.0.0, 1.5.0 and 2.0.0, with types that import helper;
 * - helper 1.0.0;
 * - untyped 1.2.0 without types, and @types/untyped 1.0.0;
 * - @acme/private 1.0.0, for a token, whose tarball redirects to storage;
 * - corrupt 1.0.0, whose tarball does not match its integrity.
 */
async function registry(): Promise<Registry> {
    const requests: string[] = [];
    const authorizations = new Map<string, string | undefined>();
    const tarballs = new Map<string, Buffer>();
    const packuments = new Map<string, object>();

    const storage = await listen((request, response) => {
        authorizations.set(`storage${request.url}`, request.headers.authorization);
        const body = tarballs.get(request.url ?? "");

        response.writeHead(body ? 200 : 404).end(body);
    });

    const server = await listen((request, response) => {
        const path = decodeURIComponent(request.url ?? "");
        requests.push(path);
        authorizations.set(path, request.headers.authorization);

        if (path.startsWith("/private/") && request.headers.authorization !== "Bearer secret-token") {
            response.writeHead(401).end();
            return;
        }

        if (path.startsWith("/private/tarballs/")) {
            response.writeHead(302, { Location: `${storage.url}${path}` }).end();
            return;
        }

        const tarball = tarballs.get(path);

        if (tarball) {
            response.writeHead(200).end(tarball);
            return;
        }

        const packument = packuments.get(path);

        response.writeHead(packument ? 200 : 404, { "Content-Type": "application/json" }).end(packument && JSON.stringify(packument));
    });

    const publish = (base: string, name: string, versions: Record<string, Record<string, string>>, options: { corrupt?: boolean } = {}) => {
        const entries: Record<string, object> = {};

        for (const [version, files] of Object.entries(versions)) {
            const path = `${base === "/private" ? "/private/tarballs" : ""}/${name}/-/${name.replace(/^@[^/]+\//, "")}-${version}.tgz`;
            const content = tarball(Object.fromEntries([
                ["package/package.json", JSON.stringify({ name, version, ...JSON.parse(files["package.json"] ?? "{}") })],
                ...Object.entries(files).filter(([file]) => file !== "package.json").map(([file, text]) => [`package/${file}`, text])
            ]));

            tarballs.set(path, content);
            entries[version] = {
                dist: {
                    tarball: `${server.url}${path}`,
                    integrity: `sha512-${createHash("sha512").update(options.corrupt ? "other" : content).digest("base64")}`
                }
            };
        }

        packuments.set(`${base}/${name}`, {
            "dist-tags": { latest: Object.keys(versions).at(-1) },
            versions: entries
        });
    };

    const greeter = (version: string) => ({
        "package.json": JSON.stringify({ types: "index.d.ts", dependencies: { helper: "^1.0.0" } }),
        "index.js": "module.exports = {}",
        "index.d.ts": `import { Helper } from "helper";\nexport declare function greet(name: string): string;\nexport declare class Greeter {\n    hello(): string;\n    helper: Helper;\n}\nexport declare const VERSION = "${version}";\n`
    });

    publish("", "greeter", { "1.0.0": greeter("1.0.0"), "1.5.0": greeter("1.5.0"), "2.0.0": greeter("2.0.0") });
    publish("", "helper", { "1.0.0": { "index.d.ts": "export interface Helper {\n    help(): void;\n}\n" } });
    publish("", "untyped", { "1.2.0": { "index.js": "exports.run = () => {}" } });
    publish("", "@types/untyped", { "1.0.0": { "index.d.ts": "export function run(): void;\n" } });
    publish("/private", "@acme/private", { "1.0.0": { "index.d.ts": "export declare function secret(): string;\n" } });
    publish("", "corrupt", { "1.0.0": { "index.d.ts": "export declare function broken(): void;\n" } }, { corrupt: true });

    return {
        url: server.url,
        storage: storage.url,
        requests,
        authorizations,
        close: async () => {
            await server.close();
            await storage.close();
        }
    };
}

async function listen(
    handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void
): Promise<{ url: string; close(): Promise<void> }> {
    const server: Server = createServer(handler);

    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));

    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => new Promise(resolve => server.close(() => resolve()))
    };
}

/**
 * A project that uses the packages of the registry, with a lock file that
 * pins greeter 1.0.0.
 */
function project(directory: string): string {
    const path = join(directory, "project");

    write(path, {
        "package.json": JSON.stringify({
            name: "app",
            type: "module",
            dependencies: {
                greeter: "^1.0.0",
                untyped: "^1.0.0",
                "@acme/private": "^1.0.0",
                corrupt: "1.0.0",
                local: "file:../local"
            }
        }),
        "package-lock.json": JSON.stringify({
            lockfileVersion: 3,
            packages: { "node_modules/greeter": { version: "1.0.0" } }
        }),
        "src/main.ts": [
            "import { greet, Greeter, VERSION } from \"greeter\";",
            "import { run } from \"untyped\";",
            "import { secret } from \"@acme/private\";",
            "import { broken } from \"corrupt\";",
            "import { alias } from \"@/alias\";",
            "import { local } from \"local\";",
            "",
            "export function main(): string {",
            "    run();",
            "    broken();",
            "    alias();",
            "    local();",
            "    new Greeter().helper.help();",
            "    return greet(VERSION) + secret();",
            "}",
            ""
        ].join("\n")
    });

    return path;
}

async function scan(path: string, cache: string, npmrc: Npmrc, download: boolean) {
    const logs: string[] = [];
    const packages = await providePackages(path, path, detectModules(path, () => {}), sourceFiles(path), {
        cache,
        download,
        npmrc,
        log: message => logs.push(message),
        verbose: false
    });

    try {
        const result = new TypeScriptScanner(packages).scan(path, ".");
        const main = result.modules[0].files.find(file => file.path === "src/main.ts")?.functions?.[0] as Method;

        return { calls: (main.calls ?? []).map(call => `${call.target} ${call.resolved}`), logs };
    } finally {
        packages.dispose();
    }
}

test("downloads the types of the packages the code imports, and resolves calls into them", async () => {
    const directory = mkdtempSync(join(tmpdir(), "graphnous-npm-"));
    const server = await registry();

    try {
        const path = project(directory);
        const cache = join(directory, "cache");
        const npmrc = Npmrc.parse(`registry=${server.url}\n@acme:registry=${server.url}/private\n//127.0.0.1:${new URL(server.url).port}/private/:_authToken=secret-token\n`);

        const { calls, logs } = await scan(path, cache, npmrc, true);

        assert.deepEqual(calls, [
            "untyped:run true",
            "broken false",
            "alias false",
            "local false",
            "helper:Helper.help true",
            "greeter:Greeter.constructor true",
            "greeter:greet true",
            "@acme/private:secret true"
        ]);

        // The version the lock file pins, with only its types
        assert.ok(existsSync(join(cache, "greeter@1.0.0/node_modules/greeter/index.d.ts")));
        assert.ok(!existsSync(join(cache, "greeter@1.0.0/node_modules/greeter/index.js")));
        assert.ok(!existsSync(join(cache, "greeter@1.5.0")));
        assert.ok(existsSync(join(cache, "@types+untyped@1.0.0/node_modules/@types/untyped/index.d.ts")));
        assert.ok(!existsSync(join(cache, "corrupt@1.0.0")));
        assert.ok(logs.some(message => message.includes("corrupt@1.0.0: could not download it")));

        // Names the code does not declare, nor ranges outside the registry,
        // are never asked for
        assert.ok(!server.requests.some(request => /alias|local/.test(request)), server.requests.join("\n"));

        // The token goes to the private registry alone, not where it
        // redirects the tarball to, nor to the public one
        assert.equal(server.authorizations.get("/private/@acme/private"), "Bearer secret-token");
        assert.equal(server.authorizations.get("storage/private/tarballs/@acme/private/-/private-1.0.0.tgz"), undefined);
        assert.equal(server.authorizations.get("/greeter"), undefined);

        // Another scan finds them in the cache
        server.requests.length = 0;

        const again = await scan(path, cache, npmrc, false);

        assert.deepEqual(again.calls, calls);
        assert.deepEqual(server.requests, []);
    } finally {
        await server.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

test("leaves calls into packages unresolved without their types", async () => {
    const directory = mkdtempSync(join(tmpdir(), "graphnous-npm-"));

    try {
        const { calls } = await scan(project(directory), join(directory, "cache"), Npmrc.none("http://127.0.0.1:1/"), false);

        assert.ok(calls.every(call => call.endsWith(" false")), calls.join("\n"));
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("uses the packages installed in the repository without downloading them", async () => {
    const directory = mkdtempSync(join(tmpdir(), "graphnous-npm-"));

    try {
        const path = project(directory);

        write(path, {
            "node_modules/greeter/package.json": JSON.stringify({ name: "greeter", version: "1.0.0", types: "index.d.ts" }),
            "node_modules/greeter/index.d.ts": "export declare function greet(name: string): string;\nexport declare const VERSION: string;\nexport declare class Greeter { helper: any }\n"
        });

        const { calls } = await scan(path, join(directory, "cache"), Npmrc.none("http://127.0.0.1:1/"), false);

        assert.ok(calls.includes("greeter:greet true"), calls.join("\n"));
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

// Helpers

function write(directory: string, files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        writeFileSync(join(directory, path), content);
    }
}

/**
 * A gzipped tar of the files, as npm packs them.
 */
function tarball(files: Record<string, string>): Buffer {
    const blocks: Buffer[] = [];

    for (const [name, text] of Object.entries(files)) {
        const content = Buffer.from(text);
        const header = Buffer.alloc(512);

        header.write(name, 0, 100);
        header.write("0000644\0", 100);
        header.write("0000000\0", 108);
        header.write("0000000\0", 116);
        header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
        header.write("00000000000\0", 136);
        header.write("        ", 148);
        header.write("0", 156);
        header.write("ustar\0", 257);
        header.write("00", 263);

        const checksum = header.reduce((sum, byte) => sum + byte, 0);
        header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);

        blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
    }

    blocks.push(Buffer.alloc(1024));

    return gzipSync(Buffer.concat(blocks));
}
