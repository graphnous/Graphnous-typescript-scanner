import type { Order } from "../../../src/orders";

export interface ButtonProps {
    label: string;
    title?: string;
    disabled?: boolean;
}

export function Button({ label }: ButtonProps) {
    return <button>{label}</button>;
}

export function OrderButton(props: { order: Order }) {
    return <Button label={props.order.id} />;
}

export function ClosedButton(props: ButtonProps) {
    return <Button {...props} title="Closed" disabled />;
}
