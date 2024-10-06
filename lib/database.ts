import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { VPCStack } from "./vpc";

export class DatabaseStack extends cdk.Stack {
  public readonly password: cdk.aws_ssm.StringParameter;
  public readonly db: cdk.aws_rds.DatabaseInstance;

  constructor(
    scope: Construct,
    id: string,
    proj: string,
    vpcStack: VPCStack,
    props?: cdk.StackProps
  ) {
    super(scope, id, props);

    this.password = this.createPassword(proj);
    this.db = this.createDatabase(proj, vpcStack, this.password);
  }

  private createPassword(proj: string): cdk.aws_ssm.StringParameter {
    return new cdk.aws_ssm.StringParameter(this, "RDSPassword", {
      parameterName: `/${proj}/rds/password`,
      stringValue: process.env.RDS_PASSWORD!,
      dataType: cdk.aws_ssm.ParameterDataType.TEXT,
    });
  }

  private createDatabase(
    proj: string,
    vpcStack: VPCStack,
    password: cdk.aws_ssm.StringParameter
  ): cdk.aws_rds.DatabaseInstance {
    return new cdk.aws_rds.DatabaseInstance(this, "Database", {
      engine: cdk.aws_rds.DatabaseInstanceEngine.mysql({
        version: cdk.aws_rds.MysqlEngineVersion.VER_8_0_39,
      }),
      instanceType: cdk.aws_ec2.InstanceType.of(
        cdk.aws_ec2.InstanceClass.T3,
        cdk.aws_ec2.InstanceSize.MICRO
      ),
      vpcSubnets: {
        subnets: vpcStack.privateSubnets.map((subnet) =>
          cdk.aws_ec2.Subnet.fromSubnetAttributes(
            this,
            `PrivateRDSSubnetRef-${subnet.node.id}`,
            {
              subnetId: subnet.ref,
              availabilityZone: subnet.availabilityZone,
            }
          )
        ),
      },
      subnetGroup: new cdk.aws_rds.SubnetGroup(this, "RDSSubnetGroup", {
        vpc: vpcStack.vpc,
        description: "Subnet group for RDS instance",
        vpcSubnets: {
          subnets: vpcStack.privateSubnets.map((subnet) =>
            cdk.aws_ec2.Subnet.fromSubnetAttributes(
              this,
              `PrivateRDSGroupSubnetRef-${subnet.node.id}`,
              {
                subnetId: subnet.ref,
                availabilityZone: subnet.availabilityZone,
              }
            )
          ),
        },
      }),
      allocatedStorage: 20,
      publiclyAccessible: false,
      // credentials: cdk.aws_rds.Credentials.fromSecret(password),
      multiAz: false,
      vpc: vpcStack.vpc,
      databaseName: proj,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}
