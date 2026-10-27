import { z } from "zod";

/**
 * Limite máximo permitido para upload de terrenos (200 MB).
 */
export const MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024;

/**
 * Extensões de arquivos de terrenos e topografia permitidas no ArqLab.
 */
export const ALLOWED_EXTENSIONS = [".dwg", ".kmz"] as const;

/**
 * MIME types aceitos para ingestão de arquivos pesados.
 */
export const ALLOWED_CONTENT_TYPES = [
  "application/acad",
  "application/x-acad",
  "application/autocad_dwg",
  "image/vnd.dwg",
  "application/vnd.google-earth.kmz",
  "application/octet-stream",
] as const;

/**
 * Schema Zod para validação da requisição de geração de URL pré-assinada.
 */
export const generatePresignedUrlInputSchema = z.object({
  projetoId: z
    .string()
    .trim()
    .min(1, "O identificador do projeto (projetoId) e obrigatorio."),
  fileName: z
    .string()
    .trim()
    .min(1, "O nome do arquivo (fileName) e obrigatorio.")
    .refine(
      (name) => {
        const lower = name.toLowerCase();
        return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
      },
      {
        message: `Extensao invalida. Apenas arquivos com extensoes ${ALLOWED_EXTENSIONS.join(", ")} sao permitidos.`,
      }
    ),
  fileSizeBytes: z
    .number()
    .int("O tamanho do arquivo deve ser um numero inteiro.")
    .positive("O tamanho do arquivo deve ser maior que zero.")
    .max(
      MAX_FILE_SIZE_BYTES,
      `O tamanho do arquivo nao pode ultrapassar ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB (200 MB).`
    ),
  contentType: z
    .enum(ALLOWED_CONTENT_TYPES)
    .optional()
    .default("application/octet-stream"),
});

/**
 * Schema Zod para o contrato de resposta com a URL pré-assinada gerada.
 */
export const generatePresignedUrlResponseSchema = z.object({
  uploadUrl: z.string().url("A URL pre-assinada deve ser uma URL valida."),
  fileKey: z.string().min(1, "A chave do arquivo no S3 e obrigatoria."),
  expiresIn: z.number().int().positive(),
});

export type GeneratePresignedUrlInput = z.infer<typeof generatePresignedUrlInputSchema>;
export type GeneratePresignedUrlResponse = z.infer<typeof generatePresignedUrlResponseSchema>;
