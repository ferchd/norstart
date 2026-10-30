import { Route } from "norstar/http";
import { UserController } from "../user-controller.ts";

Route.get("/health", () => ({ status: "ok" }));

Route.get("/users/:id", [UserController, "show"]);

Route.post("/echo", async ({ request }) => request.json());
