import { Application, Container } from "norstar";
import { fileURLToPath } from "node:url";
import { UserController, UserStore } from "./user-controller.ts";

const configPath = fileURLToPath(new URL("./framework.toml", import.meta.url));
const application = Application.configure({
	configPath,
	configureServices: (services: Container) => {
		services.register(UserStore, () => new UserStore(), "scoped");
		services.register(
			UserController,
			(resolver) => new UserController(resolver.get(UserStore)),
			"scoped",
		);
	},
}).create();

const running = application.run();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void application.stop("signal");
	});
}

const result = await running;
if (result.status === "failed") {
	process.exitCode = result.exitCode;
}
