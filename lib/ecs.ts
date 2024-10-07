import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { VPCStack } from "./vpc";

export class ECSStack extends cdk.Stack {
  public readonly service: cdk.aws_ecs.FargateService;
  public readonly blueTargetGroup: cdk.aws_elasticloadbalancingv2.ApplicationTargetGroup;
  public readonly greenTargetGroup: cdk.aws_elasticloadbalancingv2.ApplicationTargetGroup;
  public readonly listener: cdk.aws_elasticloadbalancingv2.ApplicationListener;
  public readonly ecrRepository: cdk.aws_ecr.IRepository;

  constructor(
    scope: Construct,
    id: string,
    vpcStack: VPCStack,
    proj: string,
    props?: cdk.StackProps
  ) {
    super(scope, id, props);

    const cluster = this.createCluster(vpcStack, proj);

    const executionRole = this.createExecutionRole();
    const taskRole = this.createTaskRole();
    const taskDefinition = this.createTaskDefinition(
      proj,
      executionRole,
      taskRole
    );

    this.ecrRepository = this.getEcrRepository();

    this.addContainerToTaskDefinition(proj, taskDefinition);

    const alb = this.createAlb(vpcStack, proj);
    const albSecurityGroup = this.createAlbSecurityGroup(vpcStack);

    alb.addSecurityGroup(albSecurityGroup);

    this.listener = this.createListener(alb);
    this.blueTargetGroup = this.createTargetGroup(vpcStack, "Blue");
    this.greenTargetGroup = this.createTargetGroup(vpcStack, "Green");

    this.listener.addTargetGroups("TargetGroups", {
      targetGroups: [this.blueTargetGroup],
    });

    this.service = this.createFargateService(
      cluster,
      vpcStack,
      proj,
      taskDefinition
    );
    this.attachServiceToTargetGroup(this.blueTargetGroup);
    this.enableAutoScaling();

    new cdk.CfnOutput(this, "ALBDNS", {
      value: alb.loadBalancerDnsName,
    });
  }

  private createCluster(vpcStack: VPCStack, proj: string): cdk.aws_ecs.Cluster {
    return new cdk.aws_ecs.Cluster(this, "Cluster", {
      clusterName: `${proj}-cluster`,
      vpc: vpcStack.vpc,
    });
  }

