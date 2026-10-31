import { serviceModuleLoadedKey } from "./discovery-tokens.ts";

let nextStoreId = 0;
const host = globalThis as typeof globalThis & Record<string, unknown>;
host[serviceModuleLoadedKey] = true;

export class DiscoverableStore {
	static readonly norstarService = {
		lifetime: "scoped" as const,
		inject: [],
	};

	readonly id = ++nextStoreId;
}

export class DiscoverableController {
	static readonly norstarService = {
		lifetime: "scoped" as const,
		inject: [DiscoverableStore],
	};

	constructor(private readonly store: DiscoverableStore) {}

	show(): { storeId: number } {
		return { storeId: this.store.id };
	}
}
