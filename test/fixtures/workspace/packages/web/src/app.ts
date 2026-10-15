import { hello, Store } from "@mono/core";
import { slug } from "@mono/core/utils";
import { button } from "@/components/button";
import { lib } from "~lib";

class CachedStore extends Store {
}

export function app(): string {
    button();
    lib();
    new Store().get(slug("key"));
    new CachedStore();

    return hello("web");
}
