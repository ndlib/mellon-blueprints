import { BuildSpec, LinuxBuildImage, PipelineProject } from '@aws-cdk/aws-codebuild'
import codepipeline = require('@aws-cdk/aws-codepipeline')
import codepipelineActions = require('@aws-cdk/aws-codepipeline-actions')
import { ManualApprovalAction } from '@aws-cdk/aws-codepipeline-actions'
import { PolicyStatement } from '@aws-cdk/aws-iam'
import { Bucket, BucketEncryption } from '@aws-cdk/aws-s3'
import { Topic } from '@aws-cdk/aws-sns'
import cdk = require('@aws-cdk/core')
import { SlackApproval, PipelineNotifications } from '@ndlib/ndlib-cdk'
import { CDKPipelineDeploy } from '../cdk-pipeline-deploy'
import { NamespacedPolicy } from '../namespaced-policy'
import { FoundationStack } from '../foundation'

export interface IDeploymentPipelineStackProps extends cdk.StackProps {
  readonly oauthTokenPath: string;
  readonly appRepoOwner: string;
  readonly appRepoName: string;
  readonly appSourceBranch: string;
  readonly infraRepoOwner: string;
  readonly infraRepoName: string;
  readonly infraSourceBranch: string;
  readonly namespace: string;
  readonly contextEnvName: string;
  readonly owner: string;
  readonly contact: string;
  readonly tokenAudiencePath: string;
  readonly tokenIssuerPath: string;
  readonly slackNotifyStackName?: string;
  readonly allowedOrigins: string;
  readonly notificationReceivers?: string;
  readonly foundationStack: FoundationStack;
  readonly hostnamePrefix: string;
  readonly createDns: boolean;
}

export class DeploymentPipelineStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: IDeploymentPipelineStackProps) {
    super(scope, id, props)

    const testStackName = `${props.namespace}-test-user-content`
    const prodStackName = `${props.namespace}-prod-user-content`

    // Helper for creating a Pipeline project and action with deployment permissions needed by this pipeline
    const createDeploy = (targetStack: string, namespace: string, hostnamePrefix: string) => {
      const domainName = `${hostnamePrefix}.${props.foundationStack.hostedZone.zoneName}`
      const cdkDeploy = new CDKPipelineDeploy(this, `${namespace}-deploy`, {
        targetStack,
        dependsOnStacks: [],
        infraSourceArtifact,
        appSourceArtifact,
        appBuildCommands: [
          'yarn',
          'cd src',
          'yarn',
        ],
        cdkDirectory: 'deploy/cdk',
        namespace: `${namespace}`,
        contextEnvName: props.contextEnvName,
        additionalContext: {
          description: "User content API",
          projectName: "marble",
          owner: props.owner,
          contact: props.contact,
          "userContent:lambdaCodePath": "$CODEBUILD_SRC_DIR_AppCode/src",
          "userContent:allowedOrigins": props.allowedOrigins,
          "userContent:hostnamePrefix": hostnamePrefix,
          "createDns": props.createDns ? "true" : "false",
        },
      })
      cdkDeploy.project.addToRolePolicy(new PolicyStatement({
        actions: ['ssm:GetParameters'],
        resources:[
          cdk.Fn.sub('arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter' + props.tokenAudiencePath),
          cdk.Fn.sub('arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter' + props.tokenIssuerPath),
        ],
      }))
      cdkDeploy.project.addToRolePolicy(NamespacedPolicy.api())
      cdkDeploy.project.addToRolePolicy(NamespacedPolicy.apiDomain(domainName))
      cdkDeploy.project.addToRolePolicy(NamespacedPolicy.dynamodb(targetStack))
      cdkDeploy.project.addToRolePolicy(NamespacedPolicy.iamRole(targetStack))
      cdkDeploy.project.addToRolePolicy(NamespacedPolicy.lambda(targetStack))

      if(props.createDns){
        cdkDeploy.project.addToRolePolicy(NamespacedPolicy.route53RecordSet(props.foundationStack.hostedZone.hostedZoneId))
      }
      return cdkDeploy
    }

