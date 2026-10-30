# Norstar HTTP demo

This example starts the built-in HTTP profile from `framework.toml` and serves routes from a separate module.

Run it from the repository root:

```sh
bun run examples/http-demo/main.ts
```

The server listens on `127.0.0.1:3000` by default. Try `GET /health`, `GET /users/42`, and `POST /echo` with a JSON body.

Route handlers can return a `Response`, a string, a JSON-serializable value, or `undefined` for an empty response. Controller classes and their dependencies are resolved from a request scope and disposed after the response body completes or is cancelled.

Run the local throughput comparison with:

```sh
bun run examples/http-demo/benchmark.ts
```

The benchmark compares a small JSON endpoint served by Bun directly and by the Norstar HTTP profile. It is a local diagnostic, not a cross-machine performance claim. Set `BENCHMARK_ITERATIONS` to change the measured requests per server.
