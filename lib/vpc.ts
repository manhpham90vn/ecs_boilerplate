import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

interface EndpointConfig {
  id: string;
  serviceName: string;
}

export class VPCStack extends cdk.Stack {
  public readonly vpc: cdk.aws_ec2.Vpc;
  public readonly privateSubnets: cdk.aws_ec2.CfnSubnet[];
  public readonly publicSubnets: cdk.aws_ec2.CfnSubnet[];
  public readonly publicRouteTable: cdk.aws_ec2.CfnRouteTable;

  constructor(
    scope: Construct,
    id: string,
    proj: string,
    props?: cdk.StackProps
  ) {
    super(scope, id, props);

    this.vpc = this.createVPC(proj);
    const availabilityZones = this.vpc.availabilityZones;

    this.publicSubnets = this.createSubnets(
      proj,
      this.vpc,
      "Public",
      0,
      availabilityZones
    );
    this.privateSubnets = this.createSubnets(
      proj,
      this.vpc,
      "Private",
      48,
      availabilityZones
    );

    const igw = this.createInternetGateway(proj);
    this.publicRouteTable = this.createRouteTable(
      proj,
      "Public",
      this.publicSubnets
    );
    const privateRouteTable = this.createRouteTable(
      proj,
      "Private",
      this.privateSubnets
    );

    this.createPublicRoutes(igw);
    this.createVPCEndpoints(privateRouteTable);

    new cdk.CfnOutput(this, "VPCID", { value: this.vpc.vpcId });
  }

  private createVPC(proj: string): cdk.aws_ec2.Vpc {
    return new cdk.aws_ec2.Vpc(this, "VPC", {
      vpcName: `${proj}-VPC`,
      ipAddresses: cdk.aws_ec2.IpAddresses.cidr("10.0.0.0/16"),
      enableDnsHostnames: true,
      enableDnsSupport: true,
      maxAzs: 3,
      natGateways: 0,
      subnetConfiguration: [],
    });
  }

  private createSubnets(
    proj: string,
    vpc: cdk.aws_ec2.Vpc,
    type: "Public" | "Private",
    offset: number,
    availabilityZones: string[]
  ): cdk.aws_ec2.CfnSubnet[] {
    return availabilityZones.map((zone, index) => {
      const id = `${type}-Subnet-${index + 1}`;
      return new cdk.aws_ec2.CfnSubnet(this, id, {
        vpcId: vpc.vpcId,
        cidrBlock: `10.0.${16 * index + offset}.0/20`,
        availabilityZone: zone,
        mapPublicIpOnLaunch: type === "Public",
        tags: [
          { key: "Name", value: `${proj}_${id}` },
          { key: "aws-cdk:subnet-type", value: type },
        ],
      });
    });
  }

  private createInternetGateway(proj: string): cdk.aws_ec2.CfnInternetGateway {
    const igw = new cdk.aws_ec2.CfnInternetGateway(this, "InternetGateway", {
      tags: [{ key: "Name", value: `${proj}-InternetGateway` }],
    });
    new cdk.aws_ec2.CfnVPCGatewayAttachment(this, "VPCGatewayAttachment", {
      vpcId: this.vpc.vpcId,
      internetGatewayId: igw.ref,
    });
    return igw;
  }

  private createRouteTable(
    proj: string,
    type: "Public" | "Private",
    subnets: cdk.aws_ec2.CfnSubnet[]
  ): cdk.aws_ec2.CfnRouteTable {
    const routeTable = new cdk.aws_ec2.CfnRouteTable(
      this,
      `${proj}-${type}RouteTable`,
      {
        vpcId: this.vpc.vpcId,
        tags: [{ key: "Name", value: `${proj}-${type}RouteTable` }],
      }
    );

    subnets.forEach((subnet, index) => {
      new cdk.aws_ec2.CfnSubnetRouteTableAssociation(
        this,
        `${type}SubnetAssociation-${index}`,
        {
          subnetId: subnet.ref,
          routeTableId: routeTable.ref,
        }
      );
    });
    return routeTable;
  }

  private createPublicRoutes(igw: cdk.aws_ec2.CfnInternetGateway): void {
    new cdk.aws_ec2.CfnRoute(this, "DefaultRoute", {
      routeTableId: this.publicRouteTable.ref,
      destinationCidrBlock: "0.0.0.0/0",
      gatewayId: igw.ref,
    });
  }

  private createVPCEndpoints(
    privateRouteTable: cdk.aws_ec2.CfnRouteTable
  ): void {
    const vpcEndpointSG = new cdk.aws_ec2.SecurityGroup(this, "VPCEndpointSG", {
      vpc: this.vpc,
      allowAllOutbound: true,
    });
    vpcEndpointSG.addIngressRule(
      cdk.aws_ec2.Peer.anyIpv4(),
      cdk.aws_ec2.Port.allTraffic()
    );

    new cdk.aws_ec2.CfnVPCEndpoint(this, "S3Endpoint", {
      serviceName: `com.amazonaws.${process.env.CDK_DEFAULT_REGION}.s3`,
      vpcId: this.vpc.vpcId,
      vpcEndpointType: "Gateway",
      routeTableIds: [privateRouteTable.ref],
    });

    const endpoints: EndpointConfig[] = [
      {
        id: "ECREndpoint",
        serviceName: `com.amazonaws.${process.env.CDK_DEFAULT_REGION}.ecr.dkr`,
      },
      {
        id: "ECRApiEndpoint",
        serviceName: `com.amazonaws.${process.env.CDK_DEFAULT_REGION}.ecr.api`,
      },
      {
        id: "CloudWatchLogsEndpoint",
        serviceName: `com.amazonaws.${process.env.CDK_DEFAULT_REGION}.logs`,
      },
      {
        id: "SSMEndpoint",
        serviceName: `com.amazonaws.${process.env.CDK_DEFAULT_REGION}.ssm`,
      },
    ];

    endpoints.forEach((endpoint) => {
      new cdk.aws_ec2.CfnVPCEndpoint(this, `${endpoint.id}Endpoint`, {
        serviceName: endpoint.serviceName,
        vpcId: this.vpc.vpcId,
        privateDnsEnabled: true,
        vpcEndpointType: "Interface",
        subnetIds: this.privateSubnets.map((subnet) => subnet.ref),
        securityGroupIds: [vpcEndpointSG.securityGroupId],
      });
    });
  }
}
