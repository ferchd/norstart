import { GreetingService } from "./greeting.service.ts";

export class GreetingController {
	constructor(private readonly greeting: GreetingService) {}

	index() {
		return { message: this.greeting.message() };
	}
}
