import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { ECSStack } from "./ecs";

export class DeployStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    ecsStack: ECSStack,
    proj: string,
    props?: cdk.StackProps
  ) {
    super(scope, id, props);

    // create CodeDeploy application
    const codedeployApp = new cdk.aws_codedeploy.EcsApplication(
      this,
      "CodeDeployApplication",
      {
        applicationName: `${proj}_CodeDeployApplication`,
      }
    );

    // create CodeDeploy deployment group
    const deploymentGroup = new cdk.aws_codedeploy.EcsDeploymentGroup(
      this,
      "DeploymentGroup",
      {
        service: ecsStack.service,
        application: codedeployApp,
        deploymentGroupName: `${proj}_DeploymentGroup`,
        autoRollback: {
          failedDeployment: true,
        },
        blueGreenDeploymentConfig: {
          blueTargetGroup: ecsStack.blueTargetGroup,
          greenTargetGroup: ecsStack.greenTargetGroup,
          listener: ecsStack.listener,
          terminationWaitTime: cdk.Duration.minutes(60),
          deploymentApprovalWaitTime: cdk.Duration.minutes(10),
        },
      }
    );

    // create CodePipeline artifact to store source output
    const sourceOutput = new cdk.aws_codepipeline.Artifact();

    // create CodePipeline artifact to store build output
    const buildOutput = new cdk.aws_codepipeline.Artifact();

    // ECR Source Action (this action pulls the image from ECR)
    const sourceAction = new cdk.aws_codepipeline_actions.EcrSourceAction({
      actionName: "ECR_Source",
      repository: ecsStack.ecrRepository,
      imageTag: "latest",
      output: sourceOutput,
    });

    const codeBuildProject = new cdk.aws_codebuild.PipelineProject(
      this,
      "CodeBuildProject",
      {
        projectName: `${proj}_BuildProject`,
        environment: {
          buildImage: cdk.aws_codebuild.LinuxBuildImage.STANDARD_5_0,
          computeType: cdk.aws_codebuild.ComputeType.SMALL,
          environmentVariables: {
            TASK_FAMILY: {
              value: `${proj}-task`,
            },
            CONTAINER_NAME: {
              value: `${proj}-container`,
            },
            CONTAINER_PORT: {
              value: "80",
            },
            HOST_PORT: {
              value: "80",
            },
            TASK_ROLE_ARN: {
              value: ecsStack.taskRole.roleArn,
            },
            EXECUTION_ROLE_ARN: {
              value: ecsStack.executionRole.roleArn,
            },
          },
        },
        buildSpec: cdk.aws_codebuild.BuildSpec.fromObject({
          version: "0.2",
          phases: {
            build: {
              commands: [
                "IMAGE_URL=$(jq -r '.ImageURI' imageDetail.json)",
                'echo "{" > taskdef.json',
                'echo "  "family": "$TASK_FAMILY"," >> taskdef.json',
                'echo "  "networkMode": "awsvpc"," >> taskdef.json',
                'echo "  "executionRoleArn": "$EXECUTION_ROLE_ARN"," >> taskdef.json',
                'echo "  "taskRoleArn": "$TASK_ROLE_ARN"," >> taskdef.json',
                'echo "  "containerDefinitions": [" >> taskdef.json',
                'echo "    {" >> taskdef.json',
                'echo "      "name": "$CONTAINER_NAME"," >> taskdef.json',
                'echo "      "image": "$IMAGE_URL"," >> taskdef.json',
                'echo "      "memory": 512," >> taskdef.json',
                'echo "      "cpu": 256," >> taskdef.json',
                'echo "      "essential": true," >> taskdef.json',
                'echo "      "portMappings": [" >> taskdef.json',
                'echo "        {" >> taskdef.json',
                'echo "          "containerPort": $CONTAINER_PORT," >> taskdef.json',
                'echo "          "hostPort": $HOST_PORT" >> taskdef.json',
                'echo "        }" >> taskdef.json',
                'echo "      ]" >> taskdef.json',
                'echo "    }" >> taskdef.json',
                'echo "  ]" >> taskdef.json',
                'echo "}" >> taskdef.json',

                'echo "version: 0.0" > appspec.yaml',
                'echo "Resources:" >> appspec.yaml',
                'echo "  - TargetService:" >> appspec.yaml',
                'echo "      Type: AWS::ECS::Service" >> appspec.yaml',
                'echo "      Properties:" >> appspec.yaml',
                'echo "        TaskDefinition: <TASK_DEFINITION>" >> appspec.yaml',
                'echo "        LoadBalancerInfo:" >> appspec.yaml',
                'echo "          ContainerName: "$CONTAINER_NAME"" >> appspec.yaml',
                'echo "          ContainerPort: $CONTAINER_PORT" >> appspec.yaml',

                "cat taskdef.json",
                "cat appspec.yaml",
              ],
            },
          },
          artifacts: {
            files: ["taskdef.json", "appspec.yaml"],
          },
        }),
      }
    );

    // CodeBuild Project (this project builds the image)
    const buildAction = new cdk.aws_codepipeline_actions.CodeBuildAction({
      actionName: "Build",
      project: codeBuildProject,
      input: sourceOutput,
      outputs: [buildOutput],
    });

    // Approval Action (this action waits for manual approval)
    const approvalAction =
      new cdk.aws_codepipeline_actions.ManualApprovalAction({
        actionName: "ManualApproval",
        runOrder: 1,
      });

    // ECS Deploy Action (this action deploys the image to ECS)
    const deployAction =
      new cdk.aws_codepipeline_actions.CodeDeployEcsDeployAction({
        actionName: "ECS_Deploy",
        deploymentGroup: deploymentGroup,
        appSpecTemplateInput: buildOutput,
        taskDefinitionTemplateInput: buildOutput,
      });

    // create CodePipeline
    new cdk.aws_codepipeline.Pipeline(this, "EcsPipeline", {
      pipelineName: `${proj}-Pipeline`,
      stages: [
        {
          stageName: "Source",
          actions: [sourceAction],
        },
        {
          stageName: "Approval",
          actions: [approvalAction],
        },
        {
          stageName: "Build",
          actions: [buildAction],
        },
        {
          stageName: "Deploy",
          actions: [deployAction],
        },
      ],
    });
  }
}
