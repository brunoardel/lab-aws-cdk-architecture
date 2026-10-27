import {
  IdempotencyService,
  type IdempotencyServiceOptions,
} from "../services/idempotency.service.js";

export interface ProcessFileInput {
  jobId: string;
  fileKey?: string;
  bucketName?: string;
  projetoId?: string;
  forceError?: boolean;
  simulatedVolumes?: {
    volumeCorteM3?: number;
    volumeAterroM3?: number;
  };
  [key: string]: any;
}

export interface ProcessFileResult {
  statusCode: number;
  jobId: string;
  status: "COMPLETED";
  results: {
    volumeCorteM3: number;
    volumeAterroM3: number;
    volumeLiquidoM3: number;
    malhaValidada: boolean;
  };
  completedAt: string;
}

/**
 * Handler Lambda: Executa o processamento do arquivo de terreno (validação de malha e terraplanagem)
 * e finaliza o ciclo de vida do job no DynamoDB como COMPLETED.
 */
export const handler = async (
  event: ProcessFileInput,
  options?: IdempotencyServiceOptions
): Promise<ProcessFileResult> => {
  const { jobId, forceError, simulatedVolumes } = event;

  if (!jobId || jobId.trim() === "") {
    throw new Error("Parâmetro obrigatório ausente: jobId é requerido para processamento.");
  }

  // Simulação de erro forçado para testar o Retry e Catch (Saga Rollback) da State Machine
  if (forceError === true) {
    throw new Error(
      `Falha simulada na etapa de processamento geométrico/volumétrico do Job: ${jobId}. Disparando rollback saga.`
    );
  }

  // Simulação do cálculo paramétrico de terraplanagem
  const corte = simulatedVolumes?.volumeCorteM3 ?? 4150.75;
  const aterro = simulatedVolumes?.volumeAterroM3 ?? 3820.25;
  const liquido = Math.round((corte - aterro) * 100) / 100;

  const results = {
    volumeCorteM3: corte,
    volumeAterroM3: aterro,
    volumeLiquidoM3: liquido,
    malhaValidada: true,
  };

  const idempotencyService = new IdempotencyService(options);
  const updatedRecord = await idempotencyService.completeJob(jobId, results);

  return {
    statusCode: 200,
    jobId,
    status: "COMPLETED",
    results,
    completedAt: updatedRecord.completedAt || new Date().toISOString(),
  };
};
