import { z } from 'zod';
import AWS from 'aws-sdk';

const glue = new AWS.Glue();

const TOOL = [
  "get-glue-job-status",
  "Check the status of an AWS Glue job using JobName and JobRunId.",
  {
    jobName: z.string(),
    jobRunId: z.string()
  },
  async ({ jobName, jobRunId }) => {
    try {
      const params = { JobName: jobName, RunId: jobRunId };
      const response = await glue.getJobRun(params).promise();

      const status = response.JobRun.JobRunState;
      const startedOn = response.JobRun.StartedOn;
      const completedOn = response.JobRun.CompletedOn;
      const errorMsg = response.JobRun.ErrorMessage || null;

      const s3Output = response.JobRun.Arguments
        ? response.JobRun.Arguments["--output_s3_path"] || "N/A"
        : "N/A";

      let textMessage = `🧠 Glue Job: ${jobName}\nRunId: ${jobRunId}\nStatus: ${status}`;
      if (status === "SUCCEEDED") {
        textMessage += `\n✅ Job completed successfully.\nOutput: ${s3Output}`;
      } else if (status === "FAILED") {
        textMessage += `\n❌ Job failed.\nError: ${errorMsg || "Unknown"}`;
      } else {
        textMessage += `\n⏱ Job still in progress...`;
      }

      return {
        content: [
          {
            type: "text",
            text: textMessage
          },
          {
            type: "json",
            data: {
              jobName,
              jobRunId,
              status,
              startedOn,
              completedOn,
              outputPath: s3Output
            }
          }
        ]
      };
    } catch (error) {
      console.error("Error fetching Glue job status:", error);
      return {
        content: [
          {
            type: "text",
            text: `❌ Failed to fetch status for Glue job '${jobName}' (${jobRunId}): ${error.message}`
          }
        ]
      };
    }
  }
];

export default TOOL;
