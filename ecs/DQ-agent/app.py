import logger
import agent
import json
import jwt
import os
import uuid
import boto3
import requests
import urllib3
from datetime import datetime
from user import User
from flask import Flask, request, jsonify

# Disable SSL warnings for self-signed certificates
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

l = logger.get()

# Initialize Flask app for ECS deployment
app = Flask(__name__)

JWT_SIGNATURE_SECRET = os.environ['JWT_SIGNATURE_SECRET'] # Used for signing tokens to MCP Servers
COGNITO_JWKS_URL = os.environ['COGNITO_JWKS_URL']
SESSION_STORE_BUCKET_NAME = os.environ['SESSION_STORE_BUCKET_NAME']
jwks_client = jwt.PyJWKClient(COGNITO_JWKS_URL)

# Initialize AWS clients
s3_client = boto3.client('s3')

def create_task_session(user_id: str, username: str, prompt: str) -> str:
    """Create a unique task session and store initial state in S3"""
    task_id = str(uuid.uuid4())
    session_data = {
        "task_id": task_id,
        "user_id": user_id,
        "username": username,
        "prompt": prompt,
        "status": "STARTED",
        "created_at": datetime.utcnow().isoformat(),
        "progress": "Initializing agent reasoning..."
    }
    
    try:
        # Store in S3 for progress tracking
        s3_client.put_object(
            Bucket=SESSION_STORE_BUCKET_NAME,
            Key=f"tasks/{task_id}/status.json",
            Body=json.dumps(session_data),
            ContentType='application/json'
        )
        l.info(f"Created task session: {task_id} for user: {username}")
        return task_id
    except Exception as e:
        l.error(f"Failed to create task session: {e}")
        raise

def update_task_progress(task_id: str, status: str, message: str):
    """Update task progress in S3"""
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
        l.info(f"Updated task {task_id} status: {status}")
    except Exception as e:
        l.error(f"Failed to update task progress for {task_id}: {e}")