    const artifactBucket = new Bucket(this, 'artifactBucket', {
      encryption: BucketEncryption.KMS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    // Source Actions
    const appSourceArtifact = new codepipeline.Artifact('AppCode')
    const appSourceAction = new codepipelineActions.GitHubSourceAction({
        actionName: 'AppCode',
        branch: props.appSourceBranch,
        oauthToken: cdk.SecretValue.secretsManager(props.oauthTokenPath, { jsonField: 'oauth' }),
        output: appSourceArtifact,
        owner: props.appRepoOwner,
        repo: props.appRepoName,
    })
    const infraSourceArtifact = new codepipeline.Artifact('InfraCode')
    const infraSourceAction = new codepipelineActions.GitHubSourceAction({
        actionName: 'InfraCode',
        branch: props.infraSourceBranch,
        oauthToken: cdk.SecretValue.secretsManager(props.oauthTokenPath, { jsonField: 'oauth' }),
        output: infraSourceArtifact,
        owner: props.infraRepoOwner,
        repo: props.infraRepoName,
    })

    // Deploy to Test
    const testHostnamePrefix = `${props.hostnamePrefix}-test`
    const deployTest = createDeploy(testStackName, `${props.namespace}-test`, testHostnamePrefix)
    const testHostname = `https://${testHostnamePrefix}.` + props.foundationStack.hostedZone.zoneName
    const smokeTestsProject = new PipelineProject(this, 'MarbleUserContentSmokeTests', {
      buildSpec: BuildSpec.fromObject({
        phases: {
          build: {
            commands: [
              `newman run tests/postman/collection.json --folder Smoke --env-var api=${testHostname}`,
            ],
          },
        },
        version: '0.2',
      }),
      environment: {
        buildImage: LinuxBuildImage.fromDockerRegistry('postman/newman'),
      },
    })
    const smokeTestsAction = new codepipelineActions.CodeBuildAction({
      input: appSourceArtifact,
      project: smokeTestsProject,
      actionName: 'SmokeTests',
      runOrder: 98,
    })

    // Approval
    const appRepoUrl = `https://github.com/${props.appRepoOwner}/${props.appRepoName}`
    const approvalTopic = new Topic(this, 'ApprovalTopic')
    const approvalAction = new ManualApprovalAction({
      actionName: 'Approval',
      additionalInformation: `A new version of ${appRepoUrl} has been deployed to stack '${testStackName}' and is awaiting your approval. If you approve these changes, they will be deployed to stack '${prodStackName}'.`,
      notificationTopic: approvalTopic,
      runOrder: 99, // This should always be the last action in the stage
    })
    if(props.slackNotifyStackName !== undefined){
      const slackApproval = new SlackApproval(this, 'SlackApproval', {
        approvalTopic,
        notifyStackName: props.slackNotifyStackName,
      })
    }

    // Deploy to Production
    const prodHostnamePrefix = props.hostnamePrefix
    const deployProd = createDeploy(prodStackName, `${props.namespace}-prod`, props.hostnamePrefix)
    const prodHostname = `https://${prodHostnamePrefix}.` + props.foundationStack.hostedZone.zoneName
    const smokeTestsProdProject = new PipelineProject(this, 'MarbleUserContentProdSmokeTests', {
      buildSpec: BuildSpec.fromObject({
        phases: {
          build: {
            commands: [
              `newman run tests/postman/collection.json --folder Smoke --env-var api=${prodHostname}`,
            ],
          },
        },
        version: '0.2',
      }),
      environment: {
        buildImage: LinuxBuildImage.fromDockerRegistry('postman/newman'),
      },
    })
    const smokeTestsProdAction = new codepipelineActions.CodeBuildAction({
      input: appSourceArtifact,
      project: smokeTestsProdProject,
      actionName: 'SmokeTests',
      runOrder: 98,
    })

    // Pipeline
    const pipeline = new codepipeline.Pipeline(this, 'DeploymentPipeline', {
      artifactBucket,
      stages: [
        {
          actions: [appSourceAction, infraSourceAction],
          stageName: 'Source',
        },
        {
          actions: [deployTest.action, smokeTestsAction, approvalAction],
          stageName: 'Test',
        },
        {
          actions: [deployProd.action, smokeTestsProdAction],
          stageName: 'Production',
        },
      ],
    })
    if(props.notificationReceivers){
      const notifications = new PipelineNotifications(this, 'PipelineNotifications', {
        pipeline,
        receivers: props.notificationReceivers,
      })
    }
  }
}