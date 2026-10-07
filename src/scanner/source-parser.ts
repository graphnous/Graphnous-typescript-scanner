import ts from "typescript-api";
import type {
    Annotation,
    Call,
    Class,
    EnumConstant,
    Field,
    FieldAccess,
    File,
    Import,
    Method,
    Modifier,
    Parameter,
    TypeRef,
    TypeUse
} from "../generated/ScanResult.js";

/**
 * Where a declaration is: its lines and columns, starting at 1, with the
 * end inclusive.
 */
interface Location {
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
}

/**
 * Where declarations are declared: the qualified name their names extend,
 * e.g. "src/orders:" in a file and "src/orders:Orders" in a class, and for
 * the bodies of methods the method, whose local classes are named after it.
 */
interface Scope {
    prefix: string;
    /** The classes that classes declared here are listed under. */
    classes: Class[];
    enclosingMethod?: string;
}

type ClassLike =
    | ts.ClassLikeDeclaration
    | ts.InterfaceDeclaration
    | ts.EnumDeclaration
    | ts.TypeAliasDeclaration;

type FunctionBody = ts.Block | ts.Expression;

/**
 * Turns TypeScript and JavaScript sources into the scan result model.
 *
 * Parsing is two passes: {@link parse} names the declarations of each file,
 * and {@link resolve} then fills in what refers to declarations, such as
 * calls, field accesses and the classes types refer to, so references
 * resolve to declarations in any file of the target.
 *
 * Qualified names are the file path relative to the target without its
 * extension, a colon, then the dotted name, e.g. "src/orders:Orders.find".
 * Constructors are named "constructor", and the accessors of a property
 * "get" and "set" after it, e.g. "src/orders:Order.total.get". Local and
 * anonymous classes are named after the method that declares them, e.g.
 * "src/orders:Orders.find.Query", with anonymous ones numbered from 1.
 *
 * A reference resolves when it is to a declaration in the target; else its
 * target is the name as written, e.g. "console.log".
 */
export class SourceParser {

    private readonly checker: ts.TypeChecker;

    /** The qualified names of the declarations of the target. */
    private readonly names = new Map<ts.Node, string>();

    /** Declarations named by methods and functions, to tell them apart. */
    private readonly methods = new Set<ts.Node>();

    /** Declarations named by fields, variables and enum constants. */
    private readonly fields = new Set<ts.Node>();

    /** Declarations named by classes, interfaces, enums and type aliases. */
    private readonly classes = new Set<ts.Node>();

    /** What the second pass fills in. */
    private readonly pending: (() => void)[] = [];

    /** The anonymous classes of each method so far, to number them. */
    private readonly anonymousClasses = new Map<string, number>();

    private sourceFile!: ts.SourceFile;

    constructor(program: ts.Program) {
        this.checker = program.getTypeChecker();
    }

    /**
     * Adds the imports and declarations of the source file to the file.
     *
     * @param path the path of the file relative to the target, without its
     *             extension, as qualified names start with
     */
    parse(sourceFile: ts.SourceFile, path: string, file: File): void {
        this.sourceFile = sourceFile;

        const imports: Import[] = [];
        const classes: Class[] = [];
        const functions: Method[] = [];
        const variables: Field[] = [];

        this.statements(
            sourceFile.statements,
            { prefix: `${path}:`, classes },
            imports,
            functions,
            variables
        );

        if (imports.length > 0) {
            file.imports = imports;
        }

        file.classes = classes;

        if (functions.length > 0) {
            file.functions = functions;
        }

        if (variables.length > 0) {
            file.variables = variables;
        }
    }

    /**
     * Fills in the references of every parsed file, once all files are
     * parsed.
     */
    resolve(): void {
        for (const task of this.pending) {
            task();
        }

        this.pending.length = 0;
    }

    // Declarations

