import { readFileSync } from "node:fs";

export const NPM_REGISTRY = "https://registry.npmjs.org/";

/**
 * The registries to download packages from, and their credentials, as an
 * .npmrc sets them:
 *
 * - registry=https://npm.example.com/ for all packages;
 * - @company:registry=https://npm.example.com/ for those of a scope;
 * - //npm.example.com/:_authToken=... for a token, and :_auth=... or
 *   :username=... with :_password=... (base64) for a user and password, for
 *   the registry whose URL starts with what precedes them.
 *
 * ${NAME} in values is read from the environment, so the file needs no
 * secrets. Credentials are only sent to URLs their key matches.
 */
export class Npmrc {

    private constructor(
        readonly registry: string,
        private readonly scopes: Map<string, string>,
        private readonly credentials: Map<string, Record<string, string>>
    ) {
    }

    static none(registry = NPM_REGISTRY): Npmrc {
        return new Npmrc(withSlash(registry), new Map(), new Map());
    }

    static read(
        path: string,
        registry = NPM_REGISTRY,
        environment: (name: string) => string | undefined = name => process.env[name]
    ): Npmrc {
        let content: string;

        try {
            content = readFileSync(path, "utf8");
        } catch (error) {
            throw new Error(`Could not read the npmrc ${path}: ${error instanceof Error ? error.message : error}`);
        }

        return Npmrc.parse(content, registry, environment);
    }

    static parse(
        content: string,
        registry = NPM_REGISTRY,
        environment: (name: string) => string | undefined = name => process.env[name]
    ): Npmrc {
        const values = new Map<string, string>();

        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();

            if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) {
                continue;
            }

            const separator = trimmed.indexOf("=");

            if (separator <= 0) {
                continue;
            }

            const key = interpolate(trimmed.slice(0, separator).trim(), environment);
            values.set(key, unquote(interpolate(trimmed.slice(separator + 1).trim(), environment)));
        }

        const defaultRegistry = withSlash(values.get("registry") ?? registry);
        const scopes = new Map<string, string>();
        const credentials = new Map<string, Record<string, string>>();

        for (const [key, value] of values) {
            const scope = /^(@[^:]+):registry$/.exec(key);

            if (scope) {
                scopes.set(scope[1], withSlash(value));
            }
        }

        // Keys of credentials: //host/path/:_authToken, or the legacy ones
        // without a prefix, for the default registry
        const prefixes = new Map<string, Map<string, string>>();

        for (const [key, value] of values) {
            const match = /^(\/\/[^:]+(?::\d+)?[^:]*):(_authToken|_auth|username|_password)$/.exec(key)
                ?? /^()(_authToken|_auth)$/.exec(key);

            if (!match) {
                continue;
            }

            const prefix = match[1] === "" ? nerfDart(defaultRegistry) : withSlash(match[1]);
            const fields = prefixes.get(prefix) ?? new Map<string, string>();

            fields.set(match[2], value);
            prefixes.set(prefix, fields);
        }

        for (const [prefix, fields] of prefixes) {
            const token = fields.get("_authToken");
            const auth = fields.get("_auth");
            const username = fields.get("username");
            const password = fields.get("_password");

            if (token) {
                credentials.set(prefix, { Authorization: `Bearer ${token}` });
            } else if (auth) {
                credentials.set(prefix, { Authorization: `Basic ${auth}` });
            } else if (username && password) {
                const decoded = Buffer.from(password, "base64").toString("utf8");

                credentials.set(prefix, {
                    Authorization: `Basic ${Buffer.from(`${username}:${decoded}`).toString("base64")}`
                });
            }
        }

        return new Npmrc(defaultRegistry, scopes, credentials);
    }

    /** The registry of a package, by its scope. */
    registryOf(name: string): string {
        const scope = name.startsWith("@") ? name.slice(0, name.indexOf("/")) : undefined;

        return (scope && this.scopes.get(scope)) ?? this.registry;
    }

    /**
     * The headers with the credentials for a URL: those of the longest key
     * the URL starts with, else none.
     */
    headersFor(url: string): Record<string, string> {
        const dart = nerfDart(url);
        let best: string | undefined;

        for (const prefix of this.credentials.keys()) {
            if (dart.startsWith(prefix) && (best === undefined || prefix.length > best.length)) {
                best = prefix;
            }
        }

        return best === undefined ? {} : this.credentials.get(best)!;
    }

    /** Whether any registry has credentials, to log that they are used. */
    hasCredentials(): boolean {
        return this.credentials.size > 0;
    }

    /** The registries in use, without credentials, for the log. */
    describe(): string {
        return [this.registry, ...[...this.scopes].map(([scope, url]) => `${scope}: ${url}`)].join(", ");
    }
}

/**
 * A URL as npm keys its credentials: without its scheme, as
 * //host[:port]/path/.
 */
function nerfDart(url: string): string {
    const parsed = new URL(url);

    return `//${parsed.host}${parsed.pathname}`;
}

function withSlash(url: string): string {
    return url.endsWith("/") ? url : `${url}/`;
}

function unquote(value: string): string {
    return value.length >= 2 && /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
}

/**
 * Replaces ${NAME} with the environment variable, and keeps those that are
 * not set; ${NAME?} becomes empty when it is not set.
 */
export function interpolate(value: string, environment: (name: string) => string | undefined): string {
    return value.replace(/\$\{([^}?]+)(\?)?\}/g, (whole, name: string, optional: string | undefined) =>
        environment(name) ?? (optional ? "" : whole)
    );
}