def send_websocket_notification(username: str, message: str, websocket_url: str):
    """Send notification via WebSocket"""
    if not websocket_url:
        l.warning("No WebSocket URL provided, skipping notification")
        return False
    
    # Skip WebSocket notification if URL is localhost (Lambda can't reach local dev server)
    if "localhost" in websocket_url or "127.0.0.1" in websocket_url:
        l.info(f"Skipping WebSocket notification to localhost URL: {websocket_url}")
        l.info(f"Agent response for {username}: {message[:200]}...")
        return True  # Return True to avoid error handling
    
    try:
        response = requests.post(
            websocket_url,
            json={"username": username, "message": message},
            timeout=5,
            verify=False  # Disable SSL verification for self-signed certificates
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

def invoke_agent_async(task_id: str, user: User, prompt: str, websocket_url: str):
    """Invoke agent processing asynchronously via HTTP (ECS self-call)"""
    payload = {
        "type": "async_agent_processing",
        "task_id": task_id,
        "user_id": user.id,
        "username": user.name,
        "prompt": prompt,
        "websocket_url": websocket_url
    }
    
    try:
        # For ECS: Make async HTTP request to self instead of Lambda invoke
        # This will be handled by a background thread to avoid blocking
        import threading
        
        def process_async():
            try:
                handle_async_agent_processing(payload)
            except Exception as e:
                l.error(f"Background async processing failed: {e}")
        
        # Start background thread for async processing
        thread = threading.Thread(target=process_async)
        thread.daemon = True  # Don't block container shutdown
        thread.start()
        
        l.info(f"Async agent processing started in background thread for task: {task_id}")
    except Exception as e:
        l.error(f"Failed to start async agent processing: {e}")
        raise

def handle_async_agent_processing(event):
    """Handle the actual agent processing in background"""
    task_id = event["task_id"]
    user = User(id=event["user_id"], name=event["username"])
    prompt = event["prompt"]
    websocket_url = event["websocket_url"]
    
    l.info(f"Starting async agent processing for task: {task_id}, user: {user.name}")
    
    try:
        # Update progress
        update_task_progress(task_id, "PROCESSING", "Agent is analyzing your request...")
        
        # Run agent processing (this can take as long as needed)
        l.info(f"Calling agent.prompt for task: {task_id}")
        response_text = agent.prompt(user, prompt, websocket_url=websocket_url, task_id=task_id)
        
        # Log the full response for debugging
        l.info(f"Agent response for task {task_id}: {response_text}")
        
        # Update final status
        update_task_progress(task_id, "COMPLETED", response_text)
        
        # Send WebSocket notification
        send_websocket_notification(user.name, response_text, websocket_url)
        
        l.info(f"Async agent processing completed for task: {task_id}")
        return {"statusCode": 200, "body": json.dumps({"message": "Processing completed", "task_id": task_id})}
        
    except Exception as e:
        l.exception(f"Async agent processing failed for task: {task_id}")
        error_message = f"Processing failed: {str(e)}"
        update_task_progress(task_id, "FAILED", error_message)
        send_websocket_notification(user.name, error_message, websocket_url)
        return {"statusCode": 500, "body": json.dumps({"error": str(e), "task_id": task_id})}

def handle_user_request_async(event):
    """Handle user request - return task ID immediately"""
    try:
        claims = get_jwt_claims(event["headers"]["Authorization"])
        user = User(id=claims["sub"], name=claims["username"])
        l.info(f"jwt parsed. user.id={user.id} user.name={user.name}")
        
        request_body = json.loads(event["body"])
        prompt_text = request_body["text"]
        websocket_url = request_body.get("websocket_url", os.environ.get("WEB_APP_NOTIFY_URL"))
        
        # Check if user wants async processing (new parameter)
        use_async = request_body.get("async", False)
        
        # ONLY use async for actual DATA PROCESSING queries that run Glue jobs
        # Schema/metadata queries use fast Glue Catalog API - keep them synchronous
        data_processing_keywords = [
            "record count", "count(*)", "count records", "how many records", "total records",
            "count of", "number of records", "row count", "total rows",
            "select * from", "select count", "run query", "execute query", "analyze data",
            "query the data", "data analysis", "aggregate", "sum", "average", "min", "max"
        ]
        
        # Schema/metadata queries should stay synchronous (fast Glue Catalog API calls)
        schema_keywords = [
            "schema", "describe table", "show tables", "table structure", "columns",
            "what tables", "list tables", "table info", "database", "catalog", "metadata"
        ]
        
        # Simple chat queries should stay synchronous
        simple_keywords = [
            "hello", "hi", "help", "what can you do", "how are you", "test"
        ]
        
        # Only use async for actual data processing, not schema queries
        likely_needs_glue = any(keyword in prompt_text.lower() for keyword in data_processing_keywords)
        is_schema_query = any(keyword in prompt_text.lower() for keyword in schema_keywords)
        is_simple_query = any(keyword in prompt_text.lower() for keyword in simple_keywords)
        
        # Keep schema queries and simple queries synchronous for fast response
        if is_schema_query or is_simple_query:
            likely_needs_glue = False
            l.info(f"Schema/simple query detected - using fast synchronous processing")
        
        # Debug logging to see what's happening
        l.info(f"Checking prompt for data processing keywords: '{prompt_text[:100]}...'")
        if likely_needs_glue:
            l.info(f"Matched data processing keywords: {[kw for kw in data_processing_keywords if kw in prompt_text.lower()]}")
        l.info(f"likely_needs_glue: {likely_needs_glue}, use_async: {use_async}")
        
        # Use async processing if explicitly requested OR if it's likely a data query
        if use_async or likely_needs_glue:
            if likely_needs_glue and not use_async:
                l.info(f"Auto-detected data query, using async processing for: {prompt_text[:100]}...")
            else:
                l.info(f"Using async processing for user: {user.name}, prompt: {prompt_text[:100]}...")
        else:
            l.info("Using synchronous processing (backward compatibility)")
            return handle_user_request_sync(event, user, request_body)
        
        # Build composite prompt
        source_ip = event["requestContext"]["identity"]["sourceIp"]
        composite_prompt = f"User name: {user.name}\n"
        composite_prompt += f"User IP: {source_ip}\n"
        composite_prompt += f"User prompt: {prompt_text}"
        
        # Create task session
        task_id = create_task_session(user.id, user.name, composite_prompt)
        
        # Start async processing
        invoke_agent_async(task_id, user, composite_prompt, websocket_url)
        
        # Return immediately with task ID
        return {
            "statusCode": 200,
            "body": json.dumps({
                "task_id": task_id,
                "status": "STARTED",
                "message": "Your request is being processed. You'll receive updates in short.",
                "websocket_url": websocket_url
            })
        }
    except Exception as e:
        l.exception("Failed to handle async user request")
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)})
        }