    private statements(
        statements: ts.NodeArray<ts.Statement>,
        scope: Scope,
        imports: Import[],
        functions: Method[],
        variables: Field[]
    ): void {
        const seen = new Set<ts.Symbol>();

        for (const statement of statements) {
            if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
                imports.push(this.importOf(
                    statement,
                    statement.moduleSpecifier.text,
                    statement.importClause?.namedBindings !== undefined
                        && ts.isNamespaceImport(statement.importClause.namedBindings)
                ));
            } else if (ts.isImportEqualsDeclaration(statement)
                && ts.isExternalModuleReference(statement.moduleReference)
                && ts.isStringLiteral(statement.moduleReference.expression)) {
                imports.push(this.importOf(statement, statement.moduleReference.expression.text, true));
            } else if (ts.isExportDeclaration(statement)
                && statement.moduleSpecifier
                && ts.isStringLiteral(statement.moduleSpecifier)) {
                // A re-export, such as export * from "./orders"
                imports.push(this.importOf(
                    statement,
                    statement.moduleSpecifier.text,
                    statement.exportClause === undefined || ts.isNamespaceExport(statement.exportClause)
                ));
            } else if (isClassLike(statement)) {
                scope.classes.push(this.classOf(statement, scope, "TOP_LEVEL"));
            } else if (ts.isFunctionDeclaration(statement)) {
                if (this.isFirstOf(statement, seen)) {
                    functions.push(this.functionOf(this.implementationOf(statement), scope));
                }
            } else if (ts.isVariableStatement(statement)) {
                this.variableStatement(statement, scope, functions, variables);
            } else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
                this.namespace(statement, scope, imports, functions, variables);
            }
        }
    }

    /**
     * The declarations of a namespace, named after it, e.g.
     * "src/orders:Orders.Status", and listed with those of the file.
     */
    private namespace(
        declaration: ts.ModuleDeclaration,
        scope: Scope,
        imports: Import[],
        functions: Method[],
        variables: Field[]
    ): void {
        const prefix = qualify(scope.prefix, declaration.name.text);
        const body = declaration.body;

        if (body && ts.isModuleBlock(body)) {
            this.statements(body.statements, { ...scope, prefix }, imports, functions, variables);
        } else if (body && ts.isModuleDeclaration(body)) {
            // namespace A.B { }
            this.namespace(body, { ...scope, prefix }, imports, functions, variables);
        }
    }

    private importOf(node: ts.Node, name: string, wildcard: boolean): Import {
        const result: Import = { name };

        if (wildcard) {
            result.wildcard = true;
        }

        return { ...result, ...this.location(node) };
    }

    private variableStatement(
        statement: ts.VariableStatement,
        scope: Scope,
        functions: Method[],
        variables: Field[]
    ): void {
        const declarations = statement.declarationList.declarations;
        const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;

        for (const declaration of declarations) {
            // A single declaration spans the statement, with its modifiers
            const node = declarations.length === 1 ? statement : declaration;
            const initializer = declaration.initializer && skipParentheses(declaration.initializer);

            if (ts.isIdentifier(declaration.name) && initializer && isFunctionExpression(initializer)) {
                const qualifiedName = qualify(scope.prefix, declaration.name.text);

                functions.push(this.method(
                    declaration.name.text,
                    qualifiedName,
                    "FUNCTION",
                    node,
                    initializer,
                    [...this.modifiers(statement), ...this.modifiers(initializer)],
                    scope,
                    [declaration, initializer]
                ));
            } else if (ts.isIdentifier(declaration.name) && initializer && ts.isClassExpression(initializer)) {
                scope.classes.push(this.classOf(initializer, scope, "TOP_LEVEL", declaration.name.text, [declaration]));
            } else {
                for (const binding of bindingNames(declaration.name)) {
                    const field = this.field(
                        binding.name.text,
                        qualify(scope.prefix, binding.name.text),
                        binding === declaration ? node : binding,
                        binding === declaration ? declaration.type : undefined,
                        [binding]
                    );

                    const modifiers = this.modifiers(statement);

                    if (isConst) {
                        modifiers.push("CONST");
                    }

                    setModifiers(field, modifiers);
                    variables.push(field);
                }
            }
        }
    }

    private classOf(
        declaration: ClassLike,
        scope: Scope,
        nesting: NonNullable<Class["nesting"]>,
        fallbackName?: string,
        aliases: ts.Node[] = []
    ): Class {
        const name = declaration.name?.text
            ?? fallbackName
            ?? (nesting === "TOP_LEVEL" ? "default" : this.anonymousName(scope));

        const qualifiedName = qualify(scope.prefix, name);

        this.register(qualifiedName, this.classes, declaration, ...aliases);

        const result: Class = {
            name,
            qualifiedName,
            ...this.location(declaration)
        };

        if (nesting !== "TOP_LEVEL") {
            result.nesting = nesting;
        }

        if (scope.enclosingMethod) {
            result.enclosingMethod = scope.enclosingMethod;
        }

        setModifiers(result, this.modifiers(declaration));

        const memberScope: Scope = { prefix: qualifiedName, classes: [] };

        if (ts.isEnumDeclaration(declaration)) {
            result.kind = "ENUM";
            result.enumConstants = declaration.members.map(member => this.enumConstant(member, qualifiedName));
        } else if (ts.isTypeAliasDeclaration(declaration)) {
            result.kind = "TYPE_ALIAS";
            this.typeParameters(result, declaration.typeParameters);
            result.aliasedType = this.typeRef(declaration.type);
        } else if (ts.isInterfaceDeclaration(declaration)) {
            result.kind = "INTERFACE";
            this.typeParameters(result, declaration.typeParameters);
            this.heritage(result, declaration.heritageClauses);
            this.members(result, declaration.members, memberScope);
        } else {
            result.kind = "CLASS";
            this.typeParameters(result, declaration.typeParameters);
            this.heritage(result, declaration.heritageClauses);
            this.annotations(result, declaration);
            this.members(result, declaration.members, memberScope);
        }

        if (memberScope.classes.length > 0) {
            result.classes = memberScope.classes;
        }

        return result;
    }

    private anonymousName(scope: Scope): string {
        const key = scope.enclosingMethod ?? scope.prefix;
        const count = (this.anonymousClasses.get(key) ?? 0) + 1;

        this.anonymousClasses.set(key, count);

        return String(count);
    }

    private heritage(result: Class, clauses: ts.NodeArray<ts.HeritageClause> | undefined): void {
        for (const clause of clauses ?? []) {
            const types = clause.types.map(type => this.typeRef(type));

            // An interface extends interfaces, a class extends a class
            if (clause.token === ts.SyntaxKind.ExtendsKeyword && result.kind !== "INTERFACE") {
                result.superClasses = types;
            } else {
                result.interfaces = [...result.interfaces ?? [], ...types];
            }
        }
    }

    private members(
        result: Class,
        members: ts.NodeArray<ts.ClassElement | ts.TypeElement>,
        scope: Scope
    ): void {
        const methods: Method[] = [];
        const fields: Field[] = [];
        const seen = new Set<ts.Symbol>();
        const properties = new Map<string, Field>();

        for (const member of members) {
            const name = member.name && memberName(member.name);

            if (ts.isConstructorDeclaration(member)) {
                if (!this.isFirstOf(member, seen)) {
                    continue;
                }

                const implementation = this.implementationOf(member);
                const qualifiedName = qualify(scope.prefix, "constructor");

                methods.push(this.method(
                    "constructor",
                    qualifiedName,
                    "CONSTRUCTOR",
                    implementation,
                    implementation,
                    this.modifiers(implementation),
                    scope,
                    this.overloadsOf(member)
                ));

                // Parameter properties, such as constructor(private readonly id: string)
                for (const parameter of implementation.parameters) {
                    if (ts.isIdentifier(parameter.name) && ts.getModifiers(parameter)?.length) {
                        const field = this.field(
                            parameter.name.text,
                            qualify(scope.prefix, parameter.name.text),
                            parameter,
                            parameter.type,
                            [parameter]
                        );

                        setModifiers(field, this.modifiers(parameter));
                        this.annotations(field, parameter);
                        fields.push(field);
                    }
                }
            } else if (name === undefined) {
                // Index signatures, static blocks and computed names
                continue;
            } else if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
                if (this.isFirstOf(member, seen)) {
                    const implementation = this.implementationOf(member);

                    methods.push(this.method(
                        name,
                        qualify(scope.prefix, name),
                        "METHOD",
                        implementation,
                        implementation,
                        this.modifiers(implementation),
                        scope,
                        this.overloadsOf(member)
                    ));
                }
            } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
                // The property, once for its getter and setter, and a method
                // for each accessor
                const qualifiedName = qualify(scope.prefix, name);
                const isGetter = ts.isGetAccessorDeclaration(member);
                let property = properties.get(name);

                if (property) {
                    this.register(qualifiedName, this.fields, member);
                } else {
                    property = this.field(
                        name,
                        qualifiedName,
                        member,
                        isGetter ? member.type : member.parameters[0]?.type,
                        [member]
                    );

                    setModifiers(property, this.modifiers(member));
                    properties.set(name, property);
                    fields.push(property);
                }

                methods.push(this.method(
                    name,
                    qualify(qualifiedName, isGetter ? "get" : "set"),
                    "METHOD",
                    member,
                    member,
                    this.modifiers(member),
                    scope,
                    []
                ));
            } else if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
                const initializer = ts.isPropertyDeclaration(member) && member.initializer
                    ? skipParentheses(member.initializer)
                    : undefined;

                if (initializer && isFunctionExpression(initializer)) {
                    // A method as a property, such as onClick = () => { }
                    methods.push(this.method(
                        name,
                        qualify(scope.prefix, name),
                        "METHOD",
                        member,
                        initializer,
                        [...this.modifiers(member), ...this.modifiers(initializer)],
                        scope,
                        [member, initializer]
                    ));
                } else {
                    const field = this.field(name, qualify(scope.prefix, name), member, member.type, [member]);

                    setModifiers(field, this.modifiers(member));
                    this.annotations(field, member);
                    fields.push(field);

                    if (initializer && ts.isClassExpression(initializer)) {
                        scope.classes.push(this.classOf(initializer, scope, "MEMBER", name));
                    }
                }
            }
        }

        if (methods.length > 0) {
            result.methods = methods;
        }

        if (fields.length > 0) {
            result.fields = fields;
        }
    }

    private enumConstant(member: ts.EnumMember, enumName: string): EnumConstant {
        const name = memberName(member.name) ?? member.name.getText(this.sourceFile);
        const qualifiedName = qualify(enumName, name);

        this.register(qualifiedName, this.fields, member);

        return { name, qualifiedName, ...this.location(member) };
    }

    /**
     * A method, function or constructor.
     *
     * @param node        the declaration, from its annotations to its body
     * @param function_   the function itself, with its parameters and body
     * @param declarations the declarations that name it, such as its
     *                    overloads, the variable it is assigned to or the
     *                    function expression
     */
    private method(
        name: string,
        qualifiedName: string,
        kind: NonNullable<Method["kind"]>,
        node: ts.Node,
        function_: ts.SignatureDeclaration,
        modifiers: Modifier[],
        scope: Scope,
        declarations: ts.Node[]
    ): Method {
        this.register(qualifiedName, this.methods, node, function_, ...declarations);

        const result: Method = {
            name,
            qualifiedName,
            ...this.location(node),
            kind
        };

        setModifiers(result, modifiers);
        this.typeParameters(result, function_.typeParameters);

        if (function_.type && kind !== "CONSTRUCTOR") {
            result.returnType = this.typeRef(function_.type);
        }

        const parameters = function_.parameters
            .filter(parameter => !(ts.isIdentifier(parameter.name) && parameter.name.text === "this"))
            .map(parameter => this.parameter(parameter, qualifiedName));

        if (parameters.length > 0) {
            result.parameters = parameters;
        }

        this.annotations(result, node);

        const body = "body" in function_ ? function_.body as FunctionBody | undefined : undefined;

        if (body) {
            const bodyScope: Scope = { prefix: qualifiedName, classes: scope.classes, enclosingMethod: qualifiedName };

            this.localClasses(body, bodyScope);

            const sourceFile = this.sourceFile;
            this.pending.push(() => this.body(result, body, sourceFile));
        }

        return result;
    }

    private functionOf(declaration: ts.FunctionDeclaration, scope: Scope): Method {
        const name = declaration.name?.text ?? "default";

        return this.method(
            name,
            qualify(scope.prefix, name),
            "FUNCTION",
            declaration,
            declaration,
            this.modifiers(declaration),
            scope,
            this.overloadsOf(declaration)
        );
    }

    private parameter(parameter: ts.ParameterDeclaration, methodName: string): Parameter {
        const name = text(parameter.name, this.sourceFile);

        const result: Parameter = { name };

        if (parameter.type) {
            result.type = this.typeRef(parameter.type);
        }

        result.qualifiedName = qualify(methodName, name);
        Object.assign(result, this.location(parameter));
        this.annotations(result, parameter);

        return result;
    }

    private field(
        name: string,
        qualifiedName: string,
        node: ts.Node,
        type: ts.TypeNode | undefined,
        declarations: ts.Node[]
    ): Field {
        this.register(qualifiedName, this.fields, ...declarations);

        const result: Field = { name };

        if (type) {
            result.type = this.typeRef(type);
        }

        result.qualifiedName = qualifiedName;

        return { ...result, ...this.location(node) };
    }

    /**
     * The classes, interfaces, enums and type aliases declared in a body,
     * listed with the classes of the scope. Those of functions nested in
     * the body belong to the method too.
     */
    private localClasses(body: FunctionBody, scope: Scope): void {
        const visit = (node: ts.Node): void => {
            if (isClassLike(node)) {
                const variable = ts.isClassExpression(node) && ts.isVariableDeclaration(node.parent)
                    && ts.isIdentifier(node.parent.name)
                    ? node.parent.name.text
                    : undefined;

                const nesting = node.name || variable ? "LOCAL" : "ANONYMOUS";

                scope.classes.push(this.classOf(node, scope, nesting, variable));
            } else {
                ts.forEachChild(node, visit);
            }
        };

        visit(body);
    }

    private typeParameters(
        result: Class | Method,
        typeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined
    ): void {
        if (typeParameters?.length) {
            result.typeParameters = typeParameters.map(parameter => text(parameter, this.sourceFile));
        }
    }

    private annotations(result: { annotations?: Annotation[] }, node: ts.Node): void {
        const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;

        if (decorators?.length) {
            result.annotations = decorators.map(decorator => this.annotation(decorator));
        }
    }

    /**
     * A decorator, with its arguments as JSON values as the Java scanner
     * encodes annotation arguments: a single argument is named "value",
     * several are numbered from 0.
     */
    private annotation(decorator: ts.Decorator): Annotation {
        const expression = decorator.expression;
        const callee = ts.isCallExpression(expression) ? expression.expression : expression;

        const result: Annotation = {
            name: ts.isPropertyAccessExpression(callee) ? callee.name.text : text(callee, this.sourceFile)
        };

        const sourceFile = this.sourceFile;

        this.pending.push(() => {
            const declaration = this.declarationOf(callee);

            if (declaration) {
                result.qualifiedName = this.names.get(declaration);
            }
        });

        Object.assign(result, this.location(decorator));

        if (ts.isCallExpression(expression) && expression.arguments.length > 0) {
            const values = expression.arguments.map(argument => this.value(argument, sourceFile));

            result.arguments = values.length === 1
                ? { value: values[0] }
                : Object.fromEntries(values.map((value, index) => [String(index), value]));
        }

        return result;
    }

    private value(expression: ts.Expression, sourceFile: ts.SourceFile): unknown {
        if (ts.isStringLiteralLike(expression)) {
            return expression.text;
        }

        if (ts.isNumericLiteral(expression)) {
            return Number(expression.text);
        }

        if (ts.isPrefixUnaryExpression(expression)
            && expression.operator === ts.SyntaxKind.MinusToken
            && ts.isNumericLiteral(expression.operand)) {
            return -Number(expression.operand.text);
        }

        switch (expression.kind) {
            case ts.SyntaxKind.TrueKeyword:
                return true;
            case ts.SyntaxKind.FalseKeyword:
                return false;
            case ts.SyntaxKind.NullKeyword:
                return null;
        }

        if (ts.isArrayLiteralExpression(expression)) {
            return expression.elements.map(element => this.value(element, sourceFile));
        }

        if (ts.isObjectLiteralExpression(expression)) {
            const entries: [string, unknown][] = [];

            for (const property of expression.properties) {
                const name = property.name && memberName(property.name);

                if (name !== undefined && ts.isPropertyAssignment(property)) {
                    entries.push([name, this.value(property.initializer, sourceFile)]);
                } else if (name !== undefined && ts.isShorthandPropertyAssignment(property)) {
                    entries.push([name, this.value(property.name, sourceFile)]);
                }
            }

            return Object.fromEntries(entries);
        }

        return text(expression, sourceFile);
    }

    // References

    /**
     * Fills in the calls, field accesses and type uses of a method body.
     */
    private body(method: Method, body: FunctionBody, sourceFile: ts.SourceFile): void {
        const calls: Call[] = [];
        const fieldAccesses: FieldAccess[] = [];
        const typeUses: TypeUse[] = [];

        // Expressions that are called, which are not also references
        const callees = new Set<ts.Node>();

        const visit = (node: ts.Node): void => {
            if (isClassLike(node)) {
                // Local classes have methods of their own
                return;
            }

            if (ts.isTypeNode(node)) {
                this.typeUses(node, typeUseKind(node), sourceFile, typeUses);
                return;
            }

            if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
                callees.add(node.expression);

                if (node.expression.kind !== ts.SyntaxKind.ImportKeyword) {
                    calls.push(this.call(node, sourceFile));
                }
            } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
                const call = this.jsxCall(node, sourceFile);

                if (call) {
                    calls.push(call);
                }

                callees.add(node.tagName);
            } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
                callees.add(node.right);

                const declaration = this.declarationOf(node.right);

                typeUses.push(this.reference(
                    declaration && this.classes.has(declaration) ? declaration : undefined,
                    node.right,
                    "INSTANCEOF",
                    sourceFile
                ));
            } else if (ts.isPropertyAccessExpression(node)
                || (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
                || (ts.isIdentifier(node) && isReference(node))) {
                this.valueReference(node, callees.has(node), sourceFile, calls, fieldAccesses, typeUses);
            }

            ts.forEachChild(node, visit);
        };

        visit(body);

        if (calls.length > 0) {
            method.calls = calls;
        }

        if (fieldAccesses.length > 0) {
            method.fieldAccesses = fieldAccesses;
        }

        if (typeUses.length > 0) {
            method.typeUses = typeUses;
        }
    }

    private call(node: ts.CallExpression | ts.NewExpression, sourceFile: ts.SourceFile): Call {
        const isConstructor = ts.isNewExpression(node) || node.expression.kind === ts.SyntaxKind.SuperKeyword;
        const kind = isConstructor ? "CONSTRUCTOR" : "METHOD";

        let declaration: ts.Node | undefined;

        try {
            declaration = this.checker.getResolvedSignature(node)?.declaration;
        } catch {
            // Resolved through the callee instead
        }

        let target = declaration && this.methods.has(declaration) ? this.names.get(declaration) : undefined;

        if (target === undefined) {
            // The class of a constructor that is not declared, or a function
            // the signature does not lead to
            const callee = node.expression.kind === ts.SyntaxKind.SuperKeyword
                ? this.superClassOf(node)
                : this.declarationOf(node.expression);

            if (callee && isConstructor && this.classes.has(callee)) {
                target = qualify(this.names.get(callee)!, "constructor");
            } else if (callee && this.methods.has(callee)) {
                target = this.names.get(callee);
            }
        }

        // super(...) as the class it calls the constructor of, e.g. Error
        const callee = node.expression.kind === ts.SyntaxKind.SuperKeyword
            ? superClassExpressionOf(node) ?? node.expression
            : node.expression;

        return {
            target: target ?? writtenName(callee, sourceFile),
            kind,
            ...this.location(node, sourceFile),
            resolved: target !== undefined
        };
    }

    /**
     * A component rendered with JSX, such as <OrderList />, as a call to the
     * function or a constructor of the class. Elements such as <div> are
     * not calls.
     */
    private jsxCall(node: ts.JsxOpeningLikeElement, sourceFile: ts.SourceFile): Call | undefined {
        const declaration = this.declarationOf(node.tagName);

        if (declaration && this.methods.has(declaration)) {
            return { target: this.names.get(declaration)!, kind: "METHOD", ...this.location(node, sourceFile), resolved: true };
        }

        if (declaration && this.classes.has(declaration)) {
            return {
                target: qualify(this.names.get(declaration)!, "constructor"),
                kind: "CONSTRUCTOR",
                ...this.location(node, sourceFile),
                resolved: true
            };
        }

        return undefined;
    }

    /**
     * A name or property in an expression: a field access when it is to a
     * field, a method reference when it is to a method it does not call,
     * such as onClick={this.save}, and a class literal when it is a class
     * as a value, such as providers: [Orders].
     */
    private valueReference(
        node: ts.Expression,
        isCalled: boolean,
        sourceFile: ts.SourceFile,
        calls: Call[],
        fieldAccesses: FieldAccess[],
        typeUses: TypeUse[]
    ): void {
        const declaration = this.declarationOf(node);

        if (!declaration) {
            return;
        }

        if (this.fields.has(declaration)) {
            fieldAccesses.push({
                target: this.names.get(declaration)!,
                access: accessOf(node),
                ...this.location(node, sourceFile),
                resolved: true
            });
        } else if (this.methods.has(declaration) && !isCalled) {
            calls.push({
                target: this.names.get(declaration)!,
                kind: "METHOD_REFERENCE",
                ...this.location(node, sourceFile),
                resolved: true
            });
        } else if (this.classes.has(declaration) && !isCalled
            && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)) {
            typeUses.push(this.reference(declaration, node, "CLASS_LITERAL", sourceFile));
        }
    }

    /**
     * The classes a type in a body refers to, one type use each.
     */
    private typeUses(
        type: ts.TypeNode,
        kind: TypeUse["kind"],
        sourceFile: ts.SourceFile,
        typeUses: TypeUse[]
    ): void {
        for (const reference of typeReferences(type)) {
            const declaration = this.typeDeclarationOf(reference);

            if (declaration !== null) {
                typeUses.push(this.reference(declaration, reference, kind, sourceFile));
            }
        }
    }

    private reference(
        declaration: ts.Node | undefined,
        node: ts.Node,
        kind: TypeUse["kind"],
        sourceFile: ts.SourceFile
    ): TypeUse {
        const name = ts.isTypeReferenceNode(node) ? node.typeName
            : ts.isExpressionWithTypeArguments(node) ? node.expression
            : node;

        return {
            target: declaration ? this.names.get(declaration)! : writtenName(name, sourceFile),
            kind,
            ...this.location(node, sourceFile),
            resolved: declaration !== undefined
        };
    }

    /**
     * A type as declared, with the classes it refers to.
     */
    private typeRef(type: ts.TypeNode | ts.ExpressionWithTypeArguments): TypeRef {
        const result: TypeRef = { name: text(type, this.sourceFile) };
        const sourceFile = this.sourceFile;

        this.pending.push(() => {
            const references = new Set<string>();

            for (const reference of typeReferences(type)) {
                const declaration = this.typeDeclarationOf(reference);

                if (declaration !== null) {
                    references.add(this.reference(declaration, reference, "OTHER", sourceFile).target);
                }
            }

            if (references.size > 0) {
                result.references = [...references];
            }
        });

        return result;
    }

    /**
     * The class a type reference is to, undefined when it is not to a class
     * of the target, and null when it is to a type parameter, which types
     * leave out.
     */
    private typeDeclarationOf(
        reference: ts.TypeReferenceNode | ts.ExpressionWithTypeArguments
    ): ts.Node | undefined | null {
        const name = ts.isTypeReferenceNode(reference) ? reference.typeName : reference.expression;
        const symbol = this.symbolOf(name);

        if (symbol && symbol.flags & ts.SymbolFlags.TypeParameter) {
            return null;
        }

        const declaration = symbol && this.registeredDeclarationOf(symbol);

        return declaration && this.classes.has(declaration) ? declaration : undefined;
    }

    /**
     * The declaration of the target an expression refers to, through any
     * imports.
     */
    private declarationOf(node: ts.Node): ts.Node | undefined {
        let symbol: ts.Symbol | undefined;

        if (ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) {
            symbol = this.checker.getShorthandAssignmentValueSymbol(node.parent);
        } else if (ts.isPropertyAccessExpression(node)) {
            symbol = this.symbolOf(node.name);
        } else if (ts.isElementAccessExpression(node)) {
            symbol = this.symbolOf(node.argumentExpression);
        } else {
            symbol = this.symbolOf(node);
        }

        return symbol && this.registeredDeclarationOf(symbol);
    }

    private superClassOf(node: ts.Node): ts.Node | undefined {
        const superClass = superClassExpressionOf(node);

        return superClass && this.declarationOf(superClass);
    }

    private symbolOf(node: ts.Node): ts.Symbol | undefined {
        try {
            const symbol = this.checker.getSymbolAtLocation(node);

            return symbol && symbol.flags & ts.SymbolFlags.Alias
                ? this.checker.getAliasedSymbol(symbol)
                : symbol;
        } catch {
            return undefined;
        }
    }

    private registeredDeclarationOf(symbol: ts.Symbol): ts.Node | undefined {
        const declarations = [
            ...symbol.valueDeclaration ? [symbol.valueDeclaration] : [],
            ...symbol.declarations ?? []
        ];

        return declarations.find(declaration => this.names.has(declaration));
    }

    // Helpers

    private register(qualifiedName: string, kind: Set<ts.Node>, ...declarations: ts.Node[]): void {
        for (const declaration of declarations) {
            // The first name counts, such as a field's for a parameter property
            if (!this.names.has(declaration)) {
                this.names.set(declaration, qualifiedName);
                kind.add(declaration);
            }
        }
    }

    /**
     * Whether the declaration is the first of its overloads, so overloaded
     * functions and methods are listed once.
     */
    private isFirstOf(declaration: ts.NamedDeclaration, seen: Set<ts.Symbol>): boolean {
        const symbol = this.declaredSymbolOf(declaration);

        if (!symbol) {
            return true;
        }

        if (seen.has(symbol)) {
            return false;
        }

        seen.add(symbol);

        return true;
    }

    private overloadsOf(declaration: ts.NamedDeclaration): ts.Node[] {
        return (this.declaredSymbolOf(declaration)?.declarations ?? [declaration])
            .filter(overload => overload.kind === declaration.kind);
    }

    /**
     * The symbol a declaration declares; a constructor has no name to ask
     * the checker with.
     */
    private declaredSymbolOf(declaration: ts.NamedDeclaration): ts.Symbol | undefined {
        return declaration.name
            ? this.checker.getSymbolAtLocation(declaration.name)
            : (declaration as { symbol?: ts.Symbol }).symbol;
    }

    /**
     * Of overloaded declarations, the implementation, or the first when
     * none has a body.
     */
    private implementationOf<T extends ts.NamedDeclaration>(declaration: T): T {
        const overloads = this.overloadsOf(declaration) as T[];

        return overloads.find(overload => "body" in overload && overload.body !== undefined) ?? declaration;
    }

    private modifiers(node: ts.Node): Modifier[] {
        const modifiers: Modifier[] = [];
        const declared = ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : [];
        const isDefault = declared.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword);

        for (const modifier of declared) {
            const mapped = modifier.kind === ts.SyntaxKind.ExportKeyword
                ? (isDefault ? "EXPORT_DEFAULT" : "EXPORT")
                : MODIFIERS.get(modifier.kind);

            if (mapped && !modifiers.includes(mapped)) {
                modifiers.push(mapped);
            }
        }

        const name = (node as { name?: ts.Node }).name;

        if (name && ts.isPrivateIdentifier(name) && !modifiers.includes("PRIVATE")) {
            modifiers.unshift("PRIVATE");
        }

        return modifiers;
    }

    private location(node: ts.Node, sourceFile = this.sourceFile): Location {
        const startPosition = node.getStart(sourceFile);
        const start = sourceFile.getLineAndCharacterOfPosition(startPosition);
        const end = sourceFile.getLineAndCharacterOfPosition(Math.max(node.getEnd() - 1, startPosition));

        return {
            startLine: start.line + 1,
            endLine: end.line + 1,
            startColumn: start.character + 1,
            endColumn: end.character + 1
        };
    }
}

