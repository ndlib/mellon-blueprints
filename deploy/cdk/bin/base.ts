#!/usr/bin/env node
import { App, ConstructNode } from '@aws-cdk/core'
import { StackTags } from '@ndlib/ndlib-cdk'
import 'source-map-support/register'
import { FoundationStack } from '../lib/foundation'
import IIIF = require('../lib/iiif-serverless')
import userContent = require('../lib/user-content')
import imageProcessing = require('../lib/image-processing')

const allContext = JSON.parse(process.env.CDK_CONTEXT_JSON ?? "{}")

const app = new App()

// Globs all kvp from context of the form "namespace:key": "value"
// and flattens it to an object of the form "key": "value"
const getContextByNamespace = (ns: string): any => {
  const result: any = {}
  const prefix = `${ns}:`
  for (const [key, value] of Object.entries(allContext)) {
    if(key.startsWith(prefix)){
      const flattenedKey =  key.substr(prefix.length)
      result[flattenedKey] = value
    }
  }
  return result
}

const getRequiredContext = (key: string) => {
  const value = app.node.tryGetContext(key)
  if(value === undefined || value === null)
    throw new Error(`Context key '${key}' is required.`)
  return value
}

// Get context keys that are required by all stacks
const owner = getRequiredContext('owner')
const contact = getRequiredContext('contact')
const namespace = getRequiredContext('namespace')
const envName = getRequiredContext('env')
const contextEnv = getRequiredContext('environments')[envName]
if(contextEnv === undefined || contextEnv === null)
  throw new Error(`Context key 'environments.${envName}' is required.`)

// The environment objects defined in our context are a mixture of properties.
// Need to decompose these into a cdk env object and other required stack props
const env = { account: contextEnv.account, region: contextEnv.region, name: envName }
const { useVpcId, domainName, createDns, useExistingDnsZone, slackNotifyStackName } = contextEnv

const oauthTokenPath = app.node.tryGetContext('oauthTokenPath')

const foundationStack = new FoundationStack(app, `${namespace}-foundation`, {
  env,
  domainName,
  useExistingDnsZone,
  useVpcId,
})

const imageServiceContext = getRequiredContext('iiifImageService')
new IIIF.DeploymentPipelineStack(app, `${namespace}-image-service-deployment`, {
  env,
  createDns,
  domainStackName: `${namespace}-domain`,
  oauthTokenPath,
  namespace,
  foundationStack,
  ...imageServiceContext,
})

const userContentContext = getContextByNamespace('userContent')
const userContentProps = {
  env,
  foundationStack,
  createDns,
  namespace,
  ...userContentContext,
}
new userContent.UserContentStack(app, `${namespace}-user-content`, userContentProps)
new userContent.DeploymentPipelineStack(app, `${namespace}-user-content-deployment`, {
  contextEnvName: envName,
  oauthTokenPath,
  owner,
  contact,
  slackNotifyStackName,
  ...userContentProps,
})

const imageProcessingContext = getContextByNamespace('imageProcessing')
const imageProcessingProps = {
  env,
  foundationStack,
  ...imageProcessingContext,
}
new imageProcessing.ImagesStack(app, `${namespace}-image-processing`, imageProcessingProps)
new imageProcessing.DeploymentPipelineStack(app, `${namespace}-image-processing-deployment`, {
  contextEnvName: envName,
  oauthTokenPath,
  owner,
  contact,
  namespace,
  ...imageProcessingProps,
})
app.node.applyAspect(new StackTags())