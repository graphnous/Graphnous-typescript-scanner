import {
    type AttributeNode,
    type DirectiveNode,
    type ElementNode,
    ElementTypes,
    NodeTypes,
    parse,
    type RootNode,
    type SimpleExpressionNode,
    type TemplateChildNode
} from "@vue/compiler-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript-api";
import type { Mapping, TemplateCheck } from "./angular-templates.js";

/**
 * A Vue single-file component, as the TypeScript the program checks.
 */
export interface VueComponent {
    /** The file, relative to the target. */
    path: string;
    /**
     * The generated file: the .vue file with all but its scripts blanked
     * out, so its offsets are those of the .vue file, then the template as
     * a function, and for <script setup> the component as its default
     * export.
     */
    generatedFile: string;
    generatedText: string;
    /** Where the generated code after the .vue file starts. */
    generatedFrom: number;
    /** The name of the declaration the component is the default export of, when generated. */
    component?: string;
    /** The <template> block, to locate the component at. */
    template?: { start: number; end: number };
    check?: TemplateCheck;
}

const FUNCTION = "__vueTemplate";

const COMPONENT = "__vueComponent";

/** Names templates see without declaring them, as Vue allows. */
const GLOBALS = new Set([
    "Infinity", "undefined", "NaN", "isFinite", "isNaN", "parseFloat", "parseInt", "decodeURI", "decodeURIComponent",
    "encodeURI", "encodeURIComponent", "Math", "Number", "Date", "Array", "Object", "Boolean", "String", "RegExp",
    "Map", "Set", "JSON", "Intl", "BigInt", "console", "Error", "Symbol", "true", "false", "null", "this"
]);

/**
 * The Vue single-file components of the target: their scripts as
 * TypeScript at their places in the .vue file, and their templates as
 * generated TypeScript in the same module, so the template sees the
 * top-level names of <script setup> as Vue's compiler gives them to it:
 *
 * - bindings, events and interpolations as the expressions they are, the
 *   props of defineProps<T>() as properties of a T;
 * - v-for as for of loops, so their items are typed, and slot props as
 *   constants;
 * - v-model as a read and a write;
 * - elements that are components the script imports or declares as calls
 *   of them, with their props as named arguments.
 */
export function vueComponents(targetPath: string, paths: string[]): VueComponent[] {
    const components: VueComponent[] = [];

    for (const path of paths) {
        if (!path.endsWith(".vue")) {
            continue;
        }

        const file = join(targetPath, path);

        try {
            components.push(component(path, file, readFileSync(file, "utf8")));
        } catch {
            // A component that cannot be parsed is listed without declarations
        }
    }

    return components;
}

function component(path: string, file: string, text: string): VueComponent {
    const root: RootNode = parse(text, { parseMode: "sfc", onError: () => {} });
    const blocks = root.children.filter((node): node is ElementNode => node.type === NodeTypes.ELEMENT);

    const scripts = blocks.filter(block => block.tag === "script");
    const template = blocks.find(block => block.tag === "template"
        && !block.props.some(prop => prop.type === NodeTypes.ATTRIBUTE && prop.name === "lang" && prop.value?.content !== "html"));

    // The .vue file with all but the contents of its scripts as spaces
    const kept = new Array<boolean>(text.length).fill(false);

    for (const script of scripts) {
        const content = script.children[0];

        if (content) {
            for (let index = content.loc.start.offset; index < content.loc.end.offset; index++) {
                kept[index] = true;
            }
        }
    }

    let generatedText = "";

    for (let index = 0; index < text.length; index++) {
        generatedText += kept[index] || text[index] === "\n" || text[index] === "\r" ? text[index] : " ";
    }

    const scriptText = scripts.map(script => script.children[0]?.loc.source ?? "").join("\n");
    const scriptFile = ts.createSourceFile(`${file}.ts`, scriptText, ts.ScriptTarget.Latest, true);
    const bindings = topLevelNames(scriptFile);
    const hasDefault = scriptFile.statements.some(statement => ts.isExportAssignment(statement) && !statement.isExportEquals);

    const generatedFrom = generatedText.length;
    const result: VueComponent = { path, generatedFile: `${file}.ts`, generatedText, generatedFrom };

    generatedText += "\n;\n";

    // <script setup>, or a component of only a template, has no default
    // export: the component is one
    if (!hasDefault) {
        generatedText += `declare const ${COMPONENT}: any;\nexport default ${COMPONENT};\n`;
        result.component = COMPONENT;
    }

    if (template) {
        result.template = { start: template.loc.start.offset, end: template.loc.end.offset };

        const generator = new Generator(text, generatedText.length, bindings);

        generator.declarations(propsType(scriptFile));
        generator.children(template.children, new Set());
        generator.end();

        generatedText += generator.text;

        result.check = {
            className: `${path.replace(/\.vue$/, "")}:default`,
            generatedFile: `${file}.ts`,
            generatedText,
            functionName: FUNCTION,
            template: { text, path, offset: 0, external: false },
            mappings: generator.mappings,
            elements: []
        };
    }

    result.generatedText = generatedText;

    return result;
}

