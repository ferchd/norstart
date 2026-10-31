import type { ApplicationConfig, ApplicationManifest } from "./contracts.ts";
import type { Container } from "./container.ts";

export interface CompiledApplicationDefinition {
	readonly config: ApplicationConfig;
	readonly manifest: ApplicationManifest;
	registerServices(services: Container): void;
}

let compiledApplication: CompiledApplicationDefinition | undefined;

export function setCompiledApplication(definition: CompiledApplicationDefinition): void {
	compiledApplication = definition;
}

export function getCompiledApplication(): CompiledApplicationDefinition | undefined {
	return compiledApplication;
}
