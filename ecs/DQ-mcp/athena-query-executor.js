import { z } from 'zod';
import AWS from 'aws-sdk';

// Initialize STS for role assumption
const sts = new AWS.STS();
const CROSS_ACCOUNT_ROLE_ARN = 'arn:aws:iam::752105949551:role/transform-alpha-EMREC2Role';

// Function to get credentials by assuming the cross-account role
async function getAssumedRoleCredentials() {
  try {
    const assumeRoleParams = {
      RoleArn: CROSS_ACCOUNT_ROLE_ARN,
      RoleSessionName: 'DQMcpAthenaSession',
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

// Initialize AWS clients with assumed role credentials
let athena, s3;

const ATHENA_DATABASE = process.env.ATHENA_DATABASE || 'ap_datamart';
const ATHENA_OUTPUT_LOCATION = process.env.ATHENA_OUTPUT_LOCATION || 's3://dq-utlity-ai-durgamj/athena-results/';
const ATHENA_WORKGROUP = process.env.ATHENA_WORKGROUP || 'dq-agent-workgroup'; // ✅ Use our workgroup with service role

const TOOL = [
  "athena-query-executor",
  "Execute SQL queries using Amazon Athena for fast results (alternative to slow Glue jobs).",
  {
    sqlQuery: z.string(),
    database: z.string().optional(),
    sessionId: z.string().optional(),
    maxResults: z.number().optional().default(1000)
  },
  async ({ sqlQuery, database, sessionId, maxResults }, ctx) => {
    try {
      const resolvedDatabase = database || ATHENA_DATABASE;
      const resolvedSessionId = sessionId || ctx.authInfo?.user_id || "unknown-session";
      
      console.log(`🚀 Executing Athena query: ${sqlQuery}`);
      console.log(`Database: ${resolvedDatabase}, Session: ${resolvedSessionId}`);

      // Initialize AWS clients with assumed role credentials
      const credentials = await getAssumedRoleCredentials();
      athena = new AWS.Athena({ credentials });
      s3 = new AWS.S3({ credentials });
      
      console.log(`✅ Successfully assumed role for Athena access`);

      // Start query execution
      const queryParams = {
        QueryString: sqlQuery,
        QueryExecutionContext: {
          Database: resolvedDatabase
        },
        ResultConfiguration: {
          OutputLocation: `${ATHENA_OUTPUT_LOCATION}session_${resolvedSessionId}/`
        },
        WorkGroup: ATHENA_WORKGROUP
      };

      const startResponse = await athena.startQueryExecution(queryParams).promise();
      const queryExecutionId = startResponse.QueryExecutionId;
      
      console.log(`Query started with execution ID: ${queryExecutionId}`);

      // Poll for completion (Athena is much faster than Glue)
      let queryStatus = 'RUNNING';
      let attempts = 0;
      const maxAttempts = 60; // 5 minutes max (much faster than Glue's 15 minutes)
      
      while (queryStatus === 'RUNNING' || queryStatus === 'QUEUED') {
        if (attempts >= maxAttempts) {
          throw new Error(`Query timeout after ${maxAttempts * 5} seconds`);
        }
        
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
        
        const statusResponse = await athena.getQueryExecution({
          QueryExecutionId: queryExecutionId
        }).promise();
        
        queryStatus = statusResponse.QueryExecution.Status.State;
        console.log(`Query status: ${queryStatus} (attempt ${attempts + 1})`);
        attempts++;
      }

      if (queryStatus === 'FAILED' || queryStatus === 'CANCELLED') {
        const errorReason = await athena.getQueryExecution({
          QueryExecutionId: queryExecutionId
        }).promise();
        
        const errorMessage = errorReason.QueryExecution.Status.StateChangeReason;
        
        // Check if this is a cross-catalog reference issue
        if (errorMessage.includes('StorageDescriptor is null') && errorMessage.includes('TargetTable:')) {
          // Extract target table information from error message
          const targetTableMatch = errorMessage.match(/TargetTable: \{[^}]*CatalogId: ([^,]+),[^}]*DatabaseName: ([^,]+),[^}]*Name: ([^,}]+)/);
          if (targetTableMatch) {
            const targetCatalogId = targetTableMatch[1];
            const targetDatabase = targetTableMatch[2];
            const targetTable = targetTableMatch[3];
            
            console.log(`🔄 Detected cross-catalog reference. Target: ${targetCatalogId}.${targetDatabase}.${targetTable}`);
            
            // First, let's try to understand what's available in the current database
            console.log(`🔍 Investigating available tables in database: ${resolvedDatabase}`);
            
            try {
              // Try to list tables in the current database to see what's actually available
              const showTablesQuery = `SHOW TABLES IN ${resolvedDatabase}`;
              const showTablesParams = {
                ...queryParams,
                QueryString: showTablesQuery
              };
              
              const showTablesResponse = await athena.startQueryExecution(showTablesParams).promise();
              const showTablesExecutionId = showTablesResponse.QueryExecutionId;
              
              // Wait for show tables to complete
              let showTablesStatus = 'RUNNING';
              let showTablesAttempts = 0;
              
              while (showTablesStatus === 'RUNNING' || showTablesStatus === 'QUEUED') {
                if (showTablesAttempts >= 20) break; // Don't wait too long
                
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                const showTablesStatusResponse = await athena.getQueryExecution({
                  QueryExecutionId: showTablesExecutionId
                }).promise();
                
                showTablesStatus = showTablesStatusResponse.QueryExecution.Status.State;
                showTablesAttempts++;
              }
              
              if (showTablesStatus === 'SUCCEEDED') {
                const tablesResults = await athena.getQueryResults({
                  QueryExecutionId: showTablesExecutionId,
                  MaxResults: 100
                }).promise();
                
                const availableTables = tablesResults.ResultSet.Rows.slice(1).map(row => 
                  row.Data[0]?.VarCharValue || ''
                ).filter(table => table.length > 0);
                
                console.log(`📋 Available tables in ${resolvedDatabase}:`, availableTables);
                
                // Check if there's a similar table name
                const similarTables = availableTables.filter(table => 
                  table.toLowerCase().includes('vendor') || 
                  table.toLowerCase().includes('master') ||
                  table.toLowerCase().includes(targetTable.toLowerCase())
                );
                
                if (similarTables.length > 0) {
                  console.log(`🎯 Found similar tables: ${similarTables.join(', ')}`);
                }
              }
            } catch (showTablesError) {
              console.log(`⚠️ Could not list tables: ${showTablesError.message}`);
            }
            
            // Provide a comprehensive error message with suggestions
            const errorDetails = [
              `❌ **Cross-Catalog Table Access Failed**`,
              ``,
              `**Original Table:** \`${sqlQuery.match(/FROM\s+([\w.]+)/i)?.[1] || 'unknown'}\``,
              `**Target Table:** \`${targetCatalogId}.${targetDatabase}.${targetTable}\``,
              ``,
              `**Issues Found:**`,
              `• Catalog '${targetCatalogId}' does not exist in current Athena environment`,
              `• Schema '${targetDatabase}' is not accessible`,
              `• This appears to be a cross-account Lake Formation shared table`,
              ``,
              `**Possible Solutions:**`,
              `1. **Check Lake Formation Permissions**: The table may be shared via Lake Formation but not properly configured`,
              `2. **Verify Cross-Account Access**: Ensure your account has been granted access to the source account's data`,
              `3. **Use Direct Table Access**: Try querying the table directly in the source account`,
              `4. **Check Glue Data Catalog**: The table metadata might need to be synchronized`,
              ``,
              `**Alternative Approach:**`,
              `Try running this query directly in the AWS Athena console to see if it works there, or check if there's an equivalent table in your current database.`
            ].join('\n');
            
            throw new Error(errorDetails);
          } else {
            throw new Error(`Query ${queryStatus}: ${errorMessage}`);
          }
        } else {
          throw new Error(`Query ${queryStatus}: ${errorMessage}`);
        }
      }

      // Get query results
      console.log('Query completed successfully, fetching results...');
      const resultsResponse = await athena.getQueryResults({
        QueryExecutionId: queryExecutionId,
        MaxResults: maxResults
      }).promise();

      // Process results
      const rows = resultsResponse.ResultSet.Rows;
      const columnInfo = resultsResponse.ResultSet.ResultSetMetadata.ColumnInfo;
      
      // Extract column names
      const columns = columnInfo.map(col => col.Name);
      
      // Extract data rows (skip header row)
      const dataRows = rows.slice(1).map(row => 
        row.Data.map(cell => cell.VarCharValue || '')
      );

      // Get execution statistics
      const executionDetails = await athena.getQueryExecution({
        QueryExecutionId: queryExecutionId
      }).promise();
      
      const stats = executionDetails.QueryExecution.Statistics;
      const executionTime = stats.TotalExecutionTimeInMillis || 0;
      const dataScanned = stats.DataScannedInBytes || 0;

      console.log(`✅ Query completed in ${executionTime}ms, scanned ${dataScanned} bytes`);

      // Format results for display
      let resultText = `🎉 **Athena Query Completed Successfully!**\n\n`;
      resultText += `**Execution Time:** ${executionTime}ms (${(executionTime/1000).toFixed(2)}s)\n`;
      resultText += `**Data Scanned:** ${(dataScanned/1024/1024).toFixed(2)} MB\n`;
      resultText += `**Rows Returned:** ${dataRows.length}\n\n`;
      
      if (dataRows.length > 0) {
        resultText += `**Results:**\n`;
        
        // For simple queries like COUNT, show the result directly
        if (columns.length === 1 && dataRows.length === 1) {
          resultText += `${columns[0]}: **${dataRows[0][0]}**\n`;
        } else {
          // For complex queries, show table format
          resultText += `| ${columns.join(' | ')} |\n`;
          resultText += `|${columns.map(() => '---').join('|')}|\n`;
          
          const displayRows = dataRows.slice(0, 10); // Show first 10 rows
          displayRows.forEach(row => {
            resultText += `| ${row.join(' | ')} |\n`;
          });
          
          if (dataRows.length > 10) {
            resultText += `\n... and ${dataRows.length - 10} more rows\n`;
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: resultText
          },
          {
            type: "text", 
            text: `**Query Details:**\n- Query ID: ${queryExecutionId}\n- Database: ${resolvedDatabase}\n- Output Location: ${ATHENA_OUTPUT_LOCATION}session_${resolvedSessionId}/`
          }
        ]
      };

    } catch (error) {
      console.error("❌ Athena query execution failed:", error);
      return {
        content: [
          {
            type: "text",
            text: `❌ **Athena Query Failed**\n\nError: ${error.message}\n\nQuery: ${sqlQuery}`
          }
        ]
      };
    }
  }
];

export default TOOL;
