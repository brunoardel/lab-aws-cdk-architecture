import { describe, it, expect, beforeAll } from "vitest";
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { ArqLabPipelineStack } from "../infra/arqlab-pipeline-stack.js";

describe("ArqLabPipelineStack - Infraestrutura como Código (CDK Assertions)", () => {
  let app: cdk.App;
  let stack: ArqLabPipelineStack;
  let template: Template;

  beforeAll(() => {
    app = new cdk.App();
    stack = new ArqLabPipelineStack(app, "TestArqLabPipelineStack", {
      env: {
        account: "123456789012",
        region: "us-east-1",
      },
    });
    template = Template.fromStack(stack);
  });

  // =========================================================================
  // 1. Validações do Bucket Amazon S3
  // =========================================================================
  describe("Amazon S3 (TerrenosBucket)", () => {
    it("deve bloquear 100% de acesso público via PublicAccessBlockConfiguration", () => {
      template.hasResourceProperties("AWS::S3::Bucket", {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    it("deve possuir criptografia em repouso gerenciada pelo S3 (SSE-S3 / AES256)", () => {
      template.hasResourceProperties("AWS::S3::Bucket", {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: "AES256",
              },
            },
          ],
        },
      });
    });

    it("deve configurar regras de CORS permitindo PUT para upload via Presigned URL", () => {
      template.hasResourceProperties("AWS::S3::Bucket", {
        CorsConfiguration: {
          CorsRules: Match.arrayWith([
            Match.objectLike({
              AllowedMethods: ["PUT"],
              AllowedOrigins: ["*"],
              AllowedHeaders: ["*"],
            }),
          ]),
        },
      });
    });
  });

  // =========================================================================
  // 2. Validações do Amazon DynamoDB
  // =========================================================================
  describe("Amazon DynamoDB (JobsIdempotencyTable)", () => {
    it("deve estar configurada no modo Serverless On-Demand (PAY_PER_REQUEST)", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
      });
    });

    it("deve possuir TTL (Time To Live) ativado no atributo expiresAt para expiração automática", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TimeToLiveSpecification: {
          AttributeName: "expiresAt",
          Enabled: true,
        },
      });
    });
  });

  // =========================================================================
  // 3. Validações do AWS Step Functions (State Machine & Saga Pattern)
  // =========================================================================
  describe("AWS Step Functions (ArqLabStateMachine)", () => {
    it("deve criar exatamente 1 State Machine orquestradora", () => {
      template.resourceCountIs("AWS::StepFunctions::StateMachine", 1);
    });

    it("deve conter políticas de Retry com Backoff Exponencial (BackoffRate: 2, MaxAttempts: 3)", () => {
      const stateMachines = template.findResources("AWS::StepFunctions::StateMachine");
      const smLogicalId = Object.keys(stateMachines)[0] as string;
      const definitionJoin = stateMachines[smLogicalId]?.Properties?.DefinitionString?.["Fn::Join"];

      expect(definitionJoin).toBeDefined();
      const rawDefinitionParts: (string | object)[] = definitionJoin[1];
      const joinedDefinition = rawDefinitionParts
        .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
        .join("");

      // Validação de Retry Exponencial na definição da State Machine
      expect(joinedDefinition).toContain('"BackoffRate":2');
      expect(joinedDefinition).toContain('"MaxAttempts":3');
      expect(joinedDefinition).toContain('"IntervalSeconds":2');
    });

    it("deve conter política de Catch apontando para a tarefa de Rollback da Saga", () => {
      const stateMachines = template.findResources("AWS::StepFunctions::StateMachine");
      const smLogicalId = Object.keys(stateMachines)[0] as string;
      const definitionJoin = stateMachines[smLogicalId]?.Properties?.DefinitionString?.["Fn::Join"];

      const rawDefinitionParts: (string | object)[] = definitionJoin[1];
      const joinedDefinition = rawDefinitionParts
        .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
        .join("");

      // Validação de Catch e transição para o estado de compensação Saga
      expect(joinedDefinition).toContain('"Catch":[');
      expect(joinedDefinition).toContain('"CompensateRollbackTask"');
      expect(joinedDefinition).toContain('"PipelineFailed"');
    });
  });

  // =========================================================================
  // 4. Validações do Amazon EventBridge
  // =========================================================================
  describe("Amazon EventBridge (S3UploadRule)", () => {
    it("deve escutar o evento Object Created originado no Amazon S3", () => {
      template.hasResourceProperties("AWS::Events::Rule", {
        EventPattern: {
          source: ["aws.s3"],
          "detail-type": ["Object Created"],
        },
      });
    });

    it("deve apontar a State Machine do Step Functions como Target da Rule", () => {
      template.hasResourceProperties("AWS::Events::Rule", {
        Targets: Match.arrayWith([
          Match.objectLike({
            Arn: {
              Ref: Match.stringLikeRegexp("ArqLabStateMachine"),
            },
          }),
        ]),
      });
    });
  });

  // =========================================================================
  // 5. Validações de Segurança e Princípio do Menor Privilégio IAM
  // =========================================================================
  describe("Políticas de Segurança IAM (Menor Privilégio)", () => {
    it("não deve existir nenhuma política IAM com Action: '*' e Resource: '*' globais", () => {
      const policies = template.findResources("AWS::IAM::Policy");
      expect(Object.keys(policies).length).toBeGreaterThan(0);

      for (const [logicalId, policy] of Object.entries(policies)) {
        const statements = policy?.Properties?.PolicyDocument?.Statement ?? [];
        for (const statement of statements) {
          const hasWildcardAction =
            statement.Action === "*" ||
            (Array.isArray(statement.Action) && statement.Action.includes("*"));
          const hasWildcardResource =
            statement.Resource === "*" ||
            (Array.isArray(statement.Resource) && statement.Resource.includes("*"));

          if (hasWildcardAction && hasWildcardResource) {
            throw new Error(
              `Violação de menor privilégio detectada na política ${logicalId}: Action e Resource com curinga total '*'`
            );
          }
        }
      }
    });

    it("deve conceder permissão granular de execução da State Machine à regra do EventBridge", () => {
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "states:StartExecution",
              Effect: "Allow",
            }),
          ]),
        },
      });
    });

    it("deve conceder permissões delimitadas de DynamoDB para as Lambdas do pipeline", () => {
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([
                "dynamodb:BatchGetItem",
                "dynamodb:GetItem",
                "dynamodb:PutItem",
                "dynamodb:UpdateItem",
              ]),
              Effect: "Allow",
            }),
          ]),
        },
      });
    });
  });
});
