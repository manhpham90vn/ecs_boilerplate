import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { VPCStack } from "./vpc";

export class DatabaseStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    proj: string,
    vpcStack: VPCStack,
    props?: cdk.StackProps
  ) {
    super(scope, id, props);

    const database = this.createDatabase(vpcStack);

    this.createSSMParameter(
      `/${proj}/rds/host`,
      database.dbInstanceEndpointAddress,
      "RDSHOST"
    );
    this.createSSMParameter(
      `/${proj}/rds/user`,
      this.getDatabaseSecret(database, "username"),
      "RDSUSER"
    );
    this.createSSMParameter(
      `/${proj}/rds/pass`,
      this.getDatabaseSecret(database, "password"),
      "RDSPASS"
    );
  }

  private getDatabaseSecret(
    database: cdk.aws_rds.DatabaseInstance,
    key: string
  ): string {
    return database.secret!.secretValueFromJson(key)!.unsafeUnwrap();
  }

  private createSSMParameter(
    parameterName: string,
    value: string,
    id: string
  ): cdk.aws_ssm.StringParameter {
    return new cdk.aws_ssm.StringParameter(this, id, {
      parameterName: parameterName,
      stringValue: value,
      dataType: cdk.aws_ssm.ParameterDataType.TEXT,
    });
  }

  private createRdsSecurityGroup(
    vpcStack: VPCStack
  ): cdk.aws_ec2.SecurityGroup {
    const rdsSecurityGroup = new cdk.aws_ec2.SecurityGroup(
      this,
      "RDSSecurityGroup",
      {
        vpc: vpcStack.vpc,
        description: "Allow inbound traffic from VPC to RDS",
        allowAllOutbound: true,
      }
    );

    rdsSecurityGroup.addIngressRule(
      cdk.aws_ec2.Peer.ipv4(vpcStack.vpc.vpcCidrBlock),
      cdk.aws_ec2.Port.tcp(3306),
      "Allow MySQL traffic from within VPC"
    );

    return rdsSecurityGroup;
  }

  private createDatabase(vpcStack: VPCStack): cdk.aws_rds.DatabaseInstance {
    return new cdk.aws_rds.DatabaseInstance(this, "Database", {
      engine: cdk.aws_rds.DatabaseInstanceEngine.mysql({
        version: cdk.aws_rds.MysqlEngineVersion.VER_8_0_39,
      }),
      instanceType: cdk.aws_ec2.InstanceType.of(
        cdk.aws_ec2.InstanceClass.T3,
        cdk.aws_ec2.InstanceSize.MICRO
      ),
      databaseName: "testdb",
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
      securityGroups: [this.createRdsSecurityGroup(vpcStack)],
      allocatedStorage: 20,
      publiclyAccessible: false,
      multiAz: false,
      vpc: vpcStack.vpc,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}
