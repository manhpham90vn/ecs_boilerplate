import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { VPCStack } from "./vpc";

export class ECSStack extends cdk.Stack {
  public readonly service: cdk.aws_ecs.FargateService;
  public readonly blueTargetGroup: cdk.aws_elasticloadbalancingv2.ApplicationTargetGroup;
  public readonly greenTargetGroup: cdk.aws_elasticloadbalancingv2.ApplicationTargetGroup;
  public readonly listener: cdk.aws_elasticloadbalancingv2.ApplicationListener;
  public readonly ecrRepository: cdk.aws_ecr.IRepository;
  public readonly taskDefinition: cdk.aws_ecs.FargateTaskDefinition;

  constructor(
    scope: Construct,
    id: string,
    vpcStack: VPCStack,
    proj: string,
    props?: cdk.StackProps
  ) {
    super(scope, id, props);

    // Create ECS cluster
    const cluster = new cdk.aws_ecs.Cluster(this, "Cluster", {
      clusterName: `${proj}-cluster`,
      vpc: vpcStack.vpc,
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

    // Add managed policies to execution role
    executionRole.addManagedPolicy(
      cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
        "CloudWatchLogsFullAccess"
      )
    );

    // Create task role for Fargate
    const taskRole = new cdk.aws_iam.Role(this, "FargateTaskRole", {
      assumedBy: new cdk.aws_iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    // Create task definition
    this.taskDefinition = new cdk.aws_ecs.FargateTaskDefinition(
      this,
      "TaskDefinition",
      {
        cpu: 256,
        memoryLimitMiB: 512,
        executionRole: executionRole,
        taskRole: taskRole,
      }
    );

    // Get ECR repository
    this.ecrRepository = cdk.aws_ecr.Repository.fromRepositoryArn(
      this,
      "ECR",
      process.env.ECR_ARN!
    );

    // Add container to task definition
    this.taskDefinition.addContainer("Container", {
      image: cdk.aws_ecs.ContainerImage.fromEcrRepository(this.ecrRepository),
      memoryLimitMiB: 512,
      cpu: 256,
      portMappings: [{ containerPort: 80 }],
      environment: {
        PORT: "80",
      },
      logging: cdk.aws_ecs.LogDrivers.awsLogs({
        streamPrefix: `${proj}-logs`,
        logGroup: new cdk.aws_logs.LogGroup(this, "LogGroup", {
          logGroupName: `/ecs/${proj}-logs`,
          retention: cdk.aws_logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
    });

    // Create ALB
    const alb = new cdk.aws_elasticloadbalancingv2.ApplicationLoadBalancer(
      this,
      "ALB",
      {
        vpc: vpcStack.vpc,
        internetFacing: true,
        loadBalancerName: `${proj}-ALB`,
        vpcSubnets: {
          subnets: vpcStack.publicSubnets.map((subnet) =>
            cdk.aws_ec2.Subnet.fromSubnetAttributes(
              this,
              `PublicSubnetRef-${subnet.node.id}`,
              {
                subnetId: subnet.ref,
                availabilityZone: subnet.availabilityZone,
                routeTableId: vpcStack.publicRouteTable.ref,
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
        vpc: vpcStack.vpc,
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
    this.listener = alb.addListener("Listener", {
      port: 80,
    });

    // Create target group for Blue deployment
    this.blueTargetGroup =
      new cdk.aws_elasticloadbalancingv2.ApplicationTargetGroup(
        this,
        "BlueTargetGroup",
        {
          vpc: vpcStack.vpc,
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
    this.greenTargetGroup =
      new cdk.aws_elasticloadbalancingv2.ApplicationTargetGroup(
        this,
        "GreenTargetGroup",
        {
          vpc: vpcStack.vpc,
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
    this.listener.addTargetGroups("TargetGroups", {
      targetGroups: [this.blueTargetGroup],
    });

    // Create a Security Group for the Fargate Service that allows all IPs within the VPC
    const serviceSecurityGroup = new cdk.aws_ec2.SecurityGroup(
      this,
      "ServiceSecurityGroup",
      {
        vpc: vpcStack.vpc,
        allowAllOutbound: true,
      }
    );

    // Allow all inbound traffic from within the VPC
    serviceSecurityGroup.addIngressRule(
      cdk.aws_ec2.Peer.ipv4(vpcStack.vpc.vpcCidrBlock),
      cdk.aws_ec2.Port.allTraffic()
    );

    // Create service
    this.service = new cdk.aws_ecs.FargateService(this, "Service", {
      cluster: cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: 1,
      serviceName: `${proj}_Service`,
      deploymentController: {
        type: cdk.aws_ecs.DeploymentControllerType.CODE_DEPLOY,
      },
      assignPublicIp: false,
      securityGroups: [serviceSecurityGroup],
      vpcSubnets: {
        subnets: vpcStack.privateSubnets.map((subnet) =>
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

    // Attach service to Blue target group
    this.service.attachToApplicationTargetGroup(this.blueTargetGroup);

    // Enable Auto Scaling for the Fargate service
    const scalableTarget = this.service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 4,
    });

    // Configure scaling policy based on CPU utilization
    scalableTarget.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: 50,
    });

    // Optionally, you can add scaling based on memory utilization as well
    scalableTarget.scaleOnMemoryUtilization("MemoryScaling", {
      targetUtilizationPercent: 70,
    });

    // Output the DNS name of the ALB
    new cdk.CfnOutput(this, "ALBDNS", {
      value: alb.loadBalancerDnsName,
    });
  }
}