const MODIFIERS = new Map<ts.SyntaxKind, Modifier>([
    [ts.SyntaxKind.PublicKeyword, "PUBLIC"],
    [ts.SyntaxKind.ProtectedKeyword, "PROTECTED"],
    [ts.SyntaxKind.PrivateKeyword, "PRIVATE"],
    [ts.SyntaxKind.StaticKeyword, "STATIC"],
    [ts.SyntaxKind.AbstractKeyword, "ABSTRACT"],
    [ts.SyntaxKind.AsyncKeyword, "ASYNC"],
    [ts.SyntaxKind.ReadonlyKeyword, "READONLY"],
    [ts.SyntaxKind.OverrideKeyword, "OVERRIDE"],
    [ts.SyntaxKind.ConstKeyword, "CONST"]
]);

/**
 * The class the class declaring the node extends, as written.
 */
function superClassExpressionOf(node: ts.Node): ts.Expression | undefined {
    return ts.findAncestor(node, ts.isClassLike)
        ?.heritageClauses
        ?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)
        ?.types[0]
        ?.expression;
}

function qualify(prefix: string, name: string): string {
    return prefix.endsWith(":") ? prefix + name : `${prefix}.${name}`;
}

function isClassLike(node: ts.Node): node is ClassLike {
    return ts.isClassDeclaration(node)
        || ts.isClassExpression(node)
        || ts.isInterfaceDeclaration(node)
        || ts.isEnumDeclaration(node)
        || ts.isTypeAliasDeclaration(node);
}

