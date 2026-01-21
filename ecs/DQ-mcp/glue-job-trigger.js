import { z } from 'zod';
import AWS from 'aws-sdk';

const glue = new AWS.Glue();
const lambda = new AWS.Lambda();

const POLLER_LAMBDA_NAME = process.env.POLLER_LAMBDA_NAME || "GlueJobPollerLambda";
const DEFAULT_GLUE_JOB = process.env.GLUE_JOB_NAME || "agent-run-sql-query"; // ✅ configurable fallback
const OUTPUT_DATA_BUCKET = process.env.OUTPUTDATABUCKET;
if (!OUTPUT_DATA_BUCKET) {
  throw new Error("OUTPUTDATABUCKET environment variable is not set");
}

const TOOL = [
  "glue-job-trigger",
  "Trigger an AWS Glue job and start a poller Lambda that monitors completion.",
  {
    jobName: z.string().optional(), // ✅ now optional, since we're overriding
    sqlQuery: z.string(),
    arguments: z.record(z.string()).optional(),
    sessionId: z.string().optional(),
    outputS3Path: z.string().optional()
  },
  async ({ jobName, sqlQuery, arguments: jobArgs, sessionId, outputS3Path }, ctx) => {
    try {
      const resolvedJobName = DEFAULT_GLUE_JOB; // ✅ always use the real Glue job name

      // Build arguments object, only including non-empty values
      const jobArguments = {
        "--sql_query": sqlQuery,
        "--session_id": sessionId || ctx.authInfo?.user_id || "unknown-session",
        "--output_path": `s3://${OUTPUT_DATA_BUCKET}/output/`, // Always use the correct bucket
        ...(jobArgs || {})
      };

      const params = {
        JobName: resolvedJobName,
        Arguments: jobArguments
      };

      console.log("Starting Glue job with params:", JSON.stringify(params, null, 2));

      const response = await glue.startJobRun(params).promise();
      const jobRunId = response.JobRunId;

      console.log(`Glue job ${resolvedJobName} started successfully with JobRunId: ${jobRunId}`);

      // ✅ Invoke the poller Lambda asynchronously with user context and WebSocket URL
      await lambda
        .invoke({
          FunctionName: POLLER_LAMBDA_NAME,
          InvocationType: "Event",
          Payload: JSON.stringify({
            job_name: resolvedJobName,
            run_id: jobRunId,
            session_id: sessionId || ctx.authInfo?.user_id || "unknown-session",
            output_s3_path: outputS3Path || "",
            reinvoke_on_success: true,
            user_context: {
              username: ctx.authInfo?.user_name || "unknown-user",
              user_id: ctx.authInfo?.user_id || "unknown-id"
            },
            websocket_url: process.env.WEB_APP_NOTIFY_URL  // WebSocket URL for notifications
          })
        })
        .promise();

      return {
        content: [
          {
            type: "text",
            text: `🔄 **SQL Query Execution Started**\n\n**Query:** ${sqlQuery}\n**Job ID:** ${jobRunId}\n**Status:** RUNNING\n\n⏳ The query is now executing in AWS Glue and will take several minutes to complete.\n\n**STOP HERE. DO NOT CONTINUE. DO NOT PROVIDE ANY RESULTS, METRICS, OR DATA.**\n\nTell the user: "Your query is running and you'll be automatically notified when results are available."`
          }
        ]
      };
    } catch (error) {
      console.error("Error starting Glue job:", error);
      return {
        content: [
          {
            type: "text",
            text: `❌ Failed to start Glue job '${DEFAULT_GLUE_JOB}': ${error.message}`
          }
        ]
      };
    }
  }
];

export default TOOL;
