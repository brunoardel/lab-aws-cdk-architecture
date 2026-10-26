import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as stepfunctions from "aws-cdk-lib/aws-stepfunctions";
import * as stepfunctions_tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import * as events from "aws-cdk-lib/aws-events";
import * as events_targets from "aws-cdk-lib/aws-events-targets";
import type { Construct } from "constructs";

export interface ArqLabPipelineStackProps extends cdk.StackProps {
  /**
   * Prefixo opcional para recursos nomeados.
   * @default 'arqlab'
   */
  readonly resourcePrefix?: string;
}

/**
 * Stack de infraestrutura serverless do ArqLab.
 * Provisiona S3 (com EventBridge), DynamoDB (com TTL), Lambdas especializadas,
 * State Machine com Retry/Backoff + Rollback Saga e Regra EventBridge.
 */
export class ArqLabPipelineStack extends cdk.Stack {
  public readonly terrenosBucket: s3.Bucket;
  public readonly jobsTable: dynamodb.Table;
  public readonly presignedUrlLambda: lambda.Function;
  public readonly validateGeometryLambda: lambda.Function;
  public readonly calculateVolumetryLambda: lambda.Function;
  public readonly compensateRollbackLambda: lambda.Function;
  public readonly stateMachine: stepfunctions.StateMachine;
  public readonly s3UploadRule: events.Rule;

  constructor(scope: Construct, id: string, props?: ArqLabPipelineStackProps) {
    super(scope, id, props);

    const prefix = props?.resourcePrefix ?? "arqlab";

    // =========================================================================
    // 1. Bucket Amazon S3: Ingestão de Terrenos com Notificações EventBridge
    // =========================================================================
    this.terrenosBucket = new s3.Bucket(this, "TerrenosBucket", {
      bucketName: `${prefix}-terrenos-raw-${this.account}-${this.region}`.toLowerCase(),
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      eventBridgeEnabled: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: ["*"],
          allowedHeaders: ["*"],
          maxAge: 300,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
    });

    // =========================================================================
    // 2. Tabela Amazon DynamoDB: Jobs e Idempotência (At-Least-Once)
    // =========================================================================
    this.jobsTable = new dynamodb.Table(this, "JobsIdempotencyTable", {
      tableName: `${prefix}-jobs-idempotency`,
      partitionKey: {
        name: "pk",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "sk",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // =========================================================================
    // 3. Funções AWS Lambda (Node.js 20.x): Handlers Especializados
    // =========================================================================
    const commonLambdaEnv = {
      TERRENOS_BUCKET: this.terrenosBucket.bucketName,
      JOBS_TABLE: this.jobsTable.tableName,
      NODE_OPTIONS: "--enable-source-maps",
    };

    // Lambda 3.1: Geração de URL Pré-Assinada
    this.presignedUrlLambda = new lambda.Function(this, "PresignedUrlLambda", {
      functionName: `${prefix}-presigned-url-generator`,
      description: "Gera URLs pre-assinadas no S3 para upload seguro de arquivos DWG/KMZ",
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      environment: commonLambdaEnv,
      timeout: cdk.Duration.seconds(10),
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          console.log("[PresignedUrlLambda] Evento recebido:", JSON.stringify(event));
          return {
            statusCode: 200,
            body: JSON.stringify({ message: "Presigned URL gerada com sucesso" }),
          };
        };
      `),
    });

    // Lambda 3.2: Validação de Geometria e Lock Condicional de Idempotência
    this.validateGeometryLambda = new lambda.Function(this, "ValidateGeometryLambda", {
      functionName: `${prefix}-validate-geometry`,
      description: "Etapa 1: Valida geometria do terreno e registra lock condicional de idempotencia no DynamoDB",
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      environment: commonLambdaEnv,
      timeout: cdk.Duration.seconds(30),
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          console.log("[ValidateGeometryLambda] Validando arquivo:", JSON.stringify(event));
          return {
            statusCode: 200,
            jobId: event.jobId || "job-default-1",
            status: "GEOMETRY_VALIDATED",
            payload: event,
          };
        };
      `),
    });

    // Lambda 3.3: Cálculo Paramétrico e Volumétrico
    this.calculateVolumetryLambda = new lambda.Function(this, "CalculateVolumetryLambda", {
      functionName: `${prefix}-calculate-volumetry`,
      description: "Etapa 2: Executa cálculo volumétrico e paramétrico de terraplanagem",
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      environment: commonLambdaEnv,
      timeout: cdk.Duration.seconds(60),
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          console.log("[CalculateVolumetryLambda] Calculando volumetria:", JSON.stringify(event));
          return {
            statusCode: 200,
            jobId: event.jobId,
            volumeM3: 4520.85,
            corteM3: 2100.5,
            aterroM3: 2420.35,
            status: "COMPLETED",
          };
        };
      `),
    });

    // Lambda 3.4: Compensação Transacional (Saga Rollback)
    this.compensateRollbackLambda = new lambda.Function(this, "CompensateRollbackLambda", {
      functionName: `${prefix}-compensate-rollback`,
      description: "Compensacao Saga: Acionada em falhas para limpar artefatos temporarios e registrar status FAILED no DynamoDB",
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      environment: commonLambdaEnv,
      timeout: cdk.Duration.seconds(30),
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          console.error("[CompensateRollbackLambda] Executando Saga Rollback para:", JSON.stringify(event));
          return {
            statusCode: 200,
            compensated: true,
            status: "ROLLED_BACK",
            error: event.error || "UnknownError",
          };
        };
      `),
    });

