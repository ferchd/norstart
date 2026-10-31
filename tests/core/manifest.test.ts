import { describe, expect, test } from "bun:test";
import type { ProfileDriver } from "../../src/core/contracts.ts";
import { parseConfiguration } from "../../src/core/configuration.ts";
import { createManifest, ProfileRegistry } from "../../src/core/manifest.ts";

describe("Manifest and profile registry", () => {
	test("creates an immutable manifest with a configurable framework version", () => {
		const configuration = parseConfiguration(
			'[profiles.api]\ntype = "http-server"\n[profiles.worker]\ntype = "worker"',
		);
		const manifest = createManifest(configuration, "2.0.0");

		expect(manifest.frameworkVersion).toBe("2.0.0");
		expect(manifest.schemaVersion).toBe(2);
		expect(manifest.serviceModules).toEqual([]);
		expect(manifest.profiles.map(({ id }) => id)).toEqual(["api", "worker"]);
		expect(Object.isFrozen(manifest)).toBe(true);
		expect(Object.isFrozen(manifest.profiles)).toBe(true);
		expect(Object.isFrozen(manifest.serviceModules)).toBe(true);
	});

	test("compiles configured service modules into the application manifest", () => {
		const configuration = parseConfiguration(
			'[application]\nserviceModules = ["src/services.ts"]\n[profiles.worker]\ntype = "worker"',
		);
		const manifest = createManifest(configuration);

		expect(manifest.serviceModules).toEqual(["src/services.ts"]);
	});

	test("resolves drivers and rejects duplicate or missing driver types", () => {
		const first: ProfileDriver = {
			type: "worker",
			create: () => {
				throw new Error("unused");
			},
		};
		const registry = new ProfileRegistry([first]);

		expect(registry.get("worker")).toBe(first);
		expect(() => new ProfileRegistry([first, first])).toThrow("Duplicate profile driver");
		expect(() => registry.get("http-server")).toThrow(
			'No profile driver registered for type "http-server"',
		);
	});
});
