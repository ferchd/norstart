import { HttpError, Route } from "norstar/http";
import { FixtureController, RequestState } from "./controllers.ts";

Route.get("/json/:id", ({ params }) => ({ id: params.id }));

Route.get("/priority/:id", () => ({ route: "parameter" }));

Route.get("/priority/new", () => ({ route: "static" }));

Route.get("/text", () => "plain response");

Route.get("/empty", () => undefined);

Route.get("/scope-ownership", ({ services }) => ({ canDispose: "dispose" in services }));

Route.get("/explicit", () => new Response("accepted", { status: 202 }));

Route.get("/locked", () => {
	const response = new Response("locked body");
	response.body?.getReader();

	return response;
});

Route.get(
	"/stream",
	() =>
		new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("streamed response"));
					controller.close();
				},
			}),
		),
);

Route.get(
	"/cancel-stream",
	() =>
		new Response(
			new ReadableStream<Uint8Array>({
				pull() {
					return new Promise<void>(() => {});
				},
			}),
		),
);

Route.get("/controller/:id", [FixtureController, "show"]);

Route.get("/http-error", ({ services }) => {
	services.get(RequestState);

	throw new HttpError(418, "short and stout");
});

Route.get("/server-error", () => {
	throw new HttpError(500, "secret server detail");
});

Route.get("/public-server-error", () => {
	throw new HttpError(503, "Temporarily unavailable", { expose: true });
});

Route.get("/unexpected-error", ({ services }) => {
	services.get(RequestState);

	throw new Error("secret implementation detail");
});

Route.post("/echo", async ({ request }) => {
	return await request.json();
});
