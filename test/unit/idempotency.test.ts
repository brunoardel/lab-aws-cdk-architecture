import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { IdempotencyService } from "../../src/services/idempotency.service.js";

describe("IdempotencyService - Controle de Idempotência At-Least-Once no DynamoDB", () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const originalEnv = process.env;

  beforeEach(() => {
    ddbMock.reset();
    process.env = {
      ...originalEnv,
      TABLE_NAME: "arqlab-jobs-idempotency-test",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "mock-access-key",
      AWS_SECRET_ACCESS_KEY: "mock-secret-key",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // =========================================================================
  // Cenário 1: Primeira Execução (Trava Condicional Adquirida com Sucesso)
  // =========================================================================
  it("Cenário 1: deve registrar com sucesso um novo job com status PROCESSING via trava condicional", async () => {
    ddbMock.on(PutCommand).resolves({});

    const service = new IdempotencyService();
    const result = await service.acquireLock("job-loteamento-001", {
      fileKey: "terrenos/raw/proj-10/terreno.dwg",
      projetoId: "proj-10",
      ttlDays: 7,
    });

    expect(result.acquired).toBe(true);
    expect(result.isDuplicate).toBe(false);
    if (result.acquired) {
      expect(result.job.pk).toBe("JOB#job-loteamento-001");
      expect(result.job.sk).toBe("METADATA");
      expect(result.job.status).toBe("PROCESSING");
      expect(result.job.fileKey).toBe("terrenos/raw/proj-10/terreno.dwg");
      expect(result.job.projetoId).toBe("proj-10");
      expect(result.job.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    }

    // Validação da chamada PutCommand com a ConditionExpression
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls.length).toBe(1);
    const putInput = putCalls[0]?.args[0].input;
    expect(putInput?.TableName).toBe("arqlab-jobs-idempotency-test");
    expect(putInput?.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(putInput?.Item?.pk).toBe("JOB#job-loteamento-001");
  });

  // =========================================================================
  // Cenário 2: Bloqueio de Duplicidade (ConditionalCheckFailedException)
  // =========================================================================
  it("Cenário 2: deve capturar ConditionalCheckFailedException e identificar duplicidade sem erro não tratado", async () => {
    const conditionalError = new Error("The conditional request failed");
    conditionalError.name = "ConditionalCheckFailedException";

    // O PutCommand falha pela condição de chave já existente
    ddbMock.on(PutCommand).rejects(conditionalError);

    // O GetCommand busca o estado do job duplicado
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: "JOB#job-duplicado-999",
        sk: "METADATA",
        jobId: "job-duplicado-999",
        status: "PROCESSING",
        createdAt: "2026-10-27T10:00:00.000Z",
      },
    });

    const service = new IdempotencyService();
    const result = await service.acquireLock("job-duplicado-999", {
      fileKey: "terrenos/raw/proj-10/terreno-duplicado.dwg",
      projetoId: "proj-10",
    });

    expect(result.acquired).toBe(false);
    if (!result.acquired) {
      expect(result.isDuplicate).toBe(true);
      expect(result.message).toContain("já registrado anteriormente");
      expect(result.job?.status).toBe("PROCESSING");
    }
  });

  // =========================================================================
  // Cenário 3: Consulta de Job Existente ou Inexistente (getJob)
  // =========================================================================
  it("Cenário 3: deve retornar os dados do job quando existente, ou null quando não encontrado", async () => {
    ddbMock.on(GetCommand).resolvesOnce({
      Item: {
        pk: "JOB#job-existente-001",
        sk: "METADATA",
        jobId: "job-existente-001",
        status: "COMPLETED",
      },
    }).resolvesOnce({
      Item: undefined,
    });

    const service = new IdempotencyService();

    const existing = await service.getJob("job-existente-001");
    expect(existing).not.toBeNull();
    expect(existing?.status).toBe("COMPLETED");

    const nonExisting = await service.getJob("job-inexistente-404");
    expect(nonExisting).toBeNull();
  });

  // =========================================================================
  // Cenário 4: Conclusão de Job com Sucesso (completeJob)
  // =========================================================================
  it("Cenário 4: deve atualizar o status para COMPLETED e gravar os resultados volumétricos calculados", async () => {
    const mockCompletedRecord = {
      pk: "JOB#job-calc-001",
      sk: "METADATA",
      jobId: "job-calc-001",
      status: "COMPLETED",
      results: {
        volumeCorteM3: 1500,
        volumeAterroM3: 1200,
        volumeLiquidoM3: 300,
      },
      completedAt: new Date().toISOString(),
    };

    ddbMock.on(UpdateCommand).resolves({
      Attributes: mockCompletedRecord,
    });

    const service = new IdempotencyService();
    const updated = await service.completeJob("job-calc-001", {
      volumeCorteM3: 1500,
      volumeAterroM3: 1200,
      volumeLiquidoM3: 300,
    });

    expect(updated.status).toBe("COMPLETED");
    expect(updated.results?.volumeCorteM3).toBe(1500);

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBe(1);
    const updateInput = updateCalls[0]?.args[0].input;
    expect(updateInput?.UpdateExpression).toContain("#status = :status");
    expect(updateInput?.ExpressionAttributeValues?.[":status"]).toBe("COMPLETED");
  });

  // =========================================================================
  // Cenário 5: Compensação Saga de Falha (failJob)
  // =========================================================================
  it("Cenário 5: deve atualizar o status para FAILED e documentar a causa da falha", async () => {
    const mockFailedRecord = {
      pk: "JOB#job-fail-001",
      sk: "METADATA",
      jobId: "job-fail-001",
      status: "FAILED",
      failureReason: "Malha geométrica corrompida ou polígonos auto-interceptantes.",
      failedAt: new Date().toISOString(),
    };

    ddbMock.on(UpdateCommand).resolves({
      Attributes: mockFailedRecord,
    });

    const service = new IdempotencyService();
    const failed = await service.failJob(
      "job-fail-001",
      "Malha geométrica corrompida ou polígonos auto-interceptantes.",
      { errorCode: "INVALID_POLYGON" }
    );

    expect(failed.status).toBe("FAILED");
    expect(failed.failureReason).toContain("Malha geométrica corrompida");

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    const updateInput = updateCalls[0]?.args[0].input;
    expect(updateInput?.ExpressionAttributeValues?.[":status"]).toBe("FAILED");
  });

  // =========================================================================
  // Cenário 6: Falha de Configuração de Ambiente
  // =========================================================================
  it("Cenário 6: deve lançar erro explícito caso nenhuma variável de tabela esteja configurada", () => {
    delete process.env["TABLE_NAME"];
    delete process.env["JOBS_TABLE_NAME"];
    delete process.env["JOBS_TABLE"];

    expect(() => new IdempotencyService()).toThrowError("TABLE_NAME");
  });
});
