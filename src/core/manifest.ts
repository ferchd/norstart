import type {
	ApplicationConfig,
	ApplicationManifest,
	ProfileDriver,
	ProfileRegistration,
} from "./contracts.ts";

export function createManifest(
	config: ApplicationConfig,
	frameworkVersion = "0.1.0",
): ApplicationManifest {
	const profiles: ProfileRegistration[] = Object.entries(config.profiles).map(
		([id, definition]) =>
			Object.freeze({
				id,
				type: definition.type,
				config: definition.config,
			}),
	);

	return Object.freeze({
		schemaVersion: 2,
		frameworkVersion,
		serviceModules: Object.freeze([...config.application.serviceModules]),
		profiles: Object.freeze(profiles),
	});
}

export class ProfileRegistry {
	private readonly byType = new Map<string, ProfileDriver>();

	constructor(drivers: readonly ProfileDriver[]) {
		for (const driver of drivers) {
			if (this.byType.has(driver.type)) {
				throw new Error(`Duplicate profile driver: ${driver.type}`);
			}
			this.byType.set(driver.type, driver);
		}
	}

	get(type: string): ProfileDriver {
		const driver = this.byType.get(type);
		if (!driver) {
			throw new Error(`No profile driver registered for type "${type}"`);
		}

		return driver;
	}
}
