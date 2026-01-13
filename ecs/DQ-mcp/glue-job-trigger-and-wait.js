import { z } from 'zod';
import AWS from 'aws-sdk';

const glue = new AWS.Glue();
const lambda = new AWS.Lambda();

const POLLER_LAMBDA_NAME = process.env.POLLER_LAMBDA_NAME || "GlueJobPollerLambda";
const DEFAULT_GLUE_JOB = process.env.GLUE_JOB_NAME || "agent-run-sql-query";

const TOOL = [
  "glue-job-trigger-and-wait",
  "Trigger an AWS Glue job and wait for it to complete, returning the final results.",
  {
    sqlQuery: z.string(),
    arguments: z.record(z.string()).optional(),
    sessionId: z.string().optional(),
    outputS3Path: z.string().optional(),
    maxWaitMinutes: z.number().optional().default(10)
  },
  async ({ sqlQuery, arguments: jobArgs, sessionId, outputS3Path, maxWaitMinutes }, ctx) => {
    try {
      const resolvedJobName = DEFAULT_GLUE_JOB;
      const resolvedSessionId = sessionId || ctx.authInfo?.user_id || "unknown-session";

      // Build arguments object
      const jobArguments = {
        "--sql_query": sqlQuery,
        "--session_id": resolvedSessionId,
        "--output_path": "s3://dq-utlity-ai-durgamj/output/", // Always use the correct bucket
        ...(jobArgs || {})
      };

      const params = {
        JobName: resolvedJobName,
        Arguments: jobArguments
      };

      console.log("Starting Glue job with params:", JSON.stringify(params, null, 2));

      // Start the Glue job
      const response = await glue.startJobRun(params).promise();
      const jobRunId = response.JobRunId;

      console.log(`Glue job ${resolvedJobName} started successfully with JobRunId: ${jobRunId}`);

      // Wait for job completion
      const maxWaitMs = maxWaitMinutes * 60 * 1000;
      const pollIntervalMs = 30000; // Poll every 30 seconds
      const startTime = Date.now();

      let jobStatus = 'RUNNING';
      let jobDetails = null;

      while (Date.now() - startTime < maxWaitMs) {
        try {
          // Check job status
          const statusResponse = await glue.getJobRun({
            JobName: resolvedJobName,
            RunId: jobRunId
          }).promise();

          jobDetails = statusResponse.JobRun;
          jobStatus = jobDetails.JobRunState;

          console.log(`Job status: ${jobStatus}`);

          // Check if job is complete
          if (['SUCCEEDED', 'FAILED', 'STOPPED', 'TIMEOUT'].includes(jobStatus)) {
            break;
          }

          // Wait before next poll
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

        } catch (statusError) {
          console.error("Error checking job status:", statusError);
          // Continue polling in case of temporary errors
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }
      }

      // Handle job completion
      if (jobStatus === 'SUCCEEDED') {
        // Try to fetch results from S3
        let resultPreview = null;
        try {
          const s3 = new AWS.S3();
          const basePath = outputS3Path || 's3://dq-utlity-ai-durgamj/output/';
          const sessionPath = `${basePath.replace(/\/$/, '')}/session_${resolvedSessionId}/`;
          
          // Parse S3 path
          const bucket = sessionPath.replace('s3://', '').split('/')[0];
          const prefix = sessionPath.replace(`s3://${bucket}/`, '');

          // List objects to find the latest results
          const listResponse = await s3.listObjectsV2({
            Bucket: bucket,
            Prefix: prefix,
            Delimiter: '/'
          }).promise();

          if (listResponse.CommonPrefixes && listResponse.CommonPrefixes.length > 0) {
            // Get the latest timestamp folder
            const timestampFolders = listResponse.CommonPrefixes.map(cp => cp.Prefix).sort().reverse();
            const latestFolder = timestampFolders[0];

            // Try to read summary.json
            try {
              const summaryKey = `${latestFolder}summary.json`;
              const summaryResponse = await s3.getObject({
                Bucket: bucket,
                Key: summaryKey
              }).promise();

              const summaryBody = summaryResponse.Body.toString('utf-8');
              const summaryLines = summaryBody.trim().split('\n');
              
              for (const line of summaryLines) {
                if (line.trim()) {
                  const summaryJson = JSON.parse(line);
                  resultPreview = {
                    query: summaryJson.query,
                    rowCount: summaryJson.row_count,
                    columns: summaryJson.columns,
                    outputLocation: summaryJson.output_location,
                    status: summaryJson.status
                  };
                  break;
                }
              }
            } catch (summaryError) {
              console.log("Could not read summary, trying CSV results...");
              
              // Fallback: try to read CSV results
              const resultsPrefix = `${latestFolder}results/`;
              const csvListResponse = await s3.listObjectsV2({
                Bucket: bucket,
                Prefix: resultsPrefix,
                MaxKeys: 1
              }).promise();

              if (csvListResponse.Contents && csvListResponse.Contents.length > 0) {
                const csvKey = csvListResponse.Contents[0].Key;
                const csvResponse = await s3.getObject({
                  Bucket: bucket,
                  Key: csvKey
                }).promise();

                const csvBody = csvResponse.Body.toString('utf-8');
                const csvLines = csvBody.split('\n').slice(0, 6); // First 6 lines (header + 5 data rows)
                
                resultPreview = {
                  query: sqlQuery,
                  preview: csvLines.join('\n'),
                  outputLocation: `s3://${bucket}/${resultsPrefix}`,
                  status: 'SUCCEEDED'
                };
              }
            }
          }
        } catch (s3Error) {
          console.error("Error fetching results from S3:", s3Error);
        }

        return {
          content: [
            {
              type: "text",
              text: `✅ SQL query executed successfully!\n\n` +
                    `📊 **Results:**\n` +
                    `${resultPreview ? 
                      `- Query: ${resultPreview.query}\n` +
                      `- Row Count: ${resultPreview.rowCount || 'N/A'}\n` +
                      `- Columns: ${resultPreview.columns ? resultPreview.columns.join(', ') : 'N/A'}\n` +
                      `- Output Location: ${resultPreview.outputLocation}\n` +
                      (resultPreview.preview ? `\n**Data Preview:**\n\`\`\`\n${resultPreview.preview}\n\`\`\`` : '')
                      : 'Results are being processed and will be available shortly.'}\n\n` +
                    `🕒 **Execution Time:** ${Math.round((Date.now() - startTime) / 1000)} seconds`
            },
            {
              type: "json",
              data: {
                jobName: resolvedJobName,
                runId: jobRunId,
                status: jobStatus,
                executionTimeSeconds: Math.round((Date.now() - startTime) / 1000),
                results: resultPreview,
                sqlQuery: sqlQuery
              }
            }
          ]
        };

      } else if (jobStatus === 'FAILED') {
        const errorMessage = jobDetails?.ErrorMessage || 'Unknown error occurred';
        
        return {
          content: [
            {
              type: "text",
              text: `❌ SQL query execution failed!\n\n` +
                    `**Error:** ${errorMessage}\n\n` +
                    `**Job Details:**\n` +
                    `- Job Name: ${resolvedJobName}\n` +
                    `- Run ID: ${jobRunId}\n` +
                    `- Query: ${sqlQuery}\n\n` +
                    `**Troubleshooting Tips:**\n` +
                    `1. Check if the table/database exists\n` +
                    `2. Verify SQL syntax\n` +
                    `3. Ensure proper permissions\n` +
                    `4. Check if Hudi table metadata is accessible`
            },
            {
              type: "json",
              data: {
                jobName: resolvedJobName,
                runId: jobRunId,
                status: jobStatus,
                error: errorMessage,
                sqlQuery: sqlQuery
              }
            }
          ]
        };

      } else {
        // Job is still running or timed out
        const isTimeout = Date.now() - startTime >= maxWaitMs;
        
        return {
          content: [
            {
              type: "text",
              text: `⏱️ ${isTimeout ? 'Query execution is taking longer than expected' : 'Query is still running'}...\n\n` +
                    `**Status:** ${jobStatus}\n` +
                    `**Job Details:**\n` +
                    `- Job Name: ${resolvedJobName}\n` +
                    `- Run ID: ${jobRunId}\n` +
                    `- Query: ${sqlQuery}\n` +
                    `- Elapsed Time: ${Math.round((Date.now() - startTime) / 1000)} seconds\n\n` +
                    `${isTimeout ? 
                      `The query is still processing in the background. You can check the status later using the job ID: ${jobRunId}` :
                      `Please wait while the query completes...`}`
            },
            {
              type: "json",
              data: {
                jobName: resolvedJobName,
                runId: jobRunId,
                status: jobStatus,
                isTimeout: isTimeout,
                elapsedTimeSeconds: Math.round((Date.now() - startTime) / 1000),
                sqlQuery: sqlQuery
              }
            }
          ]
        };
      }

    } catch (error) {
      console.error("Error in glue-job-trigger-and-wait:", error);
      return {
        content: [
          {
            type: "text",
            text: `❌ Failed to execute SQL query: ${error.message}\n\n` +
                  `**Query:** ${sqlQuery}\n\n` +
                  `Please check the query syntax and try again.`
          }
        ]
      };
    }
  }
];

export default TOOL;
