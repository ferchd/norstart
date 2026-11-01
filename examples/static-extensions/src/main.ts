import { Application } from "norstar";
import { Greeting } from "./greeting.service.ts";

await Application.configure({
	drivers: [
		{
			type: "job",
			create({ services }) {
				return {
					mode: "finite",
					finished: Promise.resolve(),
					start() {
						console.log(services.get(Greeting).message());
					},
					stop() {},
				};
			},
		},
	],
})
	.create()
	.run();
