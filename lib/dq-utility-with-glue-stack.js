const cdk = require('aws-cdk-lib');
const { Stack } = cdk;
const glue = require('aws-cdk-lib/aws-glue');
const iam = require('aws-cdk-lib/aws-iam');
const lambda = require('aws-cdk-lib/aws-lambda');
const s3 = require('aws-cdk-lib/aws-s3');
const s3deploy = require('aws-cdk-lib/aws-s3-deployment');
const ec2 = require('aws-cdk-lib/aws-ec2');
const Cognito = require('./cognito');
const McpServerConstruct = require('./mcp-server');
const AgentConstruct = require('./agent');
const EcsAgentConstruct = require('./ecs-agent');
const EcsMcpServerConstruct = require('./ecs-mcp-server');

const FN_ARCHITECTURE = lambda.Architecture.ARM_64;
const JWT_SIGNATURE_SECRET = 'jwt-signature-secret';

class DQUtilityWithGlueStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const { pollIntervalSeconds = 60 } = props;

    // === 1️⃣ Cognito Setup ===
    const cognitoConstruct = new Cognito(this, 'Cognito', {});
    
    // Access values from the construct properties (not return value)
    const cognitoJwksUrl = cognitoConstruct.cognitoJwksUrl;
    const cognitoWellKnownUrl = cognitoConstruct.cognitoWellKnownUrl;
    const cognitoSignInUrl = cognitoConstruct.cognitoSignInUrl;
    const cognitoLogoutUrl = cognitoConstruct.cognitoLogoutUrl;
    const cognitoClientId = cognitoConstruct.userPoolClient.userPoolClientId;
    const cognitoClientSecret = cognitoConstruct.userPoolClient.userPoolClientSecret.unsafeUnwrap();

    // === 2️⃣ MCP Server Setup ===
    const mcpConstruct = new McpServerConstruct(this, 'McpServerConstruct', {
      fnArchitecture: FN_ARCHITECTURE,
      jwtSignatureSecret: JWT_SIGNATURE_SECRET,
    });

    const mcpLambda = mcpConstruct.dqMcpServerFn;

    const mcpEndpoint = mcpConstruct.mcpEndpoint;

    // === 3️⃣ Agent Setup ===
    const agentConstruct = new AgentConstruct(this, 'AgentConstruct', {
      fnArchitecture: FN_ARCHITECTURE,
      jwtSignatureSecret: JWT_SIGNATURE_SECRET,
      mcpEndpoint: mcpConstruct.mcpEndpoint,
      cognitoJwksUrl,
      webAppNotifyUrl: props.webAppNotifyUrl,
    });

    const agentLambda = agentConstruct.dqAgentFn;

    // === 1️⃣.5 Shared VPC for ECS Services (to avoid VPC limit) ===
    const sharedVpc = new ec2.Vpc(this, 'DQSharedVpc', {
      maxAzs: 2,
      natGateways: 1, // Required for private subnets to access ECR
    });

    // === 2️⃣.1 ECS MCP Server Setup (NEW - runs alongside Lambda MCP) ===
    const ecsMcpConstruct = new EcsMcpServerConstruct(this, 'EcsMcpConstruct', {
      jwtSignatureSecret: JWT_SIGNATURE_SECRET,
      vpc: sharedVpc, // Pass shared VPC
    });

    // === 3️⃣.1 ECS Agent Setup (NEW - runs alongside Lambda Agent) ===
    const ecsAgentConstruct = new EcsAgentConstruct(this, 'EcsAgentConstruct', {
      mcpEndpoint: ecsMcpConstruct.mcpEndpoint, // Use ECS MCP endpoint instead of Lambda
      jwtSignatureSecret: JWT_SIGNATURE_SECRET,
      sessionStoreBucket: agentConstruct.agentSessionStoreBucket, // Reuse same S3 bucket
      cognitoJwksUrl,
      webAppNotifyUrl: props.webAppNotifyUrl,
      vpc: sharedVpc, // Pass shared VPC
    });

    // === 4️⃣ S3 Bucket for Glue Scripts ===
    const glueBucket = new s3.Bucket(this, 'GlueScriptsBucket', {
      bucketName: 'dq-utlity-ai-durgamj',
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Keep bucket on stack deletion
    });

    // === 5️⃣ Deploy Glue Script to S3 ===
    const scriptDeployment = new s3deploy.BucketDeployment(this, 'GlueScriptDeployment', {
      sources: [s3deploy.Source.asset('glue-scripts')],
      destinationBucket: glueBucket,
      destinationKeyPrefix: 'glue-scripts/',
    });

    // === 6️⃣ Use Existing Cross-Account Role for Both Athena and Glue ===
    // Comment: Using existing transform-alpha-EMREC2Role that already has all Lake Formation permissions
    // This role can access data within account and cross-account, making our life easy!
    const existingRoleArn = 'arn:aws:iam::752105949551:role/transform-alpha-EMREC2Role';
    const existingRole = iam.Role.fromRoleArn(this, 'ExistingDataAccessRole', existingRoleArn);

    /* COMMENTED OUT: Custom Athena role creation - using existing role instead
    const athenaRole = new iam.Role(this, 'AthenaServiceRole', {
      roleName: 'DQAthenaServiceRole',
      assumedBy: new iam.ServicePrincipal('athena.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonAthenaFullAccess'),
      ],
    });
    // ... all the custom permission policies commented out ...
    */
