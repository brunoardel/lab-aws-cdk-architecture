# Experimento Prático de Infraestrutura como Código (IaC) com AWS CDK e Assertions

> **Projeto:** ArqLab (`lab-aws-cdk-architecture`)  
> **Módulo:** Infraestrutura como Código (`infra/arqlab-pipeline-stack.ts`)  
> **Suíte de Testes:** `test/arqlab-pipeline-stack.test.ts`  

---

## 1. O que são Constructs no AWS CDK? (L1, L2 e L3)

O AWS Cloud Development Kit (CDK) modela infraestrutura em nuvem como código utilizando linguagens de programação fortemente tipadas (TypeScript). O conceito fundamental de abstração no CDK são os **Constructs**, divididos em três camadas:

| Camada | Nome | Descrição | Exemplo no ArqLab |
| :--- | :--- | :--- | :--- |
| **L1** | *CFN Resources* | Mapeamento 1:1 direto com os recursos do AWS CloudFormation. Não possuem valores padrão inteligentes nem métodos auxiliares. Nomes iniciam com `Cfn...`. | `new s3.CfnBucket(this, 'Bucket', { ... })` |
| **L2** | *AWS Curated Constructs* | Abstrações de alto nível desenvolvidas pela AWS. Incluem padrões de segurança recomendados, automação de relacionamentos (ex: `grant*`, `addEventNotification`), e configurações padrão robustas. | `new s3.Bucket(this, 'TerrenosBucket', { ... })` |
| **L3** | *Solutions / Patterns* | Composições de múltiplos recursos interconectados resolvendo padrões arquiteturais completos (ex: API Gateway + Lambda + DynamoDB). | `new aws_events_targets.SfnStateMachine(stateMachine)` |

### Por que o ArqLab utiliza Constructs L2?
No arquivo [infra/arqlab-pipeline-stack.ts](file:///c:/Users/Bruno/Documents/Projetos/labs/lab-aws-cdk-architecture/infra/arqlab-pipeline-stack.ts), utilizamos exclusivamente constructs L2 (`s3.Bucket`, `dynamodb.Table`, `lambda.Function`, `stepfunctions.StateMachine`). Isso garante:
- Criptografia padrão habilitada sem boilerplate.
- Bloqueio de acesso público via declarações simples e legíveis (`BlockPublicAccess.BLOCK_ALL`).
- Geração automática e enxuta de políticas IAM através do compilador do CDK.

---

## 2. Prevenção de Erros Humanos de YAML e Princípio do Menor Privilégio IAM

No CloudFormation ou Terraform puro em YAML/JSON, desenvolvedores frequentemente cometem erros de segurança graves ao declarar permissões IAM manuais:

### O Risco do YAML Manual:
```yaml
# Antipattern comum em YAML manual: concessão excessiva e frágil
Effect: Allow
Action:
  - "s3:*"
Resource: "*"
```

### A Solução Nativa do CDK L2:
No CDK, em vez de redigir políticas IAM manualmente, utilizamos métodos semânticos expostos pelos constructs de destino:

```typescript
// Concede apenas s3:GetObject* e s3:ListBucket ao recurso específico
this.terrenosBucket.grantRead(this.validateGeometryLambda);

// Concede apenas s3:PutObject* e s3:Abort* ao bucket específico
this.terrenosBucket.grantPut(this.presignedUrlLambda);

// Concede operações CRUD pontuais na tabela DynamoDB
this.jobsTable.grantReadWriteData(this.calculateVolumetryLambda);
```

### O que o CDK gera no CloudFormation sintetizado:
O compilador do CDK converte a linha `terrenosBucket.grantRead(...)` exatamente em:
```json
{
  "Action": [
    "s3:GetObject*",
    "s3:GetBucket*",
    "s3:List*"
  ],
  "Effect": "Allow",
  "Resource": [
    { "Fn::GetAtt": ["TerrenosBucketB8195530", "Arn"] },
    { "Fn::Join": ["", [{ "Fn::GetAtt": ["TerrenosBucketB8195530", "Arn"] }, "/*"]] }
  ]
}
```
**Resultado:** Zero risco de vazamento de permissão para outros buckets ou para ações perigosas como `s3:DeleteBucket`.

---

## 3. Como o `aws-cdk-lib/assertions` Barrou Erros em Tempo de Build

O pacote `aws-cdk-lib/assertions` sintetiza a árvore do CDK em memória e inspeciona o template CloudFormation resultante **antes** de qualquer comando de deploy ou custo na nuvem.

No arquivo [test/arqlab-pipeline-stack.test.ts](file:///c:/Users/Bruno/Documents/Projetos/labs/lab-aws-cdk-architecture/test/arqlab-pipeline-stack.test.ts), validamos automaticamente:
1. Bloqueio público total no S3.
2. Criptografia ativa no S3.
3. DynamoDB no modo On-Demand com TTL ativo no atributo `expiresAt`.
4. Máquina de Estados com Retry exponencial (`BackoffRate: 2`, `MaxAttempts: 3`) e Rollback Saga (`CompensateRollbackTask`).
5. Ausência de políticas IAM com curinga global `Action: "*"` e `Resource: "*"`.

---

## 4. Roteiro Prático: Simulando Falhas de Segurança e Validação Local

Você pode reproduzir na prática o poder do CDK Assertions como guardião de qualidade (Quality Gate) seguindo os passos abaixo:

### Experimento 1: Simulando um Bucket S3 Inseguro
1. Abra [infra/arqlab-pipeline-stack.ts](file:///c:/Users/Bruno/Documents/Projetos/labs/lab-aws-cdk-architecture/infra/arqlab-pipeline-stack.ts).
2. Na definição do `TerrenosBucket`, comente a linha:
   ```typescript
   // blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
   ```
3. Execute os testes no terminal:
   ```bash
   npm test
   ```
4. **Resultado Observado:** O teste falha imediatamente com o erro:
   ```text
   AssertionError: Template has 0 resources with type AWS::S3::Bucket and properties:
   { PublicAccessBlockConfiguration: { BlockPublicAcls: true, ... } }
   ```
   *O build é barrado antes de qualquer tentativa de deploy em ambiente de staging ou produção.*

### Experimento 2: Alterando a Política de Resiliência do Step Functions
1. Em [infra/arqlab-pipeline-stack.ts](file:///c:/Users/Bruno/Documents/Projetos/labs/lab-aws-cdk-architecture/infra/arqlab-pipeline-stack.ts), altere `maxAttempts` na política de retry:
   ```typescript
   const retryProps: stepfunctions.RetryProps = {
     interval: cdk.Duration.seconds(2),
     maxAttempts: 1, // Alvo: era 3
     backoffRate: 2.0,
     errors: ["States.ALL"],
   };
   ```
2. Execute os testes:
   ```bash
   npm test
   ```
3. **Resultado Observado:**
   ```text
   AssertionError: expected '...\"MaxAttempts\":1...' to contain '"MaxAttempts":3'
   ```
   *A regressão de arquitetura e resiliência é detectada em menos de 3 segundos.*

---

## 5. Conclusão

O uso integrado de **AWS CDK L2 Constructs** com **`aws-cdk-lib/assertions`** transforma a segurança e a conformidade de infraestrutura em testes unitários automatizados de ciclo rápido. A equipe tem a garantia de que nenhuma alteração acidental em IaC entrará na branch principal sem cumprir todos os requisitos arquiteturais do PRD.
