import ts from "typescript-api";

/**
 * The declarations of TypeScript's built-in library, the lib.*.d.ts files
 * of the JavaScript built-ins and the DOM, by their names.
 */
export interface LibraryDeclarations {
    /** Functions, methods, call and construct signatures. */
    methods: Map<ts.Node, string>;
    /** Properties and global variables that are not classes. */
    fields: Map<ts.Node, string>;
    /** Interfaces, classes, type aliases and the globals that construct them. */
    classes: Map<ts.Node, string>;
}

/**
 * Names the declarations of the library files by their global names, which
 * have no file path, so they never collide with the names of the target:
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
    const result: LibraryDeclarations = { methods: new Map(), fields: new Map(), classes: new Map() };
    const globals = new Globals();

    for (const sourceFile of sourceFiles) {
        globals.collect(sourceFile.statements, "");
    }

    for (const sourceFile of sourceFiles) {
        statements(sourceFile.statements, "", globals, result);
    }

    return result;
}

/**
 * The global variables of the library, and the interfaces that are the
 * type of a single global with another name, such as ArrayConstructor of
 * Array and Console of console.
 */
class Globals {

    private readonly variables = new Set<string>();

    private readonly interfaces = new Set<string>();

    private readonly variablesOfType = new Map<string, string[]>();

    collect(statements: ts.NodeArray<ts.Statement>, prefix: string): void {
        for (const statement of statements) {
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

                    if (type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
                        const key = prefix + type.typeName.text;
                        this.variablesOfType.set(key, [...this.variablesOfType.get(key) ?? [], name]);
                    }
                }
            } else if (isNamespace(statement)) {
                this.collect(statement.body.statements, `${prefix}${statement.name.text}.`);
            }
        }
    }

    /** The name the members of an interface are named after. */
    membersOf(interfaceName: string): string {
        const variables = this.variablesOfType.get(interfaceName) ?? [];

        return variables.length === 1 && !this.variables.has(interfaceName) ? variables[0] : interfaceName;
    }

    /**
     * Whether a global variable is a class: one with an interface of the
     * same name, such as Array or Math, or whose interface constructs.
     */
    isClass(name: string, type: ts.TypeNode | undefined): boolean {
        return this.interfaces.has(name)
            || (type !== undefined && ts.isTypeLiteralNode(type) && type.members.some(ts.isConstructSignatureDeclaration));
    }
}

function statements(
    nodes: ts.NodeArray<ts.Statement>,
    prefix: string,
    globals: Globals,
    result: LibraryDeclarations
): void {
    for (const statement of nodes) {
        if (ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement)) {
            if (!statement.name) {
                continue;
            }

            const name = prefix + statement.name.text;

            result.classes.set(statement, name);
            members(statement.members, ts.isInterfaceDeclaration(statement) ? globals.membersOf(name) : name, result);
        } else if (ts.isTypeAliasDeclaration(statement)) {
            result.classes.set(statement, prefix + statement.name.text);
        } else if (ts.isFunctionDeclaration(statement) && statement.name) {
            result.methods.set(statement, prefix + statement.name.text);
        } else if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name)) {
                    continue;
                }

                const name = prefix + declaration.name.text;
                const type = declaration.type;

                (globals.isClass(name, type) ? result.classes : result.fields).set(declaration, name);

                if (type && ts.isTypeLiteralNode(type)) {
                    members(type.members, name, result);
                }
            }
        } else if (isNamespace(statement)) {
            statements(statement.body.statements, `${prefix}${statement.name.text}.`, globals, result);
        }
    }
}

function members(
    nodes: ts.NodeArray<ts.TypeElement | ts.ClassElement>,
    prefix: string,
    result: LibraryDeclarations
): void {
    for (const member of nodes) {
        const name = member.name && memberName(member.name);

        if (ts.isCallSignatureDeclaration(member)) {
            result.methods.set(member, prefix);
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

function isNamespace(statement: ts.Statement): statement is ts.ModuleDeclaration & { name: ts.Identifier; body: ts.ModuleBlock } {
    return ts.isModuleDeclaration(statement)
        && ts.isIdentifier(statement.name)
        && statement.body !== undefined
        && ts.isModuleBlock(statement.body);
}
