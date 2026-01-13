const cdk = require('aws-cdk-lib');
const glue = require('aws-cdk-lib/aws-glue');
const iam = require('aws-cdk-lib/aws-iam');
const lambda = require('aws-cdk-lib/aws-lambda');

class GlueJobStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const { agentLambda, mcpLambda, pollIntervalSeconds = 60 } = props;


    // === 2️⃣ Glue Role with required permissions ===
    const glueRole = new iam.Role(this, 'GlueJobRole', {
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole'),
      ],
    });

    glueRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        's3:GetObject',
        's3:PutObject',
        's3:ListBucket',
        'glue:GetTable',
        'glue:GetDatabase',
        'glue:GetPartitions'
      ],
      resources: ['*'],
    }));

    // === 3️⃣ Create Glue Job using version 5.0 ===
    const glueJob = new glue.CfnJob(this, 'AgentGlueJob', {
      name: 'agent-run-sql-query',
      role: glueRole.roleArn,
      command: {
        name: 'glueetl',
        scriptLocation: 's3://transform-alpha-configuration/custom_test_scripts/ap_dices_na_lines.sql',// just a dummy placeholder
        pythonVersion: '3',
      },
      glueVersion: '5.0', // ✅ Updated Glue version
      executionProperty: {
        maxConcurrentRuns: 3
      },
      //maxCapacity: 10.0, // or use workerType/numberOfWorkers if needed
      workerType: 'G.1X',
      numberOfWorkers: 10,
      defaultArguments: {
        '--TempDir': 's3://dq-utlity-ai-durgamj/tmp/',
        '--enable-metrics': 'true',
        '--enable-continuous-cloudwatch-log': 'true',
        '--enable-spark-ui': 'true',
        '--spark-event-logs-path': 's3://dq-utlity-ai-durgamj/spark-logs/',
        // dynamic args (like --sql_text, --output_s3_path) will come from glue-job-trigger tool
      },
      description: 'Glue job triggered by AI Agent for dynamic SQL execution (Glue 5.0)',
    });

    // === 4️⃣ Poller Lambda (for tracking Glue job completion) ===
    const pollerRole = new iam.Role(this, 'PollerLambdaRole', {
      roleName: 'GlueJobPollerLambdaRole',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
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
        AGENT_LAMBDA_NAME: agentLambda?.functionName,
        POLL_INTERVAL_SECONDS: pollIntervalSeconds.toString(), // Name of your agent Lambda
      },
    });

    // === 5️⃣ Permissions for the Poller Lambda ===
    pollerRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'glue:GetJobRun',
        'glue:GetJobRuns',
        'lambda:InvokeFunction'
      ],
      resources: ['*'],
    }));

    // ✅ Allow Poller to invoke agent Lambda 
    if (agentLambda) {
      agentLambda.grantInvoke(pollerLambda);
    }

    // === 6️⃣ Allow MCP Lambda to invoke Poller ===
    if (mcpLambda) {
     // mcpLambda.addEnvironment('POLLER_LAMBDA_NAME', pollerLambda.functionName);
      pollerLambda.grantInvoke(mcpLambda);
    }

    // === Outputs ===be
    new cdk.CfnOutput(this, 'GlueJobName', {
      value: glueJob.name,
      description: 'Name of the Glue Job triggered by the Agent',
    });

    new cdk.CfnOutput(this, 'PollerLambdaName', {
      value: pollerLambda.functionName,
      description: 'Lambda that polls Glue job status',
    });
  }
}

module.exports = { GlueJobStack };