/*// Add S3 permissions for Athena to read data and write results
    athenaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          's3:GetObject',
          's3:GetObjectVersion',
          's3:ListBucket',
          's3:GetBucketLocation',
          's3:ListBucketVersions',
          's3:PutObject',
          's3:DeleteObject',
        ],
        resources: [
          'arn:aws:s3:::dq-utlity-ai-durgamj',
          'arn:aws:s3:::dq-utlity-ai-durgamj/*',
          'arn:aws:s3:::transform-alpha-data-mart',
          'arn:aws:s3:::transform-alpha-data-mart/*'
        ],
      })
    );

    // Add Glue Data Catalog permissions for Athena
    athenaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'glue:GetTable',
          'glue:GetTables',
          'glue:GetDatabase',
          'glue:GetDatabases',
          'glue:GetPartition',
          'glue:GetPartitions',
          'glue:BatchGetPartition',
          'glue:GetCatalogImportStatus',
          'glue:GetDataCatalogEncryptionSettings',
        ],
        resources: ['*'],
      })
    );

    // Add comprehensive S3 permissions for Athena (matching Glue role)
    athenaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          's3:ListMultipartUploadParts',
          's3:AbortMultipartUpload',
          's3:CreateBucket',
          's3:ListObjectsV2',
          's3:HeadObject',
        ],
        resources: ['*'], // Allow access to all S3 buckets for data lake access
      })
    );

    // Add specific permissions for AP data mart buckets with secure transport (matching Glue role)
    athenaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          's3:GetObject',
          's3:GetObjectVersion',
          's3:ListBucket',
          's3:GetBucketLocation',
          's3:ListBucketVersions',
        ],
        resources: [
          'arn:aws:s3:::transform-alpha-data-mart',
          'arn:aws:s3:::transform-alpha-data-mart/*'
        ],
        conditions: {
          Bool: {
            'aws:SecureTransport': 'true'  // Ensure HTTPS/TLS is used
          }
        }
      })
    );

    // Add enhanced Glue Data Catalog permissions for Athena (matching Glue role)
    athenaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'glue:SearchTables',
          'glue:GetTableVersions',
          'glue:GetTableVersion',
          'glue:GetUserDefinedFunction',
          'glue:GetUserDefinedFunctions',
        ],
        resources: ['*'],
      })
    );

    // Add enhanced Lake Formation permissions for Athena (matching Glue role)
    athenaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'lakeformation:GetDataAccess',
          'lakeformation:GetResourceLFTags',
          'lakeformation:ListLFTags',
          'lakeformation:GetLFTag',
          'lakeformation:SearchTablesByLFTags',
          'lakeformation:SearchDatabasesByLFTags'
        ],
        resources: ['*'],
      })
    );

    // Add specific Lake Formation data location permissions for Athena role
    athenaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'lakeformation:GetDataAccess'
        ],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'lakeformation:DataAccessRole': athenaRole.roleArn
          }
        }
      })
    );*/
    // === 6️⃣.1 Create Athena Workgroup with Service Role ===
    const athenaWorkgroup = new cdk.aws_athena.CfnWorkGroup(this, 'DQAthenaWorkgroup', {
      name: 'dq-agent-workgroup',
      description: 'Workgroup for DQ Agent with service role for data access',
      state: 'ENABLED',
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetrics: true,
        resultConfiguration: {
          outputLocation: 's3://dq-utlity-ai-durgamj/athena-results/',
          encryptionConfiguration: {
            encryptionOption: 'SSE_S3'
          }
        },
        executionRole: existingRole.roleArn, // ✅ This is the key fix!
      },
    });

    // Note: No dependency needed since we're using an existing role
    // athenaWorkgroup.addDependency(athenaRole.node.defaultChild); // Not needed for existing roles

    // === 7️⃣ Use Same Existing Role for Glue ===
    // Comment: Using the same existingRole reference for consistency

    /* COMMENTED OUT: Custom Glue role creation - using existing role instead
    const glueRole = new iam.Role(this, 'GlueJobRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lakeformation.amazonaws.com'),
        new iam.ServicePrincipal('ec2.amazonaws.com'),
        new iam.ServicePrincipal('glue.amazonaws.com'),
        new iam.ServicePrincipal('elasticmapreduce.amazonaws.com')
      ),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonAthenaFullAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')
      ],
    });
    */

    /* COMMENTED OUT: Custom Glue role permissions - using existing role that already has all permissions
    // Add comprehensive S3 permissions for data access
    glueRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          's3:GetObject',
          's3:GetObjectVersion',
          's3:PutObject',
          's3:DeleteObject',
          's3:ListBucket',
          's3:ListBucketVersions',
          's3:GetBucketLocation',
          's3:ListMultipartUploadParts',
          's3:AbortMultipartUpload',
          's3:CreateBucket',
        ],
        resources: ['*'], // Allow access to all S3 buckets for data lake access
      })
    );

    // Add specific permissions for AP data mart buckets
    glueRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          's3:GetObject',
          's3:GetObjectVersion',
          's3:ListBucket',
          's3:GetBucketLocation',
          's3:ListBucketVersions',
        ],
        resources: [
          'arn:aws:s3:::transform-alpha-data-mart',
          'arn:aws:s3:::transform-alpha-data-mart/*'
        ],
        conditions: {
          Bool: {
            'aws:SecureTransport': 'true'  // Ensure HTTPS/TLS is used
          }
        }
      })
    );

    // Add Glue Data Catalog permissions
    glueRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'glue:GetTable',
          'glue:GetTables',
          'glue:GetDatabase',
          'glue:GetDatabases',
          'glue:GetPartition',
          'glue:GetPartitions',
          'glue:BatchGetPartition',
          'glue:GetCatalogImportStatus',
          'glue:GetDataCatalogEncryptionSettings',
          'glue:SearchTables',
          'glue:GetTableVersions',
          'glue:GetTableVersion',
          'glue:GetUserDefinedFunction',
          'glue:GetUserDefinedFunctions',
        ],
        resources: ['*'],
      })
    );

    // Add enhanced Lake Formation permissions for data access
    glueRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'lakeformation:GetDataAccess',
          'lakeformation:GetResourceLFTags',
          'lakeformation:ListLFTags',
          'lakeformation:GetLFTag',
          'lakeformation:SearchTablesByLFTags',
          'lakeformation:SearchDatabasesByLFTags'
        ],
        resources: ['*'],
      })
    );

    // Add specific Lake Formation data location permissions for Glue role
    glueRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'lakeformation:GetDataAccess'
        ],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'lakeformation:DataAccessRole': glueRole.roleArn
          }
        }
      })
    );

    // Add CloudWatch Logs permissions
    glueRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'logs:DescribeLogGroups',
          'logs:DescribeLogStreams',
        ],
        resources: ['*'],
      })
    );
    */

    // === 7️⃣ Create Glue Job ===
    const glueJob = new glue.CfnJob(this, 'AgentGlueJob', {
      name: 'agent-run-sql-query',
      role: existingRole.roleArn,
      command: {
        name: 'glueetl',
        scriptLocation: `s3://${glueBucket.bucketName}/glue-scripts/dynamic-sql-executor.py`, // ✅ Dynamic script
        pythonVersion: '3',
      },
      glueVersion: '5.0',
      executionProperty: { maxConcurrentRuns: 3 },
      workerType: 'G.2X', // More powerful workers for faster processing
      numberOfWorkers: 2, // Minimal workers for simple queries - much faster startup
      defaultArguments: {
        '--TempDir': 's3://dq-utlity-ai-durgamj/tmp/',
        '--enable-metrics': 'true',
        '--enable-continuous-cloudwatch-log': 'true',
        '--enable-spark-ui': 'false', // Disable Spark UI for faster startup
        '--sql_query': 'SELECT 1', // Default query (will be overridden)
        '--output_path': 's3://dq-utlity-ai-durgamj/output/',
        '--session_id': 'default-session',
        '--datalake-formats': 'hudi',
        '--enable-glue-datacatalog': 'true',
        // Performance optimizations (avoiding duplicates already in Python script)
        '--conf': [
          'spark.sql.catalogImplementation=hive',
          'hive.metastore.client.factory.class=com.amazonaws.glue.catalog.metastore.AWSGlueDataCatalogHiveClientFactory',
          'spark.serializer=org.apache.spark.serializer.KryoSerializer', // Faster serialization
          'spark.sql.execution.arrow.pyspark.enabled=true', // Enable Arrow for faster data transfer
          'spark.sql.adaptive.advisoryPartitionSizeInBytes=128MB', // Optimize partition size
          'spark.sql.files.maxPartitionBytes=134217728' // 128MB max partition size
        ].join(' --conf ')
        // dynamic args (like --sql_query, --output_path) will come from glue-job-trigger tool
      },
      description:
        'Glue job triggered by AI Agent for dynamic SQL execution (Glue 5.0)',
    });

    // Ensure Glue job is created after script deployment
    glueJob.node.addDependency(scriptDeployment);

    // === 8️⃣ Poller Lambda ===
    const pollerRole = new iam.Role(this, 'PollerLambdaRole', {
      roleName: 'GlueJobPollerLambdaRole',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole'
        ),
      ],
    });

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
        AGENT_ECS_URL: ecsAgentConstruct.agentEndpoint, // Use ECS Agent endpoint instead of Lambda
        POLL_INTERVAL_SECONDS: pollIntervalSeconds.toString(),
      },
    });

    // === 9️⃣ Poller Lambda Permissions ===
    pollerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'glue:GetJobRun', 
          'glue:GetJobRuns', 
          // S3 permissions for reading Glue job results
          's3:GetObject',
          's3:ListBucket',
        ],
        resources: ['*'],
      })
    );

    // === 🔟 Wire MCP ↔ Poller ===
    // Use hardcoded function name instead of dynamic reference to avoid circular dependency
    mcpLambda.addEnvironment('POLLER_LAMBDA_NAME', 'GlueJobPollerLambda');
    mcpLambda.addEnvironment('ATHENA_OUTPUT_LOCATION', 's3://dq-utlity-ai-durgamj/athena-results/');
    mcpLambda.addEnvironment('ATHENA_WORKGROUP', 'dq-agent-workgroup'); // ✅ Use the workgroup with service role
    
    // Allow MCP Lambda to invoke Poller Lambda (Poller now sends HTTP to ECS Agent)
    mcpLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: ['arn:aws:lambda:*:*:function:GlueJobPollerLambda'],
      })
    );

    // === 1️⃣1️⃣ Outputs ===
    new cdk.CfnOutput(this, 'GlueJobName', {
      value: glueJob.name,
      description: 'Name of the Glue Job triggered by the Agent',
    });

    new cdk.CfnOutput(this, 'PollerLambdaName', {
      value: pollerLambda.functionName,
      description: 'Lambda that polls Glue job status',
    });

    // Export agent API URL and Cognito configuration for web app stack
    // Remove trailing slash to match API Gateway invoke URL format
    const rawAgentApiUrl = agentConstruct.agentApi?.url || 'https://placeholder-agent-url.amazonaws.com/prod';
    this.agentApiUrl = rawAgentApiUrl.endsWith('/') ? rawAgentApiUrl.slice(0, -1) : rawAgentApiUrl;
    
    // Export ECS Agent endpoint for web app to use instead of Lambda
    this.ecsAgentEndpoint = `${ecsAgentConstruct.agentEndpoint}/agent`;
    
    this.cognitoSigninUrl = cognitoSignInUrl;
    this.cognitoLogoutUrl = cognitoLogoutUrl;
    this.cognitoWellKnownUrl = cognitoWellKnownUrl;
    this.cognitoClientId = cognitoClientId;
    this.cognitoClientSecret = cognitoClientSecret;
    this.cognitoDomainUrl = cognitoConstruct.cognitoDomainUrl;
    this.cognitoUserPoolId = cognitoConstruct.userPool.userPoolId;
  }
}

module.exports = { DQUtilityWithGlueStack };
