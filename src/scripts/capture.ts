import { createApp } from "../app";
import { Logger } from "../core/observability/Logger";
import { Metrics } from "../core/observability/Metrics";
import { RequestTracker } from "../core/http/RequestTracker";
import type { $ApplicationServices } from "../types/application";

const unavailable = (): never => {
	throw new Error("Build-only dependency invoked");
};
const services: $ApplicationServices = {
	requests: { authorize: unavailable, runtime: unavailable },
	apiKeys: {
		create: unavailable,
		read: unavailable,
		update: unavailable,
		delete: unavailable,
		enable: unavailable,
		disable: unavailable,
		rotate: unavailable,
	},
	health: { status: unavailable },
	items: {
		create: unavailable,
		read: unavailable,
		update: unavailable,
		remove: unavailable,
		enable: unavailable,
		disable: unavailable,
	},
	licenses: {
		create: unavailable,
		read: unavailable,
		self: unavailable,
		update: unavailable,
		delete: unavailable,
		enable: unavailable,
		disable: unavailable,
		rotate: unavailable,
		adjust: unavailable,
		removeHardware: unavailable,
		removeIps: unavailable,
	},
	settings: { read: unavailable, update: unavailable },
	users: {
		create: unavailable,
		read: unavailable,
		update: unavailable,
		remove: unavailable,
		enable: unavailable,
		disable: unavailable,
	},
	validation: { validate: unavailable },
	webhooks: {
		create: unavailable,
		read: unavailable,
		update: unavailable,
		delete: unavailable,
		enable: unavailable,
		disable: unavailable,
		deliveryHistory: unavailable,
	},
};
const metrics = new Metrics();
export const app = createApp(
	services,
	new RequestTracker(metrics),
	new Logger("error"),
	metrics,
);
export default app;
