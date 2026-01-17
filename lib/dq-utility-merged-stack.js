const cdk = require('aws-cdk-lib');
const { Stack } = cdk;
const glue = require('aws-cdk-lib/aws-glue');
const iam = require('aws-cdk-lib/aws-iam');
const lambda = require('aws-cdk-lib/aws-lambda');
const s3 = require('aws-cdk-lib/aws-s3');
const s3deploy = require('aws-cdk-lib/aws-s3-deployment');
const ec2 = require('aws-cdk-lib/aws-ec2');
const ecs = require('aws-cdk-lib/aws-ecs');
const ecsPatterns = require('aws-cdk-lib/aws-ecs-patterns');
const elbv2 = require('aws-cdk-lib/aws-elasticloadbalancingv2');
const logs = require('aws-cdk-lib/aws-logs');
const Cognito = require('./cognito');
const EcsAgentConstruct = require('./ecs-agent');
const EcsMcpServerConstruct = require('./ecs-mcp-server');

const FN_ARCHITECTURE = lambda.Architecture.ARM_64;
const JWT_SIGNATURE_SECRET = 'jwt-signature-secret';


class DQUtilityMergedStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const { pollIntervalSeconds = 60 } = props;

    // === PHASE 1: INFRASTRUCTURE SETUP ===

    // 1. Shared VPC for all ECS services
    const sharedVpc = new ec2.Vpc(this, 'DQSharedVpc', {
      maxAzs: 2,
      natGateways: 1,
    });

    // 2.S3 Bucket for Glue Scripts (used by Glue + MCP only)
    const glueBucket = new s3.Bucket(this, 'GlueScriptsBucket', {
      bucketName: `dq-glue-scripts-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // 3. Deploy Glue Script to S3
    const scriptDeployment = new s3deploy.BucketDeployment(this, 'GlueScriptDeployment', {
      sources: [s3deploy.Source.asset('glue-scripts')],
      destinationBucket: glueBucket,
      destinationKeyPrefix: 'glue-scripts/',
    });

    // === PHASE 2: WEB APP SETUP (FIRST - to get the URL for Cognito) ===

    // 4. Create ECS Cluster for Web App
    const webAppCluster = new ecs.Cluster(this, 'WebAppCluster', {
      vpc: sharedVpc,
      clusterName: 'dq-web-app-cluster',
      containerInsights: true,
    });

    // 5. Create log group for Web App
    const webAppLogGroup = new logs.LogGroup(this, 'WebAppLogGroup', {
      logGroupName: '/ecs/dq-web-app',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 6. Create Web App Fargate Service (minimal setup to get the URL)
    const webAppService = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'WebAppService', {
      cluster: webAppCluster,
      memoryLimitMiB: 2048,
      cpu: 1024,
      desiredCount: 1,
      platformVersion: ecs.FargatePlatformVersion.LATEST,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskImageOptions: {
        image: ecs.ContainerImage.fromAsset('./web', {
          file: 'Dockerfile.ecs',
          platform: 'linux/amd64',
        }),
        containerPort: 8001,
        environment: {
          // Minimal environment for initial setup - Cognito details will be added later
          AWS_REGION: props.env?.region || 'us-east-1',
          PORT: '8001',
          ENVIRONMENT: 'production',
        },
        logDriver: ecs.LogDrivers.awsLogs({
          streamPrefix: 'dq-web-app',
          logGroup: webAppLogGroup,
        }),
      },
      publicLoadBalancer: true,
      listenerPort: 80,
      healthCheckGracePeriod: cdk.Duration.seconds(300),
    });

    // 7. Add HTTPS listener for Web App
    const httpsListener = webAppService.loadBalancer.addListener('HttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [
        elbv2.ListenerCertificate.fromArn('arn:aws:acm:us-east-1:75xxxxxxxx:certificate/a3a6418e-ddee-45ed-a9db-eb18ca0c2c67')
      ],
      defaultTargetGroups: [webAppService.targetGroup],
    });

    // 8. Configure load balancer to preserve host headers and enable proper forwarding
    webAppService.loadBalancer.setAttribute('routing.http.preserve_host_header.enabled', 'true');
    webAppService.loadBalancer.setAttribute('routing.http.xff_client_port.enabled', 'true');
    // Set idle timeout to 15 minutes for long-running requests
    webAppService.loadBalancer.setAttribute('idle_timeout.timeout_seconds', '900');
    
    // 9. Configure Web App health check
    webAppService.targetGroup.configureHealthCheck({
      path: '/health',
      healthyHttpCodes: '200',
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 10,
      port: '8001',
    });

    // Configure target group deregistration delay for graceful shutdowns
    webAppService.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '300');

    // 10. Get the Web App URL (this is what we need for Cognito)
    const webAppUrl = `https://${webAppService.loadBalancer.loadBalancerDnsName}`;
    const webAppNotifyUrl = `${webAppUrl}/api/notify`;

    // === PHASE 3: COGNITO SETUP (now with actual web app URL) ===
    
    // 11. Cognito Setup with actual web app URL - no more placeholders!
    const cognitoConstruct = new Cognito(this, 'Cognito', {
      webAppUrl: webAppUrl // Pass the actual web app URL dynamically
    });
    
    const cognitoJwksUrl = cognitoConstruct.cognitoJwksUrl;
    const cognitoWellKnownUrl = cognitoConstruct.cognitoWellKnownUrl;
    const cognitoSignInUrl = cognitoConstruct.cognitoSignInUrl;
    const cognitoLogoutUrl = cognitoConstruct.cognitoLogoutUrl;
    const cognitoClientId = cognitoConstruct.userPoolClient.userPoolClientId;
    const cognitoClientSecret = cognitoConstruct.userPoolClient.userPoolClientSecret.unsafeUnwrap();

    // === PHASE 4: AGENT AND MCP SERVICES (now with web app URL) ===

    // 12. ECS MCP Server Setup
    const ecsMcpConstruct = new EcsMcpServerConstruct(this, 'EcsMcpConstruct', {
      jwtSignatureSecret: JWT_SIGNATURE_SECRET,
      vpc: sharedVpc,
      webAppNotifyUrl: webAppNotifyUrl, // 🔥 CRITICAL FIX: Pass WebSocket URL to MCP Server
      dataBucket:glueBucket ,
    });

    // 14. ECS Agent Setup
    const ecsAgentConstruct = new EcsAgentConstruct(this, 'EcsAgentConstruct', {
      mcpEndpoint: ecsMcpConstruct.mcpEndpoint,
      jwtSignatureSecret: JWT_SIGNATURE_SECRET,
      cognitoJwksUrl,
      webAppNotifyUrl: webAppNotifyUrl, // Now we have the actual URL!
      vpc: sharedVpc,
    });

    // === PHASE 5: UPDATE WEB APP WITH AGENT ENDPOINT AND COGNITO DETAILS ===

    // 15. Update Web App container environment with actual agent endpoint and Cognito details
    const webAppContainer = webAppService.taskDefinition.defaultContainer;
    webAppContainer.addEnvironment('AGENT_ENDPOINT_URL', `${ecsAgentConstruct.agentEndpoint}/agent`);
    webAppContainer.addEnvironment('WEB_APP_URL', webAppUrl);
    webAppContainer.addEnvironment('NOTIFY_URL', webAppNotifyUrl);
    
    // Add Cognito environment variables now that we have them
    webAppContainer.addEnvironment('COGNITO_CLIENT_ID', cognitoClientId);
    webAppContainer.addEnvironment('COGNITO_CLIENT_SECRET', cognitoClientSecret);
    webAppContainer.addEnvironment('COGNITO_DOMAIN', cognitoConstruct.cognitoDomainUrl?.replace('https://', '') || '');
    webAppContainer.addEnvironment('COGNITO_USER_POOL_ID', cognitoConstruct.userPool.userPoolId);

    // === PHASE 6: GLUE AND ATHENA SETUP ===

    // 16. Use existing cross-account role
    const existingRoleArn = <existing role which has all permissions to the tables w.r.t to the project on which this utility is used>;
    const existingRole = iam.Role.fromRoleArn(this, 'ExistingDataAccessRole', existingRoleArn);
    
    // 17. Create Athena Workgroup
    const athenaWorkgroup = new cdk.aws_athena.CfnWorkGroup(this, 'DQAthenaWorkgroup', {
      name: 'dq-agent-workgroup',
      description: 'Workgroup for DQ Agent with service role for data access',
      state: 'ENABLED',
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetrics: true,
        resultConfiguration: {
          outputLocation: `s3://${glueBucket.bucketName}/athena-results/`,
          encryptionConfiguration: {
            encryptionOption: 'SSE_S3'
          }
        },
        executionRole: existingRole.roleArn,
      },
    });

    // 18. Create Glue Job
    const glueJob = new glue.CfnJob(this, 'AgentGlueJob', {
      name: 'agent-run-sql-query',
      role: existingRole.roleArn,
      command: {
        name: 'glueetl',
        scriptLocation: `s3://${glueBucket.bucketName}/glue-scripts/dynamic-sql-executor.py`,
        pythonVersion: '3',
      },
      glueVersion: '5.0',
      executionProperty: { maxConcurrentRuns: 3 },
      workerType: 'G.2X',
      numberOfWorkers: 2,
      defaultArguments: {
        '--TempDir': `s3://${glueBucket.bucketName}/tmp/`,
        '--enable-metrics': 'true',
        '--enable-continuous-cloudwatch-log': 'true',
        '--enable-spark-ui': 'false',
        '--sql_query': 'SELECT 1',
        '--output_path': `s3://${glueBucket.bucketName}/output/`,
        '--session_id': 'default-session',
        '--datalake-formats': 'hudi',
        '--enable-glue-datacatalog': 'true',
        '--conf': [
          'spark.sql.catalogImplementation=hive',
          'hive.metastore.client.factory.class=com.amazonaws.glue.catalog.metastore.AWSGlueDataCatalogHiveClientFactory',
          'spark.serializer=org.apache.spark.serializer.KryoSerializer',
          'spark.sql.execution.arrow.pyspark.enabled=true',
          'spark.sql.adaptive.advisoryPartitionSizeInBytes=128MB',
          'spark.sql.files.maxPartitionBytes=134217728'
        ].join(' --conf ')
      },
      description: 'Glue job triggered by AI Agent for dynamic SQL execution (Glue 5.0)',
    });

    glueJob.node.addDependency(scriptDeployment);

    // === PHASE 7: POLLER LAMBDA ===

    // 19. Poller Lambda Role
    const pollerRole = new iam.Role(this, 'PollerLambdaRole', {
      roleName: 'GlueJobPollerLambdaRole',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    
    // 20. Poller Lambda
    const pollerLambda = new lambda.Function(this, 'GlueJobPollerLambda', {
      functionName: 'GlueJobPollerLambda',
      role: pollerRole,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'poller.handler',
      code: lambda.Code.fromAsset('lambdas/poller', {
        bundling: {
          image: lambda.Runtime.PYTHON_3_13.bundlingImage,
          command: [
            'bash', '-c',
            'pip install -r requirements.txt -t /asset-output && cp -au . /asset-output'
          ],
        },
      }),
      timeout: cdk.Duration.minutes(15),
      environment: {
        AGENT_ECS_URL: ecsAgentConstruct.agentEndpoint,
        POLL_INTERVAL_SECONDS: pollIntervalSeconds.toString(),
      },
    });

    // 21. Poller Lambda Permissions
    pollerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'glue:GetJobRun', 
          'glue:GetJobRuns', 
          's3:GetObject',
          's3:ListBucket',
        ],
        resources: ['*'],
      })
    );

    // === PHASE 9: OUTPUTS ===

    new cdk.CfnOutput(this, 'WebAppUrl', {
      value: webAppUrl,
      description: 'URL of the deployed web application',
      exportName: 'DQWebAppUrl',
    });

    new cdk.CfnOutput(this, 'WebAppNotifyUrl', {
      value: webAppNotifyUrl,
      description: 'WebSocket notify URL for services to use',
      exportName: 'DQWebAppNotifyUrl',
    });

    new cdk.CfnOutput(this, 'AgentEndpointUrl', {
      value: `${ecsAgentConstruct.agentEndpoint}/agent`,
      description: 'ECS Agent endpoint URL',
      exportName: 'DQAgentEndpointUrl',
    });

    new cdk.CfnOutput(this, 'GlueJobName', {
      value: glueJob.name,
      description: 'Name of the Glue Job triggered by the Agent',
    });

    new cdk.CfnOutput(this, 'PollerLambdaName', {
      value: pollerLambda.functionName,
      description: 'Lambda that polls Glue job status',
    });

    // Store references for potential external use
    this.webAppUrl = webAppUrl;
    this.webAppNotifyUrl = webAppNotifyUrl;
    this.agentEndpointUrl = `${ecsAgentConstruct.agentEndpoint}/agent`;
    this.cognitoSigninUrl = cognitoSignInUrl;
    this.cognitoLogoutUrl = cognitoLogoutUrl;
    this.cognitoWellKnownUrl = cognitoWellKnownUrl;
    this.cognitoClientId = cognitoClientId;
    this.cognitoClientSecret = cognitoClientSecret;
    this.cognitoDomainUrl = cognitoConstruct.cognitoDomainUrl;
    this.cognitoUserPoolId = cognitoConstruct.userPool.userPoolId;
  }
}

module.exports = { DQUtilityMergedStack };
