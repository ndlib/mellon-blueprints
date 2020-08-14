import { PolicyStatement } from '@aws-cdk/aws-iam';
import { Fn, Stack } from '@aws-cdk/core';

export enum GlobalActions {
  None,
  Autoscaling,
  Cloudfront,
  Cloudwatch,
  EC2,
  ECS,
  ECR,
  Route53,
  S3,
}

export class NamespacedPolicy {
  // For actions that only support '*', ie cannot be namespaced
  public static globals(actionOptions: GlobalActions[]): PolicyStatement {
    let actions : string[] = [];
    if(actionOptions.includes(GlobalActions.S3)){
      actions.push('s3:CreateBucket');
    }
    if(actionOptions.includes(GlobalActions.Cloudfront)){
      actions = [...actions,
        'cloudfront:TagResource',
        'cloudfront:CreateDistribution',
        'cloudfront:GetDistribution',
        'cloudfront:UpdateDistribution',
        'cloudfront:DeleteDistribution',
        'cloudfront:CreateCloudFrontOriginAccessIdentity',
        'cloudfront:GetCloudFrontOriginAccessIdentity',
        'cloudfront:GetCloudFrontOriginAccessIdentityConfig',
        'cloudfront:UpdateCloudFrontOriginAccessIdentity',
        'cloudfront:DeleteCloudFrontOriginAccessIdentity',
      ];
    }
    if(actionOptions.includes(GlobalActions.Route53)){
      actions.push('route53:ListHostedZones');
    }
    if(actionOptions.includes(GlobalActions.ECR)) {
      actions.push('ecr:GetAuthorizationToken');
    }
    if(actionOptions.includes(GlobalActions.Autoscaling)) {
      actions.push('autoscaling:Describe*');
    }
    if(actionOptions.includes(GlobalActions.EC2)) {
      actions = [...actions,
        'ec2:Describe*',
        'ec2:CreateSecurityGroup',
        'ec2:CreateTags',
        'ec2:RevokeSecurityGroupEgress',
        'ec2:AuthorizeSecurityGroupEgress',
      ];
    }
    if(actionOptions.includes(GlobalActions.ECS)) {
      actions = [...actions,
        'ecs:Describe*',
        'ecs:CreateCluster',
        'ecs:RegisterTaskDefinition',
        'ecs:DeregisterTaskDefinition',
      ];
    }
    if(actionOptions.includes(GlobalActions.Cloudwatch)) {
      actions = [...actions,
        'cloudformation:ListExports',
        'logs:CreateLogGroup',
        'logs:DescribeLogGroups',
      ];
    }
    return new PolicyStatement({
      resources: ['*'],
      actions,
    });
  }

  public static iamRole(stackName: string): PolicyStatement  {
    return new PolicyStatement({
      resources: [ Fn.sub('arn:aws:iam::${AWS::AccountId}:role/' + stackName + '*') ],
      actions: ['iam:*'],
    });
  }

  public static iamInstanceProfile(stackName: string): PolicyStatement  {
    return new PolicyStatement({
      resources: [ Fn.sub('arn:aws:iam::${AWS::AccountId}:instance-profile/' + stackName + '*') ],
      actions: ['iam:CreateInstanceProfile', 'iam:AddRoleToInstanceProfile'],
    });
  }

  public static lambda(stackName: string): PolicyStatement {
    return new PolicyStatement({
      resources: [
        Fn.sub('arn:aws:lambda:${AWS::Region}:${AWS::AccountId}:function:' + stackName + '*'),
        Fn.sub('arn:aws:lambda:${AWS::Region}:${AWS::AccountId}:layer:' + stackName + '*'),
      ],
      actions: ['lambda:*'],
    });
  }

  // This is sort of a global, but I don't want to put it in globals. Doing so
  // would give full permissions to domains, since domains are under apigateway actions.
  public static api(): PolicyStatement {
    return new PolicyStatement({
      resources: [
        Fn.sub('arn:aws:apigateway:${AWS::Region}::/account'),
        Fn.sub('arn:aws:apigateway:${AWS::Region}::/restapis'),
        Fn.sub('arn:aws:apigateway:${AWS::Region}::/restapis/*'),
        Fn.sub('arn:aws:apigateway:${AWS::Region}::/domainnames/*'),
        Fn.sub('arn:aws:apigateway:${AWS::Region}::/domainnames'),
      ],
      actions: [
        'apigateway:*',
      ],
    });
  }

