export function reportCliError(error: unknown): void {
	if (error instanceof AggregateError) {
		console.error(error.message);
		for (const detail of error.errors) {
			reportCliError(detail);
		}

		return;
	}

	console.error(error instanceof Error ? error.message : error);
}
