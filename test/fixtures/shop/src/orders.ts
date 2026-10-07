import { log } from "./logging";

export enum Status {
    OPEN = "open",
    CLOSED = "closed"
}

export interface Repository<T> {
    find(id: string): T | undefined;
    save(entity: T): void;
}

export type OrderId = string;

export class Order {
    private items: string[] = [];

    constructor(readonly id: OrderId, public status: Status = Status.OPEN) {
    }

    get total(): number {
        return this.items.length;
    }

    set total(value: number) {
        this.items.length = value;
    }

    add(item: string): void {
        this.items.push(item);
    }
}

function service(name: string) {
    return (target: unknown) => target;
}

@service("orders")
export class OrderService {
    static count = 0;

    constructor(private readonly repository: Repository<Order>) {
    }

    open(id: string): Order;
    open(id: number): Order;
    async open(id: string | number): Promise<Order> {
        OrderService.count++;

        const order: Order = this.repository.find(String(id)) ?? new Order(String(id));

        if (order.status === Status.CLOSED) {
            log("closed");
        }

        this.repository.save(order);

        return order;
    }

    close = (order: Order) => {
        order.status = Status.CLOSED;
        [order].forEach(this.notify);
    };

    private notify(order: Order): void {
        class Notification {
            constructor(readonly order: Order) {
            }
        }

        new Notification(order);
    }
}

export const createService = (repository: Repository<Order>): OrderService => new OrderService(repository);

export const DEFAULT_STATUS = Status.OPEN, { MAX_ITEMS, MIN_ITEMS } = { MAX_ITEMS: 10, MIN_ITEMS: 1 };
