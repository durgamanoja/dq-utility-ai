from strands import Agent
from strands.session.s3_session_manager import S3SessionManager
import os
import logging
import json
import requests
import urllib3
import boto3
from datetime import datetime
import hashlib

# Disable SSL warnings for self-signed certificates
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
from user import User
import mcp_client_manager
from agent_config import model, system_prompt

l = logging.getLogger(__name__)
l.setLevel(logging.INFO)

SESSION_STORE_BUCKET_NAME = os.environ['SESSION_STORE_BUCKET_NAME']
l.info(f"SESSION_STORE_BUCKET_NAME={SESSION_STORE_BUCKET_NAME}")

# Initialize S3 client for progress tracking
s3_client = boto3.client('s3')


# In-memory cache for completed job results (persists because ECS Agent is always running)
_completed_jobs_cache = {}

# Cache TTL configuration (configurable via environment variable)
CACHE_TTL_HOURS = int(os.environ.get('CACHE_TTL_HOURS', '24'))  # Default 24 hours

def update_task_progress_from_agent(task_id: str, status: str, message: str):
    """Update task progress from agent (only if task_id is provided)"""
    if not task_id:
        return  # Skip if no task_id (synchronous processing)
    
    try:
        # Get existing data
        response = s3_client.get_object(
            Bucket=SESSION_STORE_BUCKET_NAME,
            Key=f"tasks/{task_id}/status.json"
        )
        session_data = json.loads(response['Body'].read())
        
        # Update status
        session_data.update({
            "status": status,
            "progress": message,
            "updated_at": datetime.utcnow().isoformat()
        })
        
        # Save back to S3
        s3_client.put_object(
            Bucket=SESSION_STORE_BUCKET_NAME,
            Key=f"tasks/{task_id}/status.json",
            Body=json.dumps(session_data),
            ContentType='application/json'
        )
        l.info(f"Agent updated task {task_id} progress: {message[:100]}...")
    except Exception as e:
        l.error(f"Failed to update task progress from agent for {task_id}: {e}")

def send_websocket_notification(username: str, message: str, websocket_url: str = None):
    """
    Send a notification to the user via WebSocket
    """
    if not websocket_url:
        # Get from environment variable or use ELB URL
        websocket_url = os.environ.get("WEB_APP_NOTIFY_URL")
    
    try:
        response = requests.post(
            websocket_url,
            json={
                "username": username,
                "message": message
            },
            timeout=5,
            verify=False  # Disable SSL certificate verification for load balancer
        )
        
        if response.status_code == 200:
            l.info(f"WebSocket notification sent successfully to {username}")
            return True
        else:
            l.warning(f"WebSocket notification failed: {response.status_code} - {response.text}")
            return False
            
    except Exception as e:
        l.error(f"Error sending WebSocket notification: {e}")
        return False

def is_cache_entry_expired(job_data: dict) -> bool:
    """
    Check if a cache entry has expired based on TTL.
    Returns True if expired, False if still valid.
    """
    try:
        completion_time_str = job_data.get('completion_time', '')
        if not completion_time_str:
            return True  # No timestamp = expired
        
        completion_time = datetime.fromisoformat(completion_time_str.replace('Z', '+00:00'))
        age_seconds = (datetime.utcnow().replace(tzinfo=completion_time.tzinfo) - completion_time).total_seconds()
        ttl_seconds = CACHE_TTL_HOURS * 3600
        
        return age_seconds > ttl_seconds
    except Exception as e:
        l.warning(f"Error checking cache expiry: {e}")
        return True  # If we can't determine age, consider it expired

