import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { VPCStack } from "./vpc";

export class DatabaseStack extends cdk.Stack {
  public readonly host: cdk.aws_ssm.StringParameter;
  public readonly port: cdk.aws_ssm.StringParameter;
  public readonly user: cdk.aws_ssm.StringParameter;
  public readonly password: cdk.aws_ssm.StringParameter;

  constructor(
    scope: Construct,
    id: string,
    proj: string,
    vpcStack: VPCStack,
    props?: cdk.StackProps
  ) {
    super(scope, id, props);

    const database = this.createDatabase(proj, vpcStack);

    this.host = new cdk.aws_ssm.StringParameter(this, "RDSHOST", {
      parameterName: `/${proj}/rds/host`,
      stringValue: database.dbInstanceEndpointAddress,
      dataType: cdk.aws_ssm.ParameterDataType.TEXT,
    });

    this.port = new cdk.aws_ssm.StringParameter(this, "RDSPORT", {
      parameterName: `/${proj}/rds/port`,
      stringValue: database.dbInstanceEndpointPort,
      dataType: cdk.aws_ssm.ParameterDataType.TEXT,
    });

    this.user = new cdk.aws_ssm.StringParameter(this, "RDSUSER", {
      parameterName: `/${proj}/rds/user`,
      stringValue: database
        .secret!.secretValueFromJson("username")!
        .unsafeUnwrap(),
      dataType: cdk.aws_ssm.ParameterDataType.TEXT,
    });

    this.password = new cdk.aws_ssm.StringParameter(this, "RDSPASS", {
      parameterName: `/${proj}/rds/pass`,
      stringValue: database
        .secret!.secretValueFromJson("password")!
        .unsafeUnwrap(),
      dataType: cdk.aws_ssm.ParameterDataType.TEXT,
    });
  }

  private createDatabase(
    proj: string,
    vpcStack: VPCStack
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
      multiAz: false,
      vpc: vpcStack.vpc,
      databaseName: proj,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}