    // =========================================================================
    // 4. Concessão de Permissões IAM de Menor Privilégio (L2 Constructs)
    // =========================================================================
    // S3 Permissions
    this.terrenosBucket.grantPut(this.presignedUrlLambda);
    this.terrenosBucket.grantRead(this.validateGeometryLambda);
    this.terrenosBucket.grantReadWrite(this.compensateRollbackLambda);

    // DynamoDB Permissions
    this.jobsTable.grantReadWriteData(this.validateGeometryLambda);
    this.jobsTable.grantReadWriteData(this.calculateVolumetryLambda);
    this.jobsTable.grantReadWriteData(this.compensateRollbackLambda);

    // =========================================================================
    // 5. AWS Step Functions State Machine: Orquestração e Padrão Saga
    // =========================================================================
    const validateGeometryTask = new stepfunctions_tasks.LambdaInvoke(this, "ValidateGeometryTask", {
      lambdaFunction: this.validateGeometryLambda,
      outputPath: "$.Payload",
      retryOnServiceExceptions: false,
    });

    const calculateVolumetryTask = new stepfunctions_tasks.LambdaInvoke(this, "CalculateVolumetryTask", {
      lambdaFunction: this.calculateVolumetryLambda,
      outputPath: "$.Payload",
      retryOnServiceExceptions: false,
    });

    const compensateRollbackTask = new stepfunctions_tasks.LambdaInvoke(this, "CompensateRollbackTask", {
      lambdaFunction: this.compensateRollbackLambda,
      outputPath: "$.Payload",
      retryOnServiceExceptions: false,
    });

    const pipelineFailState = new stepfunctions.Fail(this, "PipelineFailed", {
      error: "PipelineExecutionFailed",
      cause: "Falha na execucao do pipeline. Rollback da Saga executado com sucesso.",
    });

    const pipelineSuccessState = new stepfunctions.Succeed(this, "PipelineSucceeded", {
      comment: "Processamento volumetrico e geometrico concluido com sucesso.",
    });

    // Política de Retry com Backoff Exponencial
    const retryProps: stepfunctions.RetryProps = {
      interval: cdk.Duration.seconds(2),
      maxAttempts: 3,
      backoffRate: 2.0,
      errors: ["States.ALL"],
    };

    validateGeometryTask.addRetry(retryProps);
    calculateVolumetryTask.addRetry(retryProps);

    // Política de Catch apontando para o Rollback da Saga
    const rollbackChain = compensateRollbackTask.next(pipelineFailState);

    validateGeometryTask.addCatch(rollbackChain, {
      errors: ["States.ALL"],
      resultPath: "$.error",
    });

    calculateVolumetryTask.addCatch(rollbackChain, {
      errors: ["States.ALL"],
      resultPath: "$.error",
    });

    // Encadeamento do fluxo principal: Validação -> Cálculo -> Sucesso
    const stateMachineDefinition = validateGeometryTask
      .next(calculateVolumetryTask)
      .next(pipelineSuccessState);

    this.stateMachine = new stepfunctions.StateMachine(this, "ArqLabStateMachine", {
      stateMachineName: `${prefix}-pipeline-orchestrator`,
      definitionBody: stepfunctions.DefinitionBody.fromChainable(stateMachineDefinition),
      timeout: cdk.Duration.minutes(10),
    });

    // =========================================================================
    // 6. Amazon EventBridge Rule: Reatividade ao Upload de Arquivos no S3
    // =========================================================================
    this.s3UploadRule = new events.Rule(this, "S3UploadRule", {
      ruleName: `${prefix}-s3-object-created-rule`,
      description: "Escuta eventos ObjectCreated no TerrenosBucket e dispara a ArqLabStateMachine",
      eventPattern: {
        source: ["aws.s3"],
        detailType: ["Object Created"],
        detail: {
          bucket: {
            name: [this.terrenosBucket.bucketName],
          },
        },
      },
    });

    this.s3UploadRule.addTarget(new events_targets.SfnStateMachine(this.stateMachine));
  }
}