/**
 * The names the scripts declare at their top level, which the template
 * sees: imports, variables, functions, classes and enums.
 */
function topLevelNames(sourceFile: ts.SourceFile): Set<string> {
    const names = new Set<string>();

    const bind = (name: ts.BindingName) => {
        if (ts.isIdentifier(name)) {
            names.add(name.text);
        } else {
            name.elements.forEach(element => {
                if (!ts.isOmittedExpression(element)) {
                    bind(element.name);
                }
            });
        }
    };

    for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement) && statement.importClause) {
            const clause = statement.importClause;

            if (clause.name) {
                names.add(clause.name.text);
            }

            if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
                names.add(clause.namedBindings.name.text);
            } else if (clause.namedBindings) {
                clause.namedBindings.elements.forEach(element => names.add(element.name.text));
            }
        } else if (ts.isVariableStatement(statement)) {
            statement.declarationList.declarations.forEach(declaration => bind(declaration.name));
        } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement))
            && statement.name) {
            names.add(statement.name.text);
        }
    }

    return names;
}

/**
 * The type of the props of defineProps<T>(), also in withDefaults, as
 * written.
 */
function propsType(sourceFile: ts.SourceFile): string | undefined {
    let type: string | undefined;

    const visit = (node: ts.Node) => {
        if (type === undefined && ts.isCallExpression(node) && ts.isIdentifier(node.expression)
            && node.expression.text === "defineProps" && node.typeArguments?.length === 1) {
            type = node.typeArguments[0].getText(sourceFile);
        }

        ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    return type;
}

/**
 * A part of the generated code copied from the .vue file.
 */
interface Segment {
    generatedStart: number;
    generatedEnd: number;
    start: number;
}

class Generator {

    text = "";

    readonly mappings: Mapping[] = [];

    constructor(
        /** The .vue file. */
        private readonly source: string,
        /** Where the generated code starts in the generated file. */
        private readonly base: number,
        private readonly bindings: Set<string>
    ) {
    }

    declarations(propsType: string | undefined): void {
        this.text += "declare const __vueAny: any;\n";
        this.text += `declare const __vueProps: ${propsType ?? "any"};\n`;
        this.text += "declare function __vueList<T>(source: readonly T[] | Iterable<T> | null | undefined): T[];\n";
        this.text += "declare function __vueList(source: any): any[];\n";
        this.text += `function ${FUNCTION}() {\n`;
    }

    end(): void {
        this.text += "}\n";
    }

    children(nodes: TemplateChildNode[], scope: Set<string>): void {
        for (const node of nodes) {
            if (node.type === NodeTypes.ELEMENT) {
                this.element(node, scope);
            } else if (node.type === NodeTypes.INTERPOLATION && node.content.type === NodeTypes.SIMPLE_EXPRESSION) {
                this.statement(node.content, scope);
            }
        }
    }

    private element(element: ElementNode, outer: Set<string>): void {
        const directives = element.props.filter((prop): prop is DirectiveNode => prop.type === NodeTypes.DIRECTIVE);
        const scope = new Set(outer);
        let opened = 0;

        const loop = directives.find(directive => directive.name === "for");

        if (loop?.exp && loop.exp.type === NodeTypes.SIMPLE_EXPRESSION) {
            opened += this.loop(loop.exp, scope);
        }

        for (const directive of directives) {
            const expression = directive.exp?.type === NodeTypes.SIMPLE_EXPRESSION ? directive.exp : undefined;

            if (directive === loop || !expression || directive.name === "slot") {
                continue;
            }

            if (directive.name === "on") {
                this.handler(expression, scope);
            } else if (directive.name === "model") {
                this.statement(expression, scope);
                this.assignment(expression, scope);
            } else {
                this.statement(expression, scope);
            }
        }

        if (element.tagType === ElementTypes.COMPONENT) {
            this.component(element, scope);
        }

        // Slot props: #default="{ item }"
        const slot = directives.find(directive => directive.name === "slot");

        if (slot?.exp && slot.exp.type === NodeTypes.SIMPLE_EXPRESSION) {
            this.text += `{\nconst ${slot.exp.content}: any = null as any;\n`;
            parameterNames(slot.exp.content).forEach(name => scope.add(name));
            opened++;
        }

        this.children(element.children, scope);
        this.text += "}\n".repeat(opened);
    }

    /**
     * v-for="(item, index) in items" as for (const item of items), so its
     * item is typed; returns the blocks it opens.
     */
    private loop(expression: SimpleExpressionNode, scope: Set<string>): number {
        const match = /^\s*(\(([\s\S]*)\)|[\s\S]*?)\s+(in|of)\s+([\s\S]+?)\s*$/.exec(expression.content);

        if (!match) {
            return 0;
        }

        const aliases = splitParameters(match[2] ?? match[1]);
        const sourceOffset = expression.content.lastIndexOf(match[4]);

        this.text += "for (const ";
        this.text += aliases[0] ?? "__vueItem";
        this.text += " of __vueList(";
        this.expression(match[4], expression.loc.start.offset + sourceOffset, scope);
        this.text += ")) {\n";

        aliases.forEach((alias, index) => {
            if (index > 0) {
                this.text += `const ${alias}: any = null as any;\n`;
            }

            parameterNames(alias).forEach(name => scope.add(name));
        });

        return 1;
    }

    /**
     * An element that is a component the script imports or declares, as a
     * call of it with its props as named arguments.
     */
    private component(element: ElementNode, scope: Set<string>): void {
        const name = [element.tag, pascalCase(element.tag)].find(candidate => this.bindings.has(candidate) && !scope.has(candidate));

        if (!name) {
            return;
        }

        const generatedStart = this.text.length;
        const argumentSpans: { start: number; end: number }[] = [];
        const argumentNames: string[] = [];

        this.text += `${name}(`;

        element.props.forEach(prop => {
            const named = this.prop(prop);

            if (!named) {
                return;
            }

            if (argumentSpans.length > 0) {
                this.text += ", ";
            }

            argumentSpans.push({ start: named.start, end: named.end });
            argumentNames.push(named.name);
            this.text += named.expression ? "(null as any)" : JSON.stringify(named.value);
        });

        this.text += ");\n";

        const start = element.loc.start.offset;
        const tagEnd = this.source.indexOf(">", element.props.reduce((end, prop) => Math.max(end, prop.loc.end.offset), start + element.tag.length));

        this.mappings.push({
            generatedStart: this.base + generatedStart,
            generatedEnd: this.base + this.text.length - 2,
            start,
            end: tagEnd < 0 ? element.loc.end.offset : tagEnd + 1,
            arguments: argumentSpans,
            argumentNames
        });
    }

    /** A prop of a component as a named argument, by the span of its value. */
    private prop(prop: AttributeNode | DirectiveNode): { name: string; start: number; end: number; value?: string; expression: boolean } | undefined {
        if (prop.type === NodeTypes.ATTRIBUTE && (prop.name === "key" || prop.name === "ref")) {
            return undefined;
        }

        if (prop.type === NodeTypes.ATTRIBUTE) {
            return prop.value
                ? { name: prop.name, start: prop.value.loc.start.offset, end: prop.value.loc.end.offset, value: prop.value.content, expression: false }
                : { name: prop.name, start: prop.loc.start.offset, end: prop.loc.end.offset, value: "true", expression: false };
        }

        const expression = prop.exp?.type === NodeTypes.SIMPLE_EXPRESSION ? prop.exp : undefined;
        const argument = prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION ? prop.arg.content : undefined;

        if (!expression || !["bind", "on", "model"].includes(prop.name)) {
            return undefined;
        }

        // Vue's own, not props of the component
        if (prop.name === "bind" && (argument === "key" || argument === "ref")) {
            return undefined;
        }

        const name = prop.name === "bind" ? argument : prop.name === "on" ? `@${argument}` : `v-model${argument ? `:${argument}` : ""}`;

        return name === undefined
            ? undefined
            : { name, start: expression.loc.start.offset, end: expression.loc.end.offset, expression: true };
    }

    /**
     * An event handler: a method, as a reference to it, or statements with
     * $event.
     */
    private handler(expression: SimpleExpressionNode, scope: Set<string>): void {
        this.text += "{\nconst $event: any = null as any;\n";

        const inner = new Set([...scope, "$event"]);

        if (/^\s*[A-Za-z_$][\w$]*(\s*\.\s*[A-Za-z_$][\w$]*)*\s*$/.test(expression.content)) {
            this.statement(expression, inner);
        } else {
            this.code(expression.content, expression.loc.start.offset, inner, false);
        }

        this.text += "}\n";
    }

    /** v-model="query" writes query. */
    private assignment(expression: SimpleExpressionNode, scope: Set<string>): void {
        this.code(expression.content, expression.loc.start.offset, scope, false);
        this.text += " = null as any;\n";
    }

    private statement(expression: SimpleExpressionNode, scope: Set<string>): void {
        this.expression(expression.content, expression.loc.start.offset, scope);
        this.text += ";\n";
    }

    private expression(code: string, offset: number, scope: Set<string>): void {
        this.code(code, offset, scope, true);
    }

    /**
     * Writes the code of the template, an expression in parentheses, its
     * names that the script does not declare as props, and maps the calls,
     * accesses and names in it to where they are in the .vue file.
     */
    private code(code: string, offset: number, scope: Set<string>, isExpression: boolean): void {
        const wrapped = isExpression ? `(${code})` : code;
        const shift = isExpression ? 1 : 0;
        const parsed = ts.createSourceFile("template.ts", wrapped, ts.ScriptTarget.Latest, true);
        const locals = new Set(scope);

        // Parameters of arrow functions in the code
        const collect = (node: ts.Node) => {
            if (ts.isParameter(node)) {
                parameterNames(node.name.getText(parsed)).forEach(name => locals.add(name));
            }

            ts.forEachChild(node, collect);
        };

        collect(parsed);

        const edits: { at: number; end: number; text: string }[] = [];

        const visit = (node: ts.Node) => {
            if (ts.isTypeNode(node)) {
                return;
            }

            if (ts.isShorthandPropertyAssignment(node) && this.isFree(node.name.text, locals)) {
                edits.push({ at: node.name.getStart(parsed), end: node.name.getStart(parsed), text: `${node.name.text}: ${this.prefix(node.name.text)}` });
            } else if (ts.isIdentifier(node) && isReference(node) && this.isFree(node.text, locals)) {
                edits.push({ at: node.getStart(parsed), end: node.getStart(parsed), text: this.prefix(node.text) });
            }

            ts.forEachChild(node, visit);
        };

        visit(parsed);
        edits.sort((left, right) => left.at - right.at);

        // Copies the code, inserting the edits, and keeps where each copied
        // part came from
        const segments: Segment[] = [];
        const generatedBase = this.base + this.text.length;
        let generated = "";
        let position = 0;

        for (const edit of [...edits, { at: wrapped.length, end: wrapped.length, text: "" }]) {
            if (edit.at > position) {
                segments.push({
                    generatedStart: generatedBase + generated.length,
                    generatedEnd: generatedBase + generated.length + edit.at - position,
                    start: offset + position - shift
                });
                generated += wrapped.slice(position, edit.at);
            }

            generated += edit.text;
            position = edit.end;
        }

        // An expression in its parentheses
        this.text += generated;

        const original = (at: number, isEnd: boolean) => {
            for (const segment of segments) {
                if (at >= segment.generatedStart && (isEnd ? at <= segment.generatedEnd : at < segment.generatedEnd)) {
                    return segment.start + at - segment.generatedStart;
                }
            }

            // In an inserted prefix: where the name after it is
            return segments.find(segment => segment.generatedStart > at)?.start;
        };

        // The calls, accesses and names of the generated code
        const generatedFile = ts.createSourceFile("generated.ts", generated, ts.ScriptTarget.Latest, true);

        const map = (node: ts.Node) => {
            if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isPropertyAccessExpression(node)
                || ts.isElementAccessExpression(node) || ts.isIdentifier(node)) {
                const generatedStart = generatedBase + node.getStart(generatedFile);
                const generatedEnd = generatedBase + node.getEnd();
                const start = original(generatedStart, false);
                const end = original(generatedEnd, true);

                if (start !== undefined && end !== undefined && end > start) {
                    const mapping: Mapping = { generatedStart, generatedEnd, start, end };

                    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
                        mapping.arguments = (node.arguments ?? []).flatMap(argument => {
                            const argumentStart = original(generatedBase + argument.getStart(generatedFile), false);
                            const argumentEnd = original(generatedBase + argument.getEnd(), true);

                            return argumentStart !== undefined && argumentEnd !== undefined ? [{ start: argumentStart, end: argumentEnd }] : [];
                        });
                    }

                    this.mappings.push(mapping);
                }
            }

            ts.forEachChild(node, map);
        };

        map(generatedFile);
    }

    private isFree(name: string, locals: Set<string>): boolean {
        return !locals.has(name) && !this.bindings.has(name) && !GLOBALS.has(name);
    }

    /** What a name the script does not declare is: a prop, or for $attrs and the like nothing known. */
    private prefix(name: string): string {
        return name.startsWith("$") ? "__vueAny." : "__vueProps.";
    }
}

