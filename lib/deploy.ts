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

    // CodeBuild Project (this project builds the image)
    const codeBuildProject = new cdk.aws_codebuild.PipelineProject(
      this,
      "CodeBuildProject",
      {
        projectName: `${proj}_BuildProject`,
        environment: {
          buildImage: cdk.aws_codebuild.LinuxBuildImage.STANDARD_5_0,
        },
        buildSpec: cdk.aws_codebuild.BuildSpec.fromObject({
          version: "0.2",
          phases: {
            build: {
              commands: [
                "echo Creating appspec.yml",
                'echo "version: 0.0" > appspec.yml',
                'echo "Resources:" >> appspec.yml',
                'echo "  myEcsService:" >> appspec.yml',
                'echo "    Type: AWS::CodeDeploy::ECS::DeploymentGroup" >> appspec.yml',
                'echo "    Properties:" >> appspec.yml',
                'echo "      TaskDefinition: $TASK_DEFINITION_ARN" >> appspec.yml',
                'echo "      LoadBalancerInfo:" >> appspec.yml',
                'echo "        ContainerName: $CONTAINER_NAME" >> appspec.yml',
                'echo "        ContainerPort: $CONTAINER_PORT" >> appspec.yml',
              ],
            },
          },
          artifacts: {
            files: ["appspec.yml", "**/*"],
          },
          environment: {
            variables: {
              TASK_DEFINITION_ARN: ecsStack.taskDefinition.taskDefinitionArn,
              CONTAINER_NAME: "web",
              CONTAINER_PORT: "80",
            },
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
        deploymentGroup,
        appSpecTemplateInput: buildOutput,
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
