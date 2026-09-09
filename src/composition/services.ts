import { RedisClient } from "bun";
import { ActivityService } from "../application/services/ActivityService";
import { AdminService } from "../application/services/AdminService";
import { LicenseService } from "../application/services/LicenseService";
import { db, type Database } from "../db";
import type { ISessionRepository } from "../domain/repositories/ISessionRepository";
import { DrizzleAccessRepository } from "../infrastructure/repositories/DrizzleAccessRepository";
import { DrizzleActivityRepository } from "../infrastructure/repositories/DrizzleActivityRepository";
import { DrizzleCustomerRepository } from "../infrastructure/repositories/DrizzleCustomerRepository";
import { DrizzleDeviceRepository } from "../infrastructure/repositories/DrizzleDeviceRepository";
import { DrizzleLicenseRepository } from "../infrastructure/repositories/DrizzleLicenseRepository";
import { DrizzleMeterRepository } from "../infrastructure/repositories/DrizzleMeterRepository";
import {
	DrizzleStripeSubscriptionRepository,
	DrizzleStripeWebhookRepository,
} from "../infrastructure/repositories/DrizzleStripeRepository";
import { RedisSessionRepository } from "../infrastructure/repositories/RedisSessionRepository";

export interface ServiceGraph {
	activityService: ActivityService;
	adminService: AdminService;
	licenseService: LicenseService;
	licenseRepository: DrizzleLicenseRepository;
	customerRepository: DrizzleCustomerRepository;
	accessRepository: DrizzleAccessRepository;
	deviceRepository: DrizzleDeviceRepository;
	meterRepository: DrizzleMeterRepository;
	stripeSubscriptionRepository: DrizzleStripeSubscriptionRepository;
	stripeWebhookRepository: DrizzleStripeWebhookRepository;
}

export function createServiceGraph(
	sessionRepository: ISessionRepository,
	database: Database = db,
	activityRetentionDays = 30,
): ServiceGraph {
	const licenseRepository = new DrizzleLicenseRepository(database);
	const customerRepository = new DrizzleCustomerRepository(database);
	const accessRepository = new DrizzleAccessRepository(
		database,
		activityRetentionDays,
	);
	const deviceRepository = new DrizzleDeviceRepository(database);
	const meterRepository = new DrizzleMeterRepository(database);
	const activityService = new ActivityService(
		new DrizzleActivityRepository(database),
	);
	const stripeSubscriptionRepository = new DrizzleStripeSubscriptionRepository(
		database,
	);
	const stripeWebhookRepository = new DrizzleStripeWebhookRepository(database);

	return {
		activityService,
		adminService: new AdminService(
			licenseRepository,
			customerRepository,
			accessRepository,
			deviceRepository,
			sessionRepository,
			meterRepository,
			activityService,
			stripeSubscriptionRepository,
		),
		licenseService: new LicenseService(
			licenseRepository,
			deviceRepository,
			sessionRepository,
			meterRepository,
			activityService,
		),
		licenseRepository,
		customerRepository,
		accessRepository,
		deviceRepository,
		meterRepository,
		stripeSubscriptionRepository,
		stripeWebhookRepository,
	};
}

export interface ConnectedAdminService {
	service: AdminService;
	close(): void;
}

/** Creates the real database and Redis-backed admin service used by the CLI. */
export async function createConnectedAdminService(
	database: Database = db,
	redisUrl = Bun.env.KEYZORI_REDIS_URL ?? "redis://localhost:6379",
	activityRetentionDays = Number(Bun.env.KEYZORI_EVENT_RETENTION_DAYS ?? "30"),
): Promise<ConnectedAdminService> {
	const redis = new RedisClient(redisUrl);
	await redis.connect();
	const graph = createServiceGraph(
		new RedisSessionRepository(redis),
		database,
		activityRetentionDays,
	);
	return {
		service: graph.adminService,
		close: () => redis.close(),
	};
}
