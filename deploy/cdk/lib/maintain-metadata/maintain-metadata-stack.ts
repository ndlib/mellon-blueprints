import { Construct, Duration, Expiration, Stack, StackProps, CfnOutput } from "@aws-cdk/core"
import { AppsyncFunction, AuthorizationType, DynamoDbDataSource, FieldLogLevel, GraphqlApi, MappingTemplate, Resolver, Schema } from '@aws-cdk/aws-appsync'
import { ParameterType, StringParameter } from '@aws-cdk/aws-ssm'
import { FoundationStack } from '../foundation'
import { ManifestPipelineStack } from '../manifest-pipeline'
import path = require('path')


export interface IBaseStackProps extends StackProps {
  /**
   * The name of the foundation stack upon which this stack is dependent
   */
  readonly foundationStack: FoundationStack;

  /**
   * The name of the manifest pipeline stack which defines dynamodb tables used here
   */
  readonly manifestPipelineStack: ManifestPipelineStack;
}

export class MaintainMetadataStack extends Stack {
  /**
   * The Url for the Graphql API
   */
  public readonly maintainMetadataApiUrl: string

  constructor(scope: Construct, id: string, props: IBaseStackProps) {
    super(scope, id, props)

    // Define construct contents here
    const apiSchema = Schema.fromAsset(path.join(__dirname, 'schema.graphql'))

    const api = new GraphqlApi(this, 'Api', {
      name: `${this.stackName}-api`,
      schema: apiSchema,
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: AuthorizationType.API_KEY,
          apiKeyConfig: {
            expires: Expiration.after(Duration.days(365)),
          },
        },
      },
      xrayEnabled: true,
      logConfig: { fieldLogLevel: FieldLogLevel.ERROR },
    })

    this.maintainMetadataApiUrl = api.graphqlUrl

    // Save values to Parameter Store (SSM) for later reference
    new StringParameter(this, 'SSMGraphqlApiUrl', {
      type: ParameterType.STRING,
      parameterName: `/all/stacks/${this.stackName}/graphql-api-url`,
      stringValue: api.graphqlUrl,
      description: 'AppSync GraphQL base url',
    })
    
    // print out the AppSync GraphQL endpoint to the terminal
    new CfnOutput(this, `${this.stackName}:ApiUrl`, {
      value: api.graphqlUrl,
      exportName: `${this.stackName}:ApiUrl`,
    })


    // Add Data Sources
    const websiteMetadataTable = props.manifestPipelineStack.websiteMetadataDynamoTable
    const websiteMetadataDynamoDataSource = new DynamoDbDataSource(this, 'WebsiteDynamoDataSource', {
      api: api,
      table: websiteMetadataTable,
      readOnlyAccess: false,
    })


    // Add Functions
    const getMergedItemRecordFunction = new AppsyncFunction(this, 'GetMergedItemRecordFunction', {
      api: api,
      dataSource: websiteMetadataDynamoDataSource,
      name: 'getMergedItemRecordFunction',
      description: 'Used to read all records for an Item from DynamoDB.',
      requestMappingTemplate: MappingTemplate.fromString(`
        #######################################
        ## This function returns the requested item record enhanced by ALL website overrides and the overrides for the specific website requested (if any)
        ## itemId cannot be null, websiteId may be null
        ## itemId will be pulled from 
        ##    1. stash ($ctx.stash.itemId)
        ##    2. source itemId ($ctx.source.itemId)
        ##    3. source id ($ctx.source.id)
        ##    4. source itemMetadataId ($ctx.source.itemMetadataId)  // This will be obsolete after we update Red Box
        ## websiteId will be pulled:
        ##    1 from stash ($ctx.stash.websiteId)
        ##    2 if not found in stash, from source.suppliedWebsiteId
        #######################################

        #set($id = $util.defaultIfNullOrBlank($ctx.stash.itemId, $ctx.source.itemId))  
        #set($id = $util.defaultIfNullOrBlank($id, $ctx.source.id))
        #set($id = $util.defaultIfNullOrBlank($is, $ctx.source.itemMetadataId))  

        #set($id = $util.defaultIfNullOrBlank($id, ""))
        #set($suppliedWebsiteId = $util.defaultIfNullOrBlank($ctx.stash.websiteId, $ctx.source.suppliedWebsiteId))
        #set($suppliedWebsiteId = $util.defaultIfNullOrBland($suppliedWebsiteId, ""))
        $!{ctx.stash.put("suppliedWebsiteId", $suppliedWebsiteId)}

        #set($id = $util.defaultIfNullOrBlank($id, ""))
        #set($id = $util.str.toUpper($id))
        #set($id = $util.str.toReplace($id, " ", ""))
        #set($pk = "ITEM#$id")

        ## Query all records based on the primary key

        {
            "version" : "2017-02-28",
            "operation" : "Query",
            "query": {
              "expression": "PK = :id",
              "expressionValues": {
                ":id": $util.dynamodb.toDynamoDBJson("$pk")
              }
            },
        }`),
      responseMappingTemplate: MappingTemplate.fromString(`
        ## Raise a GraphQL field error in case of a datasource invocation error
        #if($ctx.error)
            $util.error($ctx.error.message, $ctx.error.type)
        #end
        ## Pass back the result from DynamoDB. **
        ### Add extra processing here to try to generate a single record of output
        #set($results = {})
        #set($suppliedWebsiteId = $util.str.toUpper($util.defaultIfNullOrBlank($ctx.stash.suppliedWebsiteId, "")))
        
        #foreach($item in $context.result.items)
          #set($websiteInRecord = $util.str.toUpper($util.defaultIfNullOrBlank($item.websiteId, "")))
          #if( $item.TYPE == "Item" )
            #set($results = $item)
            ## store suppliedWebsiteId in results for subsequent use
            #set($results["suppliedWebsiteId"] = $suppliedWebsiteId)
          #elseif( $item.TYPE == "ParentOverride" )
            ## $!(results.put("parentId", "$item.parentId"))
            #set($results["parentId"] = $item.parentId)
          #elseif( $item.TYPE == "SupplementalData" && ($suppliedWebsiteId == $websiteInRecord || $websiteInRecord == "ALL"))
            #foreach( $entry in $util.map.copyAndRemoveAllKeys($item, ["PK","SK","TYPE","GSI1PK","GSI1SK","GSI2PK","GSI2SK","dateAddedToDynamo","dateModifiedInDynamo"]).entrySet() )
              ## $!{results.put("$entry.key", "$entry.value")}
              #set($results[$entry.key] = $entry.value)
           #end
          #end
        #end
        $util.toJson($results)
      `),
    })

    new Resolver(this, 'QueryShowItemByWebsite', {
      api: api,
      typeName: 'Query',
      fieldName: 'showItemByWebsite',
      pipelineConfig: [getMergedItemRecordFunction],
      requestMappingTemplate: MappingTemplate.fromString(`
        $!{ctx.stash.put("itemId", $ctx.args.itemId)}
        $!{ctx.stash.put("websiteId", $ctx.args.websiteId)}

        {}`),
      responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
    })

    const updateSupplementalDataRecordFunction = new AppsyncFunction(this, 'UpdateSupplementalDataRecordFunction', {
      api: api,
      dataSource: websiteMetadataDynamoDataSource,
      name: 'updateSupplementalDataRecordFunction',
      description: 'Used to update a SupplementalData record in DynamoDB.',
      requestMappingTemplate: MappingTemplate.fromString(`
        #######################################
        ## This function saves the SupplementalData record with which to enhance the associated item record
        ## websiteId will default to All if not specified
        ## itemId cannot be null, websiteId may be null, other arguments are optional
        ## all will be pulled from $ctx.stash.supplementalDataArgs
        #######################################

        #set($args = $ctx.stash.supplementalDataArgs)
        #set($id = $args.itemId)
        #set($websiteId = $args.websiteId)
        #set($id = $util.defaultIfNullOrBlank($id, ""))
        #set($idNotUpper = $id)
        #set($id = $util.str.toUpper($id))
        #set($id = $util.str.toReplace($id, " ", ""))

        #set($websiteId = $util.defaultIfNullOrBlank($websiteId, "All"))
        #set($websiteIdNotUpper = $websiteId)
        #set($websiteId = $util.str.toUpper($websiteId))
        #set($websiteId = $util.str.toReplace($websiteId, " ", ""))


        #set($pk = "ITEM#$id")
        #set($sk = "SUPPLEMENTALDATA#$websiteId")
        #set($args = $ctx.stash.supplementalDataArgs)
        $!{args.put('TYPE', 'SupplementalData')}
        $!{args.put('dateModifiedInDynamo', $util.time.nowISO8601())}
        $!{args.put('GSI1PK', "SUPPLEMENTALDATA")}
        $!{args.put('GSI1SK', "ITEM#$id")}
        $!{args.put('id', $idNotUpper)}
        $!{args.put('title', $idNotUpper)}

        {
            "version" : "2017-02-28",
            "operation" : "UpdateItem",
            "key" : {
                "PK" : $util.dynamodb.toDynamoDBJson($pk),
                "SK" : $util.dynamodb.toDynamoDBJson($sk),
            },

            ## Set up some space to keep track of things we're updating **
            #set( $expNames  = {} )
            #set( $expValues = {} )
            #set( $expSet = {} )
            #set( $expAdd = {} )
            #set( $expRemove = [] )

            ## Commenting this out since we don't want to do this, but want to retain the concept for the future
            ## Increment "version" by 1 **
            ## $!{expAdd.put("version", ":one")}
            ## $!{expValues.put(":one", $util.dynamodb.toDynamoDB(1))}

            ## Iterate through each argument, skipping "id" and "expectedVersion" **
            #foreach( $entry in $util.map.copyAndRemoveAllKeys($args, ["itemId","expectedVersion"]).entrySet() )
                #if( $util.isNull($entry.value) )
                    ## If the argument is set to "null", then remove that attribute from the item in DynamoDB **

                    #set( $discard = $expRemove.add("#$entry.key") )
                    $!{expNames.put("#$entry.key", "$entry.key")}
                #else
                    ## Otherwise set (or update) the attribute on the item in DynamoDB **

                    $!{expSet.put("#$entry.key", ":$entry.key")}
                    $!{expNames.put("#$entry.key", "$entry.key")}
                    $!{expValues.put(":$entry.key", $util.dynamodb.toDynamoDB($entry.value))}
                #end
            #end

            ## Start building the update expression, starting with attributes we're going to SET **
            #set( $expression = "" )
            #if( !$expSet.isEmpty() )
                #set( $expression = "SET" )
                #foreach( $entry in $expSet.entrySet() )
                    #set( $expression = "$expression $entry.key = $entry.value" )
                    #if ( $foreach.hasNext )
                        #set( $expression = "$expression," )
                    #end
                #end
                ## Added next 2 lines in an attempt to insert dateAddedToDynamo on only the first insert
                #set( $expression = "$expression, dateAddedToDynamo = if_not_exists(dateAddedToDynamo, :dateAddedToDynamo)")
                $!{expValues.put(":dateAddedToDynamo", $util.dynamodb.toDynamoDB($util.time.nowISO8601()))}
            #end

            ## Continue building the update expression, adding attributes we're going to ADD **
            #if( !$expAdd.isEmpty() )
                #set( $expression = "$expression ADD" )
                #foreach( $entry in $expAdd.entrySet() )
                    #set( $expression = "$expression $entry.key $entry.value" )
                    #if ( $foreach.hasNext )
                        #set( $expression = "$expression," )
                    #end
                #end
            #end

            ## Continue building the update expression, adding attributes we're going to REMOVE **
            #if( !$expRemove.isEmpty() )
                #set( $expression = "$expression REMOVE" )

                #foreach( $entry in $expRemove )
                    #set( $expression = "$expression $entry" )
                    #if ( $foreach.hasNext )
                        #set( $expression = "$expression," )
                    #end
                #end
            #end

            ## Finally, write the update expression into the document, along with any expressionNames and expressionValues **
            "update" : {
                "expression" : "$expression",
                #if( !$expNames.isEmpty() )
                    "expressionNames" : $utils.toJson($expNames),
                #end
                #if( !$expValues.isEmpty() )
                    "expressionValues" : $utils.toJson($expValues),
                #end
            },
          #if($args.expectedVersion)
            "condition" : {
                "expression"       : "version = :expectedVersion",
                "expressionValues" : {
                    ":expectedVersion" : $util.dynamodb.toDynamoDBJson($args.expectedVersion)
                }
            }
            #end

        }`),
      responseMappingTemplate: MappingTemplate.fromString(`
        ## Raise a GraphQL field error in case of a datasource invocation error
        #if($ctx.error)
            $util.error($ctx.error.message, $ctx.error.type)
        #end
        ## Pass back the result from DynamoDB. **
        $util.toJson($ctx.result)`),
    })


    // Remove once Red Box is updated to use new save...ForWebsite mutations
    const updateItemFunction = new AppsyncFunction(this, 'UpdateItemFunction', {
      api: api,
      dataSource: websiteMetadataDynamoDataSource,
      name: 'updateItemFunction',
      description: 'Used to update an Item record in DynamoDB.',
      requestMappingTemplate: MappingTemplate.fromString(`
        #set($id = $ctx.stash.itemId)
        #set($id = $util.defaultIfNullOrBlank($id, ""))
        #set($id = $util.str.toUpper($id))
        #set($id = $util.str.toReplace($id, " ", ""))
        #set($pk = "ITEM#$id")
        #set($sk = "ITEM#$id")
        #set($args = $ctx.stash.itemArgs)
        $!{args.put('TYPE', 'Item')}
        $!{args.put('dateModifiedInDynamo', $util.time.nowISO8601())}

        {
            "version" : "2017-02-28",
            "operation" : "UpdateItem",
            "key" : {
                "PK" : $util.dynamodb.toDynamoDBJson($pk),
                "SK" : $util.dynamodb.toDynamoDBJson($sk),
            },

            ## Set up some space to keep track of things we're updating **
            #set( $expNames  = {} )
            #set( $expValues = {} )
            #set( $expSet = {} )
            #set( $expAdd = {} )
            #set( $expRemove = [] )

            ## Increment "version" by 1 **
            ## $!{expAdd.put("version", ":one")}
            ## $!{expValues.put(":one", $util.dynamodb.toDynamoDB(1))}

            ## Iterate through each argument, skipping "id" and "expectedVersion" **
            #foreach( $entry in $util.map.copyAndRemoveAllKeys($args, ["itemId","expectedVersion"]).entrySet() )
                #if( $util.isNull($entry.value) )
                    ## If the argument is set to "null", then remove that attribute from the item in DynamoDB **

                    #set( $discard = $expRemove.add("#$entry.key") )
                    $!{expNames.put("#$entry.key", "$entry.key")}
                #else
                    ## Otherwise set (or update) the attribute on the item in DynamoDB **

                    $!{expSet.put("#$entry.key", ":$entry.key")}
                    $!{expNames.put("#$entry.key", "$entry.key")}
                    $!{expValues.put(":$entry.key", $util.dynamodb.toDynamoDB($entry.value))}
                #end
            #end

            ## Start building the update expression, starting with attributes we're going to SET **
            #set( $expression = "" )
            #if( !$expSet.isEmpty() )
                #set( $expression = "SET" )
                #foreach( $entry in $expSet.entrySet() )
                    #set( $expression = "$expression $entry.key = $entry.value" )
                    #if ( $foreach.hasNext )
                        #set( $expression = "$expression," )
                    #end
                #end
            #end

            ## Continue building the update expression, adding attributes we're going to ADD **
            #if( !$expAdd.isEmpty() )
                #set( $expression = "$expression ADD" )
                #foreach( $entry in $expAdd.entrySet() )
                    #set( $expression = "$expression $entry.key $entry.value" )
                    #if ( $foreach.hasNext )
                        #set( $expression = "$expression," )
                    #end
                #end
            #end

            ## Continue building the update expression, adding attributes we're going to REMOVE **
            #if( !$expRemove.isEmpty() )
                #set( $expression = "$expression REMOVE" )

                #foreach( $entry in $expRemove )
                    #set( $expression = "$expression $entry" )
                    #if ( $foreach.hasNext )
                        #set( $expression = "$expression," )
                    #end
                #end
            #end

            ## Finally, write the update expression into the document, along with any expressionNames and expressionValues **
            "update" : {
                "expression" : "$expression",
                #if( !$expNames.isEmpty() )
                    "expressionNames" : $utils.toJson($expNames),
                #end
                #if( !$expValues.isEmpty() )
                    "expressionValues" : $utils.toJson($expValues),
                #end
            },
          #if($args.expectedVersion)
            "condition" : {
                "expression"       : "version = :expectedVersion",
                "expressionValues" : {
                    ":expectedVersion" : $util.dynamodb.toDynamoDBJson($args.expectedVersion)
                }
            }
            #end

        }`),
      responseMappingTemplate: MappingTemplate.fromString(`
        ## Raise a GraphQL field error in case of a datasource invocation error
        #if($ctx.error)
            $util.error($ctx.error.message, $ctx.error.type)
        #end
        ## Pass back the result from DynamoDB. **
        $util.toJson($ctx.result)`),
    })

    // Remove once Red Box is updated to use new save...ForWebsite mutations
    const updateSupplementalDataFunction = new AppsyncFunction(this, 'UpdateSupplementalDataFunction', {
      api: api,
      dataSource: websiteMetadataDynamoDataSource,
      name: 'updateSupplementalDataFunction',
      description: 'Used to update a SupplementalData record in DynamoDB.',
      requestMappingTemplate: MappingTemplate.fromString(`
        #set($id = $ctx.stash.itemId)
        #set($id = $util.defaultIfNullOrBlank($id, ""))
        #set($id = $util.str.toUpper($id))
        #set($id = $util.str.toReplace($id, " ", ""))
        #set($pk = "ITEM#$id")
        #set($sk = "SUPPLEMENTALDATA#$id")
        #set($args = $ctx.stash.supplementalDataArgs)
        $!{args.put('TYPE', 'SupplementalData')}
        $!{args.put('dateModifiedInDynamo', $util.time.nowISO8601())}

        {
            "version" : "2017-02-28",
            "operation" : "UpdateItem",
            "key" : {
                "PK" : $util.dynamodb.toDynamoDBJson($pk),
                "SK" : $util.dynamodb.toDynamoDBJson($sk),
            },

            ## Set up some space to keep track of things we're updating **
            #set( $expNames  = {} )
            #set( $expValues = {} )
            #set( $expSet = {} )
            #set( $expAdd = {} )
            #set( $expRemove = [] )

            ## Increment "version" by 1 **
            ## $!{expAdd.put("version", ":one")}
            ## $!{expValues.put(":one", $util.dynamodb.toDynamoDB(1))}

            ## Iterate through each argument, skipping "id" and "expectedVersion" **
            #foreach( $entry in $util.map.copyAndRemoveAllKeys($args, ["itemId","expectedVersion"]).entrySet() )
                #if( $util.isNull($entry.value) )
                    ## If the argument is set to "null", then remove that attribute from the item in DynamoDB **

                    #set( $discard = $expRemove.add("#$entry.key") )
                    $!{expNames.put("#$entry.key", "$entry.key")}
                #else
                    ## Otherwise set (or update) the attribute on the item in DynamoDB **

                    $!{expSet.put("#$entry.key", ":$entry.key")}
                    $!{expNames.put("#$entry.key", "$entry.key")}
                    $!{expValues.put(":$entry.key", $util.dynamodb.toDynamoDB($entry.value))}
                #end
            #end

            ## Start building the update expression, starting with attributes we're going to SET **
            #set( $expression = "" )
            #if( !$expSet.isEmpty() )
                #set( $expression = "SET" )
                #foreach( $entry in $expSet.entrySet() )
                    #set( $expression = "$expression $entry.key = $entry.value" )
                    #if ( $foreach.hasNext )
                        #set( $expression = "$expression," )
                    #end
                #end
            #end

            ## Continue building the update expression, adding attributes we're going to ADD **
            #if( !$expAdd.isEmpty() )
                #set( $expression = "$expression ADD" )
                #foreach( $entry in $expAdd.entrySet() )
                    #set( $expression = "$expression $entry.key $entry.value" )
                    #if ( $foreach.hasNext )
                        #set( $expression = "$expression," )
                    #end
                #end
            #end

            ## Continue building the update expression, adding attributes we're going to REMOVE **
            #if( !$expRemove.isEmpty() )
                #set( $expression = "$expression REMOVE" )

                #foreach( $entry in $expRemove )
                    #set( $expression = "$expression $entry" )
                    #if ( $foreach.hasNext )
                        #set( $expression = "$expression," )
                    #end
                #end
            #end

            ## Finally, write the update expression into the document, along with any expressionNames and expressionValues **
            "update" : {
                "expression" : "$expression",
                #if( !$expNames.isEmpty() )
                    "expressionNames" : $utils.toJson($expNames),
                #end
                #if( !$expValues.isEmpty() )
                    "expressionValues" : $utils.toJson($expValues),
                #end
            },
          #if($args.expectedVersion)
            "condition" : {
                "expression"       : "version = :expectedVersion",
                "expressionValues" : {
                    ":expectedVersion" : $util.dynamodb.toDynamoDBJson($args.expectedVersion)
                }
            }
            #end

        }`),
      responseMappingTemplate: MappingTemplate.fromString(`
        ## Raise a GraphQL field error in case of a datasource invocation error
        #if($ctx.error)
            $util.error($ctx.error.message, $ctx.error.type)
        #end
        ## Pass back the result from DynamoDB. **
        $util.toJson($ctx.result)`),
    })


    // Add Resolvers
    new Resolver(this, 'FileFileGroupResolver', {
      api: api,
      typeName: 'File',
      fieldName: 'FileGroup',
      dataSource: websiteMetadataDynamoDataSource,
      requestMappingTemplate: MappingTemplate.fromString(`
        #set($id = $ctx.source.objectFileGroupId)
        #set($id = $util.defaultIfNullOrBlank($id, ""))
        #set($id = $util.str.toUpper($id))
        #set($id = $util.str.toReplace($id, " ", ""))
        #set($fullId = "FILEGROUP#$id")
        {
          "version": "2017-02-28",
          "operation": "GetItem",
          "key": {
            "PK": $util.dynamodb.toDynamoDBJson("FILEGROUP"),
            "SK": $util.dynamodb.toDynamoDBJson($fullId),
          }
        }`),
        responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
      })

    new Resolver(this, 'FileGroupFilesResolver', {
      api: api,
      typeName: 'FileGroup',
      fieldName: 'files',
      dataSource: websiteMetadataDynamoDataSource,
      requestMappingTemplate: MappingTemplate.fromString(`
        #set($id = $ctx.source.objectFileGroupId)
        #set($id = $util.defaultIfNullOrBlank($id, ""))
        #set($id = $util.str.toUpper($id))
        #set($id = $util.str.toReplace($id, " ", ""))
        #set($fullId = "FILEGROUP#$id")
        {
            "version" : "2017-02-28",
            "operation" : "Query",
            "index" : "GSI1",
            "query" : {
                "expression": "GSI1PK = :id and begins_with(GSI1SK, :beginsWith)",
                "expressionValues" : {
                  ":id" : $util.dynamodb.toDynamoDBJson($fullId),
                  ":beginsWith": $util.dynamodb.toDynamoDBJson("SORT#"),
                }
            },
            ## Add 'limit' and 'nextToken' arguments to this field in your schema to implement pagination. **
            "limit": $util.defaultIfNull($ctx.args.limit, 20),
            "nextToken": $util.toJson($util.defaultIfNullOrBlank($ctx.args.nextToken, null))
        }`),
      responseMappingTemplate: MappingTemplate.fromString(`
      {
          "items": $util.toJson($ctx.result.items),
          "nextToken": $util.toJson($util.defaultIfNullOrBlank($context.result.nextToken, null))
      }`),
    })

    new Resolver(this, 'ItemMetadataParentResolver', {
      api: api,
      typeName: 'ItemMetadata',
      fieldName: 'parent',
      pipelineConfig: [getMergedItemRecordFunction],
      requestMappingTemplate: MappingTemplate.fromString(`
        $!{ctx.stash.put("itemId", $ctx.source.parentId)}
        $!{ctx.stash.put("websiteId", $ctx.source.suppliedWebsiteId)}

        {}`),
      responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
    })


    // TODO:  This should probably be modified to bring back getMergedItemRecordFunction records
    // That would likely require 1. stashing content in the requestMappingTemplate
    //   2. executing the query here as a function, and for each record, calling the getMergedItemRecordFunction
    //   3. returning the enhanced result list along with the nextToken from the original query result
    new Resolver(this, 'ItemMetadataChildrenResolver', {
      api: api,
      typeName: 'ItemMetadata',
      fieldName: 'children',
      dataSource: websiteMetadataDynamoDataSource,
      requestMappingTemplate: MappingTemplate.fromString(`
        #set($id = $ctx.source.id)
        #set($id = $util.defaultIfNullOrBlank($id, ""))
        #set($id = $util.str.toUpper($id))
        #set($id = $util.str.toReplace($id, " ", ""))
        #set($fullId = "ITEM#$id")

        ## add stash values to enable us to eventually call GetMergedItemRecordFunction
        $!{ctx.stash.put("itemId", $ctx.source.id)}
        #if( !$util.isNull($ctx.source.suppliedWebsiteId) )
          $!{ctx.stash.put("websiteId", $ctx.source.suppliedWebsiteId)}
        #end
        {
            "version" : "2017-02-28",
            "operation" : "Query",
            "index" : "GSI1",
            "query" : {
                ## Provide a query expression. **
                "expression": "GSI1PK = :id",
                "expressionValues" : {
                  ":id" : $util.dynamodb.toDynamoDBJson($fullId),
                }
            },

            ######### ultimately, I think I need to add suppliedWebsiteId to each record returned to propogate that down the hierarchy so the next call to getItem will have the websiteId included.

            ## Add 'limit' and 'nextToken' arguments to this field in your schema to implement pagination. **
            "limit": $util.defaultIfNull($ctx.args.limit, 20),
            "nextToken": $util.toJson($util.defaultIfNullOrBlank($ctx.args.nextToken, null))
        }`),
      responseMappingTemplate: MappingTemplate.fromString(`
        #set($results = $ctx.result)
        #set($currentRecord = 0)
        #foreach($item in $results.items)
          #set($item["suppliedWebsiteId"] = $ctx.stash.websiteId)
          #set($results.items[$currentRecord] = $item)
          #set($currentRecord = $currentRecord + 1)
        #end
        {
            "items": $util.toJson($results.items),
            "nextToken": $util.toJson($util.defaultIfNullOrBlank($context.result.nextToken, null))
        }`),
      // responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
    })

    new Resolver(this, 'ItemMetadataFilesResolver', {
      api: api,
      typeName: 'ItemMetadata',
      fieldName: 'files',
      dataSource: websiteMetadataDynamoDataSource,
      requestMappingTemplate: MappingTemplate.fromString(`
        #set($id = $ctx.source.objectFileGroupId)
        #set($id = $util.defaultIfNullOrBlank($id, ""))
        #set($id = $util.str.toUpper($id))
        #set($id = $util.str.toReplace($id, " ", ""))
        #set($fullId = "FILEGROUP#$id")
        {
            "version" : "2017-02-28",
            "operation" : "Query",
            "index" : "GSI1",
            "query" : {
                ## Provide a query expression. **
                "expression": "GSI1PK = :id and begins_with(GSI1SK, :beginsWith)",
                "expressionValues" : {
                  ":id" : $util.dynamodb.toDynamoDBJson($fullId),
                  ":beginsWith": $util.dynamodb.toDynamoDBJson("SORT#"),
                }
            },
            ## Add 'limit' and 'nextToken' arguments to this field in your schema to implement pagination. **
            "limit": $util.defaultIfNull($ctx.args.limit, 20),
            "nextToken": $util.toJson($util.defaultIfNullOrBlank($ctx.args.nextToken, null))
        }`),
      responseMappingTemplate: MappingTemplate.fromString(`
        {
            "items": $util.toJson($ctx.result.items),
            "nextToken": $util.toJson($util.defaultIfNullOrBlank($context.result.nextToken, null))
        }`),
    })

    // Remove corresponding AddItemMetadataToWebsiteInput and type WebsiteItems
    // Remove this after Red Box is modified to use MutationAddItemToWebsite
    new Resolver(this, 'MutationAddItemMetadataToWebsiteResolver', {
      api: api,
      typeName: 'Mutation',
      fieldName: 'addItemMetadataToWebsite',
      dataSource: websiteMetadataDynamoDataSource,
      requestMappingTemplate: MappingTemplate.fromString(`
        #set($websiteId = $ctx.args.input.websiteId)
        #set($websiteId = $util.defaultIfNullOrBlank($websiteId, ""))
        #set($websiteId = $util.str.toUpper($websiteId))
        #set($websiteId = $util.str.toReplace($websiteId, " ", ""))
        #set($itemMetadataId = $ctx.args.input.itemMetadataId)
        #set($itemMetadataId = $util.defaultIfNullOrBlank($itemMetadataId, ""))
        #set($itemMetadataId = $util.str.toUpper($itemMetadataId))
        #set($itemMetadataId = $util.str.toReplace($itemMetadataId, " ", ""))
        #set($pk = "WEBSITE#$websiteId")
        #set($sk = "ITEM#$itemMetadataId")
        #set($GSI1PK = $pk)
        #set($GSI1SK = "ADDED#$util.time.nowISO8601()")

        ## add stash values to enable us to eventually call GetMergedItemRecordFunction
        $!{ctx.stash.put("itemId", $ctx.args.input.itemMetadataId)}
        $!{ctx.stash.put("websiteId", $ctx.args.input.websiteId)}

        {
          "version": "2017-02-28",
          "operation": "UpdateItem",
          "key": {
            "PK": $util.dynamodb.toDynamoDBJson($pk),
            "SK": $util.dynamodb.toDynamoDBJson($sk),
          },
          "update": {
            "expression": "SET itemMetadataId = :itemMetadataId, websiteId = :websiteId, #TYPE = :rowType, dateModifiedInDynamo = :dateModifiedInDynamo, GSI1PK = :GSI1PK, GSI1SK = :GSI1SK, id = :id, title = :title",
            "expressionNames": {"#TYPE": "TYPE"},
            "expressionValues": {
              ":itemMetadataId": $util.dynamodb.toDynamoDBJson($ctx.args.input.itemMetadataId),
              ":websiteId": $util.dynamodb.toDynamoDBJson($ctx.args.input.websiteId),
              ":rowType": $util.dynamodb.toDynamoDBJson("WebSiteItem"),
              ":dateModifiedInDynamo": $util.dynamodb.toDynamoDBJson($util.time.nowISO8601()),
              ":GSI1PK": $util.dynamodb.toDynamoDBJson($GSI1PK),
              ":GSI1SK": $util.dynamodb.toDynamoDBJson($GSI1SK),
              ":id": $util.dynamodb.toDynamoDBJson($ctx.args.input.itemMetadataId),
              ":title": $util.dynamodb.toDynamoDBJson($ctx.args.input.itemMetadataId),
            }
          }
        }`),
      responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
    })

    // Remove once Red Box is updated to use saveCopyrightForWebsite  also remove corresponding ReplaceCopyrightStatementInput from schema
    new Resolver(this, 'MutationReplaceCopyrightStatement', {
      api: api,
      typeName: 'Mutation',
      fieldName: 'replaceCopyrightStatement',
      pipelineConfig: [updateSupplementalDataFunction, updateItemFunction],
      requestMappingTemplate: MappingTemplate.fromString(`
        #set($supplementalDataArgs = {})
        #set($itemArgs = {})

        ## set generalCopyrightStatus based on generalInCopyright boolean
        #set($generalCopyrightStatus = 'Copyright')
        #if(!$ctx.args.input.generalInCopyright)
          #set($generalCopyrightStatus = 'not in copyright')
        #end

        $!{supplementalDataArgs.put('generalInCopyright', $ctx.args.input.generalInCopyright)}
        $!{supplementalDataArgs.put('generalCopyrightStatement', $ctx.args.input.generalCopyrightStatement)}
        $!{supplementalDataArgs.put('generalCopyrightStatus', $generalCopyrightStatus)}
        $!{itemArgs.put('copyrightStatement', $ctx.args.input.generalCopyrightStatement)}
        $!{itemArgs.put('copyrightStatus', $generalCopyrightStatus)}

        $!{ctx.stash.put("itemId", $ctx.args.input.id)}
        $!{ctx.stash.put("supplementalDataArgs", $supplementalDataArgs)}
        $!{ctx.stash.put("itemArgs", $itemArgs)}

        {}`),
      responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
    })

    // Remove once Red Box is updated to use saveDefaultImageForWebsite also remove corresponding ReplaceDefaultImageInput from schema
    new Resolver(this, 'MutationReplaceDefaultImageResolver', {
      api: api,
      typeName: 'Mutation',
      fieldName: 'replaceDefaultImage',
      pipelineConfig: [updateSupplementalDataFunction, updateItemFunction],
      requestMappingTemplate: MappingTemplate.fromString(`
        #set($supplementalDataArgs = {})
        #set($itemArgs = {})

        $!{supplementalDataArgs.put('generalDefaultFilePath', $ctx.args.input.generalDefaultFilePath)}
        $!{supplementalDataArgs.put('generalObjectFileGroupId', $ctx.args.input.generalObjectFileGroupId)}
        $!{itemArgs.put('defaultFilePath', $ctx.args.input.generalDefaultFilePath)}
        $!{itemArgs.put('objectFileGroupId', $ctx.args.input.generalObjectFileGroupId)}

        $!{ctx.stash.put("itemId", $ctx.args.input.id)}
        $!{ctx.stash.put("supplementalDataArgs", $supplementalDataArgs)}
        $!{ctx.stash.put("itemArgs", $itemArgs)}

        {}`),
      responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
    })

    // Remove once Red Box is updated to use savePartiallyDigitizedForWebsite also remove corresponding ReplacePartiallyDigitizedInput from schema
    new Resolver(this, 'MutationReplacePartiallyDigitizedResolver', {
      api: api,
      typeName: 'Mutation',
      fieldName: 'replacePartiallyDigitized',
      pipelineConfig: [updateSupplementalDataFunction, updateItemFunction],
      requestMappingTemplate: MappingTemplate.fromString(`
        #set($supplementalDataArgs = {})
        #set($itemArgs = {})

        $!{supplementalDataArgs.put('generalPartiallyDigitized', $ctx.args.input.generalPartiallyDigitized)}
        $!{itemArgs.put('partiallyDigitized', $ctx.args.input.generalPartiallyDigitized)}

        $!{ctx.stash.put("itemId", $ctx.args.input.id)}
        $!{ctx.stash.put("supplementalDataArgs", $supplementalDataArgs)}
        $!{ctx.stash.put("itemArgs", $itemArgs)}

        {}`),
      responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
    })


    new Resolver(this, 'MutationAddItemToWebsiteResolver', {
      api: api,
      typeName: 'Mutation',
      fieldName: 'addItemToWebsite',
      dataSource: websiteMetadataDynamoDataSource,
      requestMappingTemplate: MappingTemplate.fromString(`
        #set($websiteId = $ctx.args.websiteId)
        #set($websiteId = $util.defaultIfNullOrBlank($websiteId, ""))
        #set($websiteId = $util.str.toUpper($websiteId))
        #set($websiteId = $util.str.toReplace($websiteId, " ", ""))
        #set($itemId = $ctx.args.itemId)
        #set($itemId = $util.defaultIfNullOrBlank($itemId, ""))
        #set($itemId = $util.str.toUpper($itemId))
        #set($itemId = $util.str.toReplace($itemId, " ", ""))
        #set($pk = "WEBSITE#$websiteId")
        #set($sk = "ITEM#$itemId")
        #set($GSI1PK = $pk)
        #set($GSI1SK = "ADDED#$util.time.nowISO8601()")

        ## add stash values to enable us to eventually call GetMergedItemRecordFunction
        $!{ctx.stash.put("itemId", $ctx.args.itemId)}
        $!{ctx.stash.put("websiteId", $ctx.args.websiteId)}

        {
          "version": "2017-02-28",
          "operation": "UpdateItem",
          "key": {
            "PK": $util.dynamodb.toDynamoDBJson($pk),
            "SK": $util.dynamodb.toDynamoDBJson($sk),
          },
          "update": {
            "expression": "SET itemId = :itemId, websiteId = :websiteId, #TYPE = :rowType, dateModifiedInDynamo = :dateModifiedInDynamo, GSI1PK = :GSI1PK, GSI1SK = :GSI1SK, id = :id, title = :title",
            "expressionNames": {"#TYPE": "TYPE"},
            "expressionValues": {
              ":itemId": $util.dynamodb.toDynamoDBJson($ctx.args.itemId),
              ":websiteId": $util.dynamodb.toDynamoDBJson($ctx.args.websiteId),
              ":rowType": $util.dynamodb.toDynamoDBJson("WebSiteItem"),
              ":dateModifiedInDynamo": $util.dynamodb.toDynamoDBJson($util.time.nowISO8601()),
              ":GSI1PK": $util.dynamodb.toDynamoDBJson($GSI1PK),
              ":GSI1SK": $util.dynamodb.toDynamoDBJson($GSI1SK),
              ":id": $util.dynamodb.toDynamoDBJson($ctx.args.itemId),
              ":title": $util.dynamodb.toDynamoDBJson($ctx.args.itemId),
            }
          }
        }`),
      responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
    })

    new Resolver(this, 'MutationRemoveItemFromWebsiteResolver', {
      api: api,
      typeName: 'Mutation',
      fieldName: 'removeItemFromWebsite',
      dataSource: websiteMetadataDynamoDataSource,
      requestMappingTemplate: MappingTemplate.fromString(`
        #set($websiteId = $ctx.args.websiteId)
        #set($websiteId = $util.defaultIfNullOrBlank($websiteId, ""))
        #set($websiteId = $util.str.toUpper($websiteId))
        #set($websiteId = $util.str.toReplace($websiteId, " ", ""))
        #set($itemId = $ctx.args.itemId)
        #set($itemId = $util.defaultIfNullOrBlank($itemId, ""))
        #set($itemId = $util.str.toUpper($itemId))
        #set($itemId = $util.str.toReplace($itemId, " ", ""))
        #set($pk = "WEBSITE#$websiteId")
        #set($sk = "ITEM#$itemId")

        {
          "version": "2017-02-28",
          "operation": "DeleteItem",
          "key": {
            "PK": $util.dynamodb.toDynamoDBJson($pk),
            "SK": $util.dynamodb.toDynamoDBJson($sk),
          }
        }`),
      responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
    })

    new Resolver(this, 'MutationSaveCopyrightForWebsiteResolver', {
      api: api,
      typeName: 'Mutation',
      fieldName: 'saveCopyrightForWebsite',
      pipelineConfig: [updateSupplementalDataRecordFunction],
      requestMappingTemplate: MappingTemplate.fromString(`
        $!{ctx.stash.put("itemId", $ctx.args.itemId)}
        $!{ctx.stash.put("websiteId", $ctx.args.websiteId)}
        #set($supplementalDataArgs = {})
        $!{supplementalDataArgs.put('itemId', $ctx.args.itemId)}
        $!{supplementalDataArgs.put('websiteId', $ctx.args.websiteId)}

        ## note:  $null is an undefined variable, which has the effect of assigning null to our variable
        #set($copyrightStatemnt = $util.defaultIfNullOrBlank($ctx.args.copyrightStatement, $null))
        $!{supplementalDataArgs.put('copyrightStatement', $copyrightStatemnt)}
        ## set copyrightStatus based on inCopyright boolean
        #set($copyrightStatus = 'Copyright')
        #if(!$ctx.args.inCopyright)
          #set($copyrightStatus = 'not in copyright')
        #end

        $!{supplementalDataArgs.put('copyrightStatus', $copyrightStatus)}
        $!{supplementalDataArgs.put('inCopyright', $ctx.args.inCopyright)}
        $!{ctx.stash.put("supplementalDataArgs", $supplementalDataArgs)}

        {}
      `),
      responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
    })

    new Resolver(this, 'MutationSaveDefaultImageForWebsiteResolver', {
      api: api,
      typeName: 'Mutation',
      fieldName: 'saveDefaultImageForWebsite',
      pipelineConfig: [updateSupplementalDataRecordFunction],
      requestMappingTemplate: MappingTemplate.fromString(`
        $!{ctx.stash.put("itemId", $ctx.args.itemId)}
        $!{ctx.stash.put("websiteId", $ctx.args.websiteId)}
        #set($supplementalDataArgs = {})
        $!{supplementalDataArgs.put('itemId', $ctx.args.itemId)}
        $!{supplementalDataArgs.put('websiteId', $ctx.args.websiteId)}

        ## note:  $null is an undefined variable, which has the effect of assigning null to our variable
        #set($defaultFilePath = $util.defaultIfNullOrBlank($ctx.args.defaultFilePath, $null))
        #set($objectFileGroupId = $util.defaultIfNullOrBlank($ctx.args.objectFileGroupId, $null))
        $!{supplementalDataArgs.put('defaultFilePath', $defaultFilePath)}
        $!{supplementalDataArgs.put('objectFileGroupId', $objectFileGroupId)}

        $!{ctx.stash.put("supplementalDataArgs", $supplementalDataArgs)}

        {}
      `),
      responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
    })

    new Resolver(this, 'MutationSavePartiallyDigitizedForWebsiteResolver', {
      api: api,
      typeName: 'Mutation',
      fieldName: 'savePartiallyDigitizedForWebsite',
      pipelineConfig: [updateSupplementalDataRecordFunction],
      requestMappingTemplate: MappingTemplate.fromString(`
        $!{ctx.stash.put("itemId", $ctx.args.itemId)}
        $!{ctx.stash.put("websiteId", $ctx.args.websiteId)}
        #set($supplementalDataArgs = {})
        $!{supplementalDataArgs.put('itemId', $ctx.args.itemId)}
        $!{supplementalDataArgs.put('websiteId', $ctx.args.websiteId)}

        $!{supplementalDataArgs.put('partiallyDigitized', $ctx.args.partiallyDigitized)}

        $!{ctx.stash.put("supplementalDataArgs", $supplementalDataArgs)}

        {}
      `),
      responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
    })

    new Resolver(this, 'QueryGetFileGroupResolver', {
      api: api,
      typeName: 'Query',
      fieldName: 'getFileGroup',
      dataSource: websiteMetadataDynamoDataSource,
      requestMappingTemplate: MappingTemplate.fromString(`
        #set($id = $ctx.args.id)
        #set($id = $util.defaultIfNullOrBlank($id, ""))
        #set($id = $util.str.toUpper($id))
        #set($id = $util.str.toReplace($id, " ", ""))
        #set($fullId = "FILEGROUP#$id")

        {
            "version": "2017-02-28",
            "operation": "GetItem",
            "key": {
              "PK": $util.dynamodb.toDynamoDBJson("FILEGROUP"),
                "SK": $util.dynamodb.toDynamoDBJson($fullId),
            }
        }`),
      responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
    })

    new Resolver(this, 'QueryGetItemResolver', {
      api: api,
      typeName: 'Query',
      fieldName: 'getItem',
      pipelineConfig: [getMergedItemRecordFunction],
      requestMappingTemplate: MappingTemplate.fromString(`
        ## add stash values to enable us to call GetMergedItemRecordFunction
        $!{ctx.stash.put("itemId", $ctx.args.id)}
        $!{ctx.stash.put("websiteId", $util.defaultIfNullOrBlank($ctx.args.websiteId, ""))}

        {}`),
      responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
    })

    new Resolver(this, 'QueryGetWebsiteResolver', {
      api: api,
      typeName: 'Query',
      fieldName: 'getWebsite',
      dataSource: websiteMetadataDynamoDataSource,
      requestMappingTemplate: MappingTemplate.fromString(`
        #set($id = $ctx.args.id)
        #set($id = $util.defaultIfNullOrBlank($id, ""))
        #set($id = $util.str.toUpper($id))
        #set($id = $util.str.toReplace($id, " ", ""))
        #set($fullId = "WEBSITE#$id")

        {
            "version": "2017-02-28",
            "operation": "GetItem",
            "key": {
              "PK": $util.dynamodb.toDynamoDBJson("WEBSITE"),
              "SK": $util.dynamodb.toDynamoDBJson($fullId),
            }
        }`),
      responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
    })

    new Resolver(this, 'QueryListFileGroupsResolver', {
      api: api,
      typeName: 'Query',
      fieldName: 'listFileGroups',
      dataSource: websiteMetadataDynamoDataSource,
      requestMappingTemplate: MappingTemplate.fromString(`
        {
            "version" : "2017-02-28",
            "operation" : "Query",
            "query" : {
                ## Provide a query expression. **
                "expression": "PK = :id",
                "expressionValues" : {
                    ":id" : $util.dynamodb.toDynamoDBJson("FILEGROUP")
                }
            },
          "limit": #if($context.arguments.limit) $context.arguments.limit #else 10 #end,
            "nextToken": #if($context.arguments.nextToken) "$context.arguments.nextToken" #else null #end        
        }`),
      responseMappingTemplate: MappingTemplate.fromString(`
        {
            "items": $util.toJson($ctx.result.items),
            "nextToken": $util.toJson($util.defaultIfNullOrBlank($context.result.nextToken, null))
        }`),
    })

    new Resolver(this, 'QueryListFileGroupsByStorageSystemResolver', {
      api: api,
      typeName: 'Query',
      fieldName: 'listFileGroupsByStorageSystem',
      dataSource: websiteMetadataDynamoDataSource,
      requestMappingTemplate: MappingTemplate.fromString(`
        #set($storageSystem = $ctx.args.storageSystem)
        #set($storageSystem = $util.defaultIfNullOrBlank($storageSystem, ""))
        #set($storageSystem = $util.str.toUpper($storageSystem))
        #set($storageSystem = $util.str.toReplace($storageSystem, " ", ""))
        #set($typeOfData = $ctx.args.typeOfData)
        #set($typeOfData = $util.defaultIfNullOrBlank($typeOfData, ""))
        #set($typeOfData = $util.str.toUpper($typeOfData))
        #set($typeOfData = $util.str.toReplace($typeOfData, " ", ""))
        #set($fullId = "FILESYSTEM#$storageSystem#$typeOfData")
        #set($fullId = $util.str.toReplace($fullId, " ", ""))
        {
          "version" : "2017-02-28",
          "operation" : "Query",
          "index": "GSI2",
          "query" : {
              "expression": "GSI2PK = :id",
              "expressionValues" : {
                  ":id": $util.dynamodb.toDynamoDBJson($fullId)
              }
          },
          "limit": #if($context.arguments.limit) $context.arguments.limit #else 10 #end,
          "nextToken": #if($context.arguments.nextToken) "$context.arguments.nextToken" #else null #end        
        }`),
      responseMappingTemplate: MappingTemplate.fromString(`
        {
          "items": $util.toJson($context.result.items),
          "nextToken": $util.toJson($context.result.nextToken)
        }`),
    })

    new Resolver(this, 'QueryListFileGroupsForS3Resolver', {
      api: api,
      typeName: 'Query',
      fieldName: 'listFileGroupsForS3',
      dataSource: websiteMetadataDynamoDataSource,
      requestMappingTemplate: MappingTemplate.fromString(`
        #set($fullId = "FILESYSTEM#S3#RBSCWEBSITEBUCKET")
        {
          "version" : "2017-02-28",
          "operation" : "Query",
          "index": "GSI2",
          "query" : {
              "expression": "GSI2PK = :id",
              "expressionValues" : {
                  ":id": $util.dynamodb.toDynamoDBJson($fullId)
              }
          },
          "limit": #if($context.arguments.limit) $context.arguments.limit #else 10 #end,
          "nextToken": #if($context.arguments.nextToken) "$context.arguments.nextToken" #else null #end        
        }`),
      responseMappingTemplate: MappingTemplate.fromString(`
        {
          "items": $util.toJson($context.result.items),
          "nextToken": $util.toJson($context.result.nextToken)
        }`),
    })

    new Resolver(this, 'QueryListItemsBySourceSystemResolver', {
      api: api,
      typeName: 'Query',
      fieldName: 'listItemsBySourceSystem',
      dataSource: websiteMetadataDynamoDataSource,
      requestMappingTemplate: MappingTemplate.fromString(`
        #set($id = $ctx.args.id)
        #set($id = $util.defaultIfNullOrBlank($id, ""))
        #set($id = $util.str.toUpper($id))
        #set($id = $util.str.toReplace($id, " ", ""))
        #set($fullId = "SOURCESYSTEM#$id")
        {
          "version" : "2017-02-28",
          "operation" : "Query",
          "index": "GSI2",
          "query" : {
              "expression": "GSI2PK = :id and begins_with(GSI2SK, :beginsWith)",
              "expressionValues" : {
                  ":id": $util.dynamodb.toDynamoDBJson($fullId),
                  ":beginsWith": $util.dynamodb.toDynamoDBJson("SORT#"),
                }
          },
          "limit": #if($context.arguments.limit) $context.arguments.limit #else 10 #end,
          "nextToken": #if($context.arguments.nextToken) "$context.arguments.nextToken" #else null #end        
        }`),
      responseMappingTemplate: MappingTemplate.fromString(`
        {
          "items": $util.toJson($context.result.items),
          "nextToken": $util.toJson($context.result.nextToken)
        }`),
    })

    new Resolver(this, 'QueryListItemsByWebsiteResolver', {
      api: api,
      typeName: 'Query',
      fieldName: 'listItemsByWebsite',
      dataSource: websiteMetadataDynamoDataSource,
      requestMappingTemplate: MappingTemplate.fromString(`
        #set($id = $ctx.args.id)
        #set($id = $util.defaultIfNullOrBlank($id, ""))
        #set($id = $util.str.toUpper($id))
        #set($id = $util.str.toReplace($id, " ", ""))
        #set($fullId = "WEBSITE#$id")
        {
          "version" : "2017-02-28",
          "operation" : "Query",
          "query" : {
              "expression": "PK = :id",
              "expressionValues" : {
                  ":id": $util.dynamodb.toDynamoDBJson($fullId)
              }
          },
          "limit": #if($context.arguments.limit) $context.arguments.limit #else 10 #end,
          "nextToken": #if($context.arguments.nextToken) "$context.arguments.nextToken" #else null #end        
        }`),
      responseMappingTemplate: MappingTemplate.fromString(`
        {
          "items": $util.toJson($context.result.items),
          "nextToken": $util.toJson($context.result.nextToken)
        }`),
    })

    new Resolver(this, 'QueryListWebsitesResolver', {
      api: api,
      typeName: 'Query',
      fieldName: 'listWebsites',
      dataSource: websiteMetadataDynamoDataSource,
      requestMappingTemplate: MappingTemplate.fromString(`
        {
          "version" : "2017-02-28",
          "operation" : "Query",
          "query" : {
              ## Provide a query expression. **
              "expression": "PK = :id",
              "expressionValues" : {
                  ":id" : $util.dynamodb.toDynamoDBJson("WEBSITE")
              }
          },
          "limit": #if($context.arguments.limit) $context.arguments.limit #else 10 #end,
          "nextToken": #if($context.arguments.nextToken) "$context.arguments.nextToken" #else null #end        
        }`),
      responseMappingTemplate: MappingTemplate.fromString(`
        {
          "items": $util.toJson($context.result.items),
          "nextToken": $util.toJson($context.result.nextToken)
        }`),
    })

    new Resolver(this, 'WebsiteWebsiteItemsResolver', {
      api: api,
      typeName: 'Website',
      fieldName: 'websiteItems',
      dataSource: websiteMetadataDynamoDataSource,
      requestMappingTemplate: MappingTemplate.fromString(`
        #set($id = $ctx.source.id)
        #set($id = $util.defaultIfNullOrBlank($id, ""))
        #set($id = $util.str.toUpper($id))
        #set($id = $util.str.toReplace($id, " ", ""))
        #set($fullId = "WEBSITE#$id")

        {
            "version" : "2017-02-28",
            "operation" : "Query",
            "query" : {
                ## Provide a query expression. **
                "expression": "PK = :id",
                "expressionValues" : {
                    ":id" : $util.dynamodb.toDynamoDBJson($fullId)
                }
            },
            ## Add 'limit' and 'nextToken' arguments to this field in your schema to implement pagination. **
            "limit": $util.defaultIfNull($ctx.args.limit, 20),
            "nextToken": $util.toJson($util.defaultIfNullOrBlank($ctx.args.nextToken, null))
        }`),
      responseMappingTemplate: MappingTemplate.fromString(`
        {
            "items": $util.toJson($ctx.result.items),
            "nextToken": $util.toJson($context.result.nextToken)
        }`),
    })

    new Resolver(this, 'WebsiteItemItemMetadataResolver', {
      api: api,
      typeName: 'WebsiteItem',
      fieldName: 'ItemMetadata',
      pipelineConfig: [getMergedItemRecordFunction],
      requestMappingTemplate: MappingTemplate.fromString(`
        $!{ctx.stash.put("itemId", $ctx.source.itemId)}
        $!{ctx.stash.put("websiteId", $ctx.source.websiteId)}

        {}`),
      responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
    })

    // Remove after Red Box has been updated
    new Resolver(this, 'WebsiteItemsItemMetadataResolver', {
      api: api,
      typeName: 'WebsiteItems',
      fieldName: 'ItemMetadata',
      pipelineConfig: [getMergedItemRecordFunction],
      requestMappingTemplate: MappingTemplate.fromString(`
        $!{ctx.stash.put("itemId", $ctx.source.itemMetadataId)}
        $!{ctx.stash.put("websiteId", $ctx.source.websiteId)}

        {}`),
      responseMappingTemplate: MappingTemplate.dynamoDbResultItem(),
    })

  }
}