def get_cached_job_results(username: str) -> str:
    """
    Check in-memory cache for completed job results for a user.
    Returns formatted results if found, empty string if not.
    Automatically removes expired entries.
    """
    global _completed_jobs_cache
    
    user_key = username.lower()
    if user_key in _completed_jobs_cache:
        job_data = _completed_jobs_cache[user_key]
        
        # Check if entry has expired
        if is_cache_entry_expired(job_data):
            del _completed_jobs_cache[user_key]
            l.info(f"Removed expired cache entry for user: {username}")
            return ""
        
        l.info(f"Found cached job results for user: {username}")
        
        return f"""
CACHED JOB RESULTS AVAILABLE:
- Job: {job_data.get('job_name', 'unknown')}
- Status: {job_data.get('status', 'UNKNOWN')}
- Completed: {job_data.get('completion_time', 'unknown')}
- Results: {job_data.get('results', 'No results available')}
"""
    
    l.info(f"No cached job results found for user: {username}")
    return ""

def prompt(user: User, composite_prompt: str, websocket_url: str = None, task_id: str = None):

    """
    Main agent reasoning function.
    Works for both user prompts (via API Gateway)
    and system reinvocations (via poller lambda).
    Supports progress tracking for async processing.
    """
    import time
    start_time = time.time()

    l.info(f"user.id={user.id}, user.name={user.name}")
    
    # 🔹 Check for cached job results and inject into prompt for status queries
    if isinstance(composite_prompt, str) and any(keyword in composite_prompt.lower() for keyword in ['status', 'done', 'complete', 'finished', 'result', 'update']):
        cached_results = get_cached_job_results(user.name)
        if cached_results:
            composite_prompt = f"{cached_results}\n\nUser Query: {composite_prompt}"
            l.info(f"Injected cached job results into prompt for status query")

    try:
        # 🔹 Session manager setup - CRITICAL: Use unique session per agent creation
        update_task_progress_from_agent(task_id, "PROCESSING", "Setting up agent session...")
        session_start = time.time()
        
        # Fresh session per request to ensure no conversation state interference
        session_manager = S3SessionManager(
            session_id=f"session_for_user_{user.id}",
            bucket=SESSION_STORE_BUCKET_NAME,
            prefix="agent_sessions"
        )
        l.info(f"Session manager setup took {time.time() - session_start:.2f}s")

        # 🔹 Handle structured system events from poller
        update_task_progress_from_agent(task_id, "PROCESSING", "Processing your request...")
        prompt_processing_start = time.time()
        is_glue_result = False
        if isinstance(composite_prompt, dict):
            if composite_prompt.get("type") == "glue_job_result":
                is_glue_result = True
                original_event = composite_prompt.copy()  # Keep original for WebSocket notification
                composite_prompt = build_prompt_from_glue_event(composite_prompt)
            else:
                composite_prompt = json.dumps(composite_prompt)
        l.info(f"Prompt processing took {time.time() - prompt_processing_start:.2f}s")

        l.info(f"🧠 Final composite_prompt: {str(composite_prompt)[:300]}")
        
        # 🔹 MCP tools initialization
        update_task_progress_from_agent(task_id, "PROCESSING", "Initializing data tools and connections...")
        mcp_start = time.time()
        mcp_tools = mcp_client_manager.get_mcp_tools_for_user(user)
        l.info(f"MCP tools initialization took {time.time() - mcp_start:.2f}s")
        
        # 🔹 Agent creation - Fresh agent per session
        update_task_progress_from_agent(task_id, "PROCESSING", "Creating fresh AI agent with your tools...")
        agent_creation_start = time.time()
        
        # ALWAYS create a new Agent per session
        agent = Agent(
            model=model,
            agent_id="DQ_agent",
            session_manager=session_manager,
            system_prompt=system_prompt,
            callback_handler=None,
            tools=mcp_tools,
        )
            
        l.info(f"Agent creation took {time.time() - agent_creation_start:.2f}s")
        
        # 🔹 Agent execution (this is likely the longest part)
        update_task_progress_from_agent(task_id, "PROCESSING", "AI agent is analyzing your request and generating response...")
        agent_execution_start = time.time()
        agent_response = agent(composite_prompt)
        l.info(f"Agent execution took {time.time() - agent_execution_start:.2f}s")
        
        response_text = agent_response.message["content"][0]["text"]
        l.info(f"🤖 Agent Response: {response_text[:500]}...")  # Log first 500 chars of response
        update_task_progress_from_agent(task_id, "PROCESSING", "Finalizing response...")
        
        # 🔹 Send WebSocket notification for Glue job results AND store in session
        if is_glue_result and websocket_url:
            websocket_start = time.time()
            l.info(f"Sending WebSocket notification to user: {user.name}")
            
            # 🔥 CRITICAL FIX: Store completed job result in in-memory cache
            global _completed_jobs_cache
            try:
                job_result_data = {
                    "type": "completed_glue_job",
                    "job_name": original_event.get("glue_job_name", "unknown"),
                    "run_id": original_event.get("glue_run_id", ""),
                    "status": original_event.get("status", "UNKNOWN"),
                    "completion_time": datetime.utcnow().isoformat(),
                    "results": response_text,
                    "session_id": original_event.get("session_id", "")
                }
                
                # Store in in-memory cache (persists because ECS Agent is always running)
                _completed_jobs_cache[user.name.lower()] = job_result_data
                l.info(f"Stored completed job result in memory cache for user: {user.name}")
                
            except Exception as e:
                l.error(f"Failed to store job result in cache: {e}")
            
            send_websocket_notification(
                username=user.name,
                message=response_text,
                websocket_url=websocket_url
            )
            l.info(f"WebSocket notification took {time.time() - websocket_start:.2f}s")
        
        total_time = time.time() - start_time
        l.info(f"Total agent processing took {total_time:.2f}s")
        
        return response_text

    except Exception as e:
        total_time = time.time() - start_time
        l.exception(f"Agent execution failed after {total_time:.2f}s")
        return f"Failed to process request: {e}"

