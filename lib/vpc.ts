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

  createVPC(scope: Construct, proj: string): cdk.aws_ec2.Vpc {
    return new cdk.aws_ec2.Vpc(scope, "VPC", {
      vpcName: `${proj}-VPC`,
      ipAddresses: cdk.aws_ec2.IpAddresses.cidr("10.0.0.0/16"),
      enableDnsHostnames: true,
      enableDnsSupport: true,
      maxAzs: 3,
      natGateways: 0,
      subnetConfiguration: [],
    });
  }

  createSubnet(
    scope: Construct,
    proj: string,
    vpc: cdk.aws_ec2.Vpc,
    type: "Public" | "Private",
    offset: number,
    availabilityZones: string[]
  ): cdk.aws_ec2.CfnSubnet[] {
    const subnets: cdk.aws_ec2.CfnSubnet[] = [];
    for (let i = 0; i < availabilityZones.length; i++) {
      const id = `${type}-Subnet-${i + 1}`;
      const cidrBlock = `10.0.${16 * i + offset}.0/20`;
      const availabilityZone = availabilityZones[i];
      const subnet = new cdk.aws_ec2.CfnSubnet(scope, id, {
        vpcId: vpc.vpcId,
        cidrBlock: cidrBlock,
        availabilityZone: availabilityZone,
        mapPublicIpOnLaunch: true,
        tags: [
          { key: "Name", value: `${proj}_${id}` },
          { key: "aws-cdk:subnet-type", value: type },
        ],
      });
      subnets.push(subnet);
    }
    return subnets;
  }

  createInternetGateway(
    scope: Construct,
    proj: string,
    vpc: cdk.aws_ec2.Vpc
  ): cdk.aws_ec2.CfnInternetGateway {
    const igw = new cdk.aws_ec2.CfnInternetGateway(scope, "InternetGateway", {
      tags: [{ key: "Name", value: `${proj}-InternetGateway` }],
    });

    // Attach Internet Gateway to VPC
    new cdk.aws_ec2.CfnVPCGatewayAttachment(scope, "VPCGatewayAttachment", {
      vpcId: vpc.vpcId,
      internetGatewayId: igw.ref,
    });

    return igw;
  }

  createRouteTable(
    scope: Construct,
    proj: string,
    vpc: cdk.aws_ec2.Vpc,
    type: "Public" | "Private",
    subnets: cdk.aws_ec2.CfnSubnet[]
  ): cdk.aws_ec2.CfnRouteTable {
    const routeTable = new cdk.aws_ec2.CfnRouteTable(
      scope,
      `${proj}-${type}RouteTable`,
      {
        vpcId: vpc.vpcId,
        tags: [{ key: "Name", value: `${proj}-${type}RouteTable` }],
      }
    );

    // Associate subnets with route table
    subnets.forEach((subnet, index) => {
      new cdk.aws_ec2.CfnSubnetRouteTableAssociation(
        scope,
        `${type}SubnetAssociation-${index}`,
        {
          subnetId: subnet.ref,
          routeTableId: routeTable.ref,
        }
      );
    });

    return routeTable;
  }

  createInterfaceEndpoint(
    scope: Construct,
    vpc: cdk.aws_ec2.Vpc,
    endpoint: EndpointConfig,
    securityGroup: cdk.aws_ec2.SecurityGroup,
    subnetIds: string[]
  ): cdk.aws_ec2.CfnVPCEndpoint {
    return new cdk.aws_ec2.CfnVPCEndpoint(scope, `${endpoint.id}Endpoint`, {
      serviceName: endpoint.serviceName,
      vpcId: vpc.vpcId,
      privateDnsEnabled: true,
      vpcEndpointType: "Interface",
      subnetIds: subnetIds,
      securityGroupIds: [securityGroup.securityGroupId],
    });
  }

  constructor(
    scope: Construct,
    id: string,
    proj: string,
    props?: cdk.StackProps
  ) {
    super(scope, id, props);

    // Create VPC
    this.vpc = this.createVPC(this, proj);

    // Get availability zones
    const availabilityZones = this.vpc.availabilityZones;

    // Create public subnets
    this.publicSubnets = this.createSubnet(
      this,
      proj,
      this.vpc,
      "Public",
      0,
      availabilityZones
    );

    // Create private subnets
    this.privateSubnets = this.createSubnet(
      this,
      proj,
      this.vpc,
      "Private",
      48,
      availabilityZones
    );

    // Create Internet Gateway
    const igw = this.createInternetGateway(this, proj, this.vpc);

    // Create route table for public subnets
    this.publicRouteTable = this.createRouteTable(
      this,
      proj,
      this.vpc,
      "Public",
      this.publicSubnets
    );

    // Create route for public subnets
    new cdk.aws_ec2.CfnRoute(this, "DefaultRoute", {
      routeTableId: this.publicRouteTable.ref,
      destinationCidrBlock: "0.0.0.0/0",
      gatewayId: igw.ref,
    });

    // Create route table for private subnets
    const privateRouteTable = this.createRouteTable(
      this,
      proj,
      this.vpc,
      "Private",
      this.privateSubnets
    );

    // Create security group for VPC endpoint
    const vpcEndpointSecurityGroup = new cdk.aws_ec2.SecurityGroup(
      this,
      "VPCEndpointSG",
      {
        vpc: this.vpc,
        allowAllOutbound: true,
      }
    );

    // Allow all inbound traffic
    vpcEndpointSecurityGroup.addIngressRule(
      cdk.aws_ec2.Peer.anyIpv4(),
      cdk.aws_ec2.Port.allTraffic()
    );

    // Create PrivateLink endpoint for S3
    new cdk.aws_ec2.CfnVPCEndpoint(this, "S3Endpoint", {
      serviceName: `com.amazonaws.${process.env.CDK_DEFAULT_REGION}.s3`,
      vpcId: this.vpc.vpcId,
      vpcEndpointType: "Gateway",
      routeTableIds: [privateRouteTable.ref],
    });

    const endpoints = [
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
    ];

    // Create PrivateLink endpoints
    endpoints.forEach((endpoint) => {
      this.createInterfaceEndpoint(
        this,
        this.vpc,
        endpoint,
        vpcEndpointSecurityGroup,
        this.privateSubnets.map((subnet) => subnet.ref)
      );
    });

    // Output VPC ID
    new cdk.CfnOutput(this, "VPCID", {
      value: this.vpc.vpcId,
    });
  }
}
