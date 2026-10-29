import type { ProfileDriver, ProfileInstance } from "../../src/core/contracts.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});

	return { promise, resolve };
}

export class PersistentFakeDriver implements ProfileDriver {
	readonly type = "fake-persistent";
	create(): ProfileInstance {
		const done = deferred();

		return {
			mode: "persistent",
			finished: done.promise,
			start: () => undefined,
			stop: () => done.resolve(),
		};
	}
}

export class FiniteFakeDriver implements ProfileDriver {
	readonly type = "fake-finite";
	create(): ProfileInstance {
		const done = deferred();

		return {
			mode: "finite",
			finished: done.promise,
			start: () => {
				queueMicrotask(done.resolve);
			},
			stop: () => done.resolve(),
		};
	}
}

export const fakeProfileDrivers: readonly ProfileDriver[] = Object.freeze([
	new PersistentFakeDriver(),
	new FiniteFakeDriver(),
]);
