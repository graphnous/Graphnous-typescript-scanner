import ts from "typescript-api";
import { holdsSecret, namesSecret } from "./secrets.js";

/**
 * The longest text of a constant that is recorded.
 */
export const MAX_CONSTANT_LENGTH = 1000;

export type ConstantValue = string | number | boolean;

/**
 * The values of constant expressions, as JavaScript computes them: of
 * literals, of the constants they refer to, and of the operators and
 * template literals that combine them, such as `orders.${EVENT}`.
 *
 * A constant is a const variable, a readonly property with an
 * initializer, or an enum member; a property of an object declared as
 * const, as in { created: "orders.created" } as const, and a declared
 * constant without an initializer, as in a package's types, are known by
 * their literal types. A constant whose name names a secret has no value
 * here, nor has an expression that uses one.
 */
export class Constants {

    /**
     * The values of the constants found, by their declarations; null for
     * none.
     */
    private readonly declared = new Map<ts.Node, ConstantValue | null>();

    constructor(private readonly checker: ts.TypeChecker) {
    }

    /**
     * The value of the expression as the scan result records it: its
     * text, when it is a constant expression of at most
     * MAX_CONSTANT_LENGTH characters that holds no secret.
     */
    text(expression: ts.Expression): string | undefined {
        return recorded(this.value(expression));
    }

    /**
     * The value of a const variable or of a readonly property with an
     * initializer, as text records it.
     */
    textOf(declaration: ts.VariableDeclaration | ts.PropertyDeclaration): string | undefined {
        return isConstantDeclaration(declaration) && ts.isIdentifier(declaration.name)
            ? recorded(this.declaredValue(declaration, new Set()))
            : undefined;
    }

    /**
     * The value of the expression, when it is a constant expression.
     */
    value(expression: ts.Expression): ConstantValue | undefined {
        return this.evaluate(expression, new Set());
    }

    /**
     * @param evaluating the declarations being evaluated, to stop at a
     *                   cycle
     */
    private evaluate(expression: ts.Expression, evaluating: Set<ts.Node>): ConstantValue | undefined {
        if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
            || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression)) {
            return this.evaluate(expression.expression, evaluating);
        }

        if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
            return expression.text;
        }

        if (ts.isNumericLiteral(expression)) {
            const value = Number(expression.text.replace(/_/g, ""));

            return Number.isNaN(value) ? undefined : value;
        }

        switch (expression.kind) {
            case ts.SyntaxKind.TrueKeyword:
                return true;
            case ts.SyntaxKind.FalseKeyword:
                return false;
        }

        if (ts.isPrefixUnaryExpression(expression)) {
            return unary(expression.operator, this.evaluate(expression.operand, evaluating));
        }

        if (ts.isTemplateExpression(expression)) {
            let value = expression.head.text;

            for (const span of expression.templateSpans) {
                const part = this.evaluate(span.expression, evaluating);

                if (part === undefined) {
                    return undefined;
                }

                value += String(part) + span.literal.text;
            }

            return value;
        }

        if (ts.isBinaryExpression(expression)) {
            const left = this.evaluate(expression.left, evaluating);
            const right = left === undefined ? undefined : this.evaluate(expression.right, evaluating);

            return left === undefined || right === undefined ? undefined : binary(expression.operatorToken.kind, left, right);
        }

        if (ts.isConditionalExpression(expression)) {
            const condition = this.evaluate(expression.condition, evaluating);

            return typeof condition === "boolean"
                ? this.evaluate(condition ? expression.whenTrue : expression.whenFalse, evaluating)
                : undefined;
        }

        if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
            return this.reference(expression, evaluating);
        }

        return undefined;
    }

    /**
     * The value of the constant a name refers to.
     */
    private reference(
        expression: ts.Identifier | ts.PropertyAccessExpression | ts.ElementAccessExpression,
        evaluating: Set<ts.Node>
    ): ConstantValue | undefined {
        const name = ts.isIdentifier(expression)
            ? expression
            : ts.isPropertyAccessExpression(expression) ? expression.name : expression.argumentExpression;

        let symbol = this.checker.getSymbolAtLocation(name);

        if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
            symbol = this.checker.getAliasedSymbol(symbol);
        }

        const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];

        if (!symbol || !declaration || namesSecret(symbol.name)) {
            return undefined;
        }

        if (ts.isEnumMember(declaration)) {
            return this.checker.getConstantValue(declaration);
        }

        if ((ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration)) && isConstantDeclaration(declaration)) {
            return declaration.initializer
                ? this.declaredValue(declaration, evaluating)
                : this.literal(expression);
        }

        if (ts.isPropertyAssignment(declaration) || ts.isShorthandPropertyAssignment(declaration) || ts.isPropertySignature(declaration)) {
            // Known when the object is declared as const, or the property readonly
            return this.literal(expression);
        }

        return undefined;
    }

    private declaredValue(
        declaration: ts.VariableDeclaration | ts.PropertyDeclaration,
        evaluating: Set<ts.Node>
    ): ConstantValue | undefined {
        const known = this.declared.get(declaration);

        if (known !== undefined) {
            return known ?? undefined;
        }

        if (!declaration.initializer || evaluating.has(declaration)
            || (ts.isIdentifier(declaration.name) && namesSecret(declaration.name.text))) {
            return undefined;
        }

        evaluating.add(declaration);

        try {
            const value = this.evaluate(declaration.initializer, evaluating);

            this.declared.set(declaration, value ?? null);

            return value;
        } finally {
            evaluating.delete(declaration);
        }
    }

    /**
     * The value of the literal type of an expression, as "orders.created"
     * for a property of an object declared as const.
     */
    private literal(expression: ts.Expression): ConstantValue | undefined {
        const type = this.checker.getTypeAtLocation(expression);

        if (type.isStringLiteral() || type.isNumberLiteral()) {
            return type.value;
        }

        if (type.flags & ts.TypeFlags.BooleanLiteral) {
            return (type as ts.Type & { intrinsicName?: string }).intrinsicName === "true";
        }

        return undefined;
    }
}

