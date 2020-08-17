import { Vpc } from "@aws-cdk/aws-ec2"
import cxapi = require('@aws-cdk/cx-api')
import { HostedZone } from "@aws-cdk/aws-route53"

export const mockVpcFromLookup = (response?: any) => {
  jest.mock('@aws-cdk/aws-ec2')
  const mockFromLookup = jest.spyOn(Vpc, 'fromLookup')
  mockFromLookup.mockImplementation((scope, id, options) => {
    return response ?? {
      vpcId: options.vpcId ?? 'vpc-1234',
      publicSubnets: [
        {
          subnetId: 'pub-sub-in-us-east-1a',
          availabilityZone: 'us-east-1a',
          routeTable: { routeTableId: 'rt-123' },
        },
        {
          subnetId: 'pub-sub-in-us-east-1b',
          availabilityZone: 'us-east-1b',
          routeTable: { routeTableId: 'rt-123' },
        },
      ],
      privateSubnets: [
        {
          subnetId: 'pri-sub-1-in-us-east-1c',
          availabilityZone: 'us-east-1c',
          routeTable: { routeTableId: 'rt-123' },
        },
        {
          subnetId: 'pri-sub-2-in-us-east-1c',
          availabilityZone: 'us-east-1c',
          routeTable: { routeTableId: 'rt-123' },
        },
        {
          subnetId: 'pri-sub-1-in-us-east-1d',
          availabilityZone: 'us-east-1d',
          routeTable: { routeTableId: 'rt-123' },
        },
        {
          subnetId: 'pri-sub-2-in-us-east-1d',
          availabilityZone: 'us-east-1d',
          routeTable: { routeTableId: 'rt-123' },
        },
      ],
    }
  })
}


export const mockHostedZoneFromLookup = (response?: any) => {
  jest.mock('@aws-cdk/aws-route53')
  const mockFromLookup = jest.spyOn(HostedZone, 'fromLookup')
  mockFromLookup.mockImplementation((scope, id, query) => {
    return response ?? {
      hostedZoneId: 'mockHostedZone-id',
      zoneName: 'mockHostedZone-name',
    }
  })
}