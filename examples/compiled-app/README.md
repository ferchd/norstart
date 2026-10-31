# Compiled application

From this directory, run:

```sh
bun ../../src/cli/main.ts check
bun ../../src/cli/main.ts build
bun dist/main.js
```

Open `http://127.0.0.1:3000/`. Stop with Ctrl+C. The production bundle includes the validated configuration, static service registrations, and route modules. It can run without the source tree or TOML configuration.

Use `bun ../../src/cli/main.ts dev` to compile and watch during development. Exported classes in `src/**/*.service.ts` and `src/**/*.controller.ts` are discovered automatically; constructor class types identify dependencies. Controllers default to scoped lifetime and services to transient lifetime. Static `norstarService` metadata can set explicit lifetimes, injection tokens, and token aliases.
