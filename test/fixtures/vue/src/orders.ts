import type { Order } from "./types";

export function formatTotal(order: Order): string {
    return `${order.total}`;
}