def handle_user_request_sync(event, user, request_body):
    """Handle user request synchronously (original behavior)"""
    try:
        source_ip = event["requestContext"]["identity"]["sourceIp"]
        prompt_text = request_body["text"]
        websocket_url = request_body.get("websocket_url")
        
        l.info(f"Synchronous processing for user: {user.name}")
        
        composite_prompt = f"User name: {user.name}\n"
        composite_prompt += f"User IP: {source_ip}\n"
        composite_prompt += f"User prompt: {prompt_text}"
        
        # Add timeout handling for agent processing
        import signal
        
        def timeout_handler(signum, frame):
            raise TimeoutError("Agent processing timed out after 60 seconds")
        
        # Set a 60-second timeout (increased for Glue job processing)
        signal.signal(signal.SIGALRM, timeout_handler)
        signal.alarm(60)
        
        try:
            response_text = agent.prompt(user, composite_prompt, websocket_url=websocket_url)
            signal.alarm(0)  # Cancel the alarm
            l.info(f"Synchronous response completed")
        except TimeoutError as e:
            signal.alarm(0)  # Cancel the alarm
            l.error(f"Agent processing timed out: {e}")
            return {
                "statusCode": 200,
                "body": json.dumps({"text": "I'm processing your request, but it's taking longer than expected. Please try a simpler query or check back in a moment."})
            }
        
        return {
            "statusCode": 200,
            "body": json.dumps({"text": response_text})
        }
    except Exception as e:
        l.exception("Synchronous processing failed")
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)})
        }

def send_websocket_notification_with_retry(username: str, message: str, websocket_url: str, max_retries: int = 3):
    """Enhanced WebSocket notification with retry logic and better error handling"""
    import time
    
    for attempt in range(max_retries):
        try:
            l.info(f"Attempt {attempt + 1}/{max_retries}: Sending WebSocket notification to {websocket_url}")
            
            response = requests.post(
                websocket_url,
                json={"username": username, "message": message},
                timeout=10,
                headers={'Content-Type': 'application/json'},
                verify=False  # Disable SSL verification for self-signed certificates
            )
            
            l.info(f"WebSocket notification response: {response.status_code} - {response.text}")
            
            if response.status_code == 200:
                l.info(f"WebSocket notification successful on attempt {attempt + 1}")
                return True
            else:
                l.warning(f"WebSocket notification failed with status {response.status_code}: {response.text}")
                
        except Exception as e:
            l.error(f"WebSocket notification attempt {attempt + 1} failed: {str(e)}")
            
        if attempt < max_retries - 1:
            time.sleep(2 ** attempt)  # Exponential backoff
    
    l.error(f"All {max_retries} WebSocket notification attempts failed")
    return False

def get_jwt_claims(authorization_header):
    jwt_string = authorization_header.split(" ")[1]
    # print(jwt_string)
    signing_key = jwks_client.get_signing_key_from_jwt(jwt_string)
    claims = jwt.decode(jwt_string, signing_key.key, algorithms=["RS256"])
    # print(claims)
    return claims

# ===== FLASK ENDPOINTS FOR ECS DEPLOYMENT =====

