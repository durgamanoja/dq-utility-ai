const ecs = require('aws-cdk-lib/aws-ecs');
const ecsPatterns = require('aws-cdk-lib/aws-ecs-patterns');
const ec2 = require('aws-cdk-lib/aws-ec2');
const iam = require('aws-cdk-lib/aws-iam');
const logs = require('aws-cdk-lib/aws-logs');
const { Duration, RemovalPolicy, CfnOutput } = require('aws-cdk-lib');
const { Construct } = require('constructs');
const path = require('path');
const s3 = require('aws-cdk-lib/aws-s3');
const cdk = require('aws-cdk-lib');

class EcsMcpServerConstruct extends Construct {
    constructor(scope, id, props) {
        super(scope, id, props);

        // Use shared VPC (passed from main stack)
        const vpc = props.vpc;
        if (!vpc) {
            throw new Error('MCP Server requires a shared VPC to be passed via props.vpc');
        }

        // Create ECS Cluster
        const cluster = new ecs.Cluster(this, 'DQMcpCluster', {
            clusterName: 'dq-mcp-cluster',
            vpc: vpc,
            containerInsights: true
        });

        // Create log group
        const logGroup = new logs.LogGroup(this, 'DQMcpLogGroup', {
            logGroupName: '/ecs/dq-mcp-server',
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: RemovalPolicy.DESTROY
        });
        
        const dataBucket = new s3.Bucket(this, 'DQMcpDataBucket', {
          bucketName: `dq-utility-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`,
          removalPolicy: RemovalPolicy.RETAIN, // or DESTROY for non-prod
          autoDeleteObjects: false,
        });
        
        // Create Task Role (for the container to access AWS services)
        const taskRole = new iam.Role(this, 'DQMcpTaskRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            description: 'Role for DQ MCP Server ECS Task'
        });

        
        // Add permissions for ECS MCP server
        taskRole.addToPolicy(new iam.PolicyStatement({
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
        taskRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                "lakeformation:GetDataAccess"
            ],
            resources: ["*"],
            conditions: {
                StringEquals: {
                    "lakeformation:DataAccessRole": taskRole.roleArn
                }
            }
        }));

        taskRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                "glue:StartJobRun",
                "glue:GetJobRun",
                "glue:GetJobRuns",
                "glue:BatchStopJobRun"
            ],
            resources: ["*"]
        }));

        dataBucket.grantReadWrite(taskRole);
        
        // Add comprehensive S3 permissions for data access and file operations
        taskRole.addToPolicy(new iam.PolicyStatement({
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
        taskRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                "s3:GetObject",
                "s3:GetObjectVersion",
                "s3:ListBucket",
                "s3:GetBucketLocation",
                "s3:ListBucketVersions"
            ],
            resources: [
                "arn:aws:s3:::transform-xx",
                "arn:aws:s3:::transform-xx*"
            ],
            conditions: {
                Bool: {
                    'aws:SecureTransport': 'true'  // Ensure HTTPS/TLS is used
                }
            }
        }));

        // Add permissions for the actual table data bucket (without secure transport requirement for compatibility)
        taskRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                "s3:GetObject",
                "s3:GetObjectVersion", 
                "s3:ListBucket",
                "s3:GetBucketLocation",
                "s3:ListBucketVersions"
            ],
            resources: [
                "arn:aws:s3:::transform-xx",
                "arn:aws:s3:::transform-xx/*"
            ]
        }));

        // Add Lambda invoke permissions for calling Poller Lambda
        taskRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                "lambda:InvokeFunction"
            ],
            resources: ["*"]
        }));

        // Add minimal Athena permissions (data access handled by workgroup service role)
        taskRole.addToPolicy(new iam.PolicyStatement({
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

        // Add permission to assume the existing working role for cross-account table access
        taskRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                "sts:AssumeRole"
            ],
            resources: [
                <existing role which has permissions to my database> // In the interest of time i have used an existing role instead of granting permissions all over again 
            ]
        }));

        // Create Fargate service with Application Load Balancer (same pattern as WebSocket)
        const fargateService = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'DQMcpService', {
            cluster: cluster,
            memoryLimitMiB: 1024,
            cpu: 512,
            desiredCount: 1,
            platformVersion: ecs.FargatePlatformVersion.LATEST,
            runtimePlatform: {
                cpuArchitecture: ecs.CpuArchitecture.X86_64, // Match working WebSocket ECS
                operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
            },
            taskImageOptions: {
                image: ecs.ContainerImage.fromAsset(path.join(__dirname, '../ecs/DQ-mcp'), {
                    platform: 'linux/amd64', // Match working WebSocket ECS
                }),
                containerPort: 3001,
                environment: {
                    JWT_SIGNATURE_SECRET: props.jwtSignatureSecret,
                    PORT: '3001',
                    POLLER_LAMBDA_NAME: 'GlueJobPollerLambda',
                    ATHENA_OUTPUT_LOCATION: `s3://${dataBucket.bucketName}/athena-results/`,
                    ATHENA_WORKGROUP: 'dq-agent-workgroup',
                    WEB_APP_NOTIFY_URL: props.webAppNotifyUrl, // 🔥 CRITICAL FIX: WebSocket URL for notifications
                    DEPLOYMENT_VERSION: '2025-12-30-ecs-pattern-v1'
                },
                taskRole: taskRole,
                logDriver: ecs.LogDrivers.awsLogs({
                    streamPrefix: 'dq-mcp-server',
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
            port: '3001',
        });

        // Configure load balancer for long-running Athena queries (15 minutes)
        fargateService.loadBalancer.setAttribute('idle_timeout.timeout_seconds', '900');
        
        // Configure target group deregistration delay for graceful shutdowns
        fargateService.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '300');

        // Auto Scaling Configuration
        const scaling = fargateService.service.autoScaleTaskCount({
            minCapacity: 1,
            maxCapacity: 5
        });

        // Scale based on CPU utilization
        scaling.scaleOnCpuUtilization('CpuScaling', {
            targetUtilizationPercent: 70,
            scaleInCooldown: Duration.seconds(300),
            scaleOutCooldown: Duration.seconds(60)
        });

        // Outputs
        new CfnOutput(this, 'McpALBUrl', {
            value: `http://${fargateService.loadBalancer.loadBalancerDnsName}`,
            description: 'DQ MCP Server ALB URL (replaces API Gateway)',
            exportName: 'DQMcpALBUrl'
        });

        new CfnOutput(this, 'McpEndpointUrl', {
            value: `http://${fargateService.loadBalancer.loadBalancerDnsName}/mcp`,
            description: 'DQ MCP Server endpoint URL',
            exportName: 'DQMcpEndpointUrl'
        });

        new CfnOutput(this, 'McpEcsClusterName', {
            value: cluster.clusterName,
            description: 'MCP ECS Cluster name',
            exportName: 'DQMcpEcsCluster'
        });

        new CfnOutput(this, 'McpEcsServiceName', {
            value: fargateService.service.serviceName,
            description: 'MCP ECS Service name',
            exportName: 'DQMcpEcsService'
        });

        // Expose properties for other constructs
        this.fargateService = fargateService;
        this.cluster = cluster;
        this.taskRole = taskRole;
        this.mcpEndpoint = `http://${fargateService.loadBalancer.loadBalancerDnsName}/mcp`;
        this.dataBucket = dataBucket;
        this.dataBucketName = dataBucket.bucketName;
    }
}

module.exports = EcsMcpServerConstruct;
