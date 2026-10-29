import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	loadConfiguration,
	loadConfigurationSync,
	parseConfiguration,
} from "../../src/core/configuration.ts";
import { withTemporaryDirectory } from "./helpers.ts";

describe("Configuration", () => {
	test("parses and freezes application and profile configuration", () => {
		const configuration = parseConfiguration(
			'[application]\nname = "norstar"\n[profiles.api]\ntype = "http-server"\nport = 3000',
		);

		expect(configuration.application.name).toBe("norstar");
		expect(configuration.profiles.api?.type).toBe("http-server");
		expect(configuration.profiles.api?.config).toEqual({ port: 3000 });
		expect(Object.isFrozen(configuration)).toBe(true);
		expect(Object.isFrozen(configuration.profiles)).toBe(true);
		expect(Object.isFrozen(configuration.profiles.api?.config)).toBe(true);
	});

	test("uses an empty application table when omitted", () => {
		const configuration = parseConfiguration('[profiles.job]\ntype = "worker"');

		expect(configuration.application.name).toBeUndefined();
	});

	test("rejects malformed TOML and invalid application tables", () => {
		expect(() => parseConfiguration("[broken")).toThrow("not valid TOML");
		expect(() =>
			parseConfiguration('application = "invalid"\n[profiles.job]\ntype = "worker"'),
		).toThrow("[application] must be a table");
	});

	test("rejects missing, empty, and malformed profiles", () => {
		expect(() => parseConfiguration('[application]\nname = "missing"')).toThrow(
			"at least one [profiles.<name>] table",
		);
		expect(() => parseConfiguration("profiles = {}")).toThrow(
			"at least one [profiles.<name>] table",
		);
		expect(() => parseConfiguration('[profiles]\njob = "not-a-table"')).toThrow(
			"[profiles.job] must be a table",
		);
		expect(() => parseConfiguration('[profiles.job]\ntype = ""')).toThrow(
			"type must be a non-empty string",
		);
	});

	test("loads TOML from a file through both async and sync APIs", async () => {
		await withTemporaryDirectory(async (directory) => {
			const path = join(directory, "framework.toml");
			await writeFile(path, '[profiles.job]\ntype = "worker"');

			expect((await loadConfiguration(path)).profiles.job?.type).toBe("worker");
			expect(loadConfigurationSync(path).profiles.job?.type).toBe("worker");
		});
	});

	test("reports missing configuration files with their resolved path", async () => {
		await withTemporaryDirectory(async (directory) => {
			const missingPath = join(directory, "missing.toml");

			await expect(loadConfiguration(missingPath)).rejects.toThrow(missingPath);
			expect(() => loadConfigurationSync(missingPath)).toThrow(missingPath);
		});
	});
});
