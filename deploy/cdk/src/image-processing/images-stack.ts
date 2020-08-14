import cdk = require('@aws-cdk/core');
import * as s3 from '@aws-cdk/aws-s3';
import { Rule, Schedule } from '@aws-cdk/aws-events';
import { EcsTask } from '@aws-cdk/aws-events-targets';
import * as iam from '@aws-cdk/aws-iam';
import * as ecs from '@aws-cdk/aws-ecs';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as lambda from '@aws-cdk/aws-lambda';
import { S3NotificationToLambdaCustomResource } from './s3ToLambda';
import fs = require('fs');
import { FoundationStack } from '../foundation';

export interface ImagesStackProps extends cdk.StackProps {
  readonly lambdaCodePath: string
  readonly dockerfilePath: string
  readonly rbscBucketName: string
  readonly processBucketName: string
  readonly imageBucketName: string
  readonly foundationStack: FoundationStack;
}

export class ImagesStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: ImagesStackProps) {
    super(scope, id, props);

    if(!fs.existsSync(props.lambdaCodePath)) {
      this.node.addError(`Cannot deploy this stack. Asset path not found ${props.lambdaCodePath}`);
      return;
    }
    if(!fs.existsSync(props.dockerfilePath)) {
      this.node.addError(`Cannot deploy this stack. Asset path not found ${props.dockerfilePath}`);
      return;
    }

    const rbscBucketName = props.rbscBucketName;
    const rbscBucket = s3.Bucket.fromBucketName(this, 'RbscBucket', rbscBucketName);
    const processBucketName = props.processBucketName;
    const processBucket = s3.Bucket.fromBucketName(this, 'ProcessBucket', processBucketName);
    const imageBucketName = props.imageBucketName;
    const imageBucket = s3.Bucket.fromBucketName(this, 'ImageBucket', imageBucketName);

    /* get rbsc bucket and attach object listener */
    const changedImgRole = new iam.Role(this, 'S3ImageRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    changedImgRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: [
        processBucket.bucketArn + '/*',
      ],
      actions: [
        "s3:PutObject",
      ],
    }));
    const awsLambdaLoggingPolicy = 'service-role/AWSLambdaBasicExecutionRole'
    const roleLoggingPolicy = iam.ManagedPolicy.fromAwsManagedPolicyName(awsLambdaLoggingPolicy)
    changedImgRole.addManagedPolicy(roleLoggingPolicy)

    const imageTracker = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.PYTHON_3_8,
      code: lambda.Code.fromAsset(props.lambdaCodePath),
      handler: 'generate.handler',
      environment: {
        PROCESS_BUCKET: processBucketName,
      },
      role: changedImgRole,
    });
    // https://github.com/aws/aws-cdk/issues/2004
    new S3NotificationToLambdaCustomResource(this, id, rbscBucket, imageTracker);

    const cluster = new ecs.Cluster(this, 'Cluster', { vpc: props.foundationStack.vpc });
    cluster.addCapacity('Ec2Group', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO),
      minCapacity: 1,
      maxCapacity: 1,
      desiredCapacity: 1,
    });

    const taskRole = new iam.Role(this, 'MarbleImageTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
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
        "s3:ListBucket"
      ],
    }));
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
    }));

    const taskDef = new ecs.Ec2TaskDefinition(this, "TaskDefinition", {taskRole: taskRole});
    const logging = new ecs.AwsLogDriver({streamPrefix: 'marbleimg'});
    taskDef.addContainer("AppContainer", {
      image: ecs.ContainerImage.fromAsset(props.dockerfilePath),
      memoryLimitMiB: 512,
      logging,
      environment: {
        RBSC_BUCKET: rbscBucketName,
        PROCESS_BUCKET: processBucketName,
        IMAGE_BUCKET: imageBucketName,
      },
    })

    const ecsTaskTarget = new EcsTask({
      cluster: cluster,
      taskDefinition: taskDef
    });

    /* setup ECS to run via cron to process images */
    new Rule(this, 'ScheduleRule', {
      schedule: Schedule.cron({ minute: '0,15,30,45' }),
      targets: [ecsTaskTarget],
    });
  }
}