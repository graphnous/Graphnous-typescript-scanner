import ts from "typescript-api";

/**
 * Declarations outside the target, of TypeScript's built-in library and of
 * packages, by their names.
 */
export interface LibraryDeclarations {
    /** Functions, methods, call and construct signatures. */
    methods: Map<ts.Node, string>;
    /** Properties, enum members and variables that are not classes. */
    fields: Map<ts.Node, string>;
    /** Interfaces, classes, enums, type aliases and the globals that construct them. */
    classes: Map<ts.Node, string>;
}

/**
 * Names the declarations of the built-in library, the lib.*.d.ts files of
 * the JavaScript built-ins and the DOM, by their global names, which have
 * no file path, so they never collide with the names of the target:
 * "Array.isArray", "Promise.race", "Headers.get", "console.log" and
 * "TypeError.constructor". Namespaces add their name, e.g.
 * "Intl.NumberFormat.format".
 *
 * The members of the interface a global is declared with are named after the
 * global, so the static methods of ArrayConstructor are "Array.isArray", and
 * those of Console, the type of console, are "console.log". A call signature
 * is named after what declares it, e.g. "Number" for Number(value), and a
 * construct signature "constructor" after it.
 */
export function libraryDeclarations(sourceFiles: readonly ts.SourceFile[]): LibraryDeclarations {
    return walk(sourceFiles.map(sourceFile => [sourceFile, ""]), BUILT_IN_CALL);
}

/**
 * Names the declarations of the packages of the program, the files in a
 * node_modules directory, as they are imported: the module, a colon, then
 * the name it exports, e.g. "react:useState", "express:Router" or
 * "react-dom/client:createRoot", with the members of classes and
 * interfaces after them, e.g. "express:Request.get". What a module exports
 * with export = is "default". An @types package is named after the
 * package it is for, so @types/express is "express". What calling a value
 * of a callable type calls is "call" after the type, e.g. "ava:TestFn.call".
 *
 * A declaration no import reaches is named after its file in the package,
 * e.g. "express-serve-static-core/types:Helper", where an index file is
 * the package itself. Global declarations, such as those of @types/node,
 * have their global names, as those of the built-in library: "process.on".
 * Modules declared with declare module "fs" are named after it, e.g.
 * "fs:readFile"; node: is left out.
 */
export function packageDeclarations(
    program: ts.Program,
    isTarget: (sourceFile: ts.SourceFile) => boolean
): LibraryDeclarations {
    const files: [ts.SourceFile, string][] = [];

    for (const sourceFile of program.getSourceFiles()) {
        const location = isTarget(sourceFile) || program.isSourceFileDefaultLibrary(sourceFile)
            ? undefined
            : packageFileOf(sourceFile.fileName);

        if (location) {
            files.push([sourceFile, ts.isExternalModule(sourceFile) ? `${location}:` : ""]);
        }
    }

    const result = walk(files, PACKAGE_CALL);
    const exported = exportedNames(program, result);

    for (const declarations of [result.methods, result.fields, result.classes]) {
        for (const declaration of declarations.keys()) {
            const name = exported.get(declaration);

            if (name !== undefined) {
                declarations.set(declaration, name);
            }
        }
    }

    return result;
}

/**
 * The package of a file in a node_modules directory and its path in it, as
 * in "express-serve-static-core/types" or "express" for its index, or
 * undefined for a file outside node_modules.
 */
export function packageFileOf(fileName: string): string | undefined {
    const path = fileName.replace(/\\/g, "/");
    const index = path.lastIndexOf("/node_modules/");

    if (index < 0) {
        return undefined;
    }

    const parts = path.slice(index + "/node_modules/".length).split("/");
    const nameParts = parts[0].startsWith("@") ? 2 : 1;

    if (parts.length <= nameParts) {
        return undefined;
    }

    const file = parts.slice(nameParts).join("/").replace(/\.d\.[cm]?ts$|\.[cm]?[jt]sx?$/, "").replace(/(^|\/)index$/, "");

    return packageNameOf(parts.slice(0, nameParts).join("/")) + (file ? `/${file}` : "");
}

/**
 * The name of the package an @types package is for: express for
 * @types/express, and @babel/core for @types/babel__core.
 */
function packageNameOf(name: string): string {
    if (!name.startsWith("@types/")) {
        return name;
    }

    const types = name.slice("@types/".length);

    return types.includes("__") ? `@${types.replace("__", "/")}` : types;
}

/** A module as named in the names: without node:. */
function moduleName(specifier: string): string {
    return specifier.replace(/^node:/, "");
}

