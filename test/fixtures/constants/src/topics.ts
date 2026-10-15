export const PREFIX = "orders.";
export const CREATED = PREFIX + "created";
export const VERSIONED = `${CREATED}.v${2}`;
export const PARTITIONS = 3 * (2 + 1);
export const ENABLED = !false;
export const CHOSEN = ENABLED ? "on" : "off";

export let changing = "orders";
export const READ = process.env.TOPIC;
export const DERIVED = PREFIX + READ;
export const A: string = B + "";
export const B: string = A + "";

export const API_KEY = "abc";
export const HEADER = "X-" + API_KEY;
export const DATABASE = "postgresql://app:hunter2@db/orders";
export const ROUTING_KEY = "orders.created";

export enum Topic {
    Created = "orders.created",
    Deleted = "orders.deleted"
}

export const TOPICS = {
    created: "orders.created"
} as const;

export const MUTABLE = {
    created: "orders.created"
};

export class Channels {
    static readonly ORDERS = PREFIX + "all";
    readonly name = "orders";
    notReadonly = "orders";
}
