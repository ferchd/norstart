import { Application } from "norstar";
import { Inspector } from "./inspector.service.ts";

await Application.configure({
	drivers: [
		{
			type: "job",
			create({ services }) {
				let finish!: () => void;
				const finished = new Promise<void>((resolve) => {
					finish = resolve;
				});

				return {
					mode: "finite",
					finished,
					async start() {
						console.log(await services.get(Inspector).tables());
						finish();
					},
					stop() {},
				};
			},
		},
	],
})
	.create()
	.run();
