import type { ApplicationExtension } from "norstar/core";

export class Clock {
	message(): string {
		return "hello from a static extension provider";
	}

	dispose(): void {
		console.log("clock disposed");
	}
}

const extension: ApplicationExtension = {
	name: "clock",
	providers: [{ token: Clock, useClass: Clock, inject: [], lifetime: "singleton" }],
	initialize() {
		console.log("clock initialized");
	},
	shutdown() {
		console.log("clock extension closed");
	},
};

export default extension;
