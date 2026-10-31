import { Application } from "norstar";
import { fileURLToPath } from "node:url";

const configPath = fileURLToPath(new URL("./framework.toml", import.meta.url));
const application = Application.configure({ configPath }).create();

await application.run();
