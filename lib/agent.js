const iam = require('aws-cdk-lib/aws-iam');
const lambda = require('aws-cdk-lib/aws-lambda');
const apigw = require('aws-cdk-lib/aws-apigateway');
const ddb = require('aws-cdk-lib/aws-dynamodb');
const s3 = require('aws-cdk-lib/aws-s3');
const { Duration, RemovalPolicy, CfnOutput } = require('aws-cdk-lib');
const { Construct } = require('constructs');
const path = require('path');

class AgentConstruct extends Construct {
    constructor(scope, id, props) {
        super(scope, id, props);

        const agentSessionStoreBucket = new s3.Bucket(this, 'AgentSessionStore', {
            removalPolicy: RemovalPolicy.DESTROY,
            autoDeleteObjects: true
        });       

        // Commented out dependencies layer - using Docker bundling instead
        // const dependenciesLayer = new lambda.LayerVersion(this, 'DependenciesLayer', {
        //     removalPolicy: RemovalPolicy.DESTROY,
        //     compatibleArchitectures: [props.fnArchitecture],
        //     code: lambda.Code.fromAsset('./layers/dependencies', {
        //         bundling: {
        //             image: lambda.Runtime.PYTHON_3_13.bundlingImage,
        //             command: [
        //                 'bash',
        //                 '-c',
        //                 'pip install --no-cache-dir -r requirements.txt -t /asset-output/python && cp -au . /asset-output/python'
        //             ]
        //         }
        //     })
        // });

        const dqAgentFn = new lambda.Function(this, 'DQAgent', {
            functionName: 'DQ-agent-on-lambda',
            architecture: props.fnArchitecture,
            runtime: lambda.Runtime.PYTHON_3_13,
            handler: 'app.handler',
            timeout: Duration.seconds(900), // Increase to 15 minutes for complex processing
            memorySize: 2048, // Increase memory to improve performance
            code: lambda.Code.fromAsset(path.join(__dirname, '../lambdas/DQ-agent'), {
                bundling: {
                    image: lambda.Runtime.PYTHON_3_13.bundlingImage,
                    command: [
                        'bash', '-c',
                        'pip install -r requirements.txt -t /asset-output && cp -au . /asset-output'
                    ]
                },
                exclude: ['.venv/**', '.venv', '*.pyc', '__pycache__/**', '.idea/**']
            }),
            // layers: [dependenciesLayer], // Commented out to avoid Docker issues
            environment: {
                MCP_ENDPOINT: props.mcpEndpoint,
                JWT_SIGNATURE_SECRET: props.jwtSignatureSecret,
                SESSION_STORE_BUCKET_NAME: agentSessionStoreBucket.bucketName,
                COGNITO_JWKS_URL: props.cognitoJwksUrl,

                // Added for reinvocation + Glue integration
                AGENT_LAMBDA_NAME: 'DQ-agent-on-lambda', // used by poller lambda
                
                // Added for async invocation pattern
                SELF_LAMBDA_FUNCTION_NAME: 'DQ-agent-on-lambda', // for self-invocation
                
                // WebSocket notification URL for agent (passed dynamically from stack)
                WEB_APP_NOTIFY_URL: props.webAppNotifyUrl,
                
                // Force redeploy to fix system prompt changes and invalidate container cache
                DEPLOYMENT_VERSION: '2025-12-30-athena-first-v1'
            }
        });

        dqAgentFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
            resources: ['*'],
        }));

        // Add permission for async self-invocation (using hardcoded ARN pattern to avoid circular dependency)
        dqAgentFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['lambda:InvokeFunction'],
            resources: ['arn:aws:lambda:*:*:function:DQ-agent-on-lambda'],
        }));

        agentSessionStoreBucket.grantReadWrite(dqAgentFn);

        const agentApi = new apigw.RestApi(this, 'AgentApi', {
            restApiName: 'DQ-agent-api',
            endpointTypes: [apigw.EndpointType.REGIONAL],
            deploy: true
        });

        const agentAuthorizerFn = new lambda.Function(this, 'AgentAuthorizerFn', {
            functionName: 'DQ-agent-authorizer',
            architecture: props.fnArchitecture,
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'index.handler',
            timeout: Duration.seconds(10),
            memorySize: 1024,
            code: lambda.Code.fromAsset('./lambdas/agent-authorizer'),
            environment: {
                COGNITO_JWKS_URL: props.cognitoJwksUrl
            }
        });

        const agentAuthorizer = new apigw.TokenAuthorizer(this, 'AgentAuthorizer', {
            handler: agentAuthorizerFn,
            identitySource: apigw.IdentitySource.header('Authorization')
        });

        agentApi.root.addMethod('POST', new apigw.LambdaIntegration(dqAgentFn), {
            authorizer: agentAuthorizer,
            authorizationType: apigw.AuthorizationType.CUSTOM
        });

        new CfnOutput(this, 'AgentEndpointUrl', {
            exportName: 'ApaAgentEndpointUrl',
            value: agentApi.url
        })

        // === Output for Poller ===
        new CfnOutput(this, 'AgentLambdaName', {
            exportName: 'ApaAgentLambdaName',
            value: dqAgentFn.functionName,
        });

        // Expose the Lambda function, API, and session bucket as properties
        this.dqAgentFn = dqAgentFn;
        this.agentApi = agentApi;
        this.agentSessionStoreBucket = agentSessionStoreBucket;
    }
}

module.exports = AgentConstruct;
