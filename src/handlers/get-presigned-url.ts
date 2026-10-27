import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  generatePresignedUrlInputSchema,
  type GeneratePresignedUrlInput,
  type GeneratePresignedUrlResponse,
} from "../schemas/presigned-url.schema.js";

export const DEFAULT_PRESIGNED_URL_EXPIRATION_SECONDS = 900; // 15 minutos

/**
 * Sanitiza o nome do arquivo para mitigar ataques de directory traversal (ex: ../../etc)
 * e substitui caracteres especiais por underscores.
 */
export function sanitizeFileName(rawFileName: string): string {
  // Normaliza barras para formato POSIX e extrai somente o nome final do arquivo
  const normalized = rawFileName.replace(/\\/g, "/");
  const baseName = normalized.split("/").pop() || "arquivo";
  // Substitui caracteres não alfanuméricos (exceto ponto, hífen e underline) por underline
  return baseName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export interface GeneratePresignedUrlOptions {
  s3Client?: S3Client;
  bucketName?: string;
  expiresIn?: number;
  timestamp?: number;
}

export interface LambdaHttpResult {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

/**
 * Retorna o cliente S3 configurado, garantindo credenciais de contingência
 * para execução 100% offline em suítes de testes unitários.
 */
export function createDefaultS3Client(): S3Client {
  return new S3Client({
    region: process.env["AWS_REGION"] || process.env["DEFAULT_REGION"] || "us-east-1",
    credentials: {
      accessKeyId: process.env["AWS_ACCESS_KEY_ID"] || "mock-access-key",
      secretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"] || "mock-secret-key",
      sessionToken: process.env["AWS_SESSION_TOKEN"],
    },
  });
}

/**
 * Função de negócio para geração de Presigned URL no S3.
 */
export async function generatePresignedUrl(
  input: GeneratePresignedUrlInput,
  options?: GeneratePresignedUrlOptions
): Promise<GeneratePresignedUrlResponse> {
  const bucketName = options?.bucketName || process.env["BUCKET_NAME"];

  if (!bucketName || bucketName.trim() === "") {
    throw new Error(
      "Configuração ausente: A variável de ambiente BUCKET_NAME e obrigatória para geração da Presigned URL."
    );
  }

  const s3Client = options?.s3Client || createDefaultS3Client();
  const expiresIn = options?.expiresIn ?? DEFAULT_PRESIGNED_URL_EXPIRATION_SECONDS;
  const timestamp = options?.timestamp ?? Date.now();

  const sanitized = sanitizeFileName(input.fileName);
  const fileKey = `terrenos/raw/${input.projetoId}/${timestamp}-${sanitized}`;

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: fileKey,
    ContentType: input.contentType,
    Metadata: {
      "projeto-id": input.projetoId,
      "original-name": input.fileName,
    },
  });

  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn });

  return {
    uploadUrl,
    fileKey,
    expiresIn,
  };
}

/**
 * Handler Lambda padrão para requisições de Presigned URL (suporta API Gateway e invocações diretas).
 */
export const handler = async (
  event: any,
  options?: GeneratePresignedUrlOptions
): Promise<LambdaHttpResult> => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
  };

  try {
    let payload = event;

    // Se o evento vier encapsulado pelo API Gateway
    if (event && typeof event.body === "string") {
      try {
        payload = JSON.parse(event.body);
      } catch {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: "BadRequest",
            message: "O corpo da requisição deve ser um JSON válido.",
          }),
        };
      }
    }

    // Validação de entrada contra o Schema Zod
    const validationResult = generatePresignedUrlInputSchema.safeParse(payload);

    if (!validationResult.success) {
      const issues = validationResult.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      }));

      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "ValidationError",
          message: "Dados de requisição inválidos para geração da Presigned URL.",
          issues,
        }),
      };
    }

    const result = await generatePresignedUrl(validationResult.data, options);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result),
    };
  } catch (error: any) {
    console.error("[get-presigned-url] Erro ao processar requisição:", error);

    const isConfigurationError = error?.message?.includes("BUCKET_NAME");

    return {
      statusCode: isConfigurationError ? 500 : 500,
      headers,
      body: JSON.stringify({
        error: isConfigurationError ? "ConfigurationError" : "InternalServerError",
        message: error?.message || "Erro interno ao gerar Presigned URL no S3.",
      }),
    };
  }
};
