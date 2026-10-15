import {
    AST,
    ASTWithSource,
    Binary,
    BindingPipe,
    Call,
    Chain,
    Conditional,
    CssSelector,
    EmptyExpr,
    ImplicitReceiver,
    Interpolation,
    KeyedRead,
    LiteralArray,
    LiteralMap,
    LiteralPrimitive,
    NonNullAssert,
    ParenthesizedExpression,
    ParsedEventType,
    parseTemplate,
    PrefixNot,
    PropertyRead,
    SafeCall,
    SafeKeyedRead,
    SafePropertyRead,
    SelectorMatcher,
    TaggedTemplateLiteral,
    TemplateLiteral,
    ThisReceiver,
    TmplAstBoundAttribute,
    TmplAstBoundEvent,
    TmplAstBoundText,
    TmplAstContent,
    TmplAstDeferredBlock,
    TmplAstElement,
    TmplAstForLoopBlock,
    TmplAstIfBlock,
    TmplAstLetDeclaration,
    TmplAstNode,
    TmplAstReference,
    TmplAstSwitchBlock,
    TmplAstTemplate,
    TmplAstTextAttribute,
    TypeofExpression,
    Unary,
    VoidExpression
} from "@angular/compiler";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript-api";

/**
 * A component, directive or pipe of the target, from its decorator.
 */
interface Declared {
    /** The file, relative to the target, without its extension. */
    path: string;
    /** Its absolute path. */
    file: string;
    className: string;
    exported: "named" | "default" | undefined;
}

interface Component extends Declared {
    selector?: string;
    template?: Template;
}

interface Template {
    text: string;
    /** The file the template is in, relative to the target. */
    path: string;
    /** Where the text starts in that file. */
    offset: number;
    /** Whether it is a file of its own, from templateUrl. */
    external: boolean;
}

/**
 * Where an expression of a template is in the generated code, and in the
 * template.
 */
export interface Mapping {
    generatedStart: number;
    generatedEnd: number;
    start: number;
    end: number;
    /** For calls and pipes: the arguments as written. */
    arguments?: { start: number; end: number }[];
    /** For a pipe the target does not declare: its name, e.g. "date". */
    pipe?: string;
    /** For a component used by an element: the names of its arguments. */
    argumentNames?: string[];
}

/**
 * The check of the template of a component: generated TypeScript whose
 * calls, field accesses and type uses are those of the template, to give
 * to the method "template" of the component class.
 */
export interface TemplateCheck {
    /** The qualified name of the component class, e.g. "src/app/orders.component:OrdersComponent". */
    className: string;
    /** The generated file, which the program includes. */
    generatedFile: string;
    generatedText: string;
    /** The name of the generated function whose body is the template. */
    functionName: string;
    template: Template;
    mappings: Mapping[];
    /** The components and directives its elements use, as constructor calls. */
    elements: ElementUse[];
}

export interface ElementUse {
    className: string;
    start: number;
    end: number;
    inputs: { name: string; start: number; end: number; quoted: boolean }[];
}

export interface AngularTemplates {
    checks: TemplateCheck[];
    /** Template files, relative to the target, to list as files. */
    templateFiles: string[];
}

