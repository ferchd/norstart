import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withTemporaryDirectory<T>(
	operation: (directory: string) => Promise<T>,
): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "norstar-test-"));

	try {
		return await operation(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