function isFunctionExpression(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
    return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function skipParentheses(expression: ts.Expression): ts.Expression {
    return ts.isParenthesizedExpression(expression) ? skipParentheses(expression.expression) : expression;
}

/**
 * The name of a member, or undefined for a computed one such as [key].
 */
function memberName(name: ts.PropertyName | ts.BindingName): string | undefined {
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
        return name.text;
    }

    if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
        return name.text;
    }

    return undefined;
}

/**
 * The variables a declaration declares: itself, or the names it
 * destructures into, such as a and b of const { a, b } = value.
 */
function bindingNames(
    name: ts.BindingName
): (ts.NamedDeclaration & { name: ts.Identifier })[] {
    if (ts.isIdentifier(name)) {
        return [name.parent as ts.NamedDeclaration & { name: ts.Identifier }];
    }

    return name.elements.flatMap(element =>
        ts.isBindingElement(element) ? bindingNames(element.name) : []
    );
}

/**
 * The source of a node on one line.
 */
function text(node: ts.Node, sourceFile: ts.SourceFile): string {
    return node.getText(sourceFile).replace(/\s+/g, " ");
}

/**
 * The name of what an expression refers to as written, without the
 * arguments of the calls in it, e.g. "this.orders.find" or
 * "fetch().then".
 */
