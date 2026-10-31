import { Route } from "norstar/http";
import { GreetingController } from "./greeting.controller.ts";

Route.get("/", [GreetingController, "index"]);
