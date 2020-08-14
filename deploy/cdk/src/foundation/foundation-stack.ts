import { Certificate, CertificateValidation, ICertificate } from "@aws-cdk/aws-certificatemanager";
import { IVpc, Vpc } from "@aws-cdk/aws-ec2";
import { Cluster, ICluster } from "@aws-cdk/aws-ecs";
import { ILogGroup, LogGroup, RetentionDays } from "@aws-cdk/aws-logs";
import { HostedZone, IHostedZone } from "@aws-cdk/aws-route53";
import { Bucket, BucketAccessControl, HttpMethods, IBucket } from "@aws-cdk/aws-s3";
import { Construct, Duration, RemovalPolicy, Stack, StackProps, Fn, CfnOutput } from "@aws-cdk/core";


export interface IBaseStackProps extends StackProps {
  /**
   * The domain name to use for Route53 zones and recordsets and
   * ACM certificates
   */
  readonly domainName: string;

  /**
   * If given, it will use the given Route53 Zone for this Vpc/DomainName 
   * instead of creating one.
   *
   * Note: When using this option, this stack will not share the zone properties
   * via export/import to dependent stacks. Dependent stacks will need to
   * also be deployed with the same option used when the FoundationStack was
   * deployed.
   */
  readonly useExistingDnsZone?: boolean;

  /**
   * If given, it will use the given Vpc instead of creating one.
   *
   * Note: When using this option, this stack will not share the vpc properties
   * via export/import to dependent stacks. Dependent stacks will need to
   * also be deployed with the same option used when the FoundationStack was
   * deployed.
   */
  readonly useVpcId?: string;
}

export class FoundationStack extends Stack {
  /**
   * The VPC to place all services related to this application
   */
  public readonly vpc: IVpc;

  /**
   * The Route53 zone (only created if doCreateZone is true)
   */
  public readonly hostedZone: IHostedZone;

  /**
   * Wildcard certificate for all components of this application
   */
  public readonly certificate: ICertificate;

  /** 
   * Shared cluster for any ECS tasks/services in this application
   */
  public readonly cluster: ICluster;

  /**
   * The shared log bucket to place all logs for components in this application
   */
  public readonly logBucket: IBucket;

  /**
   * The shared log group to place all logs for components in this application
   */
  public readonly logGroup: ILogGroup;

  /**
   * Shared bucket for holding publicly available assets such as IIIF manifests and images. 
   * Do not put secrets/private objects here.
   */
  public readonly publicBucket: IBucket;

  constructor(scope: Construct, id: string, props: IBaseStackProps) {
    super(scope, id, props);

    if(props.useVpcId) {
      this.vpc = Vpc.fromLookup(this, 'VPC', { vpcId: props.useVpcId })
    } else {
      this.vpc = new Vpc(this, 'VPC', {
        maxAzs: 2,
      });
    }

    let certificateValidation = CertificateValidation.fromDns();
    if (props.useExistingDnsZone) {
      this.hostedZone = HostedZone.fromLookup(this, 'HostedZone', { domainName: props.domainName });
    } else {
      this.hostedZone = new HostedZone(this, 'HostedZone', {
        zoneName: props.domainName,
      });
      certificateValidation = CertificateValidation.fromDns(this.hostedZone);
    }

    this.certificate = new Certificate(this, 'Certificate', {
      domainName: `*.${props.domainName}`,
      validation: certificateValidation,
    });

    this.cluster = new Cluster(this, 'Cluster', { vpc: this.vpc });

    this.logBucket = new Bucket(this, 'LogBucket', {
      accessControl: BucketAccessControl.LOG_DELIVERY_WRITE,
      versioned: true,
      removalPolicy: RemovalPolicy.DESTROY,
      lifecycleRules: [{ enabled: true, expiration: Duration.days(365 * 10), noncurrentVersionExpiration: Duration.days(1) }]
    });

    this.logGroup = new LogGroup(this, 'SharedLogGroup', {
      retention: RetentionDays.ONE_YEAR,
    })

    this.publicBucket = new Bucket(this, 'PublicBucket', {
      cors: [
        {
          allowedHeaders: [
            "*"
          ],
          allowedMethods: [
            HttpMethods.GET,
          ],
          allowedOrigins: [ `*.${props.domainName}`],
          maxAge: 3600
        }],
      serverAccessLogsBucket: this.logBucket,
      serverAccessLogsPrefix: 's3/data-broker/',
      websiteIndexDocument: 'index.html',
      publicReadAccess: true,
    });
  }
}