function writtenName(node: ts.Node, sourceFile: ts.SourceFile): string {
    if (ts.isPropertyAccessExpression(node) || ts.isQualifiedName(node)) {
        const left = ts.isPropertyAccessExpression(node) ? node.expression : node.left;
        const right = ts.isPropertyAccessExpression(node) ? node.name : node.right;

        return `${writtenName(left, sourceFile)}.${right.text}`;
    }

    if (ts.isCallExpression(node)) {
        return `${writtenName(node.expression, sourceFile)}()`;
    }

    if (ts.isElementAccessExpression(node)) {
        return `${writtenName(node.expression, sourceFile)}[]`;
    }

    if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)
        || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
        return writtenName(node.expression, sourceFile);
    }

    return text(node, sourceFile);
}

/**
 * The references to named types in a type, including through type
 * arguments, unions and array element types.
 */
function typeReferences(
    type: ts.Node
): (ts.TypeReferenceNode | ts.ExpressionWithTypeArguments)[] {
    const references: (ts.TypeReferenceNode | ts.ExpressionWithTypeArguments)[] = [];

    const visit = (node: ts.Node): void => {
        if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)) {
            references.push(node);
        }

        ts.forEachChild(node, visit);
    };

    visit(type);

    return references;
}

/**
 * Whether an identifier in a body refers to something, rather than naming
 * a property or declaring something.
 */