/**
 * How a call signature is named after what declares it: a built-in after
 * the global itself, as Number for Number(value), and a package's "call"
 * after its type, as the target's are, such as "ava:TestFn.call".
 */
type CallName = (prefix: string) => string;

const BUILT_IN_CALL: CallName = prefix => prefix;

const PACKAGE_CALL: CallName = prefix => `${prefix}.call`;

function walk(files: readonly [ts.SourceFile, string][], call: CallName): LibraryDeclarations {
    const result: LibraryDeclarations = { methods: new Map(), fields: new Map(), classes: new Map() };
    const globals = new Globals();

    for (const [sourceFile, prefix] of files) {
        globals.collect(sourceFile.statements, prefix);
    }

    for (const [sourceFile, prefix] of files) {
        statements(sourceFile.statements, prefix, globals, result, call);
    }

    return result;
}

/**
 * The global variables of the library, and the interfaces that are the
 * type of a single global with another name, such as ArrayConstructor of
 * Array, Console of console and NodeJS.Process of process.
 */
class Globals {

    private readonly variables = new Set<string>();

    private readonly interfaces = new Set<string>();

    private readonly variablesOfType = new Map<string, string[]>();

    collect(nodes: ts.NodeArray<ts.Statement>, prefix: string): void {
        for (const statement of nodes) {
            if (ts.isInterfaceDeclaration(statement)) {
                this.interfaces.add(prefix + statement.name.text);
            } else if (ts.isVariableStatement(statement)) {
                for (const declaration of statement.declarationList.declarations) {
                    if (!ts.isIdentifier(declaration.name)) {
                        continue;
                    }

                    const name = prefix + declaration.name.text;
                    const type = declaration.type;

                    this.variables.add(name);

                    if (type && ts.isTypeReferenceNode(type)) {
                        const key = prefix + entityName(type.typeName);
                        this.variablesOfType.set(key, [...this.variablesOfType.get(key) ?? [], name]);
                    }
                }
            } else if (ts.isModuleDeclaration(statement)) {
                for (const [body, bodyPrefix] of moduleBodies(statement, prefix)) {
                    this.collect(body.statements, bodyPrefix);
                }
            }
        }
    }

    /** The name the members of an interface are named after. */
    membersOf(interfaceName: string): string {
        const variables = this.variablesOfType.get(interfaceName) ?? [];

        return variables.length === 1 && !this.variables.has(interfaceName) ? variables[0] : interfaceName;
    }

    /**
     * Whether a variable is a class: one with an interface of the same
     * name, such as Array or Math, or whose type constructs.
     */
    isClass(name: string, type: ts.TypeNode | undefined): boolean {
        return this.interfaces.has(name)
            || (type !== undefined && ts.isTypeLiteralNode(type) && type.members.some(ts.isConstructSignatureDeclaration));
    }
}

function entityName(name: ts.EntityName): string {
    return ts.isIdentifier(name) ? name.text : `${entityName(name.left)}.${name.right.text}`;
}

/**
 * The statements of a module declaration and the prefix of their names:
 * a namespace adds its name, declare module "fs" is named "fs:", and
 * declare global is global.
 */
function moduleBodies(declaration: ts.ModuleDeclaration, prefix: string): [ts.ModuleBlock, string][] {
    let bodyPrefix: string;

    if (ts.isStringLiteral(declaration.name)) {
        bodyPrefix = `${moduleName(declaration.name.text)}:`;
    } else if (declaration.flags & ts.NodeFlags.GlobalAugmentation) {
        bodyPrefix = "";
    } else {
        bodyPrefix = `${prefix}${declaration.name.text}.`;
    }

    const body = declaration.body;

    if (body && ts.isModuleBlock(body)) {
        return [[body, bodyPrefix]];
    }

    // namespace A.B { }
    return body && ts.isModuleDeclaration(body) ? moduleBodies(body, bodyPrefix) : [];
}

