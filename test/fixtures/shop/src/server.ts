import { createService, DEFAULT_STATUS, Order, OrderService, Status } from "./orders";
import { log } from "./logging";

const service = createService({ find: () => undefined, save: order => log(order.id) });

export const services = [OrderService];

if (OrderService.count === 0) {
    log("starting");
}

process.on("exit", () => service.open(DEFAULT_STATUS as string));

customElements.define("order-view", class extends HTMLElement {});

export default () => new Order("1", Status.OPEN);
