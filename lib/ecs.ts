import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { VPCStack } from "./vpc";

export class ECSStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    vpcStack: VPCStack,
    proj: string,
    props?: cdk.StackProps
  ) {
    super(scope, id, props);

    // Create ECS Cluster
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

    const ecrRepository = cdk.aws_ecr.Repository.fromRepositoryArn(
      this,
      "ECR",
      process.env.ECR_ARN!
    );

    // Add container to task definition
    taskDefinition.addContainer("Container", {
      image: cdk.aws_ecs.ContainerImage.fromEcrRepository(ecrRepository),
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
    const listener = alb.addListener("Listener", {
      port: 80,
    });

    // Create target group for Blue deployment
    const blueTargetGroup =
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
    const greenTargetGroup =
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
    listener.addTargetGroups("TargetGroups", {
      targetGroups: [blueTargetGroup],
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

    // create deployment group
    const deploymentGroup = new cdk.aws_codedeploy.EcsDeploymentGroup(
      this,
      "DeploymentGroup",
      {
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
      }
    );

    service.attachToApplicationTargetGroup(blueTargetGroup);

    const sourceOutput = new cdk.aws_codepipeline.Artifact();

    // ECR Source Action (this action monitors ECR for new image pushes)
    const sourceAction = new cdk.aws_codepipeline_actions.EcrSourceAction({
      actionName: "ECR_Source",
      repository: ecrRepository,
      imageTag: "latest",
      output: sourceOutput,
    });

    // ECS Deploy Action (this action deploys the new image to ECS via CodeDeploy)
    const deployAction =
      new cdk.aws_codepipeline_actions.CodeDeployEcsDeployAction({
        actionName: "ECS_Deploy",
        deploymentGroup,
        taskDefinitionTemplateInput: sourceOutput,
        appSpecTemplateInput: sourceOutput,
      });

    new cdk.aws_codepipeline.Pipeline(this, "EcsPipeline", {
      pipelineName: `${proj}-Pipeline`,
      stages: [
        {
          stageName: "Source",
          actions: [sourceAction],
        },
        {
          stageName: "Deploy",
          actions: [deployAction],
        },
      ],
    });
  }
}
