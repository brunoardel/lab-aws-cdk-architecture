# PRD — ArqLab: Arquitetura Serverless Orientada a Eventos na AWS

> **Identificador do Projeto:** `lab-aws-cdk-architecture`  
> **Nome de Referência:** ArqLab  
> **Status:** Em Desenvolvimento  
> **Versão:** 1.0.0  

---

## 1. Visão Geral do Produto

O **ArqLab** é uma referência arquitetural corporativa de alta resiliência baseada em computação Serverless e orquestração de fluxos orientados a eventos na AWS. O objetivo do projeto é demonstrar as melhores práticas em:

1. **Ingestão Segura e Desacoplada**: Upload direto de payloads para o Amazon S3 utilizando URLs pré-assinadas (*Presigned URLs*), sem sobrecarregar APIs síncronas.
2. **Reatividade a Eventos**: Disparo automático de eventos via Amazon EventBridge a partir da criação de objetos no S3.
3. **Orquestração Resiliente com Step Functions**: Execução de máquina de estados com políticas de repetição (*Retry/Backoff* com jitter) e compensação transacional distribuída (*Saga Pattern / Rollback*).
4. **Processamento Especializado com AWS Lambda**: Execução de funções computacionais (cálculos geométricos e validação estrutural).
5. **Idempotência At-Least-Once no Amazon DynamoDB**: Prevenção de duplicidade e controle atômico de estado por meio de *Conditional Writes* (`attribute_not_exists`).
6. **Desenvolvimento e Validação 100% Offline (Zero Cost)**: Todos os testes, validações de síntese e fluxos funcionais são testados sem dependência de credenciais da nuvem através de `aws-cdk-lib/assertions`, `aws-sdk-client-mock`, Vitest e emulação opcional leve com Floci.
7. **Simulador Visual Interativo**: Ferramenta gráfica local no navegador reproduzindo o AWS Management Console e o Workflow Studio do Step Functions para visualização viva dos estados do pipeline.

---

## 2. Motivação e Problemas Resolvidos

| Desafio Arquitetural | Abordagem Tradicional | Solução ArqLab |
| :--- | :--- | :--- |
| **Gargalo de Upload de Arquivos** | APIs REST síncronas recebendo payloads multipart | **S3 Presigned URLs**: cliente envia diretamente ao S3 com restrição de chave e tempo de expiração |
| **Perda ou Duplicação de Mensagens** | Consumo sem garantia ou sem chave de idempotência | **DynamoDB Conditional Writes**: bloqueio de re-execução atômica em entregas *At-Least-Once* |
| **Falhas Parciais em Múltiplas Etapas** | Estados inconsistentes deixados no banco | **Saga Pattern no Step Functions**: estágio compensatório de rollback em caso de falha irreversível |
| **Custo e Complexidade de Testes** | Contas dedicadas na nuvem para deploy de testes | **CDK Assertions + SDK Client Mocks + Vitest**: validação de 100% dos recursos em milissegundos localmente |

---

## 3. Arquitetura da Solução

```
+----------------------------------------------------------------------------------+
|                                    ARQLAB                                        |
+----------------------------------------------------------------------------------+

   [ Cliente / Front-end ]
              |
              | 1. Solicita URL de Ingestão (Validação Zod)
              v
   [ Ingestion Presigner ] ----(Gera URL com restrição de tempo/hash)----+
              |                                                          |
              | 2. Upload direto do payload                              |
              v                                                          v
   +----------------------+                                     +------------------+
   |   Amazon S3 Bucket   |                                     | Amazon DynamoDB  |
   | (arqlab-raw-payload) |                                     | (arqlab-jobs)    |
   +----------+-----------+                                     +--------+---------+
              |                                                          ^
              | 3. Evento ObjectCreated                                  |
              v                                                          |
   +----------------------+                                              |
   |  Amazon EventBridge  |                                              |
   +----------+-----------+                                              |
              |                                                          |
              | 4. Dispara Execução da Máquina de Estados                |
              v                                                          |
   +------------------------------------------------------------------+  |
   |             AWS Step Functions (ArqLabStateMachine)              |  |
   |                                                                  |  |
   |  [ Task 1: Check & Lock Idempotency ] ---------------------------+--+
   |             | (Conditional Write: attribute_not_exists)          |
   |             v                                                    |
   |  [ Task 2: Geometric Calculation Lambda ]                        |
   |             | (Retry: 3x, BackoffRate: 2.0, Jitter: FULL)        |
   |             +----------------------------------+                 |
   |             | Sucesso                          | Falha Fatal     |
   |             v                                  v                 |
   |  [ Task 3: Complete Job ]            [ Task 4: Saga Rollback ] --+
   |             |                                  |
   +-------------|----------------------------------|-----------------+
                 v                                  v
          Status: COMPLETED                  Status: FAILED / ROLLED_BACK
```

