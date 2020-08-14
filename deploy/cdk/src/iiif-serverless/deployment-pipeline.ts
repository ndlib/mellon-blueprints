import { CloudFormationCapabilities } from '@aws-cdk/aws-cloudformation';
import { BuildSpec, PipelineProject, LinuxBuildImage } from '@aws-cdk/aws-codebuild';
import codepipeline = require('@aws-cdk/aws-codepipeline');
import codepipelineActions = require('@aws-cdk/aws-codepipeline-actions');
import { PolicyStatement } from '@aws-cdk/aws-iam';
import { Bucket, BucketEncryption } from '@aws-cdk/aws-s3';
import ssm = require('@aws-cdk/aws-ssm');
import cdk = require('@aws-cdk/core');
import { Runtime } from '@aws-cdk/aws-lambda';
import { Fn } from '@aws-cdk/core';
import { NamespacedPolicy, GlobalActions } from '../namespaced-policy';
import { Topic } from '@aws-cdk/aws-sns';
import { ManualApprovalAction } from '@aws-cdk/aws-codepipeline-actions';
import { FoundationStack } from '../foundation';

export interface IDeploymentPipelineStackProps extends cdk.StackProps {
  readonly oauthTokenPath: string;
  readonly appRepoOwner: string;
  readonly appRepoName: string;
  readonly appSourceBranch: string;
  readonly infraRepoOwner: string;
  readonly infraRepoName: string;
  readonly infraSourceBranch: string;
  readonly qaRepoOwner: string;
  readonly qaRepoName: string;
  readonly qaSourceBranch: string;
  readonly namespace: string;
  readonly domainStackName: string;
  readonly foundationStack: FoundationStack;
  readonly hostnamePrefix: string;
  readonly createDns: boolean;
};

export class DeploymentPipelineStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: IDeploymentPipelineStackProps) {
    super(scope, id, props);

    const appRepoUrl = `https://github.com/${props.appRepoOwner}/${props.appRepoName}`;
    const infraRepoUrl = `https://github.com/${props.infraRepoOwner}/${props.infraRepoName}`;
    const resolvedDomain = props.foundationStack.hostedZone.zoneName;
    const testHost = `${props.hostnamePrefix}-test.${resolvedDomain}`;
    const testStackName = `${props.namespace}-image-service-test`;
    const testCDNStackName = `${props.namespace}-image-service-cdn-test`;
    const prodHost = `${props.hostnamePrefix}.${resolvedDomain}`;
    const prodStackName = `${props.namespace}-image-service-prod`;
    const prodCDNStackName = `${props.namespace}-image-service-cdn-prod`;

