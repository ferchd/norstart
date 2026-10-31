import type { ApplicationConfig, ApplicationManifest, ProfileDriver } from "./contracts.ts";
import type { Container } from "./container.ts";

export interface CompiledApplicationDefinition {
	readonly config: ApplicationConfig;
	readonly manifest: ApplicationManifest;
	readonly drivers?: readonly ProfileDriver[];
	registerServices(services: Container): void;
}

let compiledApplication: CompiledApplicationDefinition | undefined;

export function setCompiledApplication(definition: CompiledApplicationDefinition): void {
	compiledApplication = definition;
}

export function getCompiledApplication(): CompiledApplicationDefinition | undefined {
	return compiledApplication;
}