const DECORATED = /@(Component|Directive|Pipe)\s*\(/;

/**
 * The templates of the Angular components of the target, inline in the
 * @Component decorator or in the file its templateUrl names, each as
 * generated TypeScript that uses what the template does, as Angular's own
 * type checking of templates does:
 *
 * - bindings, events and interpolations as expressions of the component,
 *   e.g. this.save(order);
 * - @for and *ngFor as for of loops, so their items are typed, @if and *ngIf
 *   with as, and @let as constants;
 * - the pipes of the target as calls of their transform;
 * - elements that are components or directives of the target, by their
 *   selectors, as constructor calls with their inputs as arguments.
 */
export function angularTemplates(targetPath: string, paths: string[]): AngularTemplates {
    const components: Component[] = [];
    const directives: Component[] = [];
    const pipes = new Map<string, Declared>();

    for (const path of paths) {
        if (!/\.tsx?$/.test(path) || /\.d\.[cm]?ts$/.test(path)) {
            continue;
        }

        const file = join(targetPath, path);
        let text: string;

        try {
            text = readFileSync(file, "utf8");
        } catch {
            continue;
        }

        if (!DECORATED.test(text)) {
            continue;
        }

        const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

        for (const statement of sourceFile.statements) {
            if (ts.isClassDeclaration(statement) && statement.name) {
                declared(statement, sourceFile, path, targetPath, components, directives, pipes);
            }
        }
    }

    const matcher = new SelectorMatcher<Component>();

    for (const declaration of [...components, ...directives]) {
        if (declaration.selector) {
            try {
                matcher.addSelectables(CssSelector.parse(declaration.selector), declaration);
            } catch {
                // A selector Angular does not parse matches nothing
            }
        }
    }

    const checks: TemplateCheck[] = [];
    const templateFiles = new Set<string>();

    for (const component of components) {
        if (!component.template || !component.exported) {
            continue;
        }

        if (component.template.external) {
            templateFiles.add(component.template.path);
        }

        try {
            checks.push(check(component, component.template, targetPath, pipes, matcher, checks.length));
        } catch {
            // A template that cannot be checked uses nothing
        }
    }

    return { checks, templateFiles: [...templateFiles].sort() };
}

function declared(
    statement: ts.ClassDeclaration,
    sourceFile: ts.SourceFile,
    path: string,
    targetPath: string,
    components: Component[],
    directives: Component[],
    pipes: Map<string, Declared>
): void {
    for (const decorator of ts.getDecorators(statement) ?? []) {
        const call = decorator.expression;

        if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) {
            continue;
        }

        const kind = call.expression.text;
        const metadata = call.arguments[0];

        if (!metadata || !ts.isObjectLiteralExpression(metadata) || !["Component", "Directive", "Pipe"].includes(kind)) {
            continue;
        }

        const modifiers = ts.getModifiers(statement) ?? [];
        const isExported = modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
        const isDefault = modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword);

        const result: Component = {
            path: path.replace(/\.tsx?$/, ""),
            file: join(targetPath, path),
            className: statement.name!.text,
            exported: isExported ? (isDefault ? "default" : "named") : undefined
        };

        const property = (name: string) => metadata.properties
            .find((candidate): candidate is ts.PropertyAssignment =>
                ts.isPropertyAssignment(candidate) && ts.isIdentifier(candidate.name) && candidate.name.text === name)
            ?.initializer;

        const selector = stringOf(property("selector"));

        if (selector !== undefined) {
            result.selector = selector;
        }

        if (kind === "Pipe") {
            const name = stringOf(property("name"));

            if (name !== undefined) {
                pipes.set(name, result);
            }
        } else if (kind === "Directive") {
            directives.push(result);
        } else {
            const inline = property("template");
            const url = stringOf(property("templateUrl"));

            if (inline && (ts.isStringLiteral(inline) || ts.isNoSubstitutionTemplateLiteral(inline))) {
                // The text as written, so offsets in it are offsets in the file
                result.template = {
                    text: sourceFile.text.slice(inline.getStart(sourceFile) + 1, inline.getEnd() - 1),
                    path,
                    offset: inline.getStart(sourceFile) + 1,
                    external: false
                };
            } else if (url !== undefined) {
                const file = resolve(dirname(join(targetPath, path)), url);

                if (existsSync(file) && !relative(targetPath, file).startsWith("..")) {
                    result.template = {
                        text: readFileSync(file, "utf8"),
                        path: relative(targetPath, file).replace(/\\/g, "/"),
                        offset: 0,
                        external: true
                    };
                }
            }

            components.push(result);
        }
    }
}

function stringOf(expression: ts.Expression | undefined): string | undefined {
    return expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
        ? expression.text
        : undefined;
}

// The generated code

function check(
    component: Component,
    template: Template,
    targetPath: string,
    pipes: Map<string, Declared>,
    matcher: SelectorMatcher<Component>,
    index: number
): TemplateCheck {
    const parsed = parseTemplate(template.text, template.path, { preserveWhitespaces: false });
    const generatedFile = join(dirname(component.file), `__ng_template_${index}_${component.className}.ts`);
    const generator = new Generator(generatedFile, pipes, matcher);

    generator.header(component);
    generator.nodes(parsed.nodes, new Set(["$any"]), referencesOf(parsed.nodes));
    generator.footer();

    return {
        className: `${component.path}:${component.className}`,
        generatedFile,
        generatedText: generator.text,
        functionName: FUNCTION,
        template,
        mappings: generator.mappings,
        elements: generator.elements
    };
}

