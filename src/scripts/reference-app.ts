import { createApp } from "../app";
import { Logger } from "../core/observability/Logger";
import { Metrics } from "../core/observability/Metrics";
import { RequestTracker } from "../core/http/RequestTracker";
import type { $ApplicationServices } from "../types/application";

const unavailable = (): never => {
	throw new Error("Offline API-reference dependency invoked");
};
const services: $ApplicationServices = {
	requests: {
		authorize: unavailable,
		runtime: unavailable,
		admit: async () => {},
	},
	apiKeys: {
		create: unavailable,
		read: unavailable,
		update: unavailable,
		delete: unavailable,
		enable: unavailable,
		disable: unavailable,
		rotate: unavailable,
	},
	health: { status: unavailable, diagnostics: unavailable },
	groups: {
		create: unavailable,
		read: unavailable,
		update: unavailable,
		remove: unavailable,
		detachLicenses: unavailable,
		enable: unavailable,
		disable: unavailable,
	},
	licenses: {
		create: unavailable,
		read: unavailable,
		update: unavailable,
		delete: unavailable,
		enable: unavailable,
		disable: unavailable,
		rotate: unavailable,
		adjust: unavailable,
		removeHardware: unavailable,
		removeIps: unavailable,
		consume: unavailable,
		register: unavailable,
	},
	activity: {
		origins: [],
		publish: unavailable,
		allowedEvents: unavailable,
		read: unavailable,
		history: unavailable,
		watermark: unavailable,
		resetEpoch: unavailable,
		prune: unavailable,
		backlog: unavailable,
		assertOrigin: unavailable,
		open: unavailable,
		subscribe: unavailable,
		message: unavailable,
		close: unavailable,
		stop: unavailable,
	},
	settings: { read: unavailable, update: unavailable },
	usage: { read: unavailable, lookup: unavailable },
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
		rotateSecret: unavailable,
		replay: unavailable,
		recover: unavailable,
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
