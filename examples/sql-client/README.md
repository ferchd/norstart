# SQL client with a static extension

From this directory, run:

```sh
bun ../../src/cli/main.ts check
bun ../../src/cli/main.ts build
bun dist/main.js
```

The SQLite connection uses the `[sql]` table in `framework.toml`. Set `NORSTAR_DATABASE_URL` to a SQLite URL to override the in-memory default. The TOML file is imported and bundled as data; environment values are resolved when the configuration provider is instantiated at runtime. Credentials should come from environment variables instead of bundled configuration.

A discovered service receives `SqlClient` through the existing container and executes a read transaction against SQLite's schema table. The extension connects before profile startup and closes the client after profiles stop. Static configuration and providers remain usable after source files and TOML are removed from the deployed artifact.
