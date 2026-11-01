# Static extension providers

From this directory, run:

```sh
bun run ../../src/cli/main.ts check
bun run ../../src/cli/main.ts build
bun dist/main.js
```

The compiler reads the extension metadata declared in `framework.toml` and validates the discovered `Greeting` service against its `Clock` provider. It does not evaluate extension modules or execute registration hooks during checking or compilation. The compiled application initializes the extension, runs a finite profile, then shuts down the extension and disposes the shared singleton.

The entry point supplies only the demonstration profile driver. Extension lifecycle hooks and captured provider metadata come from the compiled manifest.
