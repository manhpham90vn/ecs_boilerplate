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

    const codedeployApp = this.createCodeDeployApplication(proj);
    const deploymentGroup = this.createCodeDeployDeploymentGroup(
      ecsStack,
      codedeployApp,
      proj
    );
    const { sourceOutput, buildOutput } = this.createPipelineArtifacts();

    const sourceAction = this.createECRSourceAction(ecsStack, sourceOutput);
    const buildAction = this.createBuildAction(
      ecsStack,
      proj,
      sourceOutput,
      buildOutput
    );
    const approvalAction = this.createManualApprovalAction();
    const deployAction = this.createDeployAction(deploymentGroup, buildOutput);

    this.createPipeline(
      proj,
      sourceAction,
      approvalAction,
      buildAction,
      deployAction
    );
  }

  private createCodeDeployApplication(
    proj: string
  ): cdk.aws_codedeploy.EcsApplication {
    return new cdk.aws_codedeploy.EcsApplication(
      this,
      "CodeDeployApplication",
      {
        applicationName: `${proj}_CodeDeployApplication`,
      }
    );
  }

  private createCodeDeployDeploymentGroup(
    ecsStack: ECSStack,
    codedeployApp: cdk.aws_codedeploy.EcsApplication,
    proj: string
  ): cdk.aws_codedeploy.EcsDeploymentGroup {
    return new cdk.aws_codedeploy.EcsDeploymentGroup(this, "DeploymentGroup", {
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
    });
  }

  private createPipelineArtifacts() {
    const sourceOutput = new cdk.aws_codepipeline.Artifact();
    const buildOutput = new cdk.aws_codepipeline.Artifact();
    return { sourceOutput, buildOutput };
  }

  private createECRSourceAction(
    ecsStack: ECSStack,
    sourceOutput: cdk.aws_codepipeline.Artifact
  ): cdk.aws_codepipeline_actions.EcrSourceAction {
    return new cdk.aws_codepipeline_actions.EcrSourceAction({
      actionName: "ECR_Source",
      repository: ecsStack.ecrRepository,
      imageTag: "latest",
      output: sourceOutput,
    });
  }

  private createBuildAction(
    ecsStack: ECSStack,
    proj: string,
    sourceOutput: cdk.aws_codepipeline.Artifact,
    buildOutput: cdk.aws_codepipeline.Artifact
  ): cdk.aws_codepipeline_actions.CodeBuildAction {
    const codeBuildProject = this.createCodeBuildProject(ecsStack, proj);
    return new cdk.aws_codepipeline_actions.CodeBuildAction({
      actionName: "Build",
      project: codeBuildProject,
      input: sourceOutput,
      outputs: [buildOutput],
    });
  }

  private createCodeBuildProject(
    ecsStack: ECSStack,
    proj: string
  ): cdk.aws_codebuild.PipelineProject {
    const project = new cdk.aws_codebuild.PipelineProject(
      this,
      "CodeBuildProject",
      {
        projectName: `${proj}_BuildProject`,
        environment: {
          buildImage: cdk.aws_codebuild.LinuxBuildImage.STANDARD_5_0,
          computeType: cdk.aws_codebuild.ComputeType.SMALL,
          environmentVariables: {
            TASK_DEFINITION: {
              value: `${proj}-task`,
            },
            CONTAINER_NAME: {
              value: `${proj}-container`,
            },
            CONTAINER_PORT: {
              value: "80",
            },
          },
        },
        buildSpec: cdk.aws_codebuild.BuildSpec.fromObject({
          version: "0.2",
          phases: {
            build: {
              commands: [
                `echo "const fs = require('fs');" > updateTaskDef.js`,
                `echo "let taskDef = JSON.parse(fs.readFileSync('taskdef.json', 'utf8'));" >> updateTaskDef.js`,
                `echo "taskDef = taskDef.taskDefinition;" >> updateTaskDef.js`,
                `echo "fs.writeFileSync('taskdef.json', JSON.stringify(taskDef, null, 2));" >> updateTaskDef.js`,
                "aws ecs describe-task-definition --task-definition $TASK_DEFINITION --output json > taskdef.json",
                "node updateTaskDef.js",
                'echo "version: 0.0" > appspec.yaml',
                'echo "Resources:" >> appspec.yaml',
                'echo "  - TargetService:" >> appspec.yaml',
                'echo "      Type: AWS::ECS::Service" >> appspec.yaml',
                'echo "      Properties:" >> appspec.yaml',
                'echo "        TaskDefinition: <TASK_DEFINITION>" >> appspec.yaml',
                'echo "        LoadBalancerInfo:" >> appspec.yaml',
                'echo "          ContainerName: \\"$CONTAINER_NAME\\"" >> appspec.yaml',
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
        logging: {
          cloudWatch: {
            logGroup: new cdk.aws_logs.LogGroup(this, "CodeBuildLogGroup", {
              logGroupName: `${proj}-CodeBuildLogGroup`,
              removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
          },
        },
      }
    );

    project.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ["ecs:DescribeTaskDefinition"],
        resources: ["*"],
      })
    );
    return project;
  }

  private createManualApprovalAction(): cdk.aws_codepipeline_actions.ManualApprovalAction {
    return new cdk.aws_codepipeline_actions.ManualApprovalAction({
      actionName: "ManualApproval",
      runOrder: 1,
    });
  }

  private createDeployAction(
    deploymentGroup: cdk.aws_codedeploy.EcsDeploymentGroup,
    buildOutput: cdk.aws_codepipeline.Artifact
  ): cdk.aws_codepipeline_actions.CodeDeployEcsDeployAction {
    return new cdk.aws_codepipeline_actions.CodeDeployEcsDeployAction({
      actionName: "ECS_Deploy",
      deploymentGroup: deploymentGroup,
      appSpecTemplateInput: buildOutput,
      taskDefinitionTemplateInput: buildOutput,
    });
  }

  private createPipeline(
    proj: string,
    sourceAction: cdk.aws_codepipeline_actions.Action,
    approvalAction: cdk.aws_codepipeline_actions.ManualApprovalAction,
    buildAction: cdk.aws_codepipeline_actions.CodeBuildAction,
    deployAction: cdk.aws_codepipeline_actions.CodeDeployEcsDeployAction
  ) {
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
      restartExecutionOnUpdate: true,
    });
  }
}
