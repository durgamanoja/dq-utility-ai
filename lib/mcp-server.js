const lambda = require('aws-cdk-lib/aws-lambda');
const apigw = require('aws-cdk-lib/aws-apigateway');
const iam = require('aws-cdk-lib/aws-iam');
const { Stack, Duration, CfnOutput } = require('aws-cdk-lib');
const { Construct } = require('constructs');

class McpServerConstruct extends Construct {
    constructor(scope, id, props) {
        super(scope, id, props);

        const lwaLayerArn = `arn:aws:lambda:${Stack.of(this).region}:753240598075:layer:LambdaAdapterLayerArm64:25`;
        const lwaLayer = lambda.LayerVersion.fromLayerVersionArn(this, 'LWALayer', lwaLayerArn);

        const mcpServerRole = new iam.Role(this, 'McpServerRole', {
            roleName: 'DQMcpServerRole',
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
            ],
        });

        mcpServerRole.addToPolicy(new iam.PolicyStatement({
        actions: [
            "glue:GetDatabase",
            "glue:GetDatabases",
            "glue:GetTable",
            "glue:GetTables",
            "glue:GetPartition",
            "glue:GetPartitions",
            // Enhanced Lake Formation permissions for table access
            "lakeformation:GetDataAccess",
            "lakeformation:GetResourceLFTags",
            "lakeformation:ListLFTags",
            "lakeformation:GetLFTag",
            "lakeformation:SearchTablesByLFTags",
            "lakeformation:SearchDatabasesByLFTags"
        ],
        resources: ["*"]
        }));

        // Add specific Lake Formation data location permissions
        mcpServerRole.addToPolicy(new iam.PolicyStatement({
        actions: [
            "lakeformation:GetDataAccess"
        ],
        resources: ["*"],
        conditions: {
            StringEquals: {
                "lakeformation:DataAccessRole": mcpServerRole.roleArn
            }
        }
        }));

        mcpServerRole.addToPolicy(new iam.PolicyStatement({
        actions: [
            "glue:StartJobRun",
            "glue:GetJobRun",
            "glue:GetJobRuns",
            "glue:BatchStopJobRun"
        ],
        resources: ["*"]
        }));

        // Add comprehensive S3 permissions for data access and file operations
        mcpServerRole.addToPolicy(new iam.PolicyStatement({
        actions: [
            "s3:GetObject",
            "s3:PutObject",
            "s3:DeleteObject",
            "s3:ListBucket",
            "s3:GetBucketLocation",
            "s3:ListObjectsV2",
            "s3:HeadObject"
        ],
        resources: ["*"]
        }));

        // Add specific permissions for AP data mart buckets with secure transport
        mcpServerRole.addToPolicy(new iam.PolicyStatement({
        actions: [
            "s3:GetObject",
            "s3:GetObjectVersion",
            "s3:ListBucket",
            "s3:GetBucketLocation",
            "s3:ListBucketVersions"
        ],
        resources: [
            "arn:aws:s3:::transform-alpha-data-mart",
            "arn:aws:s3:::transform-alpha-data-mart/*"
        ],
        conditions: {
            Bool: {
                'aws:SecureTransport': 'true'  // Ensure HTTPS/TLS is used
            }
        }
        }));

        // Add permissions for the actual table data bucket (without secure transport requirement for compatibility)
        mcpServerRole.addToPolicy(new iam.PolicyStatement({
        actions: [
            "s3:GetObject",
            "s3:GetObjectVersion", 
            "s3:ListBucket",
            "s3:GetBucketLocation",
            "s3:ListBucketVersions"
        ],
        resources: [
            "arn:aws:s3:::transform-alpha-data-mart",
            "arn:aws:s3:::transform-alpha-data-mart/*"
        ]
        }));

        // Add Lambda invoke permissions for calling Poller Lambda
        mcpServerRole.addToPolicy(new iam.PolicyStatement({
        actions: [
            "lambda:InvokeFunction"
        ],
        resources: ["*"]
        }));

        // Add minimal Athena permissions (data access handled by workgroup service role)
        mcpServerRole.addToPolicy(new iam.PolicyStatement({
        actions: [
            "athena:StartQueryExecution",
            "athena:GetQueryExecution", 
            "athena:GetQueryResults",
            "athena:StopQueryExecution",
            "athena:GetWorkGroup",
            "athena:ListQueryExecutions"
        ],
        resources: ["*"]
        }));

        // Add permission to assume the transform-alpha-EMREC2Role for cross-account table access
        mcpServerRole.addToPolicy(new iam.PolicyStatement({
        actions: [
            "sts:AssumeRole"
        ],
        resources: [
            "arn:aws:iam::752105949551:role/transform-alpha-EMREC2Role"
        ]
        }));

        const dqMcpServerFn = new lambda.Function(this, 'DQMcpServer', {
            functionName: 'dq-mcp-server',
            role: mcpServerRole,
            architecture: props.fnArchitecture,
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'run.sh',
            timeout: Duration.minutes(15),
            memorySize: 1024,
            code: lambda.Code.fromAsset('./lambdas/DQ-mcp'),
            layers: [lwaLayer],
            environment: {
                AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap',
                AWS_LWA_PORT: "3001",
                JWT_SIGNATURE_SECRET: props.jwtSignatureSecret
            }
        });

        const mcpApi = new apigw.RestApi(this, 'McpApi', {
            restApiName: 'dq-agent-mcp-api',
            endpointTypes: [apigw.EndpointType.REGIONAL],
            deploy: true
        });

        const mcpResource = mcpApi.root.addResource('mcp');

        const mcpAuthorizerRole = new iam.Role(this, 'McpAuthorizerRole', {
            roleName: 'DQMcpAuthorizerRole',
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
            ],
        });

        const mcpAuthorizerFn = new lambda.Function(this, 'McpAuthorizerFn', {
            functionName: 'dq-mcp-server-authorizer',
            role: mcpAuthorizerRole,
            architecture: props.fnArchitecture,
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'index.handler',
            timeout: Duration.seconds(10),
            memorySize: 1024,
            code: lambda.Code.fromAsset('./lambdas/mcp-authorizer'),
            environment: {
                JWT_SIGNATURE_SECRET: props.jwtSignatureSecret
            }
        });

        const mcpAuthorizer = new apigw.TokenAuthorizer(this, 'McpAuthorizer', {
            handler: mcpAuthorizerFn,
            identitySource: apigw.IdentitySource.header('Authorization')
        });

        mcpResource.addMethod('ANY', new apigw.LambdaIntegration(dqMcpServerFn), {
            authorizer: mcpAuthorizer,
            authorizationType: apigw.AuthorizationType.CUSTOM
        });

        const mcpEndpoint = `${mcpApi.url}mcp`;

        new CfnOutput(this, 'McpEndpoint', {
            value: mcpEndpoint
        })

        return { mcpEndpoint ,dqMcpServerFn } ;
    }
}

module.exports = McpServerConstruct;
