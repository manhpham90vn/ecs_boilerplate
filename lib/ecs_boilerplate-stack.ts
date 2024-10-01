import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { VPCStack } from "./vpc";
import { ECSStack } from "./ecs";
import { DeployStack } from "./deploy";

export class EcsBoilerplateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const proj = process.env.PROJECT_NAME || "ecs-boilerplate";
    const account = process.env.CDK_DEFAULT_ACCOUNT;
    const region = process.env.CDK_DEFAULT_REGION;

    const vpcStack = new VPCStack(this, "VPCStack", proj, {
      env: {
        account: account,
        region: region,
      },
    });

    const ecsStack = new ECSStack(this, "ECSStack", vpcStack, proj, {
      env: {
        account: account,
        region: region,
      },
    });

    new DeployStack(this, "DeployStack", ecsStack, proj, {
      env: {
        account: account,
        region: region,
      },
    });
  }
}
