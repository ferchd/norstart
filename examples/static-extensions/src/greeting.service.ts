import { Clock } from "./clock.extension.ts";

export class Greeting {
	constructor(private readonly clock: Clock) {}

	message(): string {
		return this.clock.message();
	}
}