/**
 * Whether the declaration cannot be assigned again: a const variable, or
 * a readonly property.
 */
function isConstantDeclaration(declaration: ts.VariableDeclaration | ts.PropertyDeclaration): boolean {
    if (ts.isVariableDeclaration(declaration)) {
        return (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;
    }

    return ts.getModifiers(declaration)?.some(modifier => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false;
}

function recorded(value: ConstantValue | undefined): string | undefined {
    if (value === undefined) {
        return undefined;
    }

    const text = String(value);

    return text.length <= MAX_CONSTANT_LENGTH && !holdsSecret(text) ? text : undefined;
}

function unary(operator: ts.PrefixUnaryOperator, value: ConstantValue | undefined): ConstantValue | undefined {
    switch (operator) {
        case ts.SyntaxKind.MinusToken:
            return typeof value === "number" ? -value : undefined;
        case ts.SyntaxKind.PlusToken:
            return typeof value === "number" ? value : undefined;
        case ts.SyntaxKind.ExclamationToken:
            return typeof value === "boolean" ? !value : undefined;
        default:
            return undefined;
    }
}

function binary(operator: ts.SyntaxKind, left: ConstantValue, right: ConstantValue): ConstantValue | undefined {
    if (operator === ts.SyntaxKind.PlusToken && (typeof left === "string" || typeof right === "string")) {
        return String(left) + String(right);
    }

    if (typeof left === "boolean" && typeof right === "boolean") {
        switch (operator) {
            case ts.SyntaxKind.AmpersandAmpersandToken:
                return left && right;
            case ts.SyntaxKind.BarBarToken:
                return left || right;
            default:
                return undefined;
        }
    }

    if (typeof left !== "number" || typeof right !== "number") {
        return undefined;
    }

    switch (operator) {
        case ts.SyntaxKind.PlusToken:
            return left + right;
        case ts.SyntaxKind.MinusToken:
            return left - right;
        case ts.SyntaxKind.AsteriskToken:
            return left * right;
        case ts.SyntaxKind.SlashToken:
            return left / right;
        case ts.SyntaxKind.PercentToken:
            return left % right;
        case ts.SyntaxKind.AsteriskAsteriskToken:
            return left ** right;
        default:
            return undefined;
    }
}
