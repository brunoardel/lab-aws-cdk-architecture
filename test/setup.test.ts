import { describe, it, expect } from "vitest";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";

describe("Sanity Check - AWS CDK Assertions & Vitest", () => {
  it("should instantiate an App and empty Stack and inspect template via Template.fromStack", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "ArqLabSanityStack", {
      env: {
        account: "123456789012",
        region: "us-east-1",
      },
    });

    const template = Template.fromStack(stack);
    expect(template).toBeDefined();

    // Uma stack vazia não deve conter recursos no CloudFormation
    template.resourceCountIs("AWS::S3::Bucket", 0);
    template.resourceCountIs("AWS::DynamoDB::Table", 0);

    const json = template.toJSON();
    expect(json).toBeTypeOf("object");
  });

  it("should assert resources using CDK Assertions helpers", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "ArqLabResourceStack");

    new cdk.CfnResource(stack, "SampleResource", {
      type: "Custom::ArqLabService",
      properties: {
        ServiceName: "ArqLabEngine",
        Environment: "local-test",
      },
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs("Custom::ArqLabService", 1);
    template.hasResourceProperties("Custom::ArqLabService", {
      ServiceName: "ArqLabEngine",
      Environment: "local-test",
    });
  });
});
