import type { HttpRequestContext } from "norstar/http";

export class UserStore {
	static readonly norstarService = {
		lifetime: "scoped" as const,
		inject: [],
	};

	find(id: string): { id: string; name: string } {
		return { id, name: "Ada Lovelace" };
	}
}

export class UserController {
	static readonly norstarService = {
		lifetime: "scoped" as const,
		inject: [UserStore],
	};

	constructor(private readonly users: UserStore) {}

	show(context: HttpRequestContext): { id: string; name: string } {
		return this.users.find(context.params.id ?? "");
	}
}
