import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { VPCStack } from "./vpc";
import { ECSStack } from "./ecs";
import { DeployStack } from "./deploy";

export class EcsBoilerplateStack extends cdk.Stack {
  private proj: string;
  public account: string;
  public region: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.setProjectInfo();

    const vpcStack = this.createVPCStack();

    const ecsStack = this.createECSStack(vpcStack);

    this.createDeployStack(ecsStack);
  }

  private setProjectInfo() {
    this.proj = process.env.PROJECT_NAME || "ecs-boilerplate";
    this.account = process.env.CDK_DEFAULT_ACCOUNT || "123456789012";
    this.region = process.env.CDK_DEFAULT_REGION || "ap-southeast-1";
  }

  private createVPCStack(): VPCStack {
    return new VPCStack(this, "VPCStack", this.proj, {
      env: {
        account: this.account,
        region: this.region,
      },
    });
  }

  private createECSStack(vpcStack: VPCStack): ECSStack {
    return new ECSStack(this, "ECSStack", vpcStack, this.proj, {
      env: {
        account: this.account,
        region: this.region,
      },
    });
  }

  private createDeployStack(ecsStack: ECSStack) {
    new DeployStack(this, "DeployStack", ecsStack, this.proj, {
      env: {
        account: this.account,
        region: this.region,
      },
    });
  }
}