/**
 * Whether an identifier refers to something, rather than naming a
 * property or declaring a parameter.
 */
function isReference(node: ts.Identifier): boolean {
    const parent = node.parent;

    return !(ts.isPropertyAccessExpression(parent) && parent.name === node)
        && !(ts.isPropertyAssignment(parent) && parent.name === node)
        && !(ts.isShorthandPropertyAssignment(parent))
        && !(ts.isParameter(parent) && parent.name === node)
        && !(ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node))
        && !(ts.isVariableDeclaration(parent) && parent.name === node)
        && !(ts.isMethodDeclaration(parent) && parent.name === node)
        && !(ts.isFunctionExpression(parent) && parent.name === node);
}

/** The names a parameter declares, such as item, or id and name of { id, name }. */
function parameterNames(parameter: string): string[] {
    const parsed = ts.createSourceFile("parameter.ts", `(${parameter}) => 0`, ts.ScriptTarget.Latest, true);
    const names: string[] = [];

    const visit = (node: ts.Node) => {
        if ((ts.isParameter(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name)) {
            names.push(node.name.text);
        }

        ts.forEachChild(node, visit);
    };

    visit(parsed);

    return names;
}

/** The parameters of (item, index), each as written. */
function splitParameters(parameters: string): string[] {
    const parsed = ts.createSourceFile("parameters.ts", `(${parameters}) => 0`, ts.ScriptTarget.Latest, true);
    const arrow = (parsed.statements[0] as ts.ExpressionStatement | undefined)?.expression;

    return arrow && ts.isArrowFunction(arrow)
        ? arrow.parameters.map(parameter => parameter.getText(parsed))
        : [parameters.trim()];
}

function pascalCase(tag: string): string {
    return tag.split("-").map(part => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}
