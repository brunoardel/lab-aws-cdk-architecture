import {
  IdempotencyService,
  type IdempotencyServiceOptions,
} from "../services/idempotency.service.js";
import { extractJobMetadata, type CheckJobInput } from "./check-job.js";

export interface RegisterJobResult {
  jobId: string;
  status: string;
  isDuplicate: boolean;
  fileKey: string;
  bucketName: string;
  projetoId?: string;
  createdAt?: string;
  message?: string;
}

/**
 * Handler Lambda: Registra o job no DynamoDB com trava condicional (status PROCESSING).
 * Garante entrega atômica At-Least-Once na orquestração.
 */
export const handler = async (
  event: CheckJobInput,
  options?: IdempotencyServiceOptions
): Promise<RegisterJobResult> => {
  const { bucketName, fileKey, projetoId, jobId } = extractJobMetadata(event);
  const idempotencyService = new IdempotencyService(options);

  const lockResult = await idempotencyService.acquireLock(jobId, {
    fileKey,
    projetoId,
  });

  if (lockResult.isDuplicate) {
    return {
      jobId,
      status: lockResult.job?.status || "ALREADY_REGISTERED",
      isDuplicate: true,
      fileKey,
      bucketName,
      projetoId,
      message: lockResult.message,
    };
  }

  return {
    jobId,
    status: lockResult.job.status,
    isDuplicate: false,
    fileKey,
    bucketName,
    projetoId,
    createdAt: lockResult.job.createdAt,
  };
};
