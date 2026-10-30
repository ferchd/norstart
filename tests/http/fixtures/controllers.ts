import type { HttpRequestContext } from "norstar/http";

export class RequestState {
	constructor(
		readonly id: number,
		private readonly onDispose: () => void,
	) {}

	dispose(): void {
		this.onDispose();
	}
}

export class FixtureController {
	constructor(private readonly state: RequestState) {}

	show(context: HttpRequestContext): { id: string; stateId: number } {
		return {
			id: context.params.id ?? "",
			stateId: this.state.id,
		};
	}
}
