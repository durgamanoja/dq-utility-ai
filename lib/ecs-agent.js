const ecs = require('aws-cdk-lib/aws-ecs');
const ecsPatterns = require('aws-cdk-lib/aws-ecs-patterns');
const ec2 = require('aws-cdk-lib/aws-ec2');
const iam = require('aws-cdk-lib/aws-iam');
const logs = require('aws-cdk-lib/aws-logs');
const { Duration, RemovalPolicy, CfnOutput } = require('aws-cdk-lib');
const { Construct } = require('constructs');
const path = require('path');

class EcsAgentConstruct extends Construct {
    constructor(scope, id, props) {
        super(scope, id, props);

        // Create or reuse VPC with NAT Gateway (shared across all ECS services)
        const vpc = props.vpc || new ec2.Vpc(this, 'DQSharedVpc', {
            maxAzs: 2,
            natGateways: 1, // Required for private subnets to access ECR
        });

        // Create ECS Cluster
        const cluster = new ecs.Cluster(this, 'DQAgentCluster', {
            vpc: vpc,
            clusterName: 'dq-agent-cluster',
            containerInsights: true,
        });

        // Create log group
        const logGroup = new logs.LogGroup(this, 'DQAgentLogGroup', {
            logGroupName: '/ecs/dq-agent',
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: RemovalPolicy.DESTROY,
        });

        // Create Task Role (for the container to access AWS services)
        const taskRole = new iam.Role(this, 'DQAgentTaskRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            description: 'Role for DQ Agent ECS Task'
        });

        // Add Bedrock permissions
        taskRole.addToPolicy(new iam.PolicyStatement({
            actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
            resources: ['*'],
        }));

        // ECS Agent doesn't need Lambda invoke permissions - removed legacy Lambda permission

        // Grant S3 access to session store bucket
        props.sessionStoreBucket.grantReadWrite(taskRole);

        // Create Fargate service with Application Load Balancer (same pattern as WebSocket)
        const fargateService = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'DQAgentService', {
            cluster: cluster,
            memoryLimitMiB: 2048,
            cpu: 1024,
            desiredCount: 1,
            platformVersion: ecs.FargatePlatformVersion.LATEST,
            runtimePlatform: {
                cpuArchitecture: ecs.CpuArchitecture.X86_64, // Match working WebSocket ECS
                operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
            },
            taskImageOptions: {
                image: ecs.ContainerImage.fromAsset(path.join(__dirname, '../ecs/DQ-agent'), {
                    platform: 'linux/amd64', // Match working WebSocket ECS
                }),
                containerPort: 8000,
                environment: {
                    MCP_ENDPOINT: props.mcpEndpoint,
                    JWT_SIGNATURE_SECRET: props.jwtSignatureSecret,
                    SESSION_STORE_BUCKET_NAME: props.sessionStoreBucket.bucketName,
                    COGNITO_JWKS_URL: props.cognitoJwksUrl,
                    AGENT_LAMBDA_NAME: 'DQ-agent-on-lambda', // used by poller lambda (legacy reference)
                    WEB_APP_NOTIFY_URL: props.webAppNotifyUrl,
                    CACHE_TTL_HOURS: '1', // Cache job results for 24 hours by default
                    DEPLOYMENT_VERSION: '2025-12-30-ecs-pattern-v1'
                },
                taskRole: taskRole,
                logDriver: ecs.LogDrivers.awsLogs({
                    streamPrefix: 'dq-agent',
                    logGroup: logGroup,
                }),
            },
            publicLoadBalancer: true,
            listenerPort: 80,
            healthCheckGracePeriod: Duration.seconds(300),
        });

        // Configure health check
        fargateService.targetGroup.configureHealthCheck({
            path: '/health',
            healthyHttpCodes: '200',
            interval: Duration.seconds(30),
            timeout: Duration.seconds(10),
            healthyThresholdCount: 2,
            unhealthyThresholdCount: 5,
            port: '8000',
        });

        // Auto Scaling Configuration
        const scaling = fargateService.service.autoScaleTaskCount({
            minCapacity: 1,
            maxCapacity: 10
        });

        // Scale based on CPU utilization
        scaling.scaleOnCpuUtilization('CpuScaling', {
            targetUtilizationPercent: 70,
            scaleInCooldown: Duration.seconds(300),
            scaleOutCooldown: Duration.seconds(60)
        });

        // Outputs
        new CfnOutput(this, 'AgentALBUrl', {
            value: `http://${fargateService.loadBalancer.loadBalancerDnsName}`,
            description: 'DQ Agent ALB URL (replaces API Gateway)',
            exportName: 'DQAgentALBUrl'
        });

        new CfnOutput(this, 'AgentEcsClusterName', {
            value: cluster.clusterName,
            description: 'Agent ECS Cluster name',
            exportName: 'DQAgentEcsCluster'
        });

        new CfnOutput(this, 'AgentEcsServiceName', {
            value: fargateService.service.serviceName,
            description: 'Agent ECS Service name',
            exportName: 'DQAgentEcsService'
        });

        // Expose properties for other constructs
        this.fargateService = fargateService;
        this.cluster = cluster;
        this.taskRole = taskRole;
        this.agentEndpoint = `http://${fargateService.loadBalancer.loadBalancerDnsName}`;
    }
}

module.exports = EcsAgentConstruct;
