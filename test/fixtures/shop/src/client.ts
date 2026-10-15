export type Client = {
    (url: string): string;
    get: (url: string) => string;
    post(url: string, body: unknown): string;
    readonly baseUrl: string;
};

export type RetryingClient = Client & {
    retry(times: number): RetryingClient;
};

export type Result = { ok: true; value: string } | { ok: false };

export function use(client: RetryingClient): string {
    client.retry(2).post(client.baseUrl, {});

    return client("/") + client.get("/orders");
}

export type Hook = (request: string) => void;

export type ClientOptions = {
    retry?: (attempt: number) => number;
};

export function hooks(hook: Hook, client: Client, options: Required<ClientOptions>): void {
    const local: Client = client;

    hook("/orders");
    local("/");
    options.retry(1);
    notify("/");
}

export const notify: Hook = request => {
    console.log(request);
};
