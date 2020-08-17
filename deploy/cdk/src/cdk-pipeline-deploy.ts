import { BuildSpec, LinuxBuildImage, PipelineProject, PipelineProjectProps } from '@aws-cdk/aws-codebuild'
import { Artifact } from '@aws-cdk/aws-codepipeline'
import { CodeBuildAction } from '@aws-cdk/aws-codepipeline-actions'
import { PolicyStatement } from '@aws-cdk/aws-iam'
import { Construct, Fn } from '@aws-cdk/core'

export interface ICDKPipelineDeployProps extends PipelineProjectProps {
  /**
   * The name of the stack that this project will deploy to. Will add
   * permissions to create change sets on these stacks.
   */
  readonly targetStack: string;
  /**
   * The stack names that the target stack will depend on. Will add permissions
   * to also create change sets on these stacks. Note: This can be ignored
   * if using the cdk deploy --exclusively option.
   */
  readonly dependsOnStacks: string[];

  /**
   * Infrastructure source artifact. Must include the cdk code
   */
  readonly infraSourceArtifact: Artifact;

  /**
   * Application source artifact.
   */
  readonly appSourceArtifact: Artifact;

  /**
   * Subdirectory of the infrastructure source where the cdk code can be found, without leading /
   * The action created will use infra source as primary input, so this should be a subdir of the
   * CODEBUILD_SRC_DIR environment variable
   */
  readonly cdkDirectory?: string;

  /**
   * Namespace to use for stack names etc
   */
  readonly namespace: string;

  /**
   * Any additional key value pairs to pass as additional --context overrides when deploying
   */
  readonly additionalContext?: { [key: string]: string };

  readonly contextEnvName: string;
  readonly appBuildCommands?: string[];
  readonly postDeployCommands?: string[];
  readonly outputFiles?: string[];
  readonly outputArtifacts?: Artifact[];
}

/**
 * Convenience class for creating a PipelineProject and Action that will use cdk to deploy
 * the service stacks in this application. Primarily handles adding the necessary
 * permissions for cdk to make changes to the target stacks involved.
 */
export class CDKPipelineDeploy extends Construct {
  public readonly project: PipelineProject
  public readonly action: CodeBuildAction

  constructor(scope: Construct, id: string, props: ICDKPipelineDeployProps) {
    super(scope, id)

    let addtlContext = ''
    if(props.additionalContext !== undefined){
      Object.entries(props.additionalContext).forEach((val) => {
        addtlContext += ` -c "${val[0]}=${val[1]}"`
      })
    }
    this.project = new PipelineProject(scope, `${id}Project`, {
      environment: {
        buildImage: LinuxBuildImage.STANDARD_4_0,
        privileged: true,
      },
      buildSpec: BuildSpec.fromObject({
        artifacts: {
          files: props.outputFiles || [],
        },
        phases: {
          install: {
            commands: [
              `cd $CODEBUILD_SRC_DIR/${props.cdkDirectory || ''}`,
              'yarn install',
            ],
            'runtime-versions': {
              nodejs: '12.x',
            },
          },
          pre_build: {
            commands: [
              `cd $CODEBUILD_SRC_DIR_${props.appSourceArtifact.artifactName}`,
              ...(props.appBuildCommands || []),
            ],
          },
          build: {
            commands: [
              `cd $CODEBUILD_SRC_DIR/${props.cdkDirectory || ''}`,
              `npm run cdk deploy -- ${props.targetStack} \
                --require-approval never --exclusively \
                -c "namespace=${props.namespace}" -c "env=${props.contextEnvName}" ${addtlContext}`,
            ],
          },
          post_build: {
            commands: props.postDeployCommands || [],
          },
        },
        version: '0.2',
      }),
    })

    // CDK will try to read logs when generating output for failed events
    this.project.addToRolePolicy(new PolicyStatement({
      actions: [ 'logs:DescribeLogGroups'],
      resources: [ '*' ],
    }))

    // Anytime cdk deploys a stack without --exclusively, it will try to also update the stacks it depends on.
    // So, we need to give the pipeline permissions to update the target stack and the stacks it depends on.
    this.project.addToRolePolicy(new PolicyStatement({
      actions: [
        'cloudformation:CreateChangeSet',
        'cloudformation:DeleteStack',
        'cloudformation:DeleteChangeSet',
        'cloudformation:DescribeChangeSet',
        'cloudformation:DescribeStacks',
        'cloudformation:DescribeStackEvents',
        'cloudformation:ExecuteChangeSet',
        'cloudformation:GetTemplate',
      ],
      resources: [props.targetStack, ...props.dependsOnStacks].map(s => Fn.sub('arn:aws:cloudformation:${AWS::Region}:${AWS::AccountId}:stack/' + s + '/*')),
    }))

    // Add permissions to read CDK bootstrap stack/bucket
    this.project.addToRolePolicy(new PolicyStatement({
      actions: ['cloudformation:DescribeStacks'],
      resources: [ Fn.sub('arn:aws:cloudformation:${AWS::Region}:${AWS::AccountId}:stack/CDKToolkit/*') ],
    }))
    this.project.addToRolePolicy(new PolicyStatement({
      // TODO: Is there a way to get the bucket name?
      actions: [
        's3:ListBucket',
        's3:GetObject',
        's3:PutObject',
        's3:ListBucketVersions',
        's3:GetBucketLocation',
        's3:GetBucketPolicy',
      ],
      resources: [ 'arn:aws:s3:::cdktoolkit-stagingbucket-*' ],
    }))

    this.action = new CodeBuildAction({
      actionName: 'Deploy',
      input: props.infraSourceArtifact,
      extraInputs: [props.appSourceArtifact],
      project: this.project,
      runOrder: 1,
      outputs: props.outputArtifacts || [],
    })
  }
}