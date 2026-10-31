# Norstar HTTP demo

This example starts the built-in HTTP profile from `framework.toml`, discovers services from the configured service module, and serves routes from a separate module.

Run it from the repository root:

```sh
bun run examples/http-demo/main.ts
```

The server listens on `127.0.0.1:3000` by default. Try `GET /health`, `GET /users/42`, and `POST /echo` with a JSON body.

Route handlers can return a `Response`, a string, a JSON-serializable value, or `undefined` for an empty response. Exported classes with `static norstarService` metadata are discovered from `application.serviceModules`; constructor dependencies are listed in its `inject` array. Controller instances use a request scope and are disposed after the response body completes or is cancelled. The framework handles `SIGINT` and `SIGTERM` and drains active requests during shutdown.

Run the local throughput comparison with:

```sh
bun run benchmark:http
```

The benchmark compares Bun's native route table with the Norstar HTTP profile across route-count and concurrency scenarios. It reports requests per second, p50/p95/p99 latency, and a process memory snapshot. Results are machine-specific diagnostics, not cross-machine performance claims. Configure `BENCHMARK_ITERATIONS`, `BENCHMARK_ROUTE_COUNTS`, and `BENCHMARK_CONCURRENCY` to adjust the workload.
