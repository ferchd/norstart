import { fileURLToPath } from "node:url";
import { Application } from "../../src/core/index.ts";
import type { ApplicationExtension, ProfileDriver } from "../../src/core/index.ts";

const MESSAGE = Symbol("message");
const resource: ApplicationExtension = {
	name: "resource",
	register(services) {
		services.register(MESSAGE, () => "hello from an extension", "singleton");
	},
	initialize() {
		console.log("resource initialized");
	},
	shutdown() {
		console.log("resource closed");
	},
};
const observer: ApplicationExtension = {
	name: "observer",
	dependencies: ["resource"],
	initialize({ services }) {
		console.log(services.get<string>(MESSAGE));
	},
	shutdown() {
		console.log("observer closed");
	},
};
const driver: ProfileDriver = {
	type: "job",
	create() {
		return {
			mode: "finite",
			finished: Promise.resolve(),
			start() {
				console.log("job started");
			},
			stop() {
				console.log("job stopped");
			},
		};
	},
};

await Application.configure({
	configPath: fileURLToPath(new URL("./framework.toml", import.meta.url)),
	extensions: [observer, resource],
	drivers: [driver],
})
	.create()
	.run();