@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint for ECS load balancer"""
    try:
        return jsonify({
            "status": "healthy",
            "service": "dq-agent-ecs",
            "timestamp": datetime.utcnow().isoformat()
        }), 200
    except Exception as e:
        l.error(f"Health check failed: {e}")
        return jsonify({
            "status": "unhealthy",
            "error": str(e)
        }), 500

@app.route('/agent', methods=['POST'])
def agent_endpoint():
    """Main agent endpoint for processing user requests"""
    try:
        # Convert Flask request to Lambda-style event for compatibility
        event = {
            "headers": dict(request.headers),
            "body": request.get_data(as_text=True),
            "requestContext": {
                "identity": {
                    "sourceIp": request.remote_addr
                }
            }
        }
        
        # Call the existing handler function
        response = handle_user_request_async(event)
        
        # Return Flask response
        return jsonify(json.loads(response["body"])), response["statusCode"]
        
    except Exception as e:
        l.exception("Agent endpoint failed")
        return jsonify({"error": str(e)}), 500

@app.route('/system/glue-result', methods=['POST'])
def handle_glue_result():
    """Handle Glue job completion notifications from Lambda Poller"""
    try:
        data = request.get_json()
        
        l.info(f"=== GLUE RESULT NOTIFICATION RECEIVED ===")
        l.info(f"Request data: {json.dumps(data, indent=2)}")
        
        if not data:
            l.error("No JSON data received")
            return jsonify({"status": "error", "message": "No JSON data provided"}), 400
        
        # Extract required fields
        user_context = data.get('user_context', {})
        username = user_context.get('username', 'unknown')
        result_preview = data.get('result_preview', 'No results available')
        
        l.info(f"Processing Glue result for user: {username}")
        l.info(f"Result preview length: {len(result_preview) if result_preview else 0}")
        
        # Use WebSocket URL from Poller if provided, fallback to environment
        websocket_url = data.get('websocket_url') or os.environ.get('WEB_APP_NOTIFY_URL')
        
        l.info(f"🔍 DEBUG: Environment WEB_APP_NOTIFY_URL = {os.environ.get('WEB_APP_NOTIFY_URL', 'NOT SET')}")
        l.info(f"🔍 DEBUG: Poller provided websocket_url = {data.get('websocket_url', 'NOT PROVIDED')}")
        l.info(f"🔍 DEBUG: Final websocket_url = {websocket_url}")
        
        if not websocket_url:
            l.error("❌ CRITICAL: No WebSocket URL available for notification")
            return jsonify({
                "status": "error", 
                "message": "No WebSocket URL configured"
            }), 500
        
        l.info(f"🚀 ATTEMPTING WebSocket notification to: {websocket_url}")
        
        # Enhanced notification with retry logic
        success = send_websocket_notification_with_retry(username, result_preview, websocket_url)
        
        if success:
            l.info(f"✅ Successfully notified user {username} via WebSocket")
            return jsonify({
                "status": "success",
                "message": f"Notification sent to {username}",
                "websocket_url": websocket_url
            }), 200
        else:
            l.error(f"❌ Failed to notify user {username} via WebSocket")
            return jsonify({
                "status": "error", 
                "message": "WebSocket notification failed",
                "websocket_url": websocket_url
            }), 500
            
    except Exception as e:
        l.exception("Glue result handling failed")
        return jsonify({
            "status": "error", 
            "message": str(e)
        }), 500

# Flask app runner for ECS
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    l.info(f"🚀 Starting DQ Agent ECS service on port {port}")
    l.info(f"📍 WebSocket notify URL: {os.environ.get('WEB_APP_NOTIFY_URL', 'Not configured')}")
    app.run(host="0.0.0.0", port=port, debug=False)

def handler(event: dict, ctx):
    l.info("> handler")

    # 🔹 Case 1: Async agent processing (background)
    if event.get("type") == "async_agent_processing":
        l.info("Detected async agent processing event.")
        return handle_async_agent_processing(event)

    # 🔹 Case 2: System reinvocation (poller lambda)
    if event.get("type") == "glue_job_result":
        l.info("Detected system reinvocation event from poller lambda.")
        try:
            session_id = event.get("session_id", "system-session")
            user_context = event.get("user_context", {})
            
            # Extract username from user_context if available, otherwise use session_id
            username = user_context.get("username", session_id)
            user = User(id=session_id, name=username)
            
            # Get WebSocket URL from the event
            websocket_url = event.get("websocket_url")
            
            l.info(f"Auto-reasoning for Glue job result. session={session_id}, user={username}, websocket_url={websocket_url}")
            response_text = agent.prompt(user, event, websocket_url=websocket_url)
            return {
                "statusCode": 200,
                "body": json.dumps({"text": response_text, "auto_reasoning": True})
            }
        except Exception as e:
            l.exception("Auto reasoning failed for poller event.")
            return {
                "statusCode": 500,
                "body": json.dumps({"error": str(e)})
            }

    # 🔹 Case 3: User request via API Gateway (NEW - supports both sync and async)
    return handle_user_request_async(event)


if __name__ == "__main__":
    debug_token = "your-debug-token"

    # 🧪 Test Case 1: Normal user query
    body = json.dumps({
        "text": "what are the tables that exist in ap_datamart_prod database"
    })
    event_user = {
        "requestContext": {
            "identity": {"sourceIp": "70.200.50.45"}
        },
        "headers": {"Authorization": f"Bearer {debug_token}"},
        "body": body
    }

    l.info('▶ Round 1: Normal user prompt')
    handler_response1 = handler(event_user, None)
    l.info(f"handler_response1: {handler_response1}")

    # 🧪 Test Case 2: Simulated Glue poller reinvocation
    event_poller = {
        "type": "glue_job_result",
        "session_id": "system-session",
        "glue_job_name": "sample-dq-job",
        "glue_run_id": "abc123",
        "status": "SUCCEEDED",
        "output_s3_path": "s3://bucket/path/output.json",
        "result_preview": "Sample data check result"
    }

    l.info('▶ Round 2: Poller reinvocation')
    handler_response2 = handler(event_poller, None)
    l.info(f"handler_response2: {handler_response2}")
