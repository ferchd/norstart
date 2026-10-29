import { fileURLToPath } from "node:url";
import { Application } from "../../src/core/index.ts";
import { fakeProfileDrivers } from "./fake-profiles.ts";

const configPath = fileURLToPath(new URL("./framework.toml", import.meta.url));
const application = Application.configure({ configPath, drivers: fakeProfileDrivers }).create();
const run = application.run();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void application.stop("signal");
	});
}

const result = await run;
if (result.status === "failed") {
	process.exitCode = result.exitCode;
}
