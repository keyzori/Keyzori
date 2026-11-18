import type { ActivityService } from "../../plugins/activity/ActivityService";
import type { Metrics } from "./Metrics";

export async function observeActivity(
	activity: Pick<ActivityService, "backlog">,
	metrics: Metrics,
	deadlineAt: number,
) {
	try {
		const sample = await activity.backlog(deadlineAt);
		metrics.setGauge("keyzori_event_publication_backlog", sample.unpublished);
		metrics.setGauge(
			"keyzori_event_publication_lag_seconds",
			sample.publicationLagSeconds,
		);
		metrics.setGauge("keyzori_event_observed_at_seconds", Date.now() / 1000);
		metrics.streamTransportSample(sample.transportBufferedBytes);
	} catch (error) {
		metrics.streamTransportSample(undefined);
		throw error;
	}
}
