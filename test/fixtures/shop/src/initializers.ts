import { Status } from "./orders";
import { log } from "./logging";

export class Registry {
    static readonly DEFAULT = new Registry("default");
    static instances = 0;

    static {
        log("registry loaded");
    }

    private readonly names = new Map<string, string>();
    readonly created = Date.now();
    status = Status.OPEN;

    constructor(readonly name: string) {
        Registry.instances++;
    }
}

export class Cache {
    private readonly entries = new Map<string, string>();
}

export class Plain {
    count = 0;
}
