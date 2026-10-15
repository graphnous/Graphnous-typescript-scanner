import { format } from "@shared/format";

export function hello(name: string): string {
    return format(name);
}

export class Store {
    get(key: string): string {
        return key;
    }
}