---

## 4. Componentes e Tecnologias

### 4.1. Infraestrutura como Código (IaC)
- **AWS CDK v2 (`aws-cdk-lib`)**: Definição tipada de todos os recursos (S3, EventBridge, Step Functions, DynamoDB, Lambdas, Roles IAM com Princípio do Menor Privilégio).
- **Constructs**: `constructs` v10.

### 4.2. Runtime e Aplicação
- **TypeScript**: Linguagem unificada da infraestrutura aos handlers (`strict: true`, `noUncheckedIndexedAccess: true`).
- **AWS SDK v3**:
  - `@aws-sdk/client-s3` & `@aws-sdk/s3-request-presigner`
  - `@aws-sdk/client-dynamodb` & `@aws-sdk/lib-dynamodb`
- **Zod**: Validação de contratos de payload e esquemas de entrada.

### 4.3. Estratégia de Testes e Simulação
- **`aws-cdk-lib/assertions`**:
  - Testes granulares de CloudFormation com `Template.fromStack(stack)`.
  - Asserções de propriedades de recursos (`hasResourceProperties`).
  - Verificação de políticas IAM e contagens de recursos (`resourceCountIs`).
- **`aws-sdk-client-mock`**:
  - Mock de comandos de S3 (`PutObjectCommand`, etc.) e DynamoDB (`PutCommand`, `GetCommand`).
  - Validação de idempotência e simulação de erros `ConditionalCheckFailedException`.
- **Vitest**:
  - Runner nativo de testes de alta performance com suporte imediato a TypeScript.
- **Floci (Docker Compose opcional)**:
  - Emulador local ultraleve com interface visual em `http://localhost:4566/_floci/ui`.
- **Simulador Visual Interativo (HTML5/CSS3/Vanilla JS)**:
  - Painel visual interativo na pasta `simulator/` com representação do Console S3, Tabela DynamoDB e Grafo interativo do Workflow Studio do Step Functions.

---

## 5. Requisitos Funcionais

1. **RF-01 - Geração de URL Pré-Assinada de Ingestão**:
   - Serviço gera presigned URL com expiração de 15 minutos (900s).
   - O objeto deve respeitar o padrão de chave `raw/{tenantId}/{jobId}.json`.

2. **RF-02 - Validação de Contrato do Payload**:
   - Payload geométrico contendo polígonos, vértices, dimensões e identificador do cliente validado por schema Zod.

3. **RF-03 - Controle de Idempotência no DynamoDB**:
   - Chave de partição `jobId` (String).
   - Tentativa de inserção do registro inicial com status `PENDING` utilizando condição `attribute_not_exists(jobId)`.
   - Se já existir, interrompe o fluxo ou marca duplicidade sem refazer o cálculo custoso.

4. **RF-04 - Execução da Máquina de Estados**:
   - Estado de cálculo executado por função Lambda.
   - Retry configurado para erros transitórios (`Lambda.ServiceException`, `Lambda.TooManyRequestsException`).
   - Catch para captura de falhas de negócio ou timeouts redirecionando para a etapa de compensação (*Saga Rollback*).

5. **RF-05 - Compensação Transacional (Saga Rollback)**:
   - Handler dedicado atualiza o registro no DynamoDB para `ROLLED_BACK`, grava o motivo da falha e emite métricas/logs detalhados.

---

## 6. Requisitos Não-Funcionais

- **RNF-01 - Autonomia Local**: Não exigir credenciais AWS reais nem custos para execução dos testes.
- **RNF-02 - Tipagem Estrita**: TypeScript configurado com as diretivas mais rigorosas de segurança de tipos.
- **RNF-03 - Segurança de Acesso (Least Privilege)**: Políticas IAM geradas pelo CDK contêm apenas permissões mínimas necessárias entre os serviços.
- **RNF-04 - Tempo de Execução de Testes**: Suíte de testes completa executando em menos de 5 segundos.
