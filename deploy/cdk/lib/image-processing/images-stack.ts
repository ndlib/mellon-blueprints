import * as ec2 from '@aws-cdk/aws-ec2'
import * as ecs from '@aws-cdk/aws-ecs'
import * as autoscale from '@aws-cdk/aws-autoscaling'
import { Rule, Schedule } from '@aws-cdk/aws-events'
import { EcsTask } from '@aws-cdk/aws-events-targets'
import * as iam from '@aws-cdk/aws-iam'
import * as lambda from '@aws-cdk/aws-lambda'
import * as s3 from '@aws-cdk/aws-s3'
import cdk = require('@aws-cdk/core')
import fs = require('fs')
import { FoundationStack } from '../foundation'
import { S3NotificationToLambdaCustomResource } from './s3ToLambda'
import { ManifestPipelineStack } from '../manifest-pipeline'

export interface ImagesStackProps extends cdk.StackProps {
  readonly lambdaCodePath: string;
  readonly dockerfilePath: string;
  readonly rbscBucketName: string;
  readonly manifestPipelineStack: ManifestPipelineStack;
  readonly foundationStack: FoundationStack;
}

export class ImagesStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: ImagesStackProps) {
    super(scope, id, props)

    const rbscBucketName = 'rbsc-test-files'
    const rbscBucket = s3.Bucket.fromBucketName(this, 'RbscBucket', rbscBucketName)
    const processBucket = s3.Bucket.fromBucketName(this, 'ProcessBucket', 'devred-sample-image')
    const imageBucket = props.foundationStack.publicBucket

    /* get rbsc bucket and attach object listener */
    const changedImgRole = new iam.Role(this, 'S3ImageRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    })
    changedImgRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: [
        processBucket.bucketArn + '/*',
      ],
      actions: [
        "s3:PutObject",
      ],
    }))
    const awsLambdaLoggingPolicy = 'service-role/AWSLambdaBasicExecutionRole'
    const roleLoggingPolicy = iam.ManagedPolicy.fromAwsManagedPolicyName(awsLambdaLoggingPolicy)
    changedImgRole.addManagedPolicy(roleLoggingPolicy)

    if(!fs.existsSync(props.lambdaCodePath)) {
      this.node.addError(`Cannot deploy this stack. Asset path not found ${props.lambdaCodePath}`)
      return
    }
    const imageTracker = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.PYTHON_3_8,
      code: lambda.Code.fromAsset(props.lambdaCodePath),
      handler: 'generate.handler',
      environment: {
        PROCESS_BUCKET: processBucket.bucketName,
      },
      role: changedImgRole,
    })
    // https://github.com/aws/aws-cdk/issues/2004
    new S3NotificationToLambdaCustomResource(this, id, rbscBucket, imageTracker)

    const ebsProps = { deleteOnTermination: true, volumeType: autoscale.EbsDeviceVolumeType.GP2 }
    const cluster = props.foundationStack.cluster as ecs.Cluster
    cluster.addCapacity('Ec2Group', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: autoscale.BlockDeviceVolume.ebs(10, ebsProps),
      }],
    })

    const taskRole = new iam.Role(this, 'MarbleImageTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    })
    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: [
        processBucket.bucketArn,
        processBucket.bucketArn + '/*',
        imageBucket.bucketArn,
        imageBucket.bucketArn + '/*',
      ],
      actions: [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
      ],
    }))
    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: [
        cdk.Fn.sub('arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/all/marble*'),
      ],
      actions: ["ssm:Get*"],
    }))
    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: [
        rbscBucket.bucketArn + '/*',
      ],
      actions: [
        "s3:GetObject",
      ],
    }))

    const taskDef = new ecs.Ec2TaskDefinition(this, "TaskDefinition", { taskRole })
    const logging = new ecs.AwsLogDriver({ streamPrefix: 'marbleimg' })

    if(!fs.existsSync(props.dockerfilePath)) {
      this.node.addError(`Cannot deploy this stack. Asset path not found ${props.dockerfilePath}`)
      return
    }
    taskDef.addContainer("AppContainer", {
      image: ecs.ContainerImage.fromAsset(props.dockerfilePath),
      memoryLimitMiB: 512,
      logging,
      environment: {
        LEVEL0: 'enable',
        RBSC_BUCKET: rbscBucketName,
        PROCESS_BUCKET: processBucket.bucketName,
        IMAGE_BUCKET: imageBucket.bucketName,
      },
    })

    const ecsTaskTarget = new EcsTask({
      cluster,
      taskDefinition: taskDef,
    })

    /* setup ECS to run via cron to process images */
    new Rule(this, 'ScheduleRule', {
      schedule: Schedule.cron({ minute: '0,30' }),
      targets: [ecsTaskTarget],
    })
  }
}