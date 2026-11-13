import { Queue } from "bullmq";
import IORedis from "ioredis";

export const ANALYSIS_QUEUE_NAME = "document-linking-analysis";
export type AnalysisQueue = { enqueue(jobId: string, resume?: boolean): Promise<void>; health(): Promise<void>; close(): Promise<void> };
export function createAnalysisQueue(redisUrl: string, queueName = ANALYSIS_QUEUE_NAME): AnalysisQueue {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<{ job_id: string }>(queueName, { connection });
  return {
    async enqueue(jobId, resume = false) {
      if (resume) { const existing = await queue.getJob(jobId); if (existing && ["failed", "completed"].includes(await existing.getState())) await existing.remove(); }
      await queue.add("analyze-document-set", { job_id: jobId }, {
        jobId, attempts: 5, backoff: { type: "polza-exponential", delay: 3000 },
        removeOnComplete: { age: 86_400, count: 1000 }, removeOnFail: { age: 604_800, count: 5000 },
      });
    },
    async health() { await connection.ping(); },
    async close() { await queue.close(); await connection.quit(); },
  };
}