  public static apiDomain(domainName: string): PolicyStatement {
    return new PolicyStatement({
      resources: [
        Fn.sub('arn:aws:apigateway:${AWS::Region}::/domainnames'),
        Fn.sub('arn:aws:apigateway:${AWS::Region}::/domainnames/${domainName}', { domainName }),
        Fn.sub('arn:aws:apigateway:${AWS::Region}::/domainnames/${domainName}/*', { domainName }),
        Fn.sub('arn:aws:apigateway:${AWS::Region}::/tags/arn%3Aaws%3Aapigateway%3A${AWS::Region}%3A%3A%2Fdomainnames%2F${domainName}', { domainName }),
      ],
      actions: [
        'apigateway:POST',
        'apigateway:PUT',
        'apigateway:GET',
        'apigateway:DELETE',
      ],
    });
  }

  public static s3(stackName: string): PolicyStatement {
    return new PolicyStatement({
      resources: [ Fn.sub('arn:aws:s3:::' + stackName + '*') ],
      actions: ['s3:*'],
    });
  }

  public static transform(): PolicyStatement {
    return new PolicyStatement({
      resources: [ Fn.sub('arn:aws:cloudformation:${AWS::Region}:aws:transform/Serverless-2016-10-31') ],
      actions: ['cloudformation:CreateChangeSet'],
    });
  }

  public static route53RecordSet(zone: string): PolicyStatement {
    return new PolicyStatement({
      actions: [
        'route53:GetHostedZone',
        'route53:ChangeResourceRecordSets',
        'route53:GetChange',
      ],
      resources: [
        `arn:aws:route53:::hostedzone/${zone}`,
        'arn:aws:route53:::change/*',
      ],
    });
  };

  public static ssm(stackName: string): PolicyStatement {
    return new PolicyStatement({
      actions: [
        'ssm:*'
      ],
      resources: [
        Fn.sub('arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/all/stacks/' + stackName + '/*'),
      ],
    });
  };

  public static dynamodb(stackName: string): PolicyStatement  {
    return new PolicyStatement({
      resources: [ Fn.sub('arn:aws:dynamodb:${AWS::Region}:${AWS::AccountId}:table/' + stackName + '*') ],
      actions: [
        'dynamodb:CreateBackup',
        'dynamodb:CreateTable',
        'dynamodb:UpdateTable',
        'dynamodb:DeleteTable',
        'dynamodb:UpdateTimeToLive',
        'dynamodb:DescribeTable',
        'dynamodb:DescribeTimeToLive',
        'dynamodb:TagResource',
        'dynamodb:UntagResource',
        'dynamodb:ListTagsOfResource',
      ],
    });
  };

  public static ecr(): PolicyStatement  {
    return new PolicyStatement({
      resources: [ Fn.sub('arn:aws:ecr:${AWS::Region}:${AWS::AccountId}:repository/aws-cdk/assets') ],
      actions: [
        'ecr:DescribeRepositories',
        'ecr:DescribeImages',
        'ecr:InitiateLayerUpload',
        'ecr:UploadLayerPart',
        'ecr:CompleteLayerUpload',
        'ecr:BatchCheckLayerAvailability',
        'ecr:PutImage',
      ],
    });
  };

  public static autoscale(stackName: string): PolicyStatement  {
    return new PolicyStatement({
      resources: [
        Fn.sub('arn:aws:autoscaling:${AWS::Region}:${AWS::AccountId}:launchConfiguration:*:launchConfigurationName/' + stackName + '*'),
        Fn.sub('arn:aws:autoscaling:${AWS::Region}:${AWS::AccountId}:autoScalingGroup:*:autoScalingGroupName/' + stackName + '*'),
      ],
      actions: [
        'autoscaling:CreateAutoScalingGroup',
        'autoscaling:UpdateAutoScalingGroup',
        'autoscaling:PutLifecycleHook',
        'autoscaling:CreateLaunchConfiguration'
      ],
    });
  };

  public static events(stackName: string): PolicyStatement  {
    return new PolicyStatement({
      resources: [
        Fn.sub('arn:aws:events:${AWS::Region}:${AWS::AccountId}:rule/' + stackName + '*'),
      ],
      actions: [
        'events:PutEvents',
        'events:DescribeRule',
        'events:PutRule',
        'events:DeleteRule',
        'events:TagResource',
        'events:UntagResource',
        'events:PutTargets',
        'events:RemoveTargets',
      ],
    });
  };

  public static sns(stackName: string): PolicyStatement  {
    return new PolicyStatement({
      resources: [
        Fn.sub('arn:aws:sns:${AWS::Region}:${AWS::AccountId}:' + stackName + '*'),
      ],
      actions: [
        'sns:CreateTopic',
        'sns:GetTopicAttributes',
        'sns:Subscribe'
      ],
    });
  };

  public static logstream(stackName: string): PolicyStatement {
    return new PolicyStatement({
      resources: [
        Fn.sub('arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/codebuild/${AWS::StackName}-*'),
      ],
      actions: [
        'logs:CreateLogStream'
      ],
    });
  }
}