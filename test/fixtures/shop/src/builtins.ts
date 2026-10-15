export async function builtins(values: unknown, headers: Headers): Promise<string[]> {
    if (!Array.isArray(values) || values.length === 0) {
        throw new TypeError("No values");
    }

    console.log(Math.min(Number(values[0]), 1));
    values.push(headers.get("accept"));
    new Intl.NumberFormat("en").format(1);

    try {
        return await Promise.race([Promise.resolve(values.map(String))]);
    } catch (error) {
        return error instanceof TypeError ? [] : [...new Map<string, string>().keys()];
    }
}
