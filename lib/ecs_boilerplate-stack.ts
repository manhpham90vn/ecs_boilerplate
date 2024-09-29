import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export class EcsBoilerplateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const proj = process.env.PROJECT_NAME;

    // Create vpc
    const vpc = new cdk.aws_ec2.Vpc(this, "VPC", {
      vpcName: `${proj}-VPC`,
      ipAddresses: cdk.aws_ec2.IpAddresses.cidr("10.0.0.0/16"),
      enableDnsHostnames: true,
      enableDnsSupport: true,
      maxAzs: 3,
      natGateways: 0,
      subnetConfiguration: [],
    });

    const availabilityZones = vpc.availabilityZones;

    // Create public subnets
    const publicSubnets: cdk.aws_ec2.CfnSubnet[] = [];
    for (let i = 0; i < availabilityZones.length; i++) {
      const id = `Public-Subnet-${i + 1}`;
      const cidrBlock = `10.0.${16 * i}.0/20`;
      const availabilityZone = availabilityZones[i];
      const publicSubnet = new cdk.aws_ec2.CfnSubnet(this, id, {
        vpcId: vpc.vpcId,
        cidrBlock: cidrBlock,
        availabilityZone: availabilityZone,
        mapPublicIpOnLaunch: true,
        tags: [
          { key: "Name", value: `${proj}_${id}` },
          { key: "aws-cdk:subnet-type", value: "Public" },
        ],
      });
      publicSubnets.push(publicSubnet);
    }

    // Create private subnets
    const privateSubnets: cdk.aws_ec2.CfnSubnet[] = [];
    for (let i = 0; i < availabilityZones.length; i++) {
      const id = `Private-Subnet-${i + 1}`;
      const cidrBlock = `10.0.${16 * i + 48}.0/20`;
      const availabilityZone = availabilityZones[i];
      const privateSubnet = new cdk.aws_ec2.CfnSubnet(this, id, {
        vpcId: vpc.vpcId,
        cidrBlock: cidrBlock,
        availabilityZone: availabilityZone,
        mapPublicIpOnLaunch: false,
        tags: [
          { key: "Name", value: `${proj}_${id}` },
          { key: "aws-cdk:subnet-type", value: "Private" },
        ],
      });
      privateSubnets.push(privateSubnet);
    }

    // Create Internet Gateway
    const igw = new cdk.aws_ec2.CfnInternetGateway(this, "InternetGateway", {
      tags: [{ key: "Name", value: `${proj}-InternetGateway` }],
    });

    // Attach Internet Gateway to the VPC
    new cdk.aws_ec2.CfnVPCGatewayAttachment(this, "VPCGatewayAttachment", {
      vpcId: vpc.vpcId,
      internetGatewayId: igw.ref,
    });

    // Create route table for public subnets
    const publicRouteTable = new cdk.aws_ec2.CfnRouteTable(
      this,
      "PublicRouteTable",
      {
        vpcId: vpc.vpcId,
        tags: [{ key: "Name", value: `${proj}-PublicRouteTable` }],
      }
    );

    // Add default route to Internet Gateway in the public route table
    new cdk.aws_ec2.CfnRoute(this, "DefaultRoute", {
      routeTableId: publicRouteTable.ref,
      destinationCidrBlock: "0.0.0.0/0",
      gatewayId: igw.ref,
    });

    // Associate public subnets with the public route table
    publicSubnets.forEach((subnet, index) => {
      new cdk.aws_ec2.CfnSubnetRouteTableAssociation(
        this,
        `PublicSubnetAssociation-${index}`,
        {
          subnetId: subnet.ref,
          routeTableId: publicRouteTable.ref,
        }
      );
    });

    // Create security group for VPC Endpoint
    const vpcEndpointSecurityGroup = new cdk.aws_ec2.SecurityGroup(
      this,
      "VPCEndpointSG",
      {
        vpc,
        allowAllOutbound: true,
      }
    );

    vpcEndpointSecurityGroup.addIngressRule(
      cdk.aws_ec2.Peer.anyIpv4(),
      cdk.aws_ec2.Port.allTraffic()
    );

    // Create PrivateLink endpoint for ECR
    new cdk.aws_ec2.CfnVPCEndpoint(this, "ECREndpoint", {
      serviceName: `com.amazonaws.${process.env.CDK_DEFAULT_REGION}.ecr.dkr`,
      vpcId: vpc.vpcId,
      privateDnsEnabled: true,
      vpcEndpointType: "Interface",
      subnetIds: privateSubnets.map((subnet) => subnet.ref),
      securityGroupIds: [vpcEndpointSecurityGroup.securityGroupId],
    });

    // Create PrivateLink endpoint for ECR API
    new cdk.aws_ec2.CfnVPCEndpoint(this, "ECRApiEndpoint", {
      serviceName: `com.amazonaws.${process.env.CDK_DEFAULT_REGION}.ecr.api`,
      vpcId: vpc.vpcId,
      privateDnsEnabled: true,
      vpcEndpointType: "Interface",
      subnetIds: privateSubnets.map((subnet) => subnet.ref),
      securityGroupIds: [vpcEndpointSecurityGroup.securityGroupId],
    });

    // Create ECS cluster
    const cluster = new cdk.aws_ecs.Cluster(this, "Cluster", {
      clusterName: `${proj}-cluster`,
      vpc: vpc,
    });

    const executionRole = new cdk.aws_iam.Role(this, "FargateExecutionRole", {
      assumedBy: new cdk.aws_iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    executionRole.addManagedPolicy(
      cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
        "service-role/AmazonECSTaskExecutionRolePolicy"
      )
    );

    executionRole.addToPolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: [
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
        ],
        resources: ["*"],
      })
    );

    // Create task definition
    const taskDefinition = new cdk.aws_ecs.FargateTaskDefinition(
      this,
      "TaskDefinition",
      {
        cpu: 256,
        memoryLimitMiB: 512,
        executionRole: executionRole,
      }
    );

    // Add container to task definition
    taskDefinition.addContainer("Container", {
      image: cdk.aws_ecs.ContainerImage.fromRegistry(process.env.ECR_URI!),
      memoryLimitMiB: 512,
      cpu: 256,
      portMappings: [{ containerPort: 80 }],
      environment: {
        PORT: "80",
      },
    });

    // Create Application Load Balancer
    const alb = new cdk.aws_elasticloadbalancingv2.ApplicationLoadBalancer(
      this,
      "ALB",
      {
        vpc: vpc,
        internetFacing: true,
        loadBalancerName: `${proj}-ALB`,
        vpcSubnets: {
          subnets: publicSubnets.map((subnet) =>
            cdk.aws_ec2.Subnet.fromSubnetAttributes(
              this,
              `PublicSubnetRef-${subnet.node.id}`,
              {
                subnetId: subnet.ref,
                availabilityZone: subnet.availabilityZone,
                routeTableId: publicRouteTable.ref,
              }
            )
          ),
        },
      }
    );

    // Create a security group for ALB
    const albSecurityGroup = new cdk.aws_ec2.SecurityGroup(
      this,
      "ALBSecurityGroup",
      {
        vpc,
        allowAllOutbound: true,
      }
    );

    albSecurityGroup.addIngressRule(
      cdk.aws_ec2.Peer.anyIpv4(),
      cdk.aws_ec2.Port.tcp(80)
    );

    alb.addSecurityGroup(albSecurityGroup);

    // Create listener for ALB
    const listener = alb.addListener("Listener", {
      port: 80,
    });

    // Create Target Group
    const targetGroup =
      new cdk.aws_elasticloadbalancingv2.ApplicationTargetGroup(
        this,
        "TargetGroup",
        {
          vpc: vpc,
          port: 80,
          protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTP,
          targetType: cdk.aws_elasticloadbalancingv2.TargetType.IP,
          healthCheck: {
            path: "/",
            interval: cdk.Duration.seconds(30),
          },
        }
      );

    // Add target group to listener
    listener.addTargetGroups("TargetGroups", {
      targetGroups: [targetGroup],
    });

    // Create a Security Group for the Fargate Service that allows all IPs within the VPC
    const serviceSecurityGroup = new cdk.aws_ec2.SecurityGroup(
      this,
      "ServiceSecurityGroup",
      {
        vpc,
        allowAllOutbound: true,
      }
    );

    // Allow all inbound traffic from within the VPC
    serviceSecurityGroup.addIngressRule(
      cdk.aws_ec2.Peer.ipv4(vpc.vpcCidrBlock),
      cdk.aws_ec2.Port.allTraffic()
    );

    // Create service
    const service = new cdk.aws_ecs.FargateService(this, "Service", {
      cluster: cluster,
      taskDefinition: taskDefinition,
      desiredCount: 1,
      serviceName: `${proj}_Service`,
      deploymentController: {
        type: cdk.aws_ecs.DeploymentControllerType.CODE_DEPLOY,
      },
      assignPublicIp: false,
      securityGroups: [serviceSecurityGroup],
      vpcSubnets: {
        subnets: privateSubnets.map((subnet) =>
          cdk.aws_ec2.Subnet.fromSubnetAttributes(
            this,
            `PrivateSubnetRef-${subnet.node.id}`,
            {
              subnetId: subnet.ref,
              availabilityZone: subnet.availabilityZone,
            }
          )
        ),
      },
    });

    service.attachToApplicationTargetGroup(targetGroup);

    new cdk.CfnOutput(this, "VPC_Id", {
      value: vpc.vpcId,
    });
  }
}
