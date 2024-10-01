import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

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

    // Create VPC
    this.vpc = new cdk.aws_ec2.Vpc(this, "VPC", {
      vpcName: `${proj}-VPC`,
      ipAddresses: cdk.aws_ec2.IpAddresses.cidr("10.0.0.0/16"),
      enableDnsHostnames: true,
      enableDnsSupport: true,
      maxAzs: 3,
      natGateways: 0,
      subnetConfiguration: [],
    });

    // Get availability zones
    const availabilityZones = this.vpc.availabilityZones;

    // Create public subnets
    this.publicSubnets = [];
    for (let i = 0; i < availabilityZones.length; i++) {
      const id = `Public-Subnet-${i + 1}`;
      const cidrBlock = `10.0.${16 * i}.0/20`;
      const availabilityZone = availabilityZones[i];
      const publicSubnet = new cdk.aws_ec2.CfnSubnet(this, id, {
        vpcId: this.vpc.vpcId,
        cidrBlock: cidrBlock,
        availabilityZone: availabilityZone,
        mapPublicIpOnLaunch: true,
        tags: [
          { key: "Name", value: `${proj}_${id}` },
          { key: "aws-cdk:subnet-type", value: "Public" },
        ],
      });
      this.publicSubnets.push(publicSubnet);
    }

    // Create private subnets
    this.privateSubnets = [];
    for (let i = 0; i < availabilityZones.length; i++) {
      const id = `Private-Subnet-${i + 1}`;
      const cidrBlock = `10.0.${16 * i + 48}.0/20`;
      const availabilityZone = availabilityZones[i];
      const privateSubnet = new cdk.aws_ec2.CfnSubnet(this, id, {
        vpcId: this.vpc.vpcId,
        cidrBlock: cidrBlock,
        availabilityZone: availabilityZone,
        mapPublicIpOnLaunch: false,
        tags: [
          { key: "Name", value: `${proj}_${id}` },
          { key: "aws-cdk:subnet-type", value: "Private" },
        ],
      });
      this.privateSubnets.push(privateSubnet);
    }

    // Create Internet Gateway
    const igw = new cdk.aws_ec2.CfnInternetGateway(this, "InternetGateway", {
      tags: [{ key: "Name", value: `${proj}-InternetGateway` }],
    });

    // Attach Internet Gateway to VPC
    new cdk.aws_ec2.CfnVPCGatewayAttachment(this, "VPCGatewayAttachment", {
      vpcId: this.vpc.vpcId,
      internetGatewayId: igw.ref,
    });

    // Create route table for public subnets
    this.publicRouteTable = new cdk.aws_ec2.CfnRouteTable(
      this,
      "PublicRouteTable",
      {
        vpcId: this.vpc.vpcId,
        tags: [{ key: "Name", value: `${proj}-PublicRouteTable` }],
      }
    );

    // Create route for public subnets
    new cdk.aws_ec2.CfnRoute(this, "DefaultRoute", {
      routeTableId: this.publicRouteTable.ref,
      destinationCidrBlock: "0.0.0.0/0",
      gatewayId: igw.ref,
    });

    // Create route table for private subnets
    const privateRouteTable = new cdk.aws_ec2.CfnRouteTable(
      this,
      "PrivateRouteTable",
      {
        vpcId: this.vpc.vpcId,
        tags: [{ key: "Name", value: `${proj}-PrivateRouteTable` }],
      }
    );

    // Associate private subnets with the private route table
    this.privateSubnets.forEach((subnet, index) => {
      new cdk.aws_ec2.CfnSubnetRouteTableAssociation(
        this,
        `PrivateSubnetAssociation-${index}`,
        {
          subnetId: subnet.ref,
          routeTableId: privateRouteTable.ref,
        }
      );
    });

    // Associate public subnets with the public route table
    this.publicSubnets.forEach((subnet, index) => {
      new cdk.aws_ec2.CfnSubnetRouteTableAssociation(
        this,
        `PublicSubnetAssociation-${index}`,
        {
          subnetId: subnet.ref,
          routeTableId: this.publicRouteTable.ref,
        }
      );
    });

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

    // Create PrivateLink endpoint for ECR
    new cdk.aws_ec2.CfnVPCEndpoint(this, "ECREndpoint", {
      serviceName: `com.amazonaws.${process.env.CDK_DEFAULT_REGION}.ecr.dkr`,
      vpcId: this.vpc.vpcId,
      privateDnsEnabled: true,
      vpcEndpointType: "Interface",
      subnetIds: this.privateSubnets.map((subnet) => subnet.ref),
      securityGroupIds: [vpcEndpointSecurityGroup.securityGroupId],
    });

    // Create PrivateLink endpoint for ECR API
    new cdk.aws_ec2.CfnVPCEndpoint(this, "ECRApiEndpoint", {
      serviceName: `com.amazonaws.${process.env.CDK_DEFAULT_REGION}.ecr.api`,
      vpcId: this.vpc.vpcId,
      privateDnsEnabled: true,
      vpcEndpointType: "Interface",
      subnetIds: this.privateSubnets.map((subnet) => subnet.ref),
      securityGroupIds: [vpcEndpointSecurityGroup.securityGroupId],
    });

    // Create PrivateLink endpoint for S3
    new cdk.aws_ec2.CfnVPCEndpoint(this, "S3Endpoint", {
      serviceName: `com.amazonaws.${process.env.CDK_DEFAULT_REGION}.s3`,
      vpcId: this.vpc.vpcId,
      vpcEndpointType: "Gateway",
      routeTableIds: [privateRouteTable.ref],
    });

    // Create PrivateLink endpoint for CloudWatch Logs
    new cdk.aws_ec2.CfnVPCEndpoint(this, "CloudWatchLogsEndpoint", {
      serviceName: `com.amazonaws.${process.env.CDK_DEFAULT_REGION}.logs`,
      vpcId: this.vpc.vpcId,
      privateDnsEnabled: true,
      vpcEndpointType: "Interface",
      subnetIds: this.privateSubnets.map((subnet) => subnet.ref),
      securityGroupIds: [vpcEndpointSecurityGroup.securityGroupId],
    });

    // Output VPC ID
    new cdk.CfnOutput(this, "VPCID", {
      value: this.vpc.vpcId,
    });
  }
}
