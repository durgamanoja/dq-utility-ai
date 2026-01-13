const cdk = require('aws-cdk-lib');
const { Stack } = cdk;
const lambda = require('aws-cdk-lib/aws-lambda');
const apigwv2 = require('aws-cdk-lib/aws-apigatewayv2');
const apigwv2Integrations = require('aws-cdk-lib/aws-apigatewayv2-integrations');
const iam = require('aws-cdk-lib/aws-iam');
const cognito = require('aws-cdk-lib/aws-cognito');
const path = require('path');

class WebAppServerlessStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const webAppLambda = new lambda.DockerImageFunction(this, 'WebAppLambda', {
      functionName: 'DQ-web-app-lambda',
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../web'), {
        file: 'Dockerfile',
        cmd: ['lambda_handler.handler'],
      }),
      architecture: lambda.Architecture.X86_64, 
      timeout: cdk.Duration.seconds(900), // 15 minutes for Gradio initialization
      memorySize: 3008, // Increased memory for better performance
      environment: {
        AGENT_ENDPOINT_URL: props.agentEndpointUrl,
        COGNITO_SIGNIN_URL: props.cognitoSigninUrl,
        COGNITO_LOGOUT_URL: props.cognitoLogoutUrl,
        COGNITO_WELL_KNOWN_URL: props.cognitoWellKnownUrl,
        COGNITO_CLIENT_ID: props.cognitoClientId,
        COGNITO_CLIENT_SECRET: props.cognitoClientSecret,
        COGNITO_DOMAIN_URL: props.cognitoDomainUrl,
      },
    });


    // ✅ HTTP API for the Web App
    const httpApi = new apigwv2.HttpApi(this, 'WebAppHttpApi', {
      apiName: 'DQ-web-app-api',
      description: 'HTTP API for DQ Web Application',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ['*'],
      },
    });

    // ✅ WebSocket API for Real-Time Updates
    const webSocketApi = new apigwv2.WebSocketApi(this, 'WebAppWebSocketApi', {
      apiName: 'DQ-web-app-websocket',
      description: 'WebSocket API for DQ Web Application real-time communication',
    });

    const webSocketLambda = new lambda.DockerImageFunction(this, 'WebSocketLambda', {
      functionName: 'DQ-websocket-lambda',
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../web'), {
        file: 'Dockerfile',
        cmd: ['websocket_handler.handler'],
      }),
      architecture: lambda.Architecture.X86_64, 
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        AGENT_ENDPOINT_URL: props.agentEndpointUrl,
        COGNITO_SIGNIN_URL: props.cognitoSigninUrl,
        COGNITO_LOGOUT_URL: props.cognitoLogoutUrl,
        COGNITO_WELL_KNOWN_URL: props.cognitoWellKnownUrl,
        COGNITO_CLIENT_ID: props.cognitoClientId,
        COGNITO_CLIENT_SECRET: props.cognitoClientSecret,
        COGNITO_DOMAIN_URL: props.cognitoDomainUrl,
      },
    });

    // ✅ Permissions to manage WebSocket connections
    webSocketLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['execute-api:ManageConnections', 'execute-api:Invoke'],
      resources: [`arn:aws:execute-api:${this.region}:${this.account}:${webSocketApi.apiId}/*`],
    }));

    // ✅ WebSocket routes
    webSocketApi.addRoute('$connect', {
      integration: new apigwv2Integrations.WebSocketLambdaIntegration('ConnectIntegration', webSocketLambda),
    });
    webSocketApi.addRoute('$disconnect', {
      integration: new apigwv2Integrations.WebSocketLambdaIntegration('DisconnectIntegration', webSocketLambda),
    });
    webSocketApi.addRoute('$default', {
      integration: new apigwv2Integrations.WebSocketLambdaIntegration('DefaultIntegration', webSocketLambda),
    });

    // ✅ WebSocket Stage
    const webSocketStage = new apigwv2.WebSocketStage(this, 'WebSocketStage', {
      webSocketApi,
      stageName: 'prod',
      autoDeploy: true,
    });

    // ✅ HTTP Routes for Web App
    const webAppIntegration = new apigwv2Integrations.HttpLambdaIntegration('WebAppIntegration', webAppLambda);

    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: webAppIntegration,
    });

    httpApi.addRoutes({
      path: '/',
      methods: [apigwv2.HttpMethod.ANY],
      integration: webAppIntegration,
    });

    // ✅ Outputs
    new cdk.CfnOutput(this, 'WebAppUrl', {
      value: httpApi.url,
      description: 'URL of the serverless web application',
      exportName: 'DQWebAppServerlessUrl',
    });

    new cdk.CfnOutput(this, 'WebSocketUrl', {
      value: `${webSocketApi.apiEndpoint}/${webSocketStage.stageName}`,
      description: 'WebSocket API URL for real-time communication',
      exportName: 'DQWebSocketUrl',
    });

    new cdk.CfnOutput(this, 'WebAppNotifyUrl', {
      value: `${httpApi.url}api/notify`,
      description: 'WebSocket notify URL for Lambda to use',
      exportName: 'DQWebAppServerlessNotifyUrl',
    });

    // Update Lambda environment with actual URLs
    webAppLambda.addEnvironment('WEB_APP_URL', httpApi.url);
    webAppLambda.addEnvironment('WEBSOCKET_URL', `${webSocketApi.apiEndpoint}/${webSocketStage.stageName}`);
    webAppLambda.addEnvironment('NOTIFY_URL', `${httpApi.url}api/notify`);
    
    // Update Cognito URLs with the correct callback URI
    const callbackUri = `${httpApi.url}callback`;
    const logoutUri = `${httpApi.url}chat`;
    
    // Use CDK Fn.sub to properly resolve tokens at deployment time
    const updatedSigninUrl = cdk.Fn.sub(
      '${CognitoDomainUrl}/login?client_id=${CognitoClientId}&response_type=code&scope=email+openid+profile&redirect_uri=${CallbackUri}',
      {
        CognitoDomainUrl: props.cognitoDomainUrl,
        CognitoClientId: props.cognitoClientId,
        CallbackUri: cdk.Fn.sub('https://${ApiId}.execute-api.${Region}.${URLSuffix}/callback', {
          ApiId: httpApi.httpApiId,
          Region: cdk.Aws.REGION,
          URLSuffix: cdk.Aws.URL_SUFFIX
        })
      }
    );
    
    const updatedLogoutUrl = cdk.Fn.sub(
      '${CognitoDomainUrl}/logout?client_id=${CognitoClientId}&logout_uri=${LogoutUri}',
      {
        CognitoDomainUrl: props.cognitoDomainUrl,
        CognitoClientId: props.cognitoClientId,
        LogoutUri: cdk.Fn.sub('https://${ApiId}.execute-api.${Region}.${URLSuffix}/chat', {
          ApiId: httpApi.httpApiId,
          Region: cdk.Aws.REGION,
          URLSuffix: cdk.Aws.URL_SUFFIX
        })
      }
    );
    
    webAppLambda.addEnvironment('COGNITO_SIGNIN_URL', updatedSigninUrl);
    webAppLambda.addEnvironment('COGNITO_LOGOUT_URL', updatedLogoutUrl);
    webAppLambda.addEnvironment('COGNITO_CALLBACK_URI', callbackUri);
    webAppLambda.addEnvironment('COGNITO_LOGOUT_URI', logoutUri);
    webAppLambda.addEnvironment('COGNITO_DOMAIN_URL', props.cognitoDomainUrl);
    
    // Add provisioned concurrency to reduce cold starts for Gradio
    const version = webAppLambda.currentVersion;
    const alias = new lambda.Alias(this, 'WebAppLambdaAlias', {
      aliasName: 'live',
      version: version,
      provisionedConcurrencyConfig: {
        provisionedConcurrentExecutions: 1, // Keep 1 instance warm
      },
    });
    
    webSocketLambda.addEnvironment('WEB_APP_URL', httpApi.url);
    webSocketLambda.addEnvironment('WEBSOCKET_URL', `${webSocketApi.apiEndpoint}/${webSocketStage.stageName}`);
    webSocketLambda.addEnvironment('NOTIFY_URL', `${httpApi.url}api/notify`);
    

    // Store URLs for cross-stack usage
    this.webAppUrl = httpApi.url;
    this.webSocketUrl = `${webSocketApi.apiEndpoint}/${webSocketStage.stageName}`;
    this.notifyUrl = `${httpApi.url}api/notify`;
  }
}

module.exports = { WebAppServerlessStack };
