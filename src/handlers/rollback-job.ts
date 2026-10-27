import {
  IdempotencyService,
  type IdempotencyServiceOptions,
} from "../services/idempotency.service.js";

export interface RollbackJobInput {
  jobId: string;
  error?: any;
  errorInfo?: {
    Error?: string;
    Cause?: string;
  };
  failureReason?: string;
  [key: string]: any;
}

export interface RollbackJobResult {
  statusCode: number;
  jobId: string;
  status: "FAILED";
  compensated: boolean;
  failureReason: string;
  failedAt: string;
}

/**
 * Handler Lambda: Compensação Saga acionada pelo bloco Catch do Step Functions em caso de erro,
 * atualizando o DynamoDB para status FAILED com a causa documentada para auditoria.
 */
export const handler = async (
  event: RollbackJobInput,
  options?: IdempotencyServiceOptions
): Promise<RollbackJobResult> => {
  const { jobId } = event;

  if (!jobId || jobId.trim() === "") {
    throw new Error("Parâmetro obrigatório ausente: jobId é requerido para executar o rollback.");
  }

  const reason =
    event.failureReason ||
    event.errorInfo?.Cause ||
    event.errorInfo?.Error ||
    (typeof event.error === "string" ? event.error : JSON.stringify(event.error)) ||
    "Falha indeterminada no pipeline de execução.";

  const idempotencyService = new IdempotencyService(options);
  const updatedRecord = await idempotencyService.failJob(jobId, reason, event.errorInfo || event.error);

  return {
    statusCode: 200,
    jobId,
    status: "FAILED",
    compensated: true,
    failureReason: reason,
    failedAt: updatedRecord.failedAt || new Date().toISOString(),
  };
};