    const artifactBucket = new Bucket(this, 'artifactBucket', {
      encryption: BucketEncryption.KMS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Source Actions
    const appSourceArtifact = new codepipeline.Artifact('AppCode');
    const appSourceAction = new codepipelineActions.GitHubSourceAction({
        actionName: 'AppCode',
        branch: props.appSourceBranch,
        oauthToken: cdk.SecretValue.secretsManager(props.oauthTokenPath, { jsonField: 'oauth' }),
        output: appSourceArtifact,
        owner: props.appRepoOwner,
        repo: props.appRepoName,
    });
    const qaSourceArtifact = new codepipeline.Artifact('QACode');
    const qaSourceAction = new codepipelineActions.GitHubSourceAction({
        actionName: 'QACode',
        branch: props.qaSourceBranch,
        oauthToken: cdk.SecretValue.secretsManager(props.oauthTokenPath, { jsonField: 'oauth' }),
        output: qaSourceArtifact,
        owner: props.qaRepoOwner,
        repo: props.qaRepoName,
    });
    const infraSourceArtifact = new codepipeline.Artifact('InfraCode');
    const infraSourceAction = new codepipelineActions.GitHubSourceAction({
        actionName: 'InfraCode',
        branch: props.infraSourceBranch,
        oauthToken: cdk.SecretValue.secretsManager(props.oauthTokenPath, { jsonField: 'oauth' }),
        output: infraSourceArtifact,
        owner: props.infraRepoOwner,
        repo: props.infraRepoName,
    });

    const builtCodeArtifact = new codepipeline.Artifact('BuiltCode');
    const build = new PipelineProject(this, 'IIIFServerlessBuild', {
      environment: {
        buildImage: LinuxBuildImage.fromDockerRegistry('lambci/lambda:build-nodejs12.x'),
      },
      buildSpec: BuildSpec.fromObject({
        phases: {
          install: {
            commands: [
              'cd $CODEBUILD_SRC_DIR/dependencies/nodejs',
              'npm install',
            ],
          },
          build: {
            commands: [
              'cd $CODEBUILD_SRC_DIR',
              `aws cloudformation package \
                --template-file ./template.yml \
                --s3-bucket ${artifactBucket.bucketName} \
                --s3-prefix 'CloudformationPackages' \
                --output-template-file package_output.yml`,
            ]
          },
        },
        version: '0.2',
        artifacts: {
          files: ['package_output.yml']
        }
      }),
    });
    build.addToRolePolicy(new PolicyStatement({
      actions: [
        's3:ListBucket',
        's3:GetObject',
        's3:PutObject',
      ],
      resources: [artifactBucket.bucketArn]
    }));
    const buildAction = new codepipelineActions.CodeBuildAction({
      actionName: 'Build',
      input: appSourceArtifact,
      outputs: [builtCodeArtifact],
      project: build,
    });

    const builtTemplatePath = new codepipeline.ArtifactPath(builtCodeArtifact, 'package_output.yml');
    const deployTestAction = new codepipelineActions.CloudFormationCreateUpdateStackAction({
      actionName: 'DeployAPI',
      templatePath: builtTemplatePath,
      stackName: testStackName,
      adminPermissions: false,
      parameterOverrides: {
        SourceBucket: props.foundationStack.publicBucket.bucketName,
        IiifLambdaTimeout: '20'
      },
      capabilities: [
        CloudFormationCapabilities.AUTO_EXPAND,
        CloudFormationCapabilities.ANONYMOUS_IAM,
      ],
      runOrder: 1,
    });
    const cdnTemplatePath = new codepipeline.ArtifactPath(infraSourceArtifact, 'deploy/cloudformation/iiif-serverless-cdn.yml');
    const deployTestCDNAction = new codepipelineActions.CloudFormationCreateUpdateStackAction({
      actionName: 'DeployCDN',
      templatePath: cdnTemplatePath,
      stackName: testCDNStackName,
      adminPermissions: false,
      parameterOverrides: {
        HostnamePrefix: `${props.hostnamePrefix}-test`,
        DomainStackName: props.domainStackName,
        APIStackName: testStackName,
        DomainCertificateArn: props.foundationStack.certificate.certificateArn,
        CreateDNSRecord: props.createDns ? 'True' : 'False',
      },
      capabilities: [
        CloudFormationCapabilities.AUTO_EXPAND,
        CloudFormationCapabilities.ANONYMOUS_IAM,
      ],
      runOrder: 2,
    });

    const smokeTestsProject = new PipelineProject(this, 'IIIFServerlessSmokeTests', {
      buildSpec: BuildSpec.fromObject({
        phases: {
          build: {
            commands: [
              `echo '{
                "values": [
                  {"key": "image-server-host","value": "${testHost}"}
                ]
              }' > test_env.json`,
              `newman run newman/smoke.json -e test_env.json`,
            ],
          },
        },
        version: '0.2',
      }),
      environment: {
        buildImage: LinuxBuildImage.fromDockerRegistry('postman/newman'),
      },
    });
    const smokeTestsAction = new codepipelineActions.CodeBuildAction({
      input: qaSourceArtifact,
      project: smokeTestsProject,
      actionName: 'SmokeTests',
      runOrder: 98,
    });

    // Approval
    const approvalTopic = new Topic(this, 'ApprovalTopic');
    const approvalAction = new ManualApprovalAction({
      actionName: 'Approval',
      additionalInformation: `A new version of ${appRepoUrl} has been deployed to https://${testHost} and is awaiting your approval. If you approve these changes, they will be deployed to https://${prodHost}.\n\n*Application Changes:*\n${appSourceAction.variables.commitMessage}\n\nFor more details on the changes, see ${appRepoUrl}/commit/${appSourceAction.variables.commitId}.\n\n*Infrastructure Changes:*\n${infraSourceAction.variables.commitMessage}\n\nFor more details on the changes, see ${infraRepoUrl}/commit/${infraSourceAction.variables.commitId}.`,
      notificationTopic: approvalTopic,
      runOrder: 99, // This should always be the last action in the stage
    });

    const deployProdAction = new codepipelineActions.CloudFormationCreateUpdateStackAction({
      actionName: 'DeployAPI',
      templatePath: builtTemplatePath,
      stackName: prodStackName,
      adminPermissions: false,
      parameterOverrides: {
        SourceBucket: props.foundationStack.publicBucket.bucketName,
        IiifLambdaTimeout: '20'
      },
      capabilities: [
        CloudFormationCapabilities.AUTO_EXPAND,
        CloudFormationCapabilities.ANONYMOUS_IAM,
      ],
      runOrder: 1,
    });
    const deployProdCDNAction = new codepipelineActions.CloudFormationCreateUpdateStackAction({
      actionName: 'DeployCDN',
      templatePath: cdnTemplatePath,
      stackName: prodCDNStackName,
      adminPermissions: false,
      parameterOverrides: {
        HostnamePrefix: props.hostnamePrefix,
        DomainStackName: props.domainStackName,
        APIStackName: prodStackName,
        DomainCertificateArn: props.foundationStack.certificate.certificateArn,
        CreateDNSRecord: props.createDns ? 'True' : 'False',
      },
      capabilities: [
        CloudFormationCapabilities.AUTO_EXPAND,
        CloudFormationCapabilities.ANONYMOUS_IAM,
      ],
      runOrder: 2,
    });

    const smokeTestsProdProject = new PipelineProject(this, 'IIIFServerlessSmokeTestsProd', {
      buildSpec: BuildSpec.fromObject({
        phases: {
          build: {
            commands: [
              `echo '{
                "values": [
                  {"key": "image-server-host","value": "${prodHost}"}
                ]
              }' > test_env.json`,
              `newman run newman/smoke.json -e test_env.json`,
            ],
          },
        },
        version: '0.2',
      }),
      environment: {
        buildImage: LinuxBuildImage.fromDockerRegistry('postman/newman'),
      },
    });
    const smokeTestsProdAction = new codepipelineActions.CodeBuildAction({
      input: qaSourceArtifact,
      project: smokeTestsProdProject,
      actionName: 'SmokeTests',
      runOrder: 98,
    });

    // Pipeline
    const pipeline = new codepipeline.Pipeline(this, 'DeploymentPipeline', {
      artifactBucket,
      stages: [
        {
          actions: [appSourceAction, qaSourceAction, infraSourceAction],
          stageName: 'Source',
        },
        {
          actions: [buildAction],
          stageName: 'Build',
        },
        {
          actions: [deployTestAction, deployTestCDNAction, smokeTestsAction, approvalAction],
          stageName: 'Test',
        },
        {
          actions: [deployProdAction, deployProdCDNAction, smokeTestsProdAction],
          stageName: 'Production',
        }
      ],
    });

    deployTestAction.addToDeploymentRolePolicy(new PolicyStatement({
      actions: [
        's3:ListBucket',
        's3:GetObject',
      ],
      resources: [
        artifactBucket.bucketArn,
        `${artifactBucket.bucketArn}/*`
      ]
    }));

    deployTestAction.addToDeploymentRolePolicy(NamespacedPolicy.transform());
    deployTestAction.addToDeploymentRolePolicy(NamespacedPolicy.iamRole(testStackName));
    deployTestAction.addToDeploymentRolePolicy(NamespacedPolicy.lambda(testStackName));
    deployTestAction.addToDeploymentRolePolicy(NamespacedPolicy.api());

    deployTestCDNAction.addToDeploymentRolePolicy(NamespacedPolicy.ssm(testCDNStackName));
    deployTestCDNAction.addToDeploymentRolePolicy(NamespacedPolicy.apiDomain(testHost));
    deployTestCDNAction.addToDeploymentRolePolicy(NamespacedPolicy.globals([GlobalActions.Cloudfront, GlobalActions.Route53]));

    deployProdAction.addToDeploymentRolePolicy(new PolicyStatement({
      actions: [
        's3:ListBucket',
        's3:GetObject',
      ],
      resources: [
        artifactBucket.bucketArn,
        `${artifactBucket.bucketArn}/*`
      ]
    }));

    deployProdAction.addToDeploymentRolePolicy(NamespacedPolicy.transform());
    deployProdAction.addToDeploymentRolePolicy(NamespacedPolicy.iamRole(prodStackName));
    deployProdAction.addToDeploymentRolePolicy(NamespacedPolicy.lambda(prodStackName));
    deployProdAction.addToDeploymentRolePolicy(NamespacedPolicy.api());

    deployProdCDNAction.addToDeploymentRolePolicy(NamespacedPolicy.ssm(prodCDNStackName));
    deployProdCDNAction.addToDeploymentRolePolicy(NamespacedPolicy.apiDomain(prodHost));
    deployProdCDNAction.addToDeploymentRolePolicy(NamespacedPolicy.globals([GlobalActions.Cloudfront, GlobalActions.Route53]));

    if(props.createDns){
      const hostedZone = props.foundationStack.hostedZone.hostedZoneId;
      deployTestCDNAction.addToDeploymentRolePolicy(NamespacedPolicy.route53RecordSet(hostedZone));
      deployProdCDNAction.addToDeploymentRolePolicy(NamespacedPolicy.route53RecordSet(hostedZone));
    }
  }
}
