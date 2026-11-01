import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import type { ApplicationConfig, ProfileDefinition } from "./contracts.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseConfiguration(source: string): ApplicationConfig {
	let parsed: unknown;
	try {
		parsed = Bun.TOML.parse(source);
	} catch (cause) {
		throw new Error("framework.toml is not valid TOML", { cause });
	}
	if (!isRecord(parsed)) {
		throw new Error("framework.toml must contain a TOML table");
	}
	const application = parsed.application ?? {};
	if (!isRecord(application)) {
		throw new Error("[application] must be a table");
	}
	const serviceModules = readServiceModules(application.serviceModules);
	const profileDrivers = readModuleSpecifiers(application.profileDrivers, "profileDrivers");
	const extensions = readModuleSpecifiers(application.extensions, "extensions");
	const rawProfiles = parsed.profiles;
	if (!isRecord(rawProfiles) || Object.keys(rawProfiles).length === 0) {
		throw new Error("framework.toml must define at least one [profiles.<name>] table");
	}
	const profiles: Record<string, ProfileDefinition> = {};
	for (const [id, raw] of Object.entries(rawProfiles)) {
		if (!id.trim()) {
			throw new Error("Profile names cannot be empty");
		}
		if (!isRecord(raw)) {
			throw new Error(`[profiles.${id}] must be a table`);
		}
		if (typeof raw.type !== "string" || !raw.type.trim()) {
			throw new Error(`[profiles.${id}].type must be a non-empty string`);
		}
		const { type, ...config } = raw;
		profiles[id] = Object.freeze({ type, config: Object.freeze(config) });
	}

	return Object.freeze({
		application: Object.freeze({
			name: typeof application.name === "string" ? application.name : undefined,
			serviceModules: Object.freeze(serviceModules),
			profileDrivers: Object.freeze(profileDrivers),
			extensions: Object.freeze(extensions),
		}),
		profiles: Object.freeze(profiles),
	});
}

function readModuleSpecifiers(value: unknown, field: string): string[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw new Error(`[application].${field} must be an array of module specifiers`);
	}

	return value.map((specifier, index) => {
		if (typeof specifier !== "string" || !specifier.trim()) {
			throw new Error(
				`[application].${field}[${index}] must be a non-empty module specifier`,
			);
		}

		return specifier;
	});
}

function readServiceModules(value: unknown): string[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw new Error("[application].serviceModules must be an array of module paths");
	}

	return value.map((modulePath, index) => {
		if (typeof modulePath !== "string" || !modulePath.trim()) {
			throw new Error(`[application].serviceModules[${index}] must be a non-empty path`);
		}

		return modulePath;
	});
}

export async function loadConfiguration(path = "framework.toml"): Promise<ApplicationConfig> {
	const file = Bun.file(resolve(path));
	if (!(await file.exists())) {
		throw new Error(`Configuration file not found: ${resolve(path)}`);
	}

	return parseConfiguration(await file.text());
}

export function loadConfigurationSync(path = "framework.toml"): ApplicationConfig {
	const absolutePath = resolve(path);
	try {
		return parseConfiguration(readFileSync(absolutePath, "utf8"));
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("framework.toml")) {
			throw error;
		}
		throw new Error(`Unable to read configuration file: ${absolutePath}`, { cause: error });
	}
}
