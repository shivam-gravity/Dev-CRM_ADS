import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { redisConnection, VECTOR_AD_GENERATION_QUEUE } from "../infra/queue.js";
import { runVectorAdGenerationJob, type VectorAdGenerationJobData } from "../modules/generation/vectorAdGenerationJob.js";
import { withLlmUsageContext } from "../infra/llmUsageContext.js";
import { isFinalFailure, sendToDeadLetter } from "../infra/deadLetterQueue.js";
import { registerGracefulShutdown } from "../infra/gracefulShutdown.js";
import { logger } from "../modules/logger/logger.js";
import { initErrorTracking, registerCrashReporting, captureError } from "../infra/errorTracking.js";

initErrorTracking("polluxa-vector-ad-generation-worker");
registerCrashReporting("polluxa-vector-ad-generation-worker");

const worker = new Worker(
  VECTOR_AD_GENERATION_QUEUE,
  async (job: Job) => {
    const data = job.data as VectorAdGenerationJobData;
    // Re-establish attribution inside this container so the image calls are billed to the
    // campaign-generation job that enqueued them.
    const refs = await withLlmUsageContext({ jobId: data.generationJobId }, () => runVectorAdGenerationJob(data));
    return { attached: refs.length };
  },
  { connection: redisConnection, concurrency: 2 }
);

worker.on("completed", (job: Job) => logger.info(`Vector ad generation job completed: campaign ${job.data?.campaignId}`));
worker.on("failed", (job: Job | undefined, err: Error) => {
  logger.error(`Vector ad generation job failed: campaign ${job?.data?.campaignId}`, err);
  captureError(err, { worker: "vectorAdGenerationWorker", campaignId: job?.data?.campaignId });
  if (job && isFinalFailure(job)) void sendToDeadLetter(VECTOR_AD_GENERATION_QUEUE, job, err);
});

registerGracefulShutdown(worker, "vectorAdGenerationWorker");
logger.info("Vector ad generation worker listening for jobs");
