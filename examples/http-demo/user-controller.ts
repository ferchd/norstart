import type { HttpRequestContext } from "norstar/http";

export class UserStore {
	find(id: string): { id: string; name: string } {
		return { id, name: "Ada Lovelace" };
	}
}

export class UserController {
	constructor(private readonly users: UserStore) {}

	show(context: HttpRequestContext): { id: string; name: string } {
		return this.users.find(context.params.id ?? "");
	}
}
