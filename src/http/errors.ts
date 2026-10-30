export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "HttpError";

		if (!Number.isInteger(status) || status < 400 || status > 599) {
			throw new RangeError("HTTP error status must be an integer from 400 through 599");
		}
	}
}
