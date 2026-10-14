import { createHash } from "node:crypto";
import semver from "semver";
import type { Npmrc } from "./npmrc.js";

/**
 * A version of a package as the registry lists it.
 */
export interface PackageVersion {
    name: string;
    version: string;
    tarball: string;
    integrity?: string;
    shasum?: string;
}

interface Packument {
    "dist-tags"?: Record<string, string>;
    versions?: Record<string, { dist?: { tarball?: unknown; integrity?: unknown; shasum?: unknown } }>;
}

const MAX_METADATA_SIZE = 64 * 1024 * 1024;

const MAX_TARBALL_SIZE = 64 * 1024 * 1024;

const MAX_REDIRECTS = 5;

/**
 * What a package name may hold, so it names a path in the registry and the
 * package cache and nothing else.
 */
const PACKAGE_NAME = /^(@[A-Za-z0-9~-][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~-][A-Za-z0-9._~-]*$/;

export function isPackageName(name: string): boolean {
    return PACKAGE_NAME.test(name) && name.length <= 214;
}

/**
 * The npm registries of an .npmrc, to download the tarballs of packages
 * from. Only files are downloaded: no npm and no script of a package runs.
 */
export class NpmRegistry {

    private readonly packuments = new Map<string, Promise<Packument | undefined>>();

    constructor(private readonly npmrc: Npmrc) {
    }

    /**
     * The version of the package a range or dist-tag asks for, as npm
     * picks it: the latest when it satisfies the range, else the newest
     * that does.
     */
    async resolve(name: string, range: string): Promise<PackageVersion | undefined> {
        if (!isPackageName(name)) {
            return undefined;
        }

        const packument = await this.packument(name);
        const versions = packument?.versions ?? {};
        const tags = packument?.["dist-tags"] ?? {};
        const latest = tags.latest;

        let version: string | undefined;

        if (tags[range] !== undefined) {
            version = tags[range];
        } else if (semver.validRange(range) !== null) {
            version = latest !== undefined && versions[latest] && semver.satisfies(latest, range)
                ? latest
                : semver.maxSatisfying(Object.keys(versions), range) ?? undefined;
        }

        const dist = version === undefined ? undefined : versions[version]?.dist;

        // The version names a directory of the package cache
        if (version === undefined || semver.valid(version) !== version || typeof dist?.tarball !== "string") {
            return undefined;
        }

        return {
            name,
            version,
            tarball: dist.tarball,
            integrity: typeof dist.integrity === "string" ? dist.integrity : undefined,
            shasum: typeof dist.shasum === "string" ? dist.shasum : undefined
        };
    }

    /**
     * The tarball of the version, checked against the integrity or shasum
     * the registry lists for it; undefined when it cannot be downloaded or
     * does not match.
     */
    async tarball(version: PackageVersion): Promise<Uint8Array | undefined> {
        const body = await this.get(version.tarball, "application/octet-stream", MAX_TARBALL_SIZE);

        return body && matches(body, version) ? body : undefined;
    }

    private packument(name: string): Promise<Packument | undefined> {
        let packument = this.packuments.get(name);

        if (!packument) {
            const url = this.npmrc.registryOf(name) + name.replace("/", "%2f");

            packument = this.get(url, "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8", MAX_METADATA_SIZE)
                .then(body => body && JSON.parse(Buffer.from(body).toString("utf8")) as Packument)
                .catch(() => undefined);

            this.packuments.set(name, packument);
        }

        return packument;
    }

    /**
     * Requests the URL, following redirects; each request carries the
     * credentials of its own URL alone.
     */
    private async get(url: string, accept: string, maxSize: number): Promise<Uint8Array | undefined> {
        let current = url;

        for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
            const parsed = new URL(current);

            if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
                return undefined;
            }

            let response: Response;

            try {
                response = await fetch(current, {
                    headers: { Accept: accept, ...this.npmrc.headersFor(current) },
                    redirect: "manual",
                    signal: AbortSignal.timeout(120_000)
                });
            } catch {
                return undefined;
            }

            const location = response.headers.get("location");

            if (response.status >= 300 && response.status < 400 && location) {
                await response.body?.cancel();
                current = new URL(location, current).toString();
                continue;
            }

            if (response.status !== 200) {
                await response.body?.cancel();
                return undefined;
            }

            return read(response, maxSize);
        }

        return undefined;
    }
}

async function read(response: Response, maxSize: number): Promise<Uint8Array | undefined> {
    if (!response.body) {
        return undefined;
    }

    const chunks: Uint8Array[] = [];
    let size = 0;

    for await (const chunk of response.body) {
        size += chunk.length;

        if (size > maxSize) {
            return undefined;
        }

        chunks.push(chunk);
    }

    return Buffer.concat(chunks);
}

/**
 * Whether the tarball matches the strongest checksum the registry lists:
 * its integrity, as sha512-<base64>, else its SHA-1 shasum.
 */
function matches(tarball: Uint8Array, version: PackageVersion): boolean {
    const integrities = (version.integrity ?? "").split(/\s+/)
        .map(entry => /^(sha512|sha384|sha256|sha1)-(.+)$/.exec(entry))
        .filter(match => match !== null);

    if (integrities.length > 0) {
        return integrities.some(([, algorithm, digest]) =>
            createHash(algorithm).update(tarball).digest("base64") === digest
        );
    }

    if (version.shasum) {
        return createHash("sha1").update(tarball).digest("hex") === version.shasum.toLowerCase();
    }

    return true;
}
