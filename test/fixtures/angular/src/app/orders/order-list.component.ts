import { Component } from "@angular/core";
import { Order } from "./order";
import { OrdersService } from "./orders.service";

@Component({
    selector: "app-order-list",
    templateUrl: "./order-list.component.html"
})
export class OrderListComponent {
    orders: Order[] = [];
    selected?: Order;
    query = "";

    constructor(readonly service: OrdersService) {
    }

    select(order: Order): void {
        this.selected = order;
    }

    refresh(): void {
    }
}