const FUNCTION = "__ngTemplate";

/** What templates use that the target does not declare, typed any. */
const ANY = "__ngAny";

/** The names of the template references, #name, which the whole template sees. */
function referencesOf(nodes: TmplAstNode[]): string[] {
    const names: string[] = [];

    const visit = (node: TmplAstNode) => {
        if (node instanceof TmplAstElement || node instanceof TmplAstTemplate) {
            names.push(...node.references.map((reference: TmplAstReference) => reference.name));
        }

        for (const child of childrenOf(node)) {
            visit(child);
        }
    };

    nodes.forEach(visit);

    return names;
}

function childrenOf(node: TmplAstNode): TmplAstNode[] {
    if (node instanceof TmplAstElement || node instanceof TmplAstTemplate || node instanceof TmplAstContent) {
        return node.children;
    }

    if (node instanceof TmplAstForLoopBlock) {
        return [...node.children, ...node.empty?.children ?? []];
    }

    if (node instanceof TmplAstIfBlock) {
        return node.branches.flatMap(branch => branch.children);
    }

    if (node instanceof TmplAstSwitchBlock) {
        return node.cases.flatMap(switchCase => switchCase.children);
    }

    if (node instanceof TmplAstDeferredBlock) {
        return [...node.children, ...node.placeholder?.children ?? [], ...node.loading?.children ?? [], ...node.error?.children ?? []];
    }

    return [];
}

class Generator {

    text = "";

    readonly mappings: Mapping[] = [];

    readonly elements: ElementUse[] = [];

    private readonly pipeImports = new Map<string, string>();

    private readonly imports: string[] = [];

    constructor(
        private readonly generatedFile: string,
        private readonly pipes: Map<string, Declared>,
        private readonly matcher: SelectorMatcher<Component>
    ) {
    }

    header(component: Component): void {
        this.text += `declare function ${ANY}(...values: any[]): any;\n`;
        this.text += `export function ${FUNCTION}(this: __ngComponent) {\n`;
        this.imports.push(this.importOf(component, "__ngComponent"));
    }

    footer(): void {
        this.text += "}\n";
        this.text = this.imports.join("") + this.text;

        // The imports come first, so the offsets of the mappings move
        const shift = this.imports.join("").length;

        for (const mapping of this.mappings) {
            mapping.generatedStart += shift;
            mapping.generatedEnd += shift;
        }
    }

    nodes(nodes: TmplAstNode[], scope: Set<string>, references: string[]): void {
        // References are seen by the whole template
        for (const reference of references) {
            if (!scope.has(reference)) {
                this.text += `const ${reference}: any = null as any;\n`;
                scope.add(reference);
            }
        }

        for (const node of nodes) {
            this.node(node, scope);
        }
    }

