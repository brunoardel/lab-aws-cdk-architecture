# ArqLab — Arquitetura Serverless Orientada a Eventos na AWS

Referência de arquitetura e laboratório prático para engenharia de software e infraestrutura em nuvem (IaC) com **AWS CDK v2**, **AWS Step Functions**, **Amazon DynamoDB**, **Amazon S3** e **AWS Lambda**, validado **100% localmente sem custos ou necessidade de conta na AWS**.

---

## 🏛️ Visão Geral da Arquitetura

O **ArqLab** implementa um pipeline assíncrono e resiliente para ingestão e processamento de cálculos técnicos:

1. **Ingestão Segura**: Upload de arquivos via S3 Presigned URLs com restrição de chave e tempo de vida controlado.
2. **Reatividade a Eventos**: Notificações S3 via Amazon EventBridge para desacoplamento completo.
3. **Orquestração com Step Functions**:
   - Controle atômico de idempotência (*Conditional Writes* no DynamoDB).
   - Execução de cálculo geométrico com políticas de *Retry Exponencial com Jitter*.
   - Tratamento de falhas com o padrão *Saga Rollback* para compensação de estado.
4. **Persistência Confiável**: DynamoDB armazenando o ciclo de vida do job (`PENDING` -> `PROCESSING` -> `COMPLETED` / `ROLLED_BACK`).

---

## ⚡ Validação 100% Local (Zero Custos & Offline-First)

Este projeto foi projetado com a premissa **Offline-First**:
- **Testes de Infraestrutura (IaC)**: Feitos com `@aws-cdk-lib/assertions`, inspecionando o CloudFormation sintetizado.
- **Testes Unitários & Lógica de Negócio**: Feitos com `vitest` e `aws-sdk-client-mock`, simulando com exatidão chamadas ao S3 e DynamoDB.
- **Sem Docker Obrigatório**: Todos os testes unitários e de síntese rodam diretamente via Node/TypeScript em segundos.

---

## 🐳 Emulador Local Opcional (Floci)

Caso você deseje rodar os serviços AWS em um emulador local e interagir com um console web visual, o projeto inclui o emulador leve **Floci**:

```bash
# Iniciar o emulador local em background
docker compose up -d

# Acessar a interface Web do Floci no navegador
# http://localhost:4566/_floci/ui

# Parar o emulador
docker compose down
```

---

## 🚀 Como Começar

### Pré-requisitos
- Node.js >= 20.x
- npm >= 10.x
- Docker (Opcional, apenas se quiser subir o Floci)

### Instalação
```bash
npm install
```

### Comandos Disponíveis

| Comando | Descrição |
| :--- | :--- |
| `npm test` | Executa a suíte de testes com Vitest |
| `npm run test:watch` | Executa os testes em modo interativo contínuo |
| `npm run typecheck` | Validação estrita de tipos do TypeScript sem emitir arquivos |

---

## 📁 Estrutura do Projeto

```
lab-aws-cdk-architecture/
├── docs/
│   ├── PRD.md               # Especificação de Requisitos do Produto
│   └── TASKS.md             # Backlog e checklist de tarefas do laboratório
├── infra/                   # Código de Infraestrutura como Código (AWS CDK)
├── src/
│   ├── handlers/            # Funções AWS Lambda (Cálculo, Saga Rollback, etc.)
│   ├── schemas/             # Schemas Zod de validação de dados e contratos
│   └── services/            # Serviços de integração (S3 Presigner, DynamoDB)
├── test/                    # Testes de infraestrutura (assertions) e unitários (mocks)
├── docker-compose.yml       # Emulador leve Floci opcional (porta 4566 + UI)
├── tsconfig.json            # Configuração estrita do TypeScript
├── vitest.config.ts         # Configuração do runner de testes Vitest
└── README.md                # Guia do projeto e documentação
```