  private createExecutionRole(): cdk.aws_iam.Role {
    const role = new cdk.aws_iam.Role(this, "EcsExecutionRole", {
      assumedBy: new cdk.aws_iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    role.addManagedPolicy(
      cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
        "service-role/AmazonECSTaskExecutionRolePolicy"
      )
    );
    role.addManagedPolicy(
      cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
        "CloudWatchLogsFullAccess"
      )
    );
    role.addManagedPolicy(
      cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
        "AmazonSSMReadOnlyAccess"
      )
    );
    return role;
  }

  private createTaskRole(): cdk.aws_iam.Role {
    return new cdk.aws_iam.Role(this, "EcsTaskRole", {
      assumedBy: new cdk.aws_iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
  }

  private createTaskDefinition(
    proj: string,
    executionRole: cdk.aws_iam.Role,
    taskRole: cdk.aws_iam.Role
  ): cdk.aws_ecs.FargateTaskDefinition {
    return new cdk.aws_ecs.FargateTaskDefinition(this, "TaskDefinition", {
      family: `${proj}-task`,
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole: executionRole,
      taskRole: taskRole,
    });
  }

  private getEcrRepository(): cdk.aws_ecr.IRepository {
    return cdk.aws_ecr.Repository.fromRepositoryArn(
      this,
      "ECR",
      process.env.ECR_ARN!
    );
  }

  private addContainerToTaskDefinition(
    proj: string,
    taskDefinition: cdk.aws_ecs.FargateTaskDefinition
  ): void {
    taskDefinition.addContainer("Container", {
      image: cdk.aws_ecs.ContainerImage.fromEcrRepository(this.ecrRepository),
      containerName: `${proj}-container`,
      memoryLimitMiB: 512,
      cpu: 256,
      portMappings: [{ containerPort: 80 }],
      environment: {
        WORDPRESS_DB_NAME: "testdb",
      },
      healthCheck: {
        command: ["CMD-SHELL", "curl -f http://localhost/ || exit 1"],
        startPeriod: cdk.Duration.seconds(120),
      },
      secrets: {
        WORDPRESS_DB_HOST: cdk.aws_ecs.Secret.fromSsmParameter(
          cdk.aws_ssm.StringParameter.fromStringParameterName(
            this,
            "RDSHostParameter",
            `/${proj}/rds/host`
          )
        ),
        WORDPRESS_DB_USER: cdk.aws_ecs.Secret.fromSsmParameter(
          cdk.aws_ssm.StringParameter.fromStringParameterName(
            this,
            "RDSUserParameter",
            `/${proj}/rds/user`
          )
        ),
        WORDPRESS_DB_PASSWORD: cdk.aws_ecs.Secret.fromSsmParameter(
          cdk.aws_ssm.StringParameter.fromStringParameterName(
            this,
            "RDSPasswordParameter",
            `/${proj}/rds/pass`
          )
        ),
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
  }

  private createAlb(
    vpcStack: VPCStack,
    proj: string
  ): cdk.aws_elasticloadbalancingv2.ApplicationLoadBalancer {
    return new cdk.aws_elasticloadbalancingv2.ApplicationLoadBalancer(
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
  }

  private createAlbSecurityGroup(
    vpcStack: VPCStack
  ): cdk.aws_ec2.SecurityGroup {
    const securityGroup = new cdk.aws_ec2.SecurityGroup(
      this,
      "ALBSecurityGroup",
      {
        vpc: vpcStack.vpc,
        allowAllOutbound: true,
      }
    );
    securityGroup.addIngressRule(
      cdk.aws_ec2.Peer.anyIpv4(),
      cdk.aws_ec2.Port.tcp(80)
    );
    return securityGroup;
  }

  private createListener(
    alb: cdk.aws_elasticloadbalancingv2.ApplicationLoadBalancer
  ): cdk.aws_elasticloadbalancingv2.ApplicationListener {
    return alb.addListener("Listener", { port: 80 });
  }

  private createTargetGroup(
    vpcStack: VPCStack,
    color: string
  ): cdk.aws_elasticloadbalancingv2.ApplicationTargetGroup {
    return new cdk.aws_elasticloadbalancingv2.ApplicationTargetGroup(
      this,
      `${color}TargetGroup`,
      {
        vpc: vpcStack.vpc,
        protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTP,
        port: 80,
        targetType: cdk.aws_elasticloadbalancingv2.TargetType.IP,
        healthCheck: {
          path: "/",
          port: "80",
          protocol: cdk.aws_elasticloadbalancingv2.Protocol.HTTP,
          timeout: cdk.Duration.seconds(60),
          healthyThresholdCount: 3,
          unhealthyThresholdCount: 3,
          interval: cdk.Duration.seconds(180),
          healthyHttpCodes: "200,302",
        },
      }
    );
  }

  private createFargateService(
    cluster: cdk.aws_ecs.Cluster,
    vpcStack: VPCStack,
    proj: string,
    taskDefinition: cdk.aws_ecs.FargateTaskDefinition
  ): cdk.aws_ecs.FargateService {
    const serviceSecurityGroup = this.createServiceSecurityGroup(vpcStack);

    return new cdk.aws_ecs.FargateService(this, "Service", {
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
  }

  private createServiceSecurityGroup(
    vpcStack: VPCStack
  ): cdk.aws_ec2.SecurityGroup {
    const serviceSecurityGroup = new cdk.aws_ec2.SecurityGroup(
      this,
      "ServiceSecurityGroup",
      {
        vpc: vpcStack.vpc,
        allowAllOutbound: true,
      }
    );
    serviceSecurityGroup.addIngressRule(
      cdk.aws_ec2.Peer.ipv4(vpcStack.vpc.vpcCidrBlock),
      cdk.aws_ec2.Port.allTraffic()
    );
    return serviceSecurityGroup;
  }

  private attachServiceToTargetGroup(
    targetGroup: cdk.aws_elasticloadbalancingv2.ApplicationTargetGroup
  ): void {
    this.service.attachToApplicationTargetGroup(targetGroup);
  }

  private enableAutoScaling(): void {
    const scalableTarget = this.service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 4,
    });

    scalableTarget.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: 50,
    });

    scalableTarget.scaleOnMemoryUtilization("MemoryScaling", {
      targetUtilizationPercent: 70,
    });
  }
}