function statements(
    nodes: ts.NodeArray<ts.Statement>,
    prefix: string,
    globals: Globals,
    result: LibraryDeclarations,
    call: CallName
): void {
    for (const statement of nodes) {
        if (ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement)) {
            const name = prefix + (statement.name?.text ?? "default");

            result.classes.set(statement, name);
            members(statement.members, ts.isInterfaceDeclaration(statement) ? globals.membersOf(name) : name, result, call);
        } else if (ts.isTypeAliasDeclaration(statement)) {
            const name = prefix + statement.name.text;

            result.classes.set(statement, name);

            // type TestFn = { (title: string): void; skip(...): void }, also
            // in an intersection, and type Hook = (request: Request) => void
            const type = ts.isParenthesizedTypeNode(statement.type) ? statement.type.type : statement.type;

            for (const literal of objectTypesOf(type)) {
                members(literal.members, globals.membersOf(name), result, call);
            }

            if (ts.isFunctionTypeNode(type)) {
                result.methods.set(type, call(name));
            }
        } else if (ts.isEnumDeclaration(statement)) {
            const name = prefix + statement.name.text;

            result.classes.set(statement, name);

            for (const member of statement.members) {
                const memberText = memberName(member.name);

                if (memberText !== undefined) {
                    result.fields.set(member, `${name}.${memberText}`);
                }
            }
        } else if (ts.isFunctionDeclaration(statement)) {
            result.methods.set(statement, prefix + (statement.name?.text ?? "default"));
        } else if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name)) {
                    continue;
                }

                const name = prefix + declaration.name.text;
                const type = declaration.type;

                (globals.isClass(name, type) ? result.classes : result.fields).set(declaration, name);

                if (type && ts.isTypeLiteralNode(type)) {
                    members(type.members, name, result, call);
                }
            }
        } else if (ts.isModuleDeclaration(statement)) {
            for (const [body, bodyPrefix] of moduleBodies(statement, prefix)) {
                statements(body.statements, bodyPrefix, globals, result, call);
            }
        }
    }
}

function members(
    nodes: ts.NodeArray<ts.TypeElement | ts.ClassElement>,
    prefix: string,
    result: LibraryDeclarations,
    call: CallName
): void {
    for (const member of nodes) {
        const name = member.name && memberName(member.name);

        if (ts.isCallSignatureDeclaration(member)) {
            result.methods.set(member, call(prefix));
        } else if (ts.isConstructSignatureDeclaration(member) || ts.isConstructorDeclaration(member)) {
            result.methods.set(member, `${prefix}.constructor`);
        } else if (name === undefined) {
            continue;
        } else if (ts.isMethodSignature(member) || ts.isMethodDeclaration(member)) {
            result.methods.set(member, `${prefix}.${name}`);
        } else if (ts.isPropertySignature(member)
            || ts.isPropertyDeclaration(member)
            || ts.isGetAccessorDeclaration(member)
            || ts.isSetAccessorDeclaration(member)) {
            result.fields.set(member, `${prefix}.${name}`);
        }
    }
}

/**
 * The name of a member; symbols such as [Symbol.iterator] by their
 * expression.
 */
function memberName(name: ts.PropertyName): string | undefined {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) {
        return name.text;
    }

    if (ts.isComputedPropertyName(name)
        && ts.isPropertyAccessExpression(name.expression)
        && ts.isIdentifier(name.expression.expression)) {
        return `[${name.expression.expression.text}.${name.expression.name.text}]`;
    }

    return undefined;
}

// Names by imports

/**
 * The names of the declarations of packages the imports of the program
 * reach: "module:export", and the members of classes, interfaces and
 * namespaces after them. Classes, interfaces and namespaces are named
 * first, so a member is named after its type rather than a variable of it.
 */
