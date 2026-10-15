import { gunzipSync } from "node:zlib";

/**
 * The files of a package tarball that tell its types: its type definitions
 * and package.json files, by their path in the package. Nothing else is
 * kept, so no code of the package is ever written, let alone run.
 */
export function typeFiles(tarball: Uint8Array, maxSize = 256 * 1024 * 1024): Map<string, Buffer> {
    const archive = gunzipSync(tarball, { maxOutputLength: maxSize });
    const files = new Map<string, Buffer>();

    let offset = 0;
    let longName: string | undefined;
    let paxPath: string | undefined;

    while (offset + 512 <= archive.length) {
        const header = archive.subarray(offset, offset + 512);

        if (header.every(byte => byte === 0)) {
            break;
        }

        const size = parseInt(field(header, 124, 12).trim() || "0", 8);
        const type = String.fromCharCode(header[156] || 48);
        const body = archive.subarray(offset + 512, offset + 512 + size);

        offset += 512 + Math.ceil(size / 512) * 512;

        if (type === "L") {
            longName = body.toString("utf8").replace(/\0.*$/s, "");
            continue;
        }

        if (type === "x") {
            paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1];
            continue;
        }

        const prefix = field(header, 345, 155);
        const name = paxPath ?? longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));

        longName = undefined;
        paxPath = undefined;

        if (type !== "0" && type !== "\0") {
            continue;
        }

        const path = packagePath(name);

        if (path !== undefined && isTypeFile(path)) {
            files.set(path, Buffer.from(body));
        }
    }

    return files;
}

/**
 * The path of a file in the package: without the directory the tarball
 * puts it in, usually "package/". Undefined for paths that would leave it.
 */
function packagePath(name: string): string | undefined {
    const parts = name.replace(/\\/g, "/").split("/").filter(part => part !== "" && part !== ".");

    if (parts.length < 2 || name.startsWith("/") || parts.some(part => part === "..")) {
        return undefined;
    }

    return parts.slice(1).join("/");
}

function isTypeFile(path: string): boolean {
    return /\.d\.[cm]?ts$/.test(path) || /(^|\/)package\.json$/.test(path);
}

function field(header: Buffer, start: number, length: number): string {
    const value = header.subarray(start, start + length);
    const end = value.indexOf(0);

    return value.subarray(0, end < 0 ? length : end).toString("utf8");
}
