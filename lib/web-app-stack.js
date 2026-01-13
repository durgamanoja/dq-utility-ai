const cdk = require('aws-cdk-lib');
const { Stack } = cdk;
const ec2 = require('aws-cdk-lib/aws-ec2');
const ecs = require('aws-cdk-lib/aws-ecs');
const ecsPatterns = require('aws-cdk-lib/aws-ecs-patterns');
const elbv2 = require('aws-cdk-lib/aws-elasticloadbalancingv2');
const acm = require('aws-cdk-lib/aws-certificatemanager');
const iam = require('aws-cdk-lib/aws-iam');
const logs = require('aws-cdk-lib/aws-logs');
const { Construct } = require('constructs');

class WebAppStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // Create VPC for the web app
    const vpc = new ec2.Vpc(this, 'WebAppVpc', {
      maxAzs: 2,
      natGateways: 1,
    });

    // Create ECS Cluster
    const cluster = new ecs.Cluster(this, 'WebAppCluster', {
      vpc: vpc,
      clusterName: 'dq-web-app-cluster',
      containerInsights: true,
    });

    // Create log group
    const logGroup = new logs.LogGroup(this, 'WebAppLogGroup', {
      logGroupName: '/ecs/dq-web-app',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create Fargate service with Application Load Balancer (HTTP first, then add HTTPS)
    const fargateService = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'WebAppService', {
      cluster: cluster,
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
          AGENT_ENDPOINT_URL: props.agentEndpointUrl || '',
          COGNITO_CLIENT_ID: props.cognitoClientId || '',
          COGNITO_CLIENT_SECRET: props.cognitoClientSecret || '',
          COGNITO_DOMAIN: props.cognitoDomain || '',
          COGNITO_USER_POOL_ID: props.cognitoUserPoolId || '',
          AWS_REGION: props.env?.region || 'us-east-1',
          PORT: '8001',
          ENVIRONMENT: 'production',
          // Dynamic URL will be set after ALB creation
        },
        logDriver: ecs.LogDrivers.awsLogs({
          streamPrefix: 'dq-web-app',
          logGroup: logGroup,
        }),
      },
      publicLoadBalancer: true,
      listenerPort: 80,
      healthCheckGracePeriod: cdk.Duration.seconds(300),
    });

    // Add HTTPS listener using new self-signed certificate for ELB domain
    const httpsListener = fargateService.loadBalancer.addListener('HttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [
        elbv2.ListenerCertificate.fromArn('arn:aws:acm:us-east-1:752105949551:certificate/a3a6418e-ddee-45ed-a9db-eb18ca0c2c67')
      ],
      defaultTargetGroups: [fargateService.targetGroup],
    });

    // Configure health check with longer grace period and proper settings
    fargateService.targetGroup.configureHealthCheck({
      path: '/health',
      healthyHttpCodes: '200',
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 10,
      port: '8001',
    });

    // Allow the web app to be accessed from anywhere
    fargateService.service.connections.allowFromAnyIpv4(
      ec2.Port.tcp(8001),
      'Allow HTTP access from anywhere'
    );

    // Update task definition with dynamic URL after ALB is created
    const webAppUrl = `https://${fargateService.loadBalancer.loadBalancerDnsName}`;
    const taskDefinition = fargateService.taskDefinition;
    const container = taskDefinition.defaultContainer;
    
    // Add dynamic environment variables
    container.addEnvironment('WEB_APP_URL', webAppUrl);
    container.addEnvironment('NOTIFY_URL', `${webAppUrl}/api/notify`);

    // Output the web app URL
    new cdk.CfnOutput(this, 'WebAppUrl', {
      value: webAppUrl,
      description: 'URL of the deployed web application',
      exportName: 'DQWebAppUrl',
    });

    // Output for Lambda to use
    new cdk.CfnOutput(this, 'WebAppNotifyUrl', {
      value: `${webAppUrl}/api/notify`,
      description: 'WebSocket notify URL for Lambda to use',
      exportName: 'DQWebAppNotifyUrl',
    });

    // Store the service for potential future use
    this.fargateService = fargateService;
    this.webAppUrl = webAppUrl;
  }
}

module.exports = { WebAppStack };
