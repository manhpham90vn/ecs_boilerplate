import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export class EcsBoilerplateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const proj = process.env.PROJECT_NAME;

    // Create VPC
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

    // Attach Internet Gateway to VPC
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

    // Create route to Internet Gateway
    new cdk.aws_ec2.CfnRoute(this, "DefaultRoute", {
      routeTableId: publicRouteTable.ref,
      destinationCidrBlock: "0.0.0.0/0",
      gatewayId: igw.ref,
    });

    // Create route table for private subnets
    const privateRouteTable = new cdk.aws_ec2.CfnRouteTable(
      this,
      "PrivateRouteTable",
      {
        vpcId: vpc.vpcId,
        tags: [{ key: "Name", value: `${proj}-PrivateRouteTable` }],
      }
    );

    // Associate private subnets with the private route table
    privateSubnets.forEach((subnet, index) => {
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

    // Create security group for VPC endpoint
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

    // Create PrivateLink endpoint for S3
    new cdk.aws_ec2.CfnVPCEndpoint(this, "S3Endpoint", {
      serviceName: `com.amazonaws.${process.env.CDK_DEFAULT_REGION}.s3`,
      vpcId: vpc.vpcId,
      vpcEndpointType: "Gateway",
      routeTableIds: [privateRouteTable.ref],
    });

    // Create PrivateLink endpoint for CloudWatch Logs
    new cdk.aws_ec2.CfnVPCEndpoint(this, "CloudWatchLogsEndpoint", {
      serviceName: `com.amazonaws.${process.env.CDK_DEFAULT_REGION}.logs`,
      vpcId: vpc.vpcId,
      privateDnsEnabled: true,
      vpcEndpointType: "Interface",
      subnetIds: privateSubnets.map((subnet) => subnet.ref),
      securityGroupIds: [vpcEndpointSecurityGroup.securityGroupId],
    });

    // Create ECS Cluster
    const cluster = new cdk.aws_ecs.Cluster(this, "Cluster", {
      clusterName: `${proj}-cluster`,
      vpc: vpc,
    });

    // Create execution role for Fargate
    const executionRole = new cdk.aws_iam.Role(this, "FargateExecutionRole", {
      assumedBy: new cdk.aws_iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    // Add managed policies to execution role
    executionRole.addManagedPolicy(
      cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
        "service-role/AmazonECSTaskExecutionRolePolicy"
      )
    );

    // Add inline policy to execution
    executionRole.addToPolicy(
      new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: [
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:BatchCheckLayerAvailability",
        ],
        resources: ["*"],
      })
    );

    // Create task role for Fargate
    const taskRole = new cdk.aws_iam.Role(this, "FargateTaskRole", {
      assumedBy: new cdk.aws_iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    // Create task definition
    const taskDefinition = new cdk.aws_ecs.FargateTaskDefinition(
      this,
      "TaskDefinition",
      {
        cpu: 256,
        memoryLimitMiB: 512,
        executionRole: executionRole,
        taskRole: taskRole,
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

    // Create ALB
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

    // Create security group for ALB
    const albSecurityGroup = new cdk.aws_ec2.SecurityGroup(
      this,
      "ALBSecurityGroup",
      {
        vpc,
        allowAllOutbound: true,
      }
    );

    // Allow all inbound traffic on port 80
    albSecurityGroup.addIngressRule(
      cdk.aws_ec2.Peer.anyIpv4(),
      cdk.aws_ec2.Port.tcp(80)
    );

    // Add security group to ALB
    alb.addSecurityGroup(albSecurityGroup);

    // Create listener
    const listener = alb.addListener("Listener", {
      port: 80,
    });

    // Create target group for Blue deployment
    const blueTargetGroup =
      new cdk.aws_elasticloadbalancingv2.ApplicationTargetGroup(
        this,
        "BlueTargetGroup",
        {
          vpc,
          protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTP,
          port: 80,
          targetType: cdk.aws_elasticloadbalancingv2.TargetType.IP,
          healthCheck: {
            path: "/",
            interval: cdk.Duration.seconds(30),
          },
        }
      );

    // Create target group for Green deployment
    const greenTargetGroup =
      new cdk.aws_elasticloadbalancingv2.ApplicationTargetGroup(
        this,
        "GreenTargetGroup",
        {
          vpc,
          protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTP,
          port: 80,
          targetType: cdk.aws_elasticloadbalancingv2.TargetType.IP,
          healthCheck: {
            path: "/",
            interval: cdk.Duration.seconds(30),
          },
        }
      );

    // Add target group to listener
    listener.addTargetGroups("TargetGroups", {
      targetGroups: [blueTargetGroup],
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

    // Create code deploy
    const codedeployApp = new cdk.aws_codedeploy.EcsApplication(
      this,
      "CodeDeployApplication",
      {
        applicationName: `${proj}_CodeDeployApplication`,
      }
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

    // create deployment group
    new cdk.aws_codedeploy.EcsDeploymentGroup(this, "DeploymentGroup", {
      service: service,
      application: codedeployApp,
      deploymentGroupName: `${proj}_DeploymentGroup`,
      autoRollback: {
        failedDeployment: true,
      },
      blueGreenDeploymentConfig: {
        blueTargetGroup: blueTargetGroup,
        greenTargetGroup: greenTargetGroup,
        listener: listener,
        terminationWaitTime: cdk.Duration.minutes(60),
        deploymentApprovalWaitTime: cdk.Duration.minutes(10),
      },
    });

    service.attachToApplicationTargetGroup(blueTargetGroup);

    new cdk.CfnOutput(this, "VPC_Id", {
      value: vpc.vpcId,
    });
  }
}