def build_prompt_from_glue_event(event: dict):
    """
    Converts a Glue job result payload from the poller Lambda
    into a natural-language reasoning prompt for the model.
    """
    job_name = event.get("glue_job_name", "unknown")
    run_id = event.get("glue_run_id", "")
    status = event.get("status", "UNKNOWN")
    output_path = event.get("output_s3_path", "")
    result_preview = event.get("result_preview", "")
    session_id = event.get("session_id", "")
    timestamp = event.get("timestamp", "")

    if status == "SUCCEEDED":
        return (
            f"🎉 Great news! The SQL query execution completed successfully!\n\n"
            f"📊 **Execution Results:**\n{result_preview}\n\n"
            f"📁 **Data Location:** {output_path}\n\n"
            f"🔍 **Analysis:** Based on these results, provide insights about the data quality, "
            f"any patterns you notice, and suggest next steps or additional queries that might be helpful. "
            f"Be conversational and helpful in explaining what the results mean."
        )
    elif status == "FAILED":
        return (
            f"❌ The SQL query execution encountered an error.\n\n"
            f"🔍 **Error Details:**\n{result_preview}\n\n"
            f"🛠️ **Your task:** Analyze this error and provide:\n"
            f"1. A clear explanation of what went wrong\n"
            f"2. Specific steps to fix the issue\n"
            f"3. Suggestions for alternative approaches\n"
            f"4. Any relevant tips for avoiding similar issues\n\n"
            f"Be helpful and provide actionable guidance to resolve the problem."
        )
    else:
        return (
            f"⚠️ The SQL query execution completed with status: {status}\n\n"
            f"📋 **Details:**\n{result_preview}\n\n"
            f"Please analyze this status and provide appropriate guidance to the user."
        )


if __name__ == "__main__":
    user_id = os.getenv("USER_ID", "system")
    user_name = os.getenv("USER_NAME", "Auto-Agent")
    prompt_text = os.getenv("PROMPT_TEXT", "No prompt received")

    # Allow testing both cases
    try:
        # Check if PROMPT_TEXT is JSON (simulate poller event)
        prompt_data = json.loads(prompt_text)
    except json.JSONDecodeError:
        prompt_data = prompt_text

    user = User(id=user_id, name=user_name)
    print(prompt(user, prompt_data))
