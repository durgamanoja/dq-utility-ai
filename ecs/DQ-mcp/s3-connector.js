import { z } from "zod";
import AWS from "aws-sdk";

// Initialize S3 client — Glue/Strands agent will use IAM credentials automatically
const s3 = new AWS.S3({ region: process.env.AWS_REGION || "us-east-1" });

/**
 * Tool: s3-file-tool
 * Description: Interact with S3 — list, get metadata, read file, or write file.
 */
const TOOL = [
  "s3-file-tool",
  "Use this tool to interact with Amazon S3 — list files under a prefix, get metadata, read text files, or write text content.",
  {
    action: z
      .enum(["list", "get-metadata", "read", "write"])
      .describe("Action to perform: list | get-metadata | read | write"),
    bucket: z.string().describe("Name of the S3 bucket"),
    prefix: z.string().optional().describe("Prefix or folder path (for list action)"),
    key: z.string().optional().describe("Full key of the S3 object (required for read/write/metadata)"),
    content: z.string().optional().describe("Text content to upload (for write action)"),
    maxKeys: z.number().optional().default(10).describe("Max number of objects to list for 'list' action"),
  },
  async ({ action, bucket, prefix, key, content, maxKeys }, ctx) => {
    const user = ctx?.authInfo?.user_name || "unknown user";

    try {
      switch (action) {
        // ---------------- LIST FILES ----------------
        case "list": {
          const response = await s3
            .listObjectsV2({
              Bucket: bucket,
              Prefix: prefix || "",
              MaxKeys: maxKeys || 10,
            })
            .promise();

          const files =
            response.Contents?.map((obj) => `${obj.Key} (${obj.Size} bytes)`).join("\n") ||
            "No files found.";

          return {
            content: [
              {
                type: "text",
                text: `📂 Listed up to ${maxKeys} files from s3://${bucket}/${prefix || ""} (requested by ${user})`,
              },
              {
                type: "text",
                text: files,
              },
            ],
          };
        }

        // ---------------- GET METADATA ----------------
        case "get-metadata": {
          if (!key) throw new Error("For 'get-metadata' action, 'key' parameter is required.");

          const response = await s3.headObject({ Bucket: bucket, Key: key }).promise();

          return {
            content: [
              {
                type: "text",
                text: `📦 Metadata for s3://${bucket}/${key}`,
              },
              {
                type: "text",
                text: JSON.stringify(
                  {
                    Size: response.ContentLength,
                    LastModified: response.LastModified,
                    ContentType: response.ContentType,
                    ETag: response.ETag,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // ---------------- READ FILE ----------------
        case "read": {
          if (!key) throw new Error("For 'read' action, 'key' parameter is required.");

          const response = await s3.getObject({ Bucket: bucket, Key: key }).promise();
          const body = response.Body?.toString("utf-8") ?? "";

          return {
            content: [
              {
                type: "text",
                text: `📝 Content of s3://${bucket}/${key} (${body.length} characters) (requested by ${user})`,
              },
              {
                type: "text",
                text: body || "[Empty file]",
              },
            ],
          };
        }

        // ---------------- WRITE FILE ----------------
        case "write": {
          if (!key) throw new Error("For 'write' action, 'key' parameter is required.");
          if (!content) throw new Error("For 'write' action, 'content' parameter is required.");

          await s3
            .putObject({
              Bucket: bucket,
              Key: key,
              Body: content,
              ContentType: "text/plain",
            })
            .promise();

          return {
            content: [
              {
                type: "text",
                text: `✅ Successfully wrote content to s3://${bucket}/${key} (uploaded by ${user})`,
              },
            ],
          };
        }

        // ---------------- DEFAULT ----------------
        default:
          throw new Error(`Unsupported action: ${action}`);
      }
    } catch (error) {
      console.error("❌ S3 tool error:", error);
      return {
        content: [
          {
            type: "text",
            text: `❌ Failed to perform '${action}' on S3: ${error.message}`,
          },
        ],
      };
    }
  },
];

export default TOOL;
