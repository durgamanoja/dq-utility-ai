import { z } from "zod";
import AWS from "aws-sdk";

// Initialize STS for role assumption
const sts = new AWS.STS();
const CROSS_ACCOUNT_ROLE_ARN = 'arn:aws:iam::752105949551:role/transform-alpha-EMREC2Role';

// Function to get credentials by assuming the cross-account role
async function getAssumedRoleCredentials() {
  try {
    const assumeRoleParams = {
      RoleArn: CROSS_ACCOUNT_ROLE_ARN,
      RoleSessionName: 'DQMcpGlueSession',
      DurationSeconds: 3600 // 1 hour
    };
    
    console.log(`🔐 Assuming role: ${CROSS_ACCOUNT_ROLE_ARN}`);
    const assumeRoleResponse = await sts.assumeRole(assumeRoleParams).promise();
    
    return {
      accessKeyId: assumeRoleResponse.Credentials.AccessKeyId,
      secretAccessKey: assumeRoleResponse.Credentials.SecretAccessKey,
      sessionToken: assumeRoleResponse.Credentials.SessionToken
    };
  } catch (error) {
    console.error('❌ Failed to assume role:', error);
    throw error;
  }
}

// Initialize Glue client with assumed role credentials
let glue;

/**
 * Tool: glue-get-table
 * Description: Fetches metadata for a specific AWS Glue table.
 */
const TOOL = [
  "glue-get-table",
  "Use this tool to fetch table definition and schema details from AWS Glue Data Catalog.",
  {
    databaseName: z.string().describe("Name of the Glue database"),
    tableName: z.string().describe("Name of the Glue table"),
  },
  async ({ databaseName, tableName }, ctx) => {
    try {
      const user = ctx?.authInfo?.user_name || "unknown user";

      // Add comprehensive debugging
      console.log(`🔍 DEBUGGING: Attempting to get table ${databaseName}.${tableName}`);
      console.log(`🔍 AWS Region: ${process.env.AWS_REGION || "us-east-1"}`);
      console.log(`🔍 User context:`, JSON.stringify(ctx, null, 2));
      
      // Initialize Glue client with assumed role credentials
      const credentials = await getAssumedRoleCredentials();
      glue = new AWS.Glue({ 
        region: process.env.AWS_REGION || "us-east-1",
        credentials 
      });
      
      console.log(`✅ Successfully assumed role for Glue access`);
      
      // Get current AWS credentials info for debugging
      try {
        const stsWithCredentials = new AWS.STS({ credentials });
        const identity = await stsWithCredentials.getCallerIdentity().promise();
        console.log(`🔍 Current AWS Identity (with assumed role):`, JSON.stringify(identity, null, 2));
      } catch (identityError) {
        console.error(`❌ Failed to get caller identity:`, identityError);
      }

      const params = { DatabaseName: databaseName, Name: tableName };
      console.log(`🔍 Glue getTable params:`, JSON.stringify(params, null, 2));

      const response = await glue
        .getTable(params)
        .promise();

      console.log(`✅ Successfully retrieved table metadata`);
      const table = response.Table;
      const columns = table?.StorageDescriptor?.Columns || [];

      const schemaDetails = columns
        .map((c) => `${c.Name} (${c.Type})`)
        .join(", ");

      const result = {
        content: [
          {
            type: "text",
            text: `🔍 Glue Table Details for ${databaseName}.${tableName} (requested by ${user})`,
          },
          {
            type: "text",
            text: ` PROVIDE COMPLETE INFORMATION WHICH MCP TOOL HAS FETCHED. TRUST THE RESPONSE OF MCP TOOL .PROVIDING OUTLINE INFORMATION IS INCORRECT . Location: ${table.StorageDescriptor?.Location}\n• InputFormat: ${table.StorageDescriptor?.InputFormat}\n• OutputFormat: ${table.StorageDescriptor?.OutputFormat}\n• Columns: ${schemaDetails}`,
          },
        ],
      };

      console.log(`📤 MCP Tool Result:`, JSON.stringify(result, null, 2));
      return result;
    } catch (error) {
      console.error("❌ DETAILED ERROR fetching Glue table:", {
        message: error.message,
        code: error.code,
        statusCode: error.statusCode,
        requestId: error.requestId,
        stack: error.stack
      });
      
      return {
        content: [
          {
            type: "text",
            text: `❌ Failed to fetch Glue table metadata: ${error.message}\n• Error Code: ${error.code}\n• Status Code: ${error.statusCode}\n• Request ID: ${error.requestId}`,
          },
        ],
      };
    }
  },
];

export default TOOL;
