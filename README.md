# GraphNous TypeScript Scanner

Scans the TypeScript and JavaScript sources of a project, the templates of
its Angular components and its Vue single-file components, and writes a
[GraphNous scan result](https://graphnous.github.io/graphnous-schemas/schema/scan/scan-result.schema.json):
its packages as modules, its files, classes, functions and variables, and
for each function and method, and the top-level code of each file, the
functions it calls, the fields it reads and writes and the types it uses.

The Graphnous server runs it on the repositories it analyses; it can also
be run on its own, with Node or as an image.

## Running

```sh
docker run --rm \
  -v "$PWD:/repository:ro" -v "$PWD/out:/output" \
  ghcr.io/graphnous/graphnous-typescript-scanner:0.1.1 \
  --path /repository --target . --output /output/scan-result.json
```

or, after [building](#building) it:

```sh
node build/scanner.js --path . --target . --output scan-result.json
```

| Argument | |
|---|---|
| `--path <dir>` | The repository to scan. Required. |
| `--target <path>` | The project in the repository, relative to it. Default `.`. |
| `--output <file>` | Where to write the scan result. Required. |
| `--npm-cache <dir>` | Where to keep the packages the project uses. Default `/npm-cache` when it exists, else `~/.cache/graphnous/npm`. |
| `--download-dependencies` | Download the packages missing from the package cache. |
| `--npm-registry <url>` | Where to download from without an `.npmrc`. Default `https://registry.npmjs.org/`. |
| `--npmrc <file>` | An `.npmrc` with the registries to download from. Default `/npm-settings/.npmrc` when it exists. |
| `--verbose` | Log details, such as each package found. |

## What it finds

- A module for each `package.json` of the target, such as the packages of a
  workspace, with their dependencies, and the files of each, as production
  or test code.
  The dependencies their dependencies pull in are listed too, with
  `transitive` set, in the versions the lock file installs
  (`package-lock.json` of npm 7 and later, `pnpm-lock.yaml`, `yarn.lock` of
  Yarn 1 and Berry, or `bun.lock`), with the scope of the dependency they
  come through.
- Classes, interfaces, enums and type aliases, with their members, those of
  type aliases of object types such as `type Client = { get(): ... }`
  included, and the
  functions and variables of each file, with line and column positions.
  Names are the file path without its extension, a colon, then the dotted
  name, e.g. `src/orders:Orders.find`.
- For each function and method, and for the code at the top level of each
  file: its calls, with their arguments, its field accesses and its type
  uses, resolved to the name of what they refer to. What cannot be resolved
  is kept as written, with `resolved` set to `false`.
- The values of constants: of `const` variables and `readonly` properties
  with an initializer, and of the arguments of calls, JSX attributes and
  decorators that are constant expressions, as JavaScript computes them,
  e.g. `orders.created` for `Topics.CREATED`, `` `${PREFIX}created` `` or a
  string enum member such as `Topic.Created`. Properties of objects
  declared `as const` are known by their types. Constants whose name
  contains `password`, `passwd`, `secret`, `token`, `credential`, `apikey`,
  `accesskey`, `privatekey` or `authorization`, and values with a url with a
  password, a `password=` setting or a private key, are left out.

Imports resolve as the project resolves them: with the path aliases of the
`tsconfig.json` or `jsconfig.json` nearest to each file, such as
`"@/*": ["src/*"]`, including those of a configuration it extends, so each
package of a workspace has its own. Imports of the packages of a workspace,
such as `@shop/ui`, resolve to their sources, also when their
`package.json` points at a build that is not there, such as
`dist/index.js` for `src/index.ts`.

What initializers use belongs to what runs them: property initializers to
the constructor, also the one a class without a declared constructor gets,
e.g. `src/cache:Cache.constructor` for `entries = new Map()`, and static
property initializers and `static { }` blocks to a method `static` of the
class, e.g. `src/registry:Registry.static`.

### Angular templates

The template of an Angular component, inline in its `@Component` or in the
file its `templateUrl` names, is checked as Angular checks it: what its
bindings, events and interpolations use belongs to a method `template` of
the component, e.g. `src/app/orders.component:OrdersComponent.template`.

- `(click)="save(order)"` calls `OrdersComponent.save`, `{{ total }}` reads
  `OrdersComponent.total`, and `[(ngModel)]="query"` reads and writes
  `OrdersComponent.query`.
- The items of `@for` and `*ngFor`, and `@if … as` and `@let`, are typed,
  so `{{ order.customer.name }}` resolves too.
- A pipe of the project, `{{ total | money:'EUR' }}`, is a call of its
  `transform`; other pipes, such as `date`, are kept by their name.
- An element that is a component or directive of the project, by its
  `selector`, is a call of its constructor, with its inputs as named
  arguments.

What a template in a file of its own uses is at its places in that file,
which is listed as a file with language `HTML`.

### Vue components

A Vue single-file component (`.vue`) is listed as a file with language
`VUE`, with the declarations of its scripts, and the component itself as
its function `default`, e.g. `src/components/OrderList:default`, which
holds what its template uses, at its places in the `.vue` file:

- `@click="select(order)"` calls `select`, and `@click="refresh"` refers to
  `refresh`; `{{ formatTotal(order) }}` calls the imported function;
- the items of `v-for` are typed, and the props of `defineProps<T>()` are
  of type `T`; `v-model="query"` reads and writes `query`;
- an element that is a component the script imports, as `<OrderCard>` or
  `<order-card>`, is a call of its `default`, with its props as named
  arguments.

Imports of `.vue` files, also through the path aliases of the
`tsconfig.json`, resolve to their scripts. Components of `<script setup>`
are resolved; the templates of the Options API (`data`, `methods`) are not
yet.

A call through a value of a callable type, such as `client(url)` with
`client: Client` where `type Client = { (url: string): Response }`, or
`hook(request)` with `type Hook = (request: Request) => void`, resolves to
the call of the type, listed as its method `call`: `src/client:Client.call`.

Calls into the JavaScript built-ins and the DOM resolve to their global
names, e.g. `Array.isArray`, `Promise.race` or `console.log`. Calls into
packages resolve when the scanner has their types, see below, to the module
they are imported from and their name, e.g. `react:useState`,
`express:Router` or `express-serve-static-core:Response.json`; an `@types`
package is named after the package it is for.

## Packages

The scanner looks for the type definitions of the packages the code imports
in:

1. The `node_modules` directories of the repository, from the target up,
   when the project was installed.
2. The package cache: those of an earlier scan.
3. With `--download-dependencies`, the registry.

Only packages the project declares in its `package.json` files are looked
for, in the versions its lock file pins (`package-lock.json`,
`pnpm-lock.yaml`, `yarn.lock` or `bun.lock`), else the newest its range
allows; then the packages their types import, and `@types/<name>` for a
package without types of its own. Declared `@types` packages, such as
`@types/node`, are included as `tsc` includes them.

### Downloading them

With `--download-dependencies`, the tarballs of the missing packages are
downloaded from the registry and checked against the integrity it lists for
them. Only their type definitions and `package.json` files are kept: no npm
runs, and no code of a package is written, let alone run. Keep the cache on
a volume so the next scan finds them:

```sh
docker run --rm \
  -v "$PWD:/repository:ro" -v "$PWD/out:/output" \
  -v graphnous-npm:/npm-cache \
  ghcr.io/graphnous/graphnous-typescript-scanner:0.1.1 \
  --path /repository --output /output/scan-result.json --download-dependencies
```

The scan container needs to reach the registry, e.g. `registry.npmjs.org`;
the image downloads through the proxy of `HTTPS_PROXY` when it is set.

### Private registries

To download from a private registry, such as GitHub Packages, a company
Nexus or Artifactory, mount an `.npmrc` at `/npm-settings/.npmrc`, or pass
it with `--npmrc`. The scanner uses:

- `registry=` for all packages, and `@scope:registry=` for those of a scope;
- the credentials of the registries: `//host/path/:_authToken=` for a token,
  and `:_auth=`, or `:username=` with a base64 `:_password=`, for a user and
  password.

`${NAME}` in the file is read from the environment, so it needs no secrets:

```ini
registry=https://nexus.example.com/repository/npm-public/
@company:registry=https://npm.pkg.github.com/
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
//nexus.example.com/repository/:_authToken=${NEXUS_TOKEN}
```

```sh
  -v "$PWD/.npmrc:/npm-settings/.npmrc:ro" \
  -e GITHUB_TOKEN=... -e NEXUS_TOKEN=... \
  ... --download-dependencies
```

Credentials are only sent to the URLs their key matches, not where a
registry redirects to. The `.npmrc` files of the scanned repository are
never read, so a project cannot point its packages at a registry of its own.

## Building

Requires Node 24.

```sh
npm ci
npm test
npm run build
```

The scan result types in `src/generated` are generated from the published
schema with `npm run generate`.

The scanner is `build/scanner.js`, with TypeScript's built-in library next
to it. Pushing a `v*` tag, e.g. `v0.1.1`, publishes the image as
`ghcr.io/graphnous/graphnous-typescript-scanner:0.1.1`.
