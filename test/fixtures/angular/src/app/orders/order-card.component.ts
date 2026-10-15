import { Component, EventEmitter, Input, Output } from "@angular/core";
import { Order } from "./order";

@Component({
    selector: "app-order-card",
    template: `<div (click)="open()">{{ label }}: {{ order.id }}</div>`
})
export class OrderCardComponent {
    @Input() order!: Order;
    @Input() label = "";
    @Output() opened = new EventEmitter<Order>();

    open(): void {
        this.opened.emit(this.order);
    }
}
