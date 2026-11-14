import { setTimeout } from "node:timers/promises";
import { configuration, runOnce } from "./agent.mjs";

const controller = new AbortController();
for (const event of ["SIGINT", "SIGTERM"]) process.once(event, () => controller.abort());
try {
	const config = configuration(process.env);
	console.log("Runner started. Target and credentials are omitted from logs.");
	while (!controller.signal.aborted) {
		let delay = 1000;
		try {
			const result = await runOnce(config, controller.signal);
			if (result.state === "reported") console.log("Delivery attempt reported.");
		} catch (error) {
			if (controller.signal.aborted) break;
			if (error.message === "runner_authorization_denied") throw error;
			console.error("Delivery transport unavailable; waiting before reconnect.");
			delay = 5000;
		}
		await setTimeout(delay, undefined, { signal: controller.signal }).catch(() => {});
	}
} catch {
	console.error("Runner stopped. Check configuration and destination authorization.");
	process.exitCode = 1;
}