    private node(node: TmplAstNode, outer: Set<string>): void {
        const scope = new Set(outer);

        if (node instanceof TmplAstElement) {
            this.element(node, node.name, node.attributes, node.inputs);
            this.bindings(node.inputs, node.outputs, scope);
            this.block(node.children, scope);
        } else if (node instanceof TmplAstTemplate) {
            this.template(node, scope);
        } else if (node instanceof TmplAstBoundText) {
            this.statement(node.value, scope);
        } else if (node instanceof TmplAstForLoopBlock) {
            this.text += "for (const ";
            this.text += node.item.name;
            this.text += " of ";
            this.expression(node.expression, scope);
            this.text += ") {\n";
            scope.add(node.item.name);

            for (const variable of node.contextVariables) {
                this.text += `const ${variable.name}: any = null as any;\n`;
                scope.add(variable.name);
            }

            this.statement(node.trackBy, scope);
            this.nodesIn(node.children, scope);
            this.text += "}\n";

            if (node.empty) {
                this.block(node.empty.children, outer);
            }
        } else if (node instanceof TmplAstIfBlock) {
            for (const branch of node.branches) {
                const branchScope = new Set(outer);

                this.text += "{\n";

                if (branch.expression) {
                    if (branch.expressionAlias) {
                        this.text += `const ${branch.expressionAlias.name} = `;
                        this.expression(branch.expression, branchScope);
                        this.text += ";\n";
                        branchScope.add(branch.expressionAlias.name);
                    } else {
                        this.statement(branch.expression, branchScope);
                    }
                }

                this.nodesIn(branch.children, branchScope);
                this.text += "}\n";
            }
        } else if (node instanceof TmplAstSwitchBlock) {
            this.statement(node.expression, scope);

            for (const switchCase of node.cases) {
                if (switchCase.expression) {
                    this.statement(switchCase.expression, scope);
                }

                this.block(switchCase.children, scope);
            }
        } else if (node instanceof TmplAstLetDeclaration) {
            this.text += `const ${node.name} = `;
            this.expression(node.value, outer);
            this.text += ";\n";
            outer.add(node.name);
        } else {
            this.block(childrenOf(node), scope);
        }
    }

    /**
     * A structural directive, such as *ngFor and *ngIf, or an ng-template:
     * its let- variables in a block of their own.
     */
    private template(node: TmplAstTemplate, scope: Set<string>): void {
        const attribute = (name: string) => node.templateAttrs
            .find((candidate): candidate is TmplAstBoundAttribute => candidate instanceof TmplAstBoundAttribute && candidate.name === name);

        const ngForOf = attribute("ngForOf");
        const ngIf = attribute("ngIf");

        // A structural directive on an element, *ngFor on <li>, copies the
        // bindings of the element, which the element has itself
        const isInline = node.tagName !== null && node.tagName !== "ng-template";

        if (node.tagName && !isInline) {
            this.element(node, node.tagName, node.attributes, node.inputs);
        }

        for (const templateAttribute of node.templateAttrs) {
            if (templateAttribute instanceof TmplAstBoundAttribute && templateAttribute !== ngForOf && templateAttribute !== ngIf) {
                this.statement(templateAttribute.value, scope);
            }
        }

        if (!isInline) {
            this.bindings(node.inputs, node.outputs, scope);
        }

        const inner = new Set(scope);
        const item = node.variables.find(variable => variable.value === "$implicit");

        if (ngForOf && item) {
            this.text += `for (const ${item.name} of `;
            this.expression(ngForOf.value, scope);
            this.text += ") {\n";
            inner.add(item.name);
        } else {
            this.text += "{\n";
        }

        for (const variable of node.variables) {
            if (inner.has(variable.name)) {
                continue;
            }

            if (ngIf && variable.value === "ngIf") {
                // *ngIf="order$ | async as order"
                this.text += `const ${variable.name} = `;
                this.expression(ngIf.value, scope);
                this.text += ";\n";
            } else {
                this.text += `const ${variable.name}: any = null as any;\n`;
            }

            inner.add(variable.name);
        }

        if (ngIf && !node.variables.some(variable => variable.value === "ngIf")) {
            this.statement(ngIf.value, scope);
        }

        this.nodesIn(node.children, inner);
        this.text += "}\n";
    }

    /**
     * An element that is a component or directive of the target, by its
     * selectors, as a constructor call with its inputs as arguments.
     */
    private element(
        node: TmplAstElement | TmplAstTemplate,
        name: string,
        attributes: TmplAstTextAttribute[],
        inputs: TmplAstBoundAttribute[]
    ): void {
        const selector = new CssSelector();

        selector.setElement(name);

        for (const attribute of attributes) {
            selector.addAttribute(attribute.name, attribute.value);

            if (attribute.name.toLowerCase() === "class") {
                attribute.value.split(/\s+/).filter(Boolean).forEach(className => selector.addClassName(className));
            }
        }

        for (const input of inputs) {
            selector.addAttribute(input.name, "");
        }

        const matched = new Set<Component>();

        this.matcher.match(selector, (_selector, declaration) => {
            matched.add(declaration);
        });

        for (const declaration of matched) {
            this.elements.push({
                className: `${declaration.path}:${declaration.className}`,
                start: node.startSourceSpan.start.offset,
                end: node.startSourceSpan.end.offset,
                inputs: [
                    ...attributes
                        .filter(attribute => attribute.valueSpan !== undefined && attribute.name.toLowerCase() !== "class")
                        .map(attribute => ({ name: attribute.name, start: attribute.valueSpan!.start.offset, end: attribute.valueSpan!.end.offset, quoted: true })),
                    ...inputs.map(input => ({
                        name: input.name,
                        start: spanOf(input.value).start,
                        end: spanOf(input.value).end,
                        quoted: false
                    }))
                ]
            });
        }
    }

