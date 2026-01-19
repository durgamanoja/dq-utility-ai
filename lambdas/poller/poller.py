import boto3
import json
import os
import time
import logging
import requests
from botocore.exceptions import ClientError


glue = boto3.client('glue')
s3 = boto3.client('s3')

# --- Configurable ---
AGENT_ECS_URL = os.environ.get('AGENT_ECS_URL', 'http://internal-DQUtilityAI-ECS-ALB-1234567890.us-east-1.elb.amazonaws.com')
POLL_INTERVAL = int(os.environ.get('POLL_INTERVAL_SECONDS', '60'))
MAX_POLL_HOURS = int(os.environ.get('MAX_POLL_HOURS', '6'))  # Safety cutoff
BUCKETNAME = os.environ.get('BUCKETNAME',None) 
# --- Logging setup ---
logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
logger = logging.getLogger()

def handler(event, context):
    """
    Expected input:
    {
        "job_name": "string",
        "run_id": "string",
        "session_id": "string",
        "output_s3_path": "string",
        "reinvoke_on_success": true
    }
    """
    if not BUCKETNAME:
        logger.error("BUCKETNAME environment variable is not set")
        return {
            "status": "error",
            "reason": "BUCKETNAME not configured"
        }
    job_name = event.get('job_name')
    run_id = event.get('run_id')
    session_id = event.get('session_id', 'unknown-session')
    output_s3_path = event.get('output_s3_path', '')
    reinvoke = event.get('reinvoke_on_success', True)
    user_context = event.get('user_context', {})  # 👈 optional: pass through user info



    if not job_name or not run_id:
        logger.error("Missing required fields: job_name or run_id")
        return {"status": "error", "reason": "Missing job_name or run_id"}

    logger.info(f"🔁 Starting poller for Glue job: {job_name} (RunId: {run_id})")

    state = "RUNNING"
    start_time = time.time()

    # --- Poll until job completes or timeout ---
    poll_count = 0
    while True:
        try:
            response = glue.get_job_run(JobName=job_name, RunId=run_id)
            state = response['JobRun']['JobRunState']
            poll_count += 1
            elapsed_minutes = (time.time() - start_time) / 60
            
            logger.info(f"Glue job state = {state} (poll #{poll_count}, {elapsed_minutes:.1f}m elapsed)")

            # Send intermediate status updates to user
            if reinvoke and poll_count % 3 == 0:  # Every 3rd poll (every ~3 minutes)
                try:
                    progress_payload = {
                        "type": "glue_job_progress",
                        "event_source": "poller_lambda",
                        "session_id": session_id,
                        "glue_job_name": job_name,
                        "glue_run_id": run_id,
                        "status": state,
                        "progress_message": f"Job is {state.lower()}... (running for {elapsed_minutes:.1f} minutes)",
                        "user_context": user_context,
                        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                        "websocket_url": event.get('websocket_url')
                    }
                    
                    # Send progress update to ECS agent
                    agent_url = f"{AGENT_ECS_URL.rstrip('/')}/system/glue-progress"
                    progress_response = requests.post(
                        agent_url,
                        json=progress_payload,
                        timeout=10,
                        headers={'Content-Type': 'application/json'}
                    )
                    
                    if progress_response.status_code == 200:
                        logger.info(f"📊 Sent progress update #{poll_count} to user (session={session_id}, status={state})")
                    else:
                        logger.warning(f"Progress update failed: {progress_response.status_code}")
                        
                except Exception as progress_error:
                    logger.warning(f"Failed to send progress update: {progress_error}")

            if state in ['SUCCEEDED', 'FAILED', 'STOPPED', 'TIMEOUT']:
                break

        except ClientError as e:
            logger.warning(f"Error getting job status: {e.response['Error']['Message']}")
        
        # Timeout safeguard
        elapsed_hours = (time.time() - start_time) / 3600
        if elapsed_hours > MAX_POLL_HOURS:
            logger.error(f"Max polling duration ({MAX_POLL_HOURS}h) exceeded — exiting.")
            state = "TIMEOUT"
            break

        time.sleep(POLL_INTERVAL)

    logger.info(f"✅ Glue job '{job_name}' completed with status: {state}")

    # --- Fetch output preview from actual Glue job results ---
    result_preview = None
    actual_output_location = None
    
    if state == 'SUCCEEDED':
        try:
            # Construct the expected output path based on Glue job pattern
            base_path = f"s3://{BUCKETNAME}/output/"  # Always use the correct bucket
            session_path = f"{base_path.rstrip('/')}/session_{session_id}/"
            
            logger.info(f"Looking for Glue job results in: {session_path}")
            
            # Parse S3 path to get bucket and prefix
            bucket, prefix = parse_s3_uri(session_path)
            
            # List objects to find the latest timestamp folder
            response = s3.list_objects_v2(
                Bucket=bucket,
                Prefix=prefix,
                Delimiter='/'
            )
            
            if 'CommonPrefixes' in response:
                # Get the latest timestamp folder (they're sortable by name)
                timestamp_folders = [cp['Prefix'] for cp in response['CommonPrefixes']]
                timestamp_folders.sort(reverse=True)  # Latest first
                
                if timestamp_folders:
                    latest_folder = timestamp_folders[0]
                    logger.info(f"Found latest results folder: {latest_folder}")
                    
                    # Try to read the summary.json first (contains execution details)
                    summary_key = f"{latest_folder}summary.json"
                    try:
                        logger.info(f"Attempting to read summary from: s3://{bucket}/{summary_key}")
                        summary_data = s3.get_object(Bucket=bucket, Key=summary_key)
                        summary_body = summary_data['Body'].read().decode('utf-8')
                        
                        # Parse the JSON to extract useful information
                        summary_lines = summary_body.strip().split('\n')
                        for line in summary_lines:
                            if line.strip():
                                summary_json = json.loads(line)
                                result_preview = f"SQL Query: {summary_json.get('query', 'N/A')}\n"
                                result_preview += f"Row Count: {summary_json.get('row_count', 'N/A')}\n"
                                result_preview += f"Status: {summary_json.get('status', 'N/A')}\n"
                                result_preview += f"Columns: {', '.join(summary_json.get('columns', []))}\n"
                                actual_output_location = summary_json.get('output_location', '')
                                break
                        
                        logger.info("Successfully read execution summary")
                        
                    except Exception as summary_error:
                        logger.warning(f"Could not read summary.json: {str(summary_error)}")
                        
                        # Fallback: try to read CSV results directly
                        results_prefix = f"{latest_folder}results/"
                        try:
                            logger.info(f"Attempting to read CSV results from: s3://{bucket}/{results_prefix}")
                            csv_response = s3.list_objects_v2(
                                Bucket=bucket,
                                Prefix=results_prefix,
                                MaxKeys=1
                            )
                            
                            if 'Contents' in csv_response and csv_response['Contents']:
                                csv_key = csv_response['Contents'][0]['Key']
                                csv_data = s3.get_object(Bucket=bucket, Key=csv_key)
                                csv_body = csv_data['Body'].read().decode('utf-8')
                                
                                # Get first few lines of CSV for preview
                                csv_lines = csv_body.split('\n')[:5]  # First 5 lines
                                result_preview = f"CSV Results Preview:\n" + '\n'.join(csv_lines)
                                actual_output_location = f"s3://{bucket}/{results_prefix}"
                                
                                logger.info("Successfully read CSV results preview")
                            else:
                                logger.warning("No CSV files found in results folder")
                                
                        except Exception as csv_error:
                            logger.warning(f"Could not read CSV results: {str(csv_error)}")
                else:
                    logger.warning(f"No timestamp folders found in {session_path}")
            else:
                logger.warning(f"No results found for session {session_id} in {session_path}")
                
        except Exception as e:
            logger.warning(f"Error fetching Glue job results: {str(e)}")


    # --- Notify Agent ECS Service ---
    if reinvoke:
        try:
            # Enhanced payload with better formatting for streaming experience
            payload = {
                "type": "glue_job_result",
                "event_source": "poller_lambda",
                "session_id": session_id,
                "glue_job_name": job_name,
                "glue_run_id": run_id,
                "status": state,
                "output_s3_path": actual_output_location or output_s3_path,  # Use actual location if available
                "result_preview": result_preview,
                "user_context": user_context,
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "execution_duration": f"{(time.time() - start_time):.1f} seconds",
                "websocket_url": event.get('websocket_url')  # WebSocket URL for notifications (if provided)
            }

            # Log the notification being sent
            if state == "SUCCEEDED":
                logger.info(f"🎉 Job completed successfully! Notifying ECS Agent for session {session_id}")
            elif state == "FAILED":
                logger.info(f"❌ Job failed! Notifying ECS Agent with error details for session {session_id}")
            else:
                logger.info(f"⚠️ Job completed with status {state}! Notifying ECS Agent for session {session_id}")

            # Send HTTP POST request to ECS agent
            agent_url = f"{AGENT_ECS_URL.rstrip('/')}/system/glue-result"
            response = requests.post(
                agent_url,
                json=payload,
                timeout=30,
                headers={'Content-Type': 'application/json'}
            )
            
            if response.status_code == 200:
                logger.info(f"📨 Successfully notified ECS Agent at '{agent_url}' (session={session_id}, status={state})")
            else:
                logger.warning(f"⚠️ ECS Agent responded with status {response.status_code}: {response.text}")

        except Exception as e:
            logger.error(f"❌ Failed to notify ECS Agent: {str(e)}")

    return {
    "status": state,
    "session_id": session_id,
    "job_name": job_name,
    "run_id": run_id,
    "output_s3_path": output_s3_path
    }

# --- Helper ---
def parse_s3_uri(uri: str):
    """Convert s3://bucket/key into (bucket, key)"""
    if not uri.startswith("s3://"):
        raise ValueError(f"Invalid S3 URI: {uri}")
    parts = uri.replace("s3://", "").split("/", 1)
    bucket = parts[0]
    key = parts[1] if len(parts) > 1 else ""
    return bucket, key
