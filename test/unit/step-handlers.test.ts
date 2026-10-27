import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { handler as checkJobHandler } from "../../src/handlers/check-job.js";
import { handler as registerJobHandler } from "../../src/handlers/register-job.js";
import { handler as processFileHandler } from "../../src/handlers/process-file.js";
import { handler as rollbackJobHandler } from "../../src/handlers/rollback-job.js";

describe("Step Functions Handlers - Orquestração Resiliente & Padrão Saga (Tarefa 4)", () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const originalEnv = process.env;

  beforeEach(() => {
    ddbMock.reset();
    process.env = {
      ...originalEnv,
      TABLE_NAME: "arqlab-jobs-idempotency-test",
      TERRENOS_BUCKET: "arqlab-terrenos-raw-test",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "mock-access-key",
      AWS_SECRET_ACCESS_KEY: "mock-secret-key",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // =========================================================================
  // Cenário 3: Fluxo Feliz Completo da State Machine (check -> register -> process)
  // =========================================================================
  describe("Cenário 3 (Fluxo Feliz): check-job -> register-job -> process-file", () => {
    it("deve orquestrar a execução sequencial com transição de status para COMPLETED", async () => {
      // 1. Etapa check-job: Simula que o job ainda não existe no DynamoDB
      ddbMock.on(GetCommand).resolvesOnce({ Item: undefined });

      const s3EventBridgeEvent = {
        detail: {
          bucket: { name: "arqlab-terrenos-raw-test" },
          object: { key: "terrenos/raw/proj-condominio-sol/1700000000-planta.dwg" },
        },
      };

      const checkResult = await checkJobHandler(s3EventBridgeEvent);
      expect(checkResult.exists).toBe(false);
      expect(checkResult.status).toBeNull();
      expect(checkResult.jobId).toBe("proj-condominio-sol_1700000000-planta.dwg");
      expect(checkResult.projetoId).toBe("proj-condominio-sol");

      // 2. Etapa register-job: Executa a trava condicional no DynamoDB
      ddbMock.on(PutCommand).resolvesOnce({});

      const registerResult = await registerJobHandler(checkResult);
      expect(registerResult.status).toBe("PROCESSING");
      expect(registerResult.isDuplicate).toBe(false);
      expect(registerResult.jobId).toBe(checkResult.jobId);

      // 3. Etapa process-file: Executa o cálculo volumétrico e atualiza para COMPLETED
      const completedRecord = {
        pk: `JOB#${checkResult.jobId}`,
        sk: "METADATA",
        jobId: checkResult.jobId,
        status: "COMPLETED",
        completedAt: new Date().toISOString(),
      };
      ddbMock.on(UpdateCommand).resolvesOnce({ Attributes: completedRecord });

      const processResult = await processFileHandler({
        jobId: registerResult.jobId,
        fileKey: registerResult.fileKey,
        simulatedVolumes: {
          volumeCorteM3: 5400.0,
          volumeAterroM3: 4200.0,
        },
      });

      expect(processResult.statusCode).toBe(200);
      expect(processResult.status).toBe("COMPLETED");
      expect(processResult.results.volumeCorteM3).toBe(5400.0);
      expect(processResult.results.volumeAterroM3).toBe(4200.0);
      expect(processResult.results.volumeLiquidoM3).toBe(1200.0);
      expect(processResult.results.malhaValidada).toBe(true);
      expect(processResult.completedAt).toBeDefined();
    });
  });

  // =========================================================================
  // Cenário 4: Falha no Processamento e Disparo da Saga Rollback
  // =========================================================================
  describe("Cenário 4 (Saga Rollback): process-file (falha) -> rollback-job (compensação)", () => {
    it("deve simular falha em process-file e acionar rollback-job para registrar FAILED no DynamoDB", async () => {
      const targetJobId = "job-falha-simulada-999";

      // 1. process-file falha intencionalmente quando forceError é true
      await expect(
        processFileHandler({
          jobId: targetJobId,
          forceError: true,
        })
      ).rejects.toThrowError("Falha simulada na etapa de processamento geométrico/volumétrico");

      // 2. O bloco Catch do Step Functions captura o erro e invoca rollback-job
      const failedRecord = {
        pk: `JOB#${targetJobId}`,
        sk: "METADATA",
        jobId: targetJobId,
        status: "FAILED",
        failureReason: "Malha geométrica corrompida durante a triangulação Delaunay.",
        failedAt: new Date().toISOString(),
      };
      ddbMock.on(UpdateCommand).resolvesOnce({ Attributes: failedRecord });

      const rollbackEvent = {
        jobId: targetJobId,
        errorInfo: {
          Error: "States.TaskFailed",
          Cause: "Malha geométrica corrompida durante a triangulação Delaunay.",
        },
      };

      const rollbackResult = await rollbackJobHandler(rollbackEvent);

      expect(rollbackResult.statusCode).toBe(200);
      expect(rollbackResult.status).toBe("FAILED");
      expect(rollbackResult.compensated).toBe(true);
      expect(rollbackResult.jobId).toBe(targetJobId);
      expect(rollbackResult.failureReason).toContain("Malha geométrica corrompida");
      expect(rollbackResult.failedAt).toBeDefined();

      // Confirma que a operação de Update no DynamoDB gravou status FAILED
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBe(1);
      const updateInput = updateCalls[0]?.args[0].input;
      expect(updateInput?.ExpressionAttributeValues?.[":status"]).toBe("FAILED");
    });
  });

  // =========================================================================
  // Cenários Especiais: Duplicidade e Validação de Argumentos
  // =========================================================================
  describe("Cenários de Duplicidade e Validação", () => {
    it("check-job deve identificar quando o job já existe e está COMPLETED", async () => {
      ddbMock.on(GetCommand).resolvesOnce({
        Item: {
          pk: "JOB#job-ja-processado",
          sk: "METADATA",
          jobId: "job-ja-processado",
          status: "COMPLETED",
          projetoId: "proj-10",
        },
      });

      const result = await checkJobHandler({
        jobId: "job-ja-processado",
        fileKey: "terrenos/raw/proj-10/1700-terreno.kmz",
      });

      expect(result.exists).toBe(true);
      expect(result.status).toBe("COMPLETED");
      expect(result.jobId).toBe("job-ja-processado");
    });

    it("register-job deve tratar duplicidade concorrente sem lançar erro fatal", async () => {
      const conditionalError = new Error("The conditional request failed");
      conditionalError.name = "ConditionalCheckFailedException";
      ddbMock.on(PutCommand).rejectsOnce(conditionalError);
      ddbMock.on(GetCommand).resolvesOnce({
        Item: {
          pk: "JOB#job-concorrente",
          sk: "METADATA",
          jobId: "job-concorrente",
          status: "PROCESSING",
        },
      });

      const result = await registerJobHandler({
        jobId: "job-concorrente",
        fileKey: "terrenos/raw/proj-1/terreno.dwg",
      });

      expect(result.isDuplicate).toBe(true);
      expect(result.status).toBe("PROCESSING");
      expect(result.message).toContain("já registrado anteriormente");
    });

    it("process-file e rollback-job devem exigir jobId válido", async () => {
      await expect(processFileHandler({ jobId: "" })).rejects.toThrowError("jobId é requerido");
      await expect(rollbackJobHandler({ jobId: "   " })).rejects.toThrowError("jobId é requerido");
    });
  });
});
