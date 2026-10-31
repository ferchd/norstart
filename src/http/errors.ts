export interface HttpErrorOptions extends ErrorOptions {
	readonly expose?: boolean;
}

export class HttpError extends Error {
	readonly expose: boolean;

	constructor(
		readonly status: number,
		message: string,
		options?: HttpErrorOptions,
	) {
		super(message, options);
		this.name = "HttpError";

		if (!Number.isInteger(status) || status < 400 || status > 599) {
			throw new RangeError("HTTP error status must be an integer from 400 through 599");
		}

		this.expose = options?.expose ?? status < 500;
	}
}
