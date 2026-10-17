import { CREATED, Channels, MUTABLE, TOPICS, Topic, changing } from "./topics";
import * as topics from "./topics";

function Listener(topic: string, group?: string): (target: unknown, context: unknown) => void {
    return () => { };
}

function publish(topic: string, event: unknown): void { }

export class Publisher {
    @Listener(topics.CREATED, `${topics.PREFIX}billing`)
    send(event: unknown, other: string): void {
        publish(CREATED, event);
        publish(Topic.Created, event);
        publish(TOPICS.created, event);
        publish(Channels.ORDERS, event);
        publish(MUTABLE.created, event);
        publish(changing, event);
        publish(`orders.${other}`, event);
    }
}
