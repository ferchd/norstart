import { expect, test } from "bun:test";
import { Application } from "../../src/core/application.ts";
import { parseConfiguration } from "../../src/core/configuration.ts";
import { createManifest } from "../../src/core/manifest.ts";
import type { CompiledApplicationDefinition } from "../../src/core/compiled-application.ts";

test("runs a compiled application without loading configuration or service modules", async () => {
	const config = parseConfiguration(
		'[application]\nserviceModules = ["missing.ts"]\n[profiles.job]\ntype = "compiled-job"',
	);
	const token = Symbol("compiled-service");
	let profileCreations = 0;
	let serviceCreations = 0;
	const definition: CompiledApplicationDefinition = {
		config,
		manifest: createManifest(config),
		registerServices: (services) => {
			services.register(
				token,
				() => {
					serviceCreations++;

					return "compiled value";
				},
				"singleton",
			);
		},
	};
	const application = Application.configure({
		compiled: definition,
		drivers: [
			{
				type: "compiled-job",
				create: (context) => {
					profileCreations++;
					expect(context.services.get(token)).toBe("compiled value");

					return {
						mode: "finite",
						finished: Promise.resolve(),
						start: () => undefined,
						stop: () => undefined,
					};
				},
			},
		],
	}).create();
	expect(profileCreations).toBe(0);
	expect(serviceCreations).toBe(0);
	expect((await application.run()).status).toBe("completed");
	expect(profileCreations).toBe(1);
	expect(serviceCreations).toBe(1);
	expect(() =>
		Application.configure({ compiled: definition, configPath: "override.toml" }).create(),
	).toThrow("cannot override");
});
