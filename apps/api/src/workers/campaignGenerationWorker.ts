import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { redisConnection, CAMPAIGN_GENERATION_QUEUE } from "../infra/queue.js";
import { runCampaignGenerationPipeline } from "../modules/orchestrator/campaignGenerationPipeline.js";
import { isFinalFailure, sendToDeadLetter } from "../infra/deadLetterQueue.js";
import { registerGracefulShutdown } from "../infra/gracefulShutdown.js";
import { recordProgressStep } from "../infra/liveProgress.js";
import { logger } from "../modules/logger/logger.js";
import { initErrorTracking, registerCrashReporting, captureError } from "../infra/errorTracking.js";

const PROGRESS_PREFIX = "campaign-generation";

initErrorTracking("polluxa-campaign-generation-worker");
registerCrashReporting("polluxa-campaign-generation-worker");

const worker = new Worker(
  CAMPAIGN_GENERATION_QUEUE,
  async (job: Job) => {
    const { jobId, forceRefresh, objective, channels } = job.data as { jobId: string; forceRefresh?: boolean; objective?: string; channels?: ("meta" | "google" | "tiktok")[] };
    return runCampaignGenerationPipeline(jobId, {
      forceRefresh,
      objective,
      channels,
      onProgress: async (completed, total, stepName) => {
        await job.updateProgress(Math.round((completed / total) * 100));
        if (stepName) await recordProgressStep(PROGRESS_PREFIX, jobId, stepName);
      },
    });
  },
  // A full generation runs 6-13 min inside this one handler. BullMQ's DEFAULT lockDuration/
  // stalledInterval is 30s — far shorter than the job — so the lock expired mid-run and BullMQ
  // dead-lettered a still-running job with "stalled more than allowable limit". Set the lock to
  // 15 min (above the pipeline's own 10-min lock TTL), renew on the usual lockDuration/2 timer,
  // check for genuinely-dead jobs every 60s, and tolerate 2 stalls before giving up. concurrency:1
  // so two multi-minute pipelines don't starve the single event loop and trip the stall check.
  {
    connection: redisConnection,
    concurrency: 1,
    lockDuration: 15 * 60 * 1000,
    stalledInterval: 60 * 1000,
    maxStalledCount: 2,
  }
);

worker.on("completed", (job: Job) => logger.info(`Campaign generation job completed: ${job.data?.jobId}`));
worker.on("failed", (job: Job | undefined, err: Error) => {
  logger.error(`Campaign generation job failed: ${job?.data?.jobId}`, err);
  captureError(err, { worker: "campaignGenerationWorker", jobId: job?.data?.jobId });
  if (job && isFinalFailure(job)) void sendToDeadLetter(CAMPAIGN_GENERATION_QUEUE, job, err);
});

registerGracefulShutdown(worker, "campaignGenerationWorker");
logger.info("Campaign generation worker listening for jobs");