function exportedNames(program: ts.Program, known: LibraryDeclarations): Map<ts.Node, string> {
    const checker = program.getTypeChecker();
    const names = new Map<ts.Node, string>();
    const isKnown = (node: ts.Node) => known.methods.has(node) || known.fields.has(node) || known.classes.has(node);
    const name = (node: ts.Node, value: string) => {
        if (isKnown(node) && !names.has(node)) {
            names.set(node, value);
        }
    };

    const modules = new Map<string, ts.Symbol>();

    // The imports of the scanned code first, then those of packages
    const sourceFiles = [...program.getSourceFiles()]
        .filter(sourceFile => !program.isSourceFileDefaultLibrary(sourceFile))
        .sort((left, right) => Number(packageFileOf(left.fileName) !== undefined) - Number(packageFileOf(right.fileName) !== undefined));

    for (const sourceFile of sourceFiles) {
        for (const specifier of moduleSpecifiers(sourceFile)) {
            const module = moduleName(specifier.text);

            if (modules.has(module) || specifier.text.startsWith(".")) {
                continue;
            }

            const symbol = safely(() => checker.getSymbolAtLocation(specifier));

            if (symbol) {
                modules.set(module, symbol);
            }
        }
    }

    const variables: [ts.Symbol, string][] = [];
    const visited = new Set<ts.Symbol>();

    // Breadth first, so a declaration gets its shortest name, and once per
    // symbol, as namespaces such as Stream export themselves
    let queue: [ts.Symbol, string][] = [];
    let next: [ts.Symbol, string][] = [];

    const visit = (symbol: ts.Symbol, base: string) => {
        const target = symbol.flags & ts.SymbolFlags.Alias ? safely(() => checker.getAliasedSymbol(symbol)) : symbol;

        if (!target || visited.has(target)) {
            return;
        }

        visited.add(target);

        for (const declaration of target.declarations ?? []) {
            name(declaration, base);
        }

        if (target.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)) {
            target.members?.forEach((member, key) => memberDeclarations(member, String(key), base, name));
        }

        if (target.flags & ts.SymbolFlags.Class) {
            target.exports?.forEach((member, key) => {
                if (key !== "prototype") {
                    memberDeclarations(member, String(key), base, name);
                }
            });
        }

        if (target.flags & (ts.SymbolFlags.Module | ts.SymbolFlags.Enum)) {
            target.exports?.forEach((member, key) => {
                if (key !== "export=") {
                    next.push([member, `${base}.${String(key)}`]);
                }
            });
        }

        if (target.flags & ts.SymbolFlags.Variable) {
            variables.push([target, base]);
        }
    };

    for (const [module, symbol] of modules) {
        for (const exported of safely(() => checker.getExportsOfModule(symbol)) ?? []) {
            queue.push([exported, `${module}:${exported.name}`]);
        }

        const exportEquals = symbol.exports?.get(ts.InternalSymbolName.ExportEquals);

        if (exportEquals) {
            queue.push([exportEquals, `${module}:default`]);
        }
    }

    for (let depth = 0; depth <= 4 && queue.length > 0; depth++) {
        for (const [symbol, base] of queue) {
            visit(symbol, base);
        }

        queue = next;
        next = [];
    }

    // The members of the type of a variable, such as the static methods of
    // a constructor interface, after the variable
    for (const [variable, base] of variables) {
        const type = safely(() => checker.getTypeOfSymbol(variable));

        if (!type) {
            continue;
        }

        for (const property of type.getProperties()) {
            for (const declaration of property.declarations ?? []) {
                name(declaration, `${base}.${property.name}`);
            }
        }

        for (const signature of type.getCallSignatures()) {
            if (signature.declaration) {
                name(signature.declaration, PACKAGE_CALL(base));
            }
        }

        for (const signature of type.getConstructSignatures()) {
            if (signature.declaration) {
                name(signature.declaration, `${base}.constructor`);
            }
        }
    }

    return names;
}

function memberDeclarations(
    member: ts.Symbol,
    key: string,
    base: string,
    name: (node: ts.Node, value: string) => void
): void {
    const memberBase = key === ts.InternalSymbolName.Call ? PACKAGE_CALL(base)
        : key === ts.InternalSymbolName.Constructor || key === ts.InternalSymbolName.New ? `${base}.constructor`
        : key === ts.InternalSymbolName.Index ? undefined
        : `${base}.${member.name}`;

    if (memberBase !== undefined) {
        for (const declaration of member.declarations ?? []) {
            name(declaration, memberBase);
        }
    }
}

/**
 * The bare module specifiers of the imports and exports of a file.
 */
function moduleSpecifiers(sourceFile: ts.SourceFile): ts.StringLiteral[] {
    const specifiers: ts.StringLiteral[] = [];

    const visit = (statements: ts.NodeArray<ts.Statement>) => {
        for (const statement of statements) {
            if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
                && statement.moduleSpecifier
                && ts.isStringLiteral(statement.moduleSpecifier)) {
                specifiers.push(statement.moduleSpecifier);
            } else if (ts.isImportEqualsDeclaration(statement)
                && ts.isExternalModuleReference(statement.moduleReference)
                && ts.isStringLiteral(statement.moduleReference.expression)) {
                specifiers.push(statement.moduleReference.expression);
            } else if (ts.isModuleDeclaration(statement) && statement.body && ts.isModuleBlock(statement.body)) {
                visit(statement.body.statements);
            }
        }
    };

    visit(sourceFile.statements);

    return specifiers;
}

/**
 * The object types of a type alias, as in type A = { ... } and
 * type A = B & { ... }.
 */
function objectTypesOf(type: ts.TypeNode): ts.TypeLiteralNode[] {
    const unwrapped = ts.isParenthesizedTypeNode(type) ? type.type : type;

    if (ts.isTypeLiteralNode(unwrapped)) {
        return [unwrapped];
    }

    return ts.isIntersectionTypeNode(unwrapped) ? unwrapped.types.flatMap(objectTypesOf) : [];
}

function safely<T>(action: () => T): T | undefined {
    try {
        return action();
    } catch {
        return undefined;
    }
}
