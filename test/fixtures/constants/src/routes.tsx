import { CREATED } from "./topics";

function Route(props: { path: string; title: string; exact?: boolean }): null {
    return null;
}

export function Routes(): unknown {
    return <Route path={`/${CREATED}`} title="Orders" exact />;
}
