# Backlog de Tarefas — ArqLab

Acompanhamento de entregas do laboratório de arquitetura serverless orientada a eventos na AWS com CDK e Step Functions.

---

### Tarefas do Projeto

- [x] **Tarefa 1: Setup do Projeto, AWS CDK, AWS SDK v3, Vitest e Docker Compose opcional com Floci**
  - [x] Criação da documentação base (`docs/PRD.md` e `docs/TASKS.md`).
  - [x] Inicialização do `package.json` com dependências AWS CDK, AWS SDK v3 e Vitest.
  - [x] Configuração do `tsconfig.json` (`strict: true`, `noUncheckedIndexedAccess: true`) e `vitest.config.ts`.
  - [x] Criação da estrutura de pastas (`infra/`, `src/handlers/`, `src/services/`, `src/schemas/`, `test/`).
  - [x] Criação do `docker-compose.yml` para emulador Floci opcional e instruções no `README.md`.
  - [x] Teste de sanidade do CDK Assertions (`Template.fromStack`) em `test/setup.test.ts`.
  - [x] Validação de scripts `npm run typecheck` e `npm test`.

- [x] **Tarefa 2: Infraestrutura como Código com AWS CDK (`ArqLabPipelineStack`) e testes de infraestrutura com `aws-cdk-lib/assertions`**
  - [x] Definição do Bucket S3 com notificações habilitadas para EventBridge.
  - [x] Definição da Tabela DynamoDB com chave de partição `jobId` e BillingMode Pay-Per-Request.
  - [x] Definição das Lambdas de cálculo geométrico e rollback saga com permissões mínimas.
  - [x] Criação da Máquina de Estados Step Functions com estados de validação, retry, catch e compensação saga.
  - [x] Suíte de testes de infraestrutura com `aws-cdk-lib/assertions` (validação de recursos CloudFormation gerados).

- [x] **Tarefa 3: Ingestão Segura com S3 Presigned URLs, validação Zod e testes com `aws-sdk-client-mock`**
  - [x] Schemas Zod de validação para metadados de upload e payload de cálculo geométrico.
  - [x] Serviço gerador de Presigned URLs com controle de expiração e restrições de caminho S3.
  - [x] Testes unitários com `aws-sdk-client-mock` para S3 Client e presigner.

- [x] **Tarefa 4: Idempotência Condicional no DynamoDB (`attribute_not_exists`) e Handlers do Step Functions (Cálculo + Saga Rollback)**
  - [x] Serviço de persistência no DynamoDB com trava condicional de idempotência (`attribute_not_exists(jobId)`).
  - [x] Handler Lambda do cálculo geométrico com tratamento de erros simulados e retry.
  - [x] Handler Lambda do Rollback Saga para atualização do DynamoDB em caso de falha irreversível.
  - [x] Testes unitários cobrindo cenários de sucesso, duplicidade de job (idempotência) e falha/rollback.

- [ ] **Tarefa 5: Simulador Visual Interativo da Arquitetura AWS (Console S3/DynamoDB + Grafo do Step Functions Workflow Studio em HTML/JS)**
  - [ ] Interface visual interativa simulando o console AWS (Bucket S3, Tabela DynamoDB).
  - [ ] Grafo de estados interativo no estilo Workflow Studio do Step Functions com animação do fluxo de execução.
  - [ ] Painel de logs de execução e disparador de cenários (Sucesso, Duplicidade/Idempotência e Falha/Rollback).
