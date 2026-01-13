const { Stack } = require('aws-cdk-lib');
const lambda = require('aws-cdk-lib/aws-lambda');
const McpServerConstruct = require('./mcp-server');
const AgentConstruct = require('./agent');
const Cognito = require('./cognito');

// Default architecture (use ARM_64 unless your environment is x86)
const FN_ARCHITECTURE = lambda.Architecture.ARM_64;
const JWT_SIGNATURE_SECRET = 'jwt-signature-secret';

class DQUtilityAIStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // === 1️⃣ Cognito Setup ===
    const { cognitoJwksUrl } = new Cognito(this, 'Cognito');

    // === 2️⃣ MCP Server Setup ===
    const mcpConstruct = new McpServerConstruct(this, 'McpServerConstruct', {
      fnArchitecture: FN_ARCHITECTURE,
      jwtSignatureSecret: JWT_SIGNATURE_SECRET
    });

    this.mcpEndpoint = mcpConstruct.mcpEndpoint;
    this.mcpLambda = mcpConstruct.dqMcpServerFn ;
    this.mcpLambda.addEnvironment('POLLER_LAMBDA_NAME', 'GlueJobPollerLambda');
    // === 3️⃣ Agent Setup ===
    const agentConstruct = new AgentConstruct(this, 'AgentConstruct', {
      fnArchitecture: FN_ARCHITECTURE,
      jwtSignatureSecret: JWT_SIGNATURE_SECRET,
      mcpEndpoint: this.mcpEndpoint,
      cognitoJwksUrl
    });

    this.agentLambda = agentConstruct.dqAgentFn ;

    // ✅ Now both Lambdas (MCP + Agent) are available as properties
    //    You can reference them from app.js or other stacks.
  }
}

module.exports = { DQUtilityAIStack };
