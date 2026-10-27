import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

export type JobStatus = "PROCESSING" | "COMPLETED" | "FAILED";

export interface JobRecord {
  pk: string;
  sk: string;
  jobId: string;
  status: JobStatus;
  fileKey: string;
  projetoId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  failedAt?: string;
  failureReason?: string;
  errorDetails?: any;
  expiresAt: number; // Timestamp Unix em segundos para TTL nativo do DynamoDB
  results?: {
    volumeCorteM3?: number;
    volumeAterroM3?: number;
    volumeLiquidoM3?: number;
    [key: string]: any;
  };
}

export interface AcquireLockOptions {
  fileKey: string;
  projetoId?: string;
  ttlDays?: number;
}

export type AcquireLockResult =
  | {
      acquired: true;
      isDuplicate: false;
      job: JobRecord;
    }
  | {
      acquired: false;
      isDuplicate: true;
      job?: JobRecord;
      message: string;
    };

export interface IdempotencyServiceOptions {
  tableName?: string;
  docClient?: DynamoDBDocumentClient;
}

export class IdempotencyService {
  private readonly tableName: string;
  private readonly docClient: DynamoDBDocumentClient;

  constructor(options?: IdempotencyServiceOptions) {
    const tableName =
      options?.tableName ||
      process.env["JOBS_TABLE_NAME"] ||
      process.env["TABLE_NAME"] ||
      process.env["JOBS_TABLE"];

    if (!tableName || tableName.trim() === "") {
      throw new Error(
        "Configuração ausente: A variável de ambiente TABLE_NAME ou JOBS_TABLE_NAME é obrigatória para o IdempotencyService."
      );
    }

    this.tableName = tableName;

    if (options?.docClient) {
      this.docClient = options.docClient;
    } else {
      const ddbClient = new DynamoDBClient({
        region: process.env["AWS_REGION"] || process.env["DEFAULT_REGION"] || "us-east-1",
        credentials: {
          accessKeyId: process.env["AWS_ACCESS_KEY_ID"] || "mock-access-key",
          secretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"] || "mock-secret-key",
          sessionToken: process.env["AWS_SESSION_TOKEN"],
        },
      });

      this.docClient = DynamoDBDocumentClient.from(ddbClient, {
        marshallOptions: { removeUndefinedValues: true },
      });
    }
  }

  /**
   * Tenta registrar a trava inicial de idempotência com status PROCESSING.
   * Utiliza ConditionExpression: "attribute_not_exists(pk)" para garantir unicidade atômica.
   */
  async acquireLock(
    jobId: string,
    options: AcquireLockOptions
  ): Promise<AcquireLockResult> {
    const nowIso = new Date().toISOString();
    const ttlDays = options.ttlDays ?? 7;
    const expiresAt = Math.floor(Date.now() / 1000) + ttlDays * 24 * 60 * 60;

    const jobRecord: JobRecord = {
      pk: `JOB#${jobId}`,
      sk: "METADATA",
      jobId,
      status: "PROCESSING",
      fileKey: options.fileKey,
      projetoId: options.projetoId,
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt,
    };

    try {
      await this.docClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: jobRecord,
          ConditionExpression: "attribute_not_exists(pk)",
        })
      );

      return {
        acquired: true,
        isDuplicate: false,
        job: jobRecord,
      };
    } catch (error: any) {
      if (
        error?.name === "ConditionalCheckFailedException" ||
        error?.code === "ConditionalCheckFailedException"
      ) {
        // Evento duplicado já recebido anteriormente (At-Least-Once delivery)
        const existingJob = await this.getJob(jobId);
        return {
          acquired: false,
          isDuplicate: true,
          job: existingJob || undefined,
          message: `Job ${jobId} já registrado anteriormente (Status atual: ${existingJob?.status || "UNKNOWN"}).`,
        };
      }

      throw error;
    }
  }

  /**
   * Consulta os dados de um job existente no DynamoDB.
   */
  async getJob(jobId: string): Promise<JobRecord | null> {
    const response = await this.docClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: `JOB#${jobId}`,
          sk: "METADATA",
        },
      })
    );

    return (response.Item as JobRecord) || null;
  }

  /**
   * Atualiza o job para status COMPLETED, anexando os resultados do cálculo geométrico/volumétrico.
   */
  async completeJob(
    jobId: string,
    results: {
      volumeCorteM3?: number;
      volumeAterroM3?: number;
      volumeLiquidoM3?: number;
      [key: string]: any;
    }
  ): Promise<JobRecord> {
    const nowIso = new Date().toISOString();

    const response = await this.docClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: {
          pk: `JOB#${jobId}`,
          sk: "METADATA",
        },
        UpdateExpression:
          "SET #status = :status, #updatedAt = :now, #completedAt = :now, #results = :results, #volumeCorte = :corte, #volumeAterro = :aterro, #volumeLiquido = :liquido",
        ExpressionAttributeNames: {
          "#status": "status",
          "#updatedAt": "updatedAt",
          "#completedAt": "completedAt",
          "#results": "results",
          "#volumeCorte": "volumeCorteM3",
          "#volumeAterro": "volumeAterroM3",
          "#volumeLiquido": "volumeLiquidoM3",
        },
        ExpressionAttributeValues: {
          ":status": "COMPLETED",
          ":now": nowIso,
          ":results": results,
          ":corte": results.volumeCorteM3 ?? 0,
          ":aterro": results.volumeAterroM3 ?? 0,
          ":liquido": results.volumeLiquidoM3 ?? 0,
        },
        ReturnValues: "ALL_NEW",
      })
    );

    return response.Attributes as JobRecord;
  }

  /**
   * Atualiza o job para status FAILED (Saga Rollback), registrando o motivo da falha.
   */
  async failJob(
    jobId: string,
    reason: string,
    errorDetails?: any
  ): Promise<JobRecord> {
    const nowIso = new Date().toISOString();

    const response = await this.docClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: {
          pk: `JOB#${jobId}`,
          sk: "METADATA",
        },
        UpdateExpression:
          "SET #status = :status, #updatedAt = :now, #failedAt = :now, #reason = :reason, #details = :details",
        ExpressionAttributeNames: {
          "#status": "status",
          "#updatedAt": "updatedAt",
          "#failedAt": "failedAt",
          "#reason": "failureReason",
          "#details": "errorDetails",
        },
        ExpressionAttributeValues: {
          ":status": "FAILED",
          ":now": nowIso,
          ":reason": reason,
          ":details": errorDetails || null,
        },
        ReturnValues: "ALL_NEW",
      })
    );

    return response.Attributes as JobRecord;
  }
}
