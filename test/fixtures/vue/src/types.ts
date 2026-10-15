export interface Customer {
    name: string;
}

export interface Order {
    id: string;
    total: number;
    customer: Customer;
}
