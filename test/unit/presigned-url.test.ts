import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import {
  handler,
  generatePresignedUrl,
  sanitizeFileName,
  DEFAULT_PRESIGNED_URL_EXPIRATION_SECONDS,
} from "../../src/handlers/get-presigned-url.js";
import { MAX_FILE_SIZE_BYTES } from "../../src/schemas/presigned-url.schema.js";

describe("Ingestão de Terrenos - S3 Presigned URL & Zod Validation (Tarefa 3)", () => {
  const s3Mock = mockClient(S3Client);
  const originalEnv = process.env;

  beforeEach(() => {
    s3Mock.reset();
    process.env = {
      ...originalEnv,
      BUCKET_NAME: "arqlab-terrenos-raw-bucket-test",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "mock-access-key-id",
      AWS_SECRET_ACCESS_KEY: "mock-secret-access-key",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // =========================================================================
  // 1. Testes de Sanitização de Nome de Arquivo (Directory Traversal)
  // =========================================================================
  describe("Função sanitizeFileName()", () => {
    it("deve remover caminhos relativos e directory traversal (../../)", () => {
      const malicious = "../../../etc/passwd/planta_terreno.dwg";
      const sanitized = sanitizeFileName(malicious);
      expect(sanitized).toBe("planta_terreno.dwg");
      expect(sanitized).not.toContain("../");
    });

    it("deve normalizar separadores do Windows (\\) e remover caminhos absolutos", () => {
      const winPath = "C:\\Projetos\\ArqLab\\topografia.kmz";
      const sanitized = sanitizeFileName(winPath);
      expect(sanitized).toBe("topografia.kmz");
      expect(sanitized).not.toContain("\\");
      expect(sanitized).not.toContain(":");
    });

    it("deve substituir caracteres perigosos ou especiais por underscores", () => {
      const special = "terreno #01 @zona-sul (v2) [final].dwg";
      const sanitized = sanitizeFileName(special);
      expect(sanitized).toBe("terreno__01__zona-sul__v2___final_.dwg");
    });
  });

  // =========================================================================
  // 2. Fluxos de Sucesso (Happy Paths)
  // =========================================================================
  describe("Geração Bem-Sucedida de Presigned URL", () => {
    it("deve gerar Presigned URL para arquivo .dwg válido com expiração de 15 minutos (900s)", async () => {
      const fixedTimestamp = 1700000000000;
      const input = {
        projetoId: "proj-12345",
        fileName: "terreno-loteamento.dwg",
        fileSizeBytes: 25 * 1024 * 1024, // 25 MB
        contentType: "application/acad" as const,
      };

      const response = await generatePresignedUrl(input, {
        timestamp: fixedTimestamp,
      });

      expect(response.uploadUrl).toBeDefined();
      expect(response.uploadUrl).toContain("https://arqlab-terrenos-raw-bucket-test.s3.us-east-1.amazonaws.com");
      expect(response.fileKey).toBe(`terrenos/raw/proj-12345/${fixedTimestamp}-terreno-loteamento.dwg`);
      expect(response.expiresIn).toBe(DEFAULT_PRESIGNED_URL_EXPIRATION_SECONDS);
      expect(response.uploadUrl).toContain("X-Amz-Expires=900");
    });

    it("deve aceitar arquivo .kmz com extensão em maiúsculas (.KMZ) e sanitizar o nome", async () => {
      const fixedTimestamp = 1700000005000;
      const event = {
        projetoId: "proj-alphaville",
        fileName: "../../upload/LEVENTAMENTO_TOPOGRAFICO.KMZ",
        fileSizeBytes: 80 * 1024 * 1024, // 80 MB
      };

      const result = await handler(event, { timestamp: fixedTimestamp });
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.fileKey).toBe(`terrenos/raw/proj-alphaville/${fixedTimestamp}-LEVENTAMENTO_TOPOGRAFICO.KMZ`);
      expect(body.uploadUrl).toContain("arqlab-terrenos-raw-bucket-test");
      expect(body.expiresIn).toBe(900);
    });

    it("deve processar requisições encapsuladas no padrão API Gateway Proxy Event", async () => {
      const apiGatewayEvent = {
        httpMethod: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projetoId: "proj-apigw-001",
          fileName: "curvas-de-nivel.dwg",
          fileSizeBytes: 10 * 1024 * 1024,
        }),
      };

      const result = await handler(apiGatewayEvent);
      expect(result.statusCode).toBe(200);
      expect(result.headers?.["Content-Type"]).toBe("application/json");

      const body = JSON.parse(result.body);
      expect(body.uploadUrl).toBeDefined();
      expect(body.fileKey).toContain("terrenos/raw/proj-apigw-001/");
    });
  });

  // =========================================================================
  // 3. Validações de Regra de Negócio com Zod (Status 400)
  // =========================================================================
  describe("Validação Zod e Casos de Erro de Entrada (HTTP 400)", () => {
    it("deve rejeitar extensões não autorizadas (ex: .pdf, .zip, .exe)", async () => {
      const invalidFiles = ["documento.pdf", "script.exe", "backup.zip", "imagem.png"];

      for (const fileName of invalidFiles) {
        const result = await handler({
          projetoId: "proj-test",
          fileName,
          fileSizeBytes: 1024,
        });

        expect(result.statusCode).toBe(400);
        const body = JSON.parse(result.body);
        expect(body.error).toBe("ValidationError");
        expect(body.issues[0].field).toBe("fileName");
        expect(body.issues[0].message).toContain("Extensao invalida");
      }
    });

    it("deve rejeitar arquivos que excedam o limite máximo configurado (200 MB)", async () => {
      const exceededSize = MAX_FILE_SIZE_BYTES + 1; // 200 MB + 1 byte

      const result = await handler({
        projetoId: "proj-heavy",
        fileName: "terreno-gigante.dwg",
        fileSizeBytes: exceededSize,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toBe("ValidationError");
      expect(body.issues[0].field).toBe("fileSizeBytes");
      expect(body.issues[0].message).toContain("200 MB");
    });

    it("deve rejeitar tamanho de arquivo menor ou igual a zero ou decimal", async () => {
      const invalidSizes = [0, -500, 10.5];

      for (const fileSizeBytes of invalidSizes) {
        const result = await handler({
          projetoId: "proj-size-test",
          fileName: "terreno.dwg",
          fileSizeBytes,
        });

        expect(result.statusCode).toBe(400);
        const body = JSON.parse(result.body);
        expect(body.error).toBe("ValidationError");
        expect(body.issues[0].field).toBe("fileSizeBytes");
      }
    });

    it("deve rejeitar projetoId ou fileName vazios ou contendo apenas espaços", async () => {
      const result = await handler({
        projetoId: "   ",
        fileName: "   ",
        fileSizeBytes: 1024,
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toBe("ValidationError");
      expect(body.issues.length).toBeGreaterThanOrEqual(2);
    });

    it("deve retornar 400 se o corpo do evento do API Gateway for um JSON corrompido", async () => {
      const malformedEvent = {
        body: "{ malformed json string ...",
      };

      const result = await handler(malformedEvent);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toBe("BadRequest");
    });
  });

  // =========================================================================
  // 4. Falha de Configuração de Ambiente (Status 500)
  // =========================================================================
  describe("Tratamento de Falhas de Configuração", () => {
    it("deve retornar status 500 caso a variável de ambiente BUCKET_NAME não esteja definida", async () => {
      delete process.env["BUCKET_NAME"];

      const result = await handler({
        projetoId: "proj-1",
        fileName: "terreno.dwg",
        fileSizeBytes: 5000,
      });

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.error).toBe("ConfigurationError");
      expect(body.message).toContain("BUCKET_NAME");
    });
  });
});
