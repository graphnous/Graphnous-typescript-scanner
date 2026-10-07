import { Order } from "./orders";

test("adds an item", () => {
    new Order("1").add("book");
});