    private bindings(inputs: TmplAstBoundAttribute[], outputs: TmplAstBoundEvent[], scope: Set<string>): void {
        for (const input of inputs) {
            this.statement(input.value, scope);
        }

        for (const output of outputs) {
            const eventScope = new Set([...scope, "$event"]);

            this.text += "{\nconst $event: any = null as any;\n";

            if (output.type === ParsedEventType.TwoWay) {
                // [(value)]="query" writes the event to the target
                this.text += "(";
                this.expression(output.handler, eventScope);
                this.text += " = $event);\n";
            } else {
                this.statement(output.handler, eventScope);
            }

            this.text += "}\n";
        }
    }

    private block(nodes: TmplAstNode[], scope: Set<string>): void {
        if (nodes.length > 0) {
            this.text += "{\n";
            this.nodesIn(nodes, new Set(scope));
            this.text += "}\n";
        }
    }

    private nodesIn(nodes: TmplAstNode[], scope: Set<string>): void {
        for (const node of nodes) {
            this.node(node, scope);
        }
    }

    private statement(ast: AST, scope: Set<string>): void {
        const inner = ast instanceof ASTWithSource ? ast.ast : ast;

        if (inner instanceof EmptyExpr) {
            return;
        }

        if (inner instanceof Interpolation) {
            inner.expressions.forEach(expression => this.statement(expression, scope));
            return;
        }

        if (inner instanceof Chain) {
            inner.expressions.forEach(expression => this.statement(expression, scope));
            return;
        }

        this.expression(inner, scope);
        this.text += ";\n";
    }

