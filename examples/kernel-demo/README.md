# Kernel lifecycle example

This directory contains a runnable example kept separate from the framework implementation in `src/`.

From the repository root, run:

```sh
bun install
bun run start
```

The app starts one persistent fake profile and one finite fake profile. The finite profile completes while the app stays up; press `Ctrl+C` to request an orderly shutdown.

The `framework.toml` file configures the example. Its fake profile drivers demonstrate the public `ProfileDriver` contract without adding demonstration code to the framework core.
