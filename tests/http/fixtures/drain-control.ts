let requestStarted = Promise.resolve();
let markRequestStarted: (() => void) | undefined;
let completeResponse: ((value: { status: string }) => void) | undefined;

export function resetDrainControl(): void {
	requestStarted = new Promise<void>((resolve) => {
		markRequestStarted = resolve;
	});
	completeResponse = undefined;
}

export function waitForDrainRequest(): Promise<void> {
	return requestStarted;
}

export function holdDrainResponse(): Promise<{ status: string }> {
	markRequestStarted?.();

	return new Promise((resolve) => {
		completeResponse = resolve;
	});
}

export function releaseDrainResponse(): void {
	completeResponse?.({ status: "drained" });
}