    /**
     * Writes the expression as TypeScript, the names of the component as
     * members of this, and maps it to where it is in the template.
     */
    private expression(ast: AST, scope: Set<string>): void {
        if (ast instanceof ASTWithSource) {
            this.expression(ast.ast, scope);
            return;
        }

        const generatedStart = this.text.length;
        let callArguments: AST[] | undefined;
        let unknownPipe: string | undefined;

        if (ast instanceof PropertyRead || ast instanceof SafePropertyRead) {
            if (ast.receiver instanceof ImplicitReceiver && !(ast.receiver instanceof ThisReceiver)) {
                this.text += scope.has(ast.name) ? ast.name : `this.${ast.name}`;
            } else {
                this.expression(ast.receiver, scope);
                this.text += `${ast instanceof SafePropertyRead ? "?." : "."}${ast.name}`;
            }
        } else if (ast instanceof ImplicitReceiver) {
            // this.foo(), as ThisReceiver is one too
            this.text += "this";
        } else if (ast instanceof KeyedRead || ast instanceof SafeKeyedRead) {
            this.expression(ast.receiver, scope);
            this.text += ast instanceof SafeKeyedRead ? "?.[" : "[";
            this.expression(ast.key, scope);
            this.text += "]";
        } else if (ast instanceof Call || ast instanceof SafeCall) {
            this.expression(ast.receiver, scope);
            this.text += ast instanceof SafeCall ? "?.(" : "(";
            this.list(ast.args, scope);
            this.text += ")";
            callArguments = ast.args;
        } else if (ast instanceof BindingPipe) {
            const pipe = this.pipes.get(ast.name);

            if (pipe && pipe.exported) {
                this.text += `(null as unknown as ${this.pipe(pipe)}).transform(`;
            } else {
                this.text += `${ANY}(`;
                unknownPipe = ast.name;
            }

            this.list([ast.exp, ...ast.args], scope);
            this.text += ")";
            callArguments = [ast.exp, ...ast.args];
        } else if (ast instanceof LiteralPrimitive) {
            this.text += ast.value === undefined ? "undefined" : JSON.stringify(ast.value);
        } else if (ast instanceof LiteralArray) {
            this.text += "[";
            this.list(ast.expressions, scope);
            this.text += "]";
        } else if (ast instanceof LiteralMap) {
            this.text += "({";
            ast.keys.forEach((key, index) => {
                this.text += `${index > 0 ? ", " : ""}${JSON.stringify(key.key)}: `;
                this.expression(ast.values[index], scope);
            });
            this.text += "})";
        } else if (ast instanceof Unary) {
            this.text += `(${ast.operator}`;
            this.expression(ast.expr, scope);
            this.text += ")";
        } else if (ast instanceof Binary) {
            this.text += "(";
            this.expression(ast.left, scope);
            this.text += ` ${ast.operation} `;
            this.expression(ast.right, scope);
            this.text += ")";
        } else if (ast instanceof PrefixNot) {
            this.text += "(!";
            this.expression(ast.expression, scope);
            this.text += ")";
        } else if (ast instanceof TypeofExpression) {
            this.text += "(typeof ";
            this.expression(ast.expression, scope);
            this.text += ")";
        } else if (ast instanceof VoidExpression) {
            this.text += "(void ";
            this.expression(ast.expression, scope);
            this.text += ")";
        } else if (ast instanceof NonNullAssert) {
            this.expression(ast.expression, scope);
            this.text += "!";
        } else if (ast instanceof ParenthesizedExpression) {
            this.text += "(";
            this.expression(ast.expression, scope);
            this.text += ")";
        } else if (ast instanceof Conditional) {
            this.text += "(";
            this.expression(ast.condition, scope);
            this.text += " ? ";
            this.expression(ast.trueExp, scope);
            this.text += " : ";
            this.expression(ast.falseExp, scope);
            this.text += ")";
        } else if (ast instanceof TemplateLiteral) {
            this.text += "(\"\"";
            ast.expressions.forEach(expression => {
                this.text += " + ";
                this.expression(expression, scope);
            });
            this.text += ")";
        } else if (ast instanceof TaggedTemplateLiteral) {
            this.expression(ast.tag, scope);
            this.text += "(";
            this.list(ast.template.expressions, scope);
            this.text += ")";
        } else if (ast instanceof Chain) {
            this.text += "(";
            this.list(ast.expressions, scope);
            this.text += ")";
        } else {
            this.text += "undefined";
        }

        const span = spanOf(ast);

        this.mappings.push({
            generatedStart,
            generatedEnd: this.text.length,
            start: span.start,
            end: span.end,
            ...callArguments ? { arguments: callArguments.map(spanOf) } : {},
            ...unknownPipe ? { pipe: unknownPipe } : {}
        });
    }

    private list(expressions: AST[], scope: Set<string>): void {
        expressions.forEach((expression, index) => {
            if (index > 0) {
                this.text += ", ";
            }

            this.expression(expression, scope);
        });
    }

    private pipe(pipe: Declared): string {
        let alias = this.pipeImports.get(`${pipe.file}#${pipe.className}`);

        if (!alias) {
            alias = `__ngPipe${this.pipeImports.size}`;
            this.pipeImports.set(`${pipe.file}#${pipe.className}`, alias);
            this.imports.push(this.importOf(pipe, alias));
        }

        return alias;
    }

    private importOf(declaration: Declared, alias: string): string {
        let specifier = relative(dirname(this.generatedFile), declaration.file).replace(/\\/g, "/").replace(/\.tsx?$/, "");

        if (!specifier.startsWith(".")) {
            specifier = `./${specifier}`;
        }

        return declaration.exported === "default"
            ? `import ${alias} from ${JSON.stringify(specifier)};\n`
            : `import { ${declaration.className} as ${alias} } from ${JSON.stringify(specifier)};\n`;
    }
}

function spanOf(ast: AST): { start: number; end: number } {
    const span = ast instanceof ASTWithSource ? ast.sourceSpan : ast.sourceSpan;

    return { start: span.start, end: span.end };
}
