import * as cr from '@aws-cdk/custom-resources';
import * as logs from '@aws-cdk/aws-logs';
import * as s3 from '@aws-cdk/aws-s3';
import * as lambda from '@aws-cdk/aws-lambda';
import * as iam from '@aws-cdk/aws-iam';
import {Construct} from '@aws-cdk/core';


export class S3NotificationToLambdaCustomResource extends Construct {

    constructor(scope: Construct, id: string, bucket: s3.IBucket, lambda: lambda.Function) {
        super(scope, id);

        // https://stackoverflow.com/questions/58087772/aws-cdk-how-to-add-an-event-notification-to-an-existing-s3-bucket
        const notificationResource = new cr.AwsCustomResource(scope, id+"CustomResource", {
            onCreate: {
                service: 'S3',
                action: 'putBucketNotificationConfiguration',
                parameters: {
                    Bucket: bucket.bucketName,
                    NotificationConfiguration: {
                        LambdaFunctionConfigurations: [
                            {
                                Events: ['s3:ObjectCreated:Put', 's3:ObjectCreated:Post'],
                                LambdaFunctionArn: lambda.functionArn,
                                Filter: {
                                    Key: {
                                        FilterRules: [{ Name: 'prefix', Value: 'digital' }]
                                    }
                                }
                            },
                            {
                                Events: ['s3:ObjectCreated:Put', 's3:ObjectCreated:Post'],
                                LambdaFunctionArn: lambda.functionArn,
                                Filter: {
                                    Key: {
                                        FilterRules: [{ Name: 'prefix', Value: 'collections/ead_xml/images' }]
                                    }
                                }
                            },
                        ]
                    }
                },
                physicalResourceId: <cr.PhysicalResourceId>(id + Date.now().toString()),
            },
            policy: cr.AwsCustomResourcePolicy.fromStatements([new iam.PolicyStatement({
                // The actual function is PutBucketNotificationConfiguration.
                // The "Action" for IAM policies is PutBucketNotification.
                // https://docs.aws.amazon.com/AmazonS3/latest/dev/list_amazons3.html#amazons3-actions-as-permissions
                actions: ["S3:PutBucketNotification"],
                 // allow this custom resource to modify this bucket
                resources: [bucket.bucketArn],
            })]),
            logRetention: logs.RetentionDays.ONE_DAY,
        });

        lambda.addPermission('AllowS3Invocation', {
            action: 'lambda:InvokeFunction',
            principal: new iam.ServicePrincipal('s3.amazonaws.com'),
            sourceArn: bucket.bucketArn
        });

        // don't create the notification custom-resource until after both the bucket and lambda
        // are fully created and policies applied.
        notificationResource.node.addDependency(bucket);
        notificationResource.node.addDependency(lambda);
        notificationResource.node.addDependency(lambda.permissionsNode.findChild('AllowS3Invocation'));
    }
}