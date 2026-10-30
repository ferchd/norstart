import { Route } from "norstar/http";

Route.get("/duplicate/:id", () => "first");

Route.get("/duplicate/:slug", () => "second");
