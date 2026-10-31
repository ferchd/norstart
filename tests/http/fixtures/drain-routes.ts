import { Route } from "norstar/http";
import { RequestState } from "./controllers.ts";
import { holdDrainResponse } from "./drain-control.ts";

Route.get("/drain", async ({ services }) => {
	services.get(RequestState);

	return await holdDrainResponse();
});
