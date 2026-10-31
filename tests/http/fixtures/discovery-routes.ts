import { Route } from "norstar/http";
import { DiscoverableController } from "./discoverable-services.ts";

Route.get("/discovery", [DiscoverableController, "show"]);