function isReference(identifier: ts.Identifier): boolean {
    const parent = identifier.parent;

    if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) {
        return false;
    }

    if (ts.isShorthandPropertyAssignment(parent)) {
        return true;
    }

    if ((ts.isJsxAttribute(parent) || ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent))) {
        return false;
    }

    return !("name" in parent && parent.name === identifier && ts.isDeclarationStatement(parent))
        && !(ts.isPropertyAssignment(parent) && parent.name === identifier)
        && !(ts.isVariableDeclaration(parent) && parent.name === identifier)
        && !(ts.isParameter(parent) && parent.name === identifier)
        && !(ts.isBindingElement(parent) && parent.name === identifier)
        && !(ts.isFunctionExpression(parent) && parent.name === identifier)
        && !(ts.isMethodDeclaration(parent) && parent.name === identifier);
}

/**
 * How a field access uses the field: written by an assignment, read and
 * written by a compound assignment or increment, else read.
 */
function accessOf(node: ts.Node): FieldAccess["access"] {
    const parent = node.parent;

    if (ts.isBinaryExpression(parent) && parent.left === node) {
        const operator = parent.operatorToken.kind;

        if (operator === ts.SyntaxKind.EqualsToken) {
            return "WRITE";
        }

        if (operator >= ts.SyntaxKind.FirstCompoundAssignment && operator <= ts.SyntaxKind.LastCompoundAssignment) {
            return "READ_WRITE";
        }
    }

    if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
        && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) {
        return "READ_WRITE";
    }

    return "READ";
}

/**
 * How a body uses a type, from where the type is.
 */
function typeUseKind(type: ts.TypeNode): TypeUse["kind"] {
    const parent = type.parent;

    if (ts.isVariableDeclaration(parent) && parent.type === type) {
        return ts.isCatchClause(parent.parent) ? "CATCH" : "LOCAL_VARIABLE";
    }

    if (ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent) || ts.isSatisfiesExpression(parent)) {
        return "CAST";
    }

    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent) || ts.isExpressionWithTypeArguments(parent)
        || ts.isJsxOpeningLikeElement(parent) || ts.isTaggedTemplateExpression(parent))
        && parent.typeArguments?.includes(type)) {
        return "TYPE_ARGUMENT";
    }

    return "OTHER";
}

function setModifiers(result: { modifiers?: Modifier[] }, modifiers: Modifier[]): void {
    if (modifiers.length > 0) {
        result.modifiers = modifiers;
    }
}
