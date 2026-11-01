# Extensions demo

Run `bun run examples/extensions-demo/main.ts` from the repository root.

The resource extension registers a service in the application container. The observer depends on it, so initialization follows dependency order even though the options list the observer first. The finite profile completes, profiles stop, extensions close in reverse order, and the container disposes services.
