import {
  IdempotencyService,
  type IdempotencyServiceOptions,
} from "../services/idempotency.service.js";

export interface CheckJobInput {
  jobId?: string;
  fileKey?: string;
  objectKey?: string;
  bucketName?: string;
  projetoId?: string;
  detail?: {
    bucket?: { name?: string };
    object?: { key?: string };
  };
  [key: string]: any;
}

export interface CheckJobResult {
  jobId: string;
  exists: boolean;
  status: string | null;
  fileKey: string;
  bucketName: string;
  projetoId?: string;
}

/**
 * Extrai o projetoId e deriva um jobId determinístico caso não seja fornecido explicitamente.
 */
export function extractJobMetadata(input: CheckJobInput): {
  bucketName: string;
  fileKey: string;
  projetoId: string;
  jobId: string;
} {
  const bucketName =
    input.bucketName ||
    input.detail?.bucket?.name ||
    process.env["TERRENOS_BUCKET"] ||
    process.env["BUCKET_NAME"] ||
    "default-bucket";

  const fileKey =
    input.fileKey ||
    input.objectKey ||
    input.detail?.object?.key ||
    "terrenos/raw/default/default-file.dwg";

  const parts = fileKey.split("/");
  const fileName = parts.pop() || "unknown-file";
  const derivedProjetoId =
    input.projetoId || (parts.length >= 3 && parts[2] ? parts[2] : "default-project");

  const jobId = input.jobId || `${derivedProjetoId}_${fileName}`;

  return {
    bucketName,
    fileKey,
    projetoId: derivedProjetoId,
    jobId,
  };
}

/**
 * Handler Lambda: Consulta se o job já foi registrado no DynamoDB para alimentar
 * a decisão (Choice state) da Step Functions State Machine.
 */
export const handler = async (
  event: CheckJobInput,
  options?: IdempotencyServiceOptions
): Promise<CheckJobResult> => {
  const { bucketName, fileKey, projetoId, jobId } = extractJobMetadata(event);
  const idempotencyService = new IdempotencyService(options);

  const existingJob = await idempotencyService.getJob(jobId);

  return {
    jobId,
    exists: existingJob !== null,
    status: existingJob ? existingJob.status : null,
    fileKey,
    bucketName,
    projetoId,
  };
};
