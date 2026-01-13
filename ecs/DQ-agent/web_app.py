from flask import Flask, request, jsonify
import json
import jwt
import os
import uuid
import boto3
import requests
import urllib3
from datetime import datetime
import threading
import logging

# Import existing modules
import logger
import agent
from user import User

# Disable SSL warnings for self-signed certificates
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Initialize Flask app
app = Flask(__name__)

# Initialize logger
l = logger.get()

# Environment variables
JWT_SIGNATURE_SECRET = os.environ.get('JWT_SIGNATURE_SECRET', 'default-secret')
COGNITO_JWKS_URL = os.environ.get('COGNITO_JWKS_URL', '')
SESSION_STORE_BUCKET_NAME = os.environ.get('SESSION_STORE_BUCKET_NAME', '')

# Initialize JWKS client if Cognito URL is provided
jwks_client = None
if COGNITO_JWKS_URL:
    jwks_client = jwt.PyJWKClient(COGNITO_JWKS_URL)

# Initialize AWS clients
lambda_client = boto3.client('lambda')
s3_client = boto3.client('s3')

def get_user_from_token(auth_header):
    """Extract user from JWT token"""
    try:
        if not auth_header or not auth_header.startswith('Bearer '):
            raise ValueError("Missing or invalid Authorization header")
        
        if not jwks_client:
            # For testing without Cognito
            return User(id="test-user", name="Test User")
        
        jwt_token = auth_header.split(' ')[1]
        signing_key = jwks_client.get_signing_key_from_jwt(jwt_token)
        claims = jwt.decode(jwt_token, signing_key.key, algorithms=["RS256"])
        
        return User(id=claims["sub"], name=claims.get("username", claims["sub"]))
    except Exception as e:
        l.error(f"Authentication failed: {e}")
        raise ValueError(f"Invalid authentication token: {e}")

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
        response = s3_client.get_object(
            Bucket=SESSION_STORE_BUCKET_NAME,
            Key=f"tasks/{task_id}/status.json"
        )
        session_data = json.loads(response['Body'].read())
        
        session_data.update({
            "status": status,
            "progress": message,
            "updated_at": datetime.utcnow().isoformat()
        })
        
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
    
    if "localhost" in websocket_url or "127.0.0.1" in websocket_url:
        l.info(f"Skipping WebSocket notification to localhost URL: {websocket_url}")
        l.info(f"Agent response for {username}: {message[:200]}...")
        return True
    
    try:
        response = requests.post(
            websocket_url,
            json={"username": username, "message": message},
            timeout=5,
            verify=False
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

def process_agent_background(task_id: str, user: User, prompt: str, websocket_url: str):
    """Process agent request in background thread - unlimited time!"""
    try:
        l.info(f"Starting background processing for task: {task_id}")
        update_task_progress(task_id, "PROCESSING", "Agent is analyzing your request...")
        
        # Run agent processing (unlimited time in ECS!)
        response_text = agent.prompt(user, prompt, websocket_url=websocket_url, task_id=task_id)
        
        # Update final status
        update_task_progress(task_id, "COMPLETED", response_text)
        
        # Send WebSocket notification
        send_websocket_notification(user.name, response_text, websocket_url)
        
        l.info(f"Background processing completed for task: {task_id}")
        
    except Exception as e:
        l.exception(f"Background processing failed for task: {task_id}")
        error_message = f"Processing failed: {str(e)}"
        update_task_progress(task_id, "FAILED", error_message)
        send_websocket_notification(user.name, error_message, websocket_url)

# Health check endpoint
@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint for ALB"""
    return jsonify({
        "status": "healthy", 
        "service": "dq-agent", 
        "version": "1.0.0"
    })

def is_simple_message(text: str) -> bool:
    """Simple heuristic to detect conversational messages that don't need async processing"""
    text_lower = text.lower().strip()
    
    # Very short messages are likely conversational
    if len(text.strip()) <= 30:
        # But exclude obvious data/SQL keywords
        data_keywords = ['sql', 'query', 'database', 'table', 'select', 'data', 'analyze', 'run', 'execute', 'show', 'list','schema','glue']
        if not any(keyword in text_lower for keyword in data_keywords):
            return True
    
    # Common conversational patterns
    simple_patterns = [
        'hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening',
        'how are you', 'what\'s up', 'thanks', 'thank you', 'bye', 'goodbye',
        'ok', 'okay', 'yes', 'no', 'sure', 'great', 'awesome', 'cool',
        'who are you', 'what can you do', 'help', 'what is this'
    ]
    
    for pattern in simple_patterns:
        if text_lower == pattern or text_lower.startswith(pattern + ' ') or text_lower.endswith(' ' + pattern):
            return True
    
    return False

# Main agent endpoint (smart sync/async processing)
@app.route('/agent', methods=['POST'])
def process_agent_request():
    """Process agent request - simple heuristic for sync vs async"""
    try:
        # Get user from JWT token
        auth_header = request.headers.get('Authorization')
        user = get_user_from_token(auth_header)
        
        l.info(f"Processing request for user: {user.name}")
        
        # Parse request body
        request_data = request.get_json()
        if not request_data or 'text' not in request_data:
            return jsonify({"error": "Missing 'text' field in request"}), 400
        
        user_text = request_data['text']
        
        # Get client IP
        client_ip = request.environ.get('HTTP_X_FORWARDED_FOR', request.remote_addr)
        if client_ip and ',' in client_ip:
            client_ip = client_ip.split(',')[0].strip()
        
        # Build composite prompt
        composite_prompt = f"User name: {user.name}\n"
        composite_prompt += f"User IP: {client_ip}\n"
        composite_prompt += f"User prompt: {user_text}"
        
        # Get WebSocket URL
        websocket_url = request_data.get('websocket_url') or os.environ.get("WEB_APP_NOTIFY_URL")
        
        # Simple heuristic: sync for simple messages, async for complex ones
        if is_simple_message(user_text):
            l.info(f"Processing simple message synchronously: '{user_text[:50]}...'")
            
            # Process synchronously for simple conversational messages
            response_text = agent.prompt(user, composite_prompt, websocket_url=websocket_url)
            
            return jsonify({
                "text": response_text,
                "processing_type": "sync",
                "message": "Response generated immediately"
            })
        else:
            l.info(f"Processing complex message asynchronously: '{user_text[:50]}...'")
            
            # Create task session for complex requests
            task_id = create_task_session(user.id, user.name, composite_prompt)
            
            # Process in background thread (no timeout limits in ECS!)
            thread = threading.Thread(
                target=process_agent_background,
                args=(task_id, user, composite_prompt, websocket_url)
            )
            thread.daemon = True
            thread.start()
            
            return jsonify({
                "task_id": task_id,
                "status": "STARTED",
                "processing_type": "async",
                "message": "Your request is being processed. You'll receive updates in short.",
                "websocket_url": websocket_url
            })
        
    except ValueError as e:
        return jsonify({"error": str(e)}), 401
    except Exception as e:
        l.exception("Failed to process agent request")
        return jsonify({"error": str(e)}), 500

# Synchronous endpoint for simple queries (optional)
@app.route('/agent/sync', methods=['POST'])
def process_agent_sync():
    """Process simple agent requests synchronously"""
    try:
        # Get user from JWT token
        auth_header = request.headers.get('Authorization')
        user = get_user_from_token(auth_header)
        
        l.info(f"Processing sync request for user: {user.name}")
        
        # Parse request body
        request_data = request.get_json()
        if not request_data or 'text' not in request_data:
            return jsonify({"error": "Missing 'text' field in request"}), 400
        
        # Get client IP
        client_ip = request.environ.get('HTTP_X_FORWARDED_FOR', request.remote_addr)
        if client_ip and ',' in client_ip:
            client_ip = client_ip.split(',')[0].strip()
        
        # Build composite prompt
        composite_prompt = f"User name: {user.name}\n"
        composite_prompt += f"User IP: {client_ip}\n"
        composite_prompt += f"User prompt: {request_data['text']}"
        
        # Process synchronously (still no timeout limits in ECS!)
        response_text = agent.prompt(user, composite_prompt, websocket_url=request_data.get('websocket_url'))
        
        return jsonify({"text": response_text})
        
    except ValueError as e:
        return jsonify({"error": str(e)}), 401
    except Exception as e:
        l.exception("Failed to process sync agent request")
        return jsonify({"error": str(e)}), 500

# Task status endpoint
@app.route('/task/<task_id>', methods=['GET'])
def get_task_status(task_id):
    """Get task status"""
    try:
        # Get user from JWT token
        auth_header = request.headers.get('Authorization')
        user = get_user_from_token(auth_header)
        
        response = s3_client.get_object(
            Bucket=SESSION_STORE_BUCKET_NAME,
            Key=f"tasks/{task_id}/status.json"
        )
        session_data = json.loads(response['Body'].read())
        
        # Verify user owns this task
        if session_data.get("user_id") != user.id:
            return jsonify({"error": "Access denied"}), 403
        
        return jsonify(session_data)
        
    except ValueError as e:
        return jsonify({"error": str(e)}), 401
    except s3_client.exceptions.NoSuchKey:
        return jsonify({"error": "Task not found"}), 404
    except Exception as e:
        l.error(f"Failed to get task status: {e}")
        return jsonify({"error": str(e)}), 500

# System endpoint for poller integration
@app.route('/system/glue-result', methods=['POST'])
def handle_glue_result():
    """Handle Glue job results from poller (system endpoint)"""
    try:
        l.info("Received Glue job result from poller")
        
        event = request.get_json()
        session_id = event.get("session_id", "system-session")
        user_context = event.get("user_context", {})
        
        # 🔥 CRITICAL FIX: Use original user ID from user_context, not session_id
        original_user_id = user_context.get("user_id", session_id)
        username = user_context.get("username", "unknown-user")
        
        # Create user with ORIGINAL user ID to maintain session continuity
        user = User(id=original_user_id, name=username)
        websocket_url = event.get("websocket_url")
        
        l.info(f"Processing Glue result for original user: {original_user_id} (username: {username})")
        
        # Process the Glue result
        response_text = agent.prompt(user, event, websocket_url=websocket_url)
        
        return jsonify({"status": "processed", "response": response_text})
        
    except Exception as e:
        l.exception("Failed to handle Glue result")
        return jsonify({"error": str(e)}), 500

# System endpoint for poller progress updates
@app.route('/system/glue-progress', methods=['POST'])
def handle_glue_progress():
    """Handle Glue job progress updates from poller (system endpoint)"""
    try:
        l.info("Received Glue job progress update from poller")
        
        event = request.get_json()
        session_id = event.get("session_id", "system-session")
        user_context = event.get("user_context", {})
        progress_message = event.get("progress_message", "Job is running...")
        status = event.get("status", "RUNNING")
        
        # Get user info from context
        original_user_id = user_context.get("user_id", session_id)
        username = user_context.get("username", "unknown-user")
        websocket_url = event.get("websocket_url")
        
        l.info(f"Processing progress update for user: {original_user_id} (username: {username}) - {progress_message}")
        
        # Send progress notification via WebSocket
        if websocket_url:
            progress_notification = f"📊 **Job Progress Update**\n\n{progress_message}\n\n_Your job is still running. You'll receive the full results when it completes._"
            
            success = send_websocket_notification(username, progress_notification, websocket_url)
            if success:
                l.info(f"Progress notification sent successfully to {username}")
            else:
                l.warning(f"Failed to send progress notification to {username}")
        
        return jsonify({"status": "progress_processed", "message": "Progress update sent"})
        
    except Exception as e:
        l.exception("Failed to handle Glue progress")
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    # For development
    app.run(host="0.0.0.0", port=8000, debug=False)
