import { join, relative, resolve } from "node:path";
import type { Dependency, Module } from "../generated/ScanResult.js";
import type { DependencyGraph, ImporterDependency } from "./dependency-graph.js";

const FIELDS: Record<string, ImporterDependency["field"]> = {
    prod: "dependencies",
    dev: "devDependencies",
    peer: "peerDependencies",
    optional: "optionalDependencies"
};

const SCOPES: Record<ImporterDependency["field"], string> = {
    dependencies: "prod",
    devDependencies: "dev",
    peerDependencies: "peer",
    optionalDependencies: "optional"
};

/** Ids of the modules of the workspace the lock file does not link. */
const WORKSPACE = "module:";

/** The scopes in the order they win, when a package comes through several. */
const SCOPE_ORDER = ["prod", "optional", "peer", "dev"];

/**
 * Adds to each module the packages its dependencies pull in, as the lock
 * file installs them: with their version, the scope of the dependency they
 * come through, prod first, and transitive set. A package of the workspace
 * a dependency pulls in refers to its module, and what it depends on, but
 * not its devDependencies, is pulled in too, as npm installs it.
 */
export function addTransitiveDependencies(modules: Module[], targetPath: string, graph: DependencyGraph): void {
    const modulesByPath = new Map(modules.map(module => [module.path, module]));
    const lockPathOf = (modulePath: string) => posix(relative(graph.directory, join(targetPath, modulePath))) || ".";
    const modulePathOf = (lockPath: string) => {
        const path = posix(relative(targetPath, resolve(graph.directory, lockPath))) || ".";

        return path.startsWith("..") ? undefined : path;
    };

    const importerOf = (module: Module | undefined, lockPath: string) => graph.importer(lockPath, new Map(
        (module?.dependencies ?? [])
            .filter(dependency => !dependency.transitive)
            .map(dependency => [dependency.name, { range: dependency.version, field: FIELDS[dependency.scope ?? "prod"] ?? "dependencies" }])
    ));

    for (const module of modules) {
        const declared = new Map((module.dependencies ?? []).map(dependency => [dependency.name, dependency]));
        const importer = importerOf(module, lockPathOf(module.path));
        const direct = new Set([...importer.values()].map(({ id }) => id));

        const visited = new Set<string>();
        const found = new Map<string, Dependency>();

        // Packages of the workspace the lock file does not link, as yarn v1
        // leaves them out, by their module
        const unlinked = unlinkedOf(module, importer);

        for (const scope of SCOPE_ORDER) {
            const queue = [
                ...[...importer]
                    .filter(([name, { field }]) => (declared.get(name)?.scope ?? SCOPES[field]) === scope)
                    .map(([, { id }]) => id),
                ...unlinked
                    .filter(dependency => (dependency.scope ?? "prod") === scope)
                    .map(dependency => `${WORKSPACE}${dependency.module}`)
            ];

            while (queue.length > 0) {
                const id = queue.shift()!;

                if (visited.has(id)) {
                    continue;
                }

                visited.add(id);

                const locked = id.startsWith(WORKSPACE) ? undefined : graph.package(id);
                const workspacePath = id.startsWith(WORKSPACE) ? id.slice(WORKSPACE.length)
                    : locked?.workspace !== undefined ? modulePathOf(locked.workspace)
                    : undefined;

                if (id.startsWith(WORKSPACE) || locked?.workspace !== undefined) {
                    const workspace = workspacePath === undefined ? undefined : modulesByPath.get(workspacePath);

                    if (workspacePath === module.path) {
                        continue;
                    }

                    const isDirect = direct.has(id) || (workspace !== undefined && declared.get(workspace.name ?? "")?.module === workspacePath);

                    if (!isDirect && workspacePath !== undefined) {
                        found.set(`${workspace?.name ?? locked?.name}@workspace`, {
                            name: workspace?.name ?? locked!.name,
                            scope,
                            transitive: true,
                            module: workspacePath
                        });
                    }

                    // What it depends on, but not for its development
                    const workspaceImporter = importerOf(workspace, locked?.workspace ?? lockPathOf(workspacePath!));

                    for (const [, { id: next, field }] of workspaceImporter) {
                        if (field !== "devDependencies") {
                            queue.push(next);
                        }
                    }

                    if (workspace) {
                        queue.push(...unlinkedOf(workspace, workspaceImporter)
                            .filter(dependency => dependency.scope !== "dev")
                            .map(dependency => `${WORKSPACE}${dependency.module}`));
                    }

                    continue;
                }

                if (!locked) {
                    continue;
                }

                if (!direct.has(id)) {
                    const key = `${locked.name}@${locked.version ?? ""}`;

                    if (!found.has(key)) {
                        found.set(key, {
                            name: locked.name,
                            ...locked.version === undefined ? {} : { version: locked.version },
                            scope,
                            transitive: true
                        });
                    }
                }

                queue.push(...locked.dependencies.values());
            }
        }

        if (found.size > 0) {
            module.dependencies = [
                ...module.dependencies ?? [],
                ...[...found.values()].sort((left, right) =>
                    left.name.localeCompare(right.name) || (left.version ?? "").localeCompare(right.version ?? ""))
            ];
        }
    }
}

/**
 * The dependencies of a module on other modules of the workspace that the
 * lock file does not link.
 */
function unlinkedOf(module: Module, importer: Map<string, ImporterDependency>): Dependency[] {
    return (module.dependencies ?? [])
        .filter(dependency => !dependency.transitive && dependency.module !== undefined && !importer.has(dependency.name));
}

function posix(path: string): string {
    return path.replace(/\\/g, "/");
}
