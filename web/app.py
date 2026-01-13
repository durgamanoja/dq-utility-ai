import os
import json
import uuid
import time
import asyncio
from typing import Dict, Set
from starlette.middleware.sessions import SessionMiddleware
from fastapi import FastAPI, Request, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from dotenv import load_dotenv
import uvicorn
import gradio as gr
import httpx
import oauth
from proxy_middleware import ProxyHeadersMiddleware

load_dotenv()

AGENT_ENDPOINT_URL = os.getenv("AGENT_ENDPOINT_URL")
print(f"AGENT_ENDPOINT_URL={AGENT_ENDPOINT_URL}")
user_avatar = "https://cdn-icons-png.flaticon.com/512/149/149071.png"
bot_avatar = "https://cdn-icons-png.flaticon.com/512/4712/4712042.png"

# WebSocket Connection Manager
class ConnectionManager:
    def __init__(self):
        # Map of session_id -> WebSocket connection
        self.active_connections: Dict[str, WebSocket] = {}
        # Map of username -> session_id for user lookup
        self.user_sessions: Dict[str, str] = {}
    
    async def connect(self, websocket: WebSocket, session_id: str, username: str):
        await websocket.accept()
        self.active_connections[session_id] = websocket
        self.user_sessions[username] = session_id
        print(f"WebSocket connected: {username} -> {session_id}")
    
    def disconnect(self, session_id: str, username: str = None):
        if session_id in self.active_connections:
            del self.active_connections[session_id]
        if username and username in self.user_sessions:
            del self.user_sessions[username]
        print(f"WebSocket disconnected: {username} -> {session_id}")
    
    async def send_to_user(self, username: str, message: dict):
        """Send message to a specific user by username"""
        if username in self.user_sessions:
            session_id = self.user_sessions[username]
            if session_id in self.active_connections:
                websocket = self.active_connections[session_id]
                try:
                    await websocket.send_text(json.dumps(message))
                    print(f"Message sent to {username}: {message}")
                    return True
                except Exception as e:
                    print(f"Error sending message to {username}: {e}")
                    self.disconnect(session_id, username)
        return False
    
    async def send_to_session(self, session_id: str, message: dict):
        """Send message to a specific session"""
        if session_id in self.active_connections:
            websocket = self.active_connections[session_id]
            try:
                await websocket.send_text(json.dumps(message))
                print(f"Message sent to session {session_id}: {message}")
                return True
            except Exception as e:
                print(f"Error sending message to session {session_id}: {e}")
                self.disconnect(session_id)
        return False

manager = ConnectionManager()

fastapi_app = FastAPI()

# Add middleware to handle load balancer headers
fastapi_app.add_middleware(
    TrustedHostMiddleware, 
    allowed_hosts=["*"]  # Allow all hosts since we're behind load balancer
)
fastapi_app.add_middleware(ProxyHeadersMiddleware)

# Custom exception handler for authentication failures
from fastapi import HTTPException
from fastapi.responses import RedirectResponse

@fastapi_app.exception_handler(HTTPException)
async def auth_exception_handler(request: Request, exc: HTTPException):
    if exc.status_code == 401:
        print(f"Authentication failed for {request.url}, redirecting to /login")
        web_app_url = os.getenv("WEB_APP_URL", "https://localhost:8000").rstrip('/')
        return RedirectResponse(url=f"{web_app_url}/login", status_code=302)
    # For other HTTP exceptions, return the original exception
    return exc

# Root path redirect
@fastapi_app.get("/")
async def root(request: Request):
    from fastapi.responses import RedirectResponse
    
    # Check if user is authenticated
    if "access_token" in request.session and "username" in request.session:
        # User is authenticated, redirect to chat
        web_app_url = os.getenv("WEB_APP_URL", "https://localhost:8000").rstrip('/')
        return RedirectResponse(url=f"{web_app_url}/chat")
    
    # Check session store as fallback
    session_id = request.session.get("_session_id")
    if session_id and session_id in session_store:
        session_data = session_store[session_id]
        if "access_token" in session_data and "username" in session_data:
            # User is authenticated, redirect to chat
            web_app_url = os.getenv("WEB_APP_URL", "https://localhost:8000").rstrip('/')
            return RedirectResponse(url=f"{web_app_url}/chat")
    
    # User is not authenticated, redirect to login
    return RedirectResponse(url="/login")

# Health check endpoint for ECS
@fastapi_app.get("/health")
def health_check():
    try:
        return {"status": "healthy", "service": "dq-web-app", "timestamp": int(time.time())}
    except Exception as e:
        print(f"Health check error: {e}")
        return {"status": "unhealthy", "error": str(e)}

# Debug endpoint to check WebSocket connections
@fastapi_app.get("/debug/websockets")
def debug_websockets():
    return {
        "active_connections": list(manager.active_connections.keys()),
        "user_sessions": manager.user_sessions,
        "chat_history_users": list(chat_history_store.keys())
    }
# Use a more robust secret key for session middleware in serverless environment
session_secret = os.getenv("SESSION_SECRET", "dq-utility-ai-session-secret-key-2024")
fastapi_app.add_middleware(
    SessionMiddleware, 
    secret_key=session_secret,
    max_age=28800,  # 8 hours
    same_site="lax",
    https_only=False,  # Set to False since load balancer terminates SSL
    domain=None  # Let browser determine domain
)

# In-memory session store for Gradio compatibility
session_store = {}

# Global chat history store for WebSocket messages
chat_history_store = {}

oauth.add_oauth_routes(fastapi_app)

def check_auth(req: Request):
    print(f"check_auth::session contents: {dict(req.session)}")
    print(f"check_auth::access_token in session: {'access_token' in req.session}")
    print(f"check_auth::username in session: {'username' in req.session}")
    
    # Try regular session first
    if "access_token" in req.session and "username" in req.session:
        username = req.session["username"]
        print(f"check_auth::auth found in regular session: {username}")
        return username
    
    # Fallback to session store
    session_id = req.session.get("_session_id")
    if session_id and session_id in session_store:
        session_data = session_store[session_id]
        username = session_data["username"]
        print(f"check_auth::auth found in session store: {username}")
        return username
    
    print("check_auth::not found in either session, raising HTTPException to redirect")
    # Gradio auth_dependency expects an exception, not a RedirectResponse
    from fastapi import HTTPException
    raise HTTPException(status_code=401, detail="Authentication required")


# WebSocket endpoint for client connections
@fastapi_app.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    # Note: WebSocket doesn't have access to session middleware
    # We'll need to pass username through query params or handle auth differently
    await manager.connect(websocket, session_id, session_id)  # Using session_id as username for now
    try:
        while True:
            # Keep connection alive and handle any client messages
            data = await websocket.receive_text()
            message = json.loads(data)
            print(f"Received WebSocket message: {message}")
            
            # Handle different message types
            if message.get("type") == "auth":
                # Update username mapping when auth info is received
                username = message.get("username")
                if username:
                    manager.user_sessions[username] = session_id
                    print(f"Updated WebSocket auth: {username} -> {session_id}")
    except WebSocketDisconnect:
        manager.disconnect(session_id)

# API endpoint for Agent to send notifications
@fastapi_app.post("/api/notify")
async def notify_user(request: Request):
    """Endpoint for Agent Lambda to send notifications to users via WebSocket"""
    try:
        print(f"=== NOTIFY_USER DEBUG ===")
        print(f"Request headers: {dict(request.headers)}")
        print(f"Request method: {request.method}")
        print(f"Request URL: {request.url}")
        
        # Get request body
        try:
            data = await request.json()
            print(f"Request body parsed successfully: {data}")
        except Exception as json_error:
            print(f"Failed to parse JSON body: {json_error}")
            raise HTTPException(status_code=400, detail=f"Invalid JSON: {str(json_error)}")
        
        username = data.get("username")
        message = data.get("message")
        
        print(f"Extracted username: {username}")
        print(f"Extracted message length: {len(message) if message else 0}")
        
        if not username or not message:
            print(f"Missing required fields - username: {bool(username)}, message: {bool(message)}")
            raise HTTPException(status_code=400, detail="Missing username or message")
        
        # Store the message in chat history for the user
        if username not in chat_history_store:
            chat_history_store[username] = []
            print(f"Created new chat history for user: {username}")
        
        chat_history_store[username].append({
            "role": "assistant",
            "content": message,
            "timestamp": int(time.time() * 1000)
        })
        
        print(f"Stored chat message for {username}: {message[:100]}...")
        print(f"Total messages in history for {username}: {len(chat_history_store[username])}")
        
        # Debug WebSocket connection state
        print(f"=== WEBSOCKET DEBUG ===")
        print(f"Active connections: {list(manager.active_connections.keys())}")
        print(f"User sessions: {manager.user_sessions}")
        print(f"Looking for user: {username}")
        
        # Also send via WebSocket for immediate notification with actual message content
        try:
            success = await manager.send_to_user(username, {
                "type": "agent_response",
                "content": message,
                "timestamp": int(time.time() * 1000)
            })
            print(f"WebSocket notification sent successfully: {success}")
            
            if not success:
                print(f"WebSocket failed - User {username} not found in active connections")
                print(f"Available users: {list(manager.user_sessions.keys())}")
                
        except Exception as ws_error:
            print(f"WebSocket notification failed: {ws_error}")
            # Don't fail the entire request if WebSocket fails
        
        print(f"=== NOTIFY_USER SUCCESS ===")
        return {"success": True, "message": "Message stored in chat history"}
    
    except HTTPException:
        # Re-raise HTTP exceptions as-is
        raise
    except Exception as e:
        print(f"=== NOTIFY_USER ERROR ===")
        print(f"Error type: {type(e).__name__}")
        print(f"Error message: {str(e)}")
        import traceback
        print(f"Error traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))

async def chat(message, history, request: gr.Request):
    try:
        # Debug session contents
        print(f"=== CHAT FUNCTION DEBUG ===")
        print(f"Session contents: {dict(request.request.session)}")
        print(f"Session store contents: {list(session_store.keys())}")
        for sid, data in session_store.items():
            print(f"  Session {sid}: {data}")
        
        # Get username and token from session directly
        username = request.request.session.get("username")
        token = request.request.session.get("access_token")
        session_id = request.request.session.get("_session_id")
        
        print(f"From regular session - username: {username}, token: {token[:20] if token else 'None'}, session_id: {session_id}")
        
        # Fallback to session store if not found in regular session
        if not username or not token:
            if session_id and session_id in session_store:
                session_data = session_store[session_id]
                username = session_data.get("username")
                token = session_data.get("access_token")
                print(f"Retrieved from session store - username: {username}, token: {token[:20] if token else 'None'}")
            else:
                print(f"Session ID {session_id} not found in session store")
        
        print(f"Final values - username: {username}, token: {token[:20] if token else 'None'}")
        
        if not username or not token:
            print("=== SESSION EXPIRED - NO VALID CREDENTIALS ===")
            yield "Session expired. Please refresh the page and login again."
            return
        
        # Check for pending WebSocket messages and add them to history
        if username in chat_history_store and chat_history_store[username]:
            print(f"Found {len(chat_history_store[username])} pending messages for {username}")
            
            # Always add pending messages to history, regardless of whether it's a new message or refresh
            for pending_msg in chat_history_store[username]:
                history.append(gr.ChatMessage(
                    role=pending_msg["role"],
                    content=pending_msg["content"]
                ))
                print(f"Added pending message to history: {pending_msg['content'][:100]}...")
            
            # Clear the pending messages after adding them
            chat_history_store[username] = []
            print(f"Cleared pending messages for {username}")
            
            # If this is just a refresh request (empty message), return the updated history
            if not message or message.strip() == "":
                yield history
                return
            
        print(f"username={username}, message={message}")
        print(f"token={token[:20]}...")

        # Simple payload for synchronous processing
        payload = {
            "text": message,
            "username": username
        }
        
        print(f"Using synchronous processing for: {message[:50]}...")
        print(f"Attempting to connect to Agent at: {AGENT_ENDPOINT_URL}")
        print(f"Payload: {payload}")
        print(f"Headers: Authorization=Bearer {token[:20]}...")
        
        agent_response = httpx.post(
            AGENT_ENDPOINT_URL,
            headers={"Authorization": f"Bearer {token}"},
            json=payload,
            timeout=900.0,  # 15 minutes timeout for long-running requests
        )

        print(f"Agent response status: {agent_response.status_code}")
        print(f"Agent response headers: {agent_response.headers}")

        if agent_response.status_code == 401 or agent_response.status_code == 403:
            yield f"Agent returned authorization error. Try to re-login. Status code: {agent_response.status_code}"
            return

        if agent_response.status_code != 200:
            try:
                error_text = agent_response.text
                yield f"Failed to communicate with Agent. Status code: {agent_response.status_code}\nError: {error_text}"
                return
            except:
                yield f"Failed to communicate with Agent. Status code: {agent_response.status_code}"
                return

        try:
            response_data = agent_response.json()
        except Exception as json_error:
            yield f"Agent returned invalid JSON response: {str(json_error)}\nResponse text: {agent_response.text[:500]}"
            return
        
        # Handle response
        response_text = response_data.get('text', response_data.get('message', str(response_data)))
        
        # Yield the immediate response first
        yield response_text
        
        # Check if this might be an async task that needs polling
        task_id = response_data.get('task_id')
        if task_id:
            print(f"Task ID detected: {task_id}, starting polling for additional messages...")
            
            # Poll for additional messages from async processing
            max_polls = 90  # Poll for up to 15 minutes (60 * 10 seconds)
            poll_count = 0
            
            while poll_count < max_polls:
                await asyncio.sleep(10)  # Wait 10 seconds between polls
                poll_count += 1
                
                print(f"Polling attempt {poll_count}/{max_polls} for user {username}")
                
                # Check for new messages in chat history
                if username in chat_history_store and chat_history_store[username]:
                    print(f"Found {len(chat_history_store[username])} new messages during polling")
                    
                    # Yield all new messages
                    for pending_msg in chat_history_store[username]:
                        print(f"Yielding polled message: {pending_msg['content'][:100]}...")
                        yield pending_msg["content"]
                    
                    # Clear the messages after yielding them
                    chat_history_store[username] = []
                    print(f"Cleared polled messages for {username}")
                    break  # Stop polling once we get messages
                else:
                    print(f"No new messages found during poll {poll_count}")
            
            if poll_count >= max_polls:
                print(f"Polling timeout reached for user {username}")
        else:
            print(f"No task ID detected, skipping polling")
        
    except httpx.ConnectError as e:
        yield f"Cannot connect to Agent API at {AGENT_ENDPOINT_URL}. Connection error: {str(e)}"
        return
    except httpx.TimeoutException as e:
        yield f"Agent request timed out after 15 minutes. Please try a simpler question or try again later. Error: {str(e)}"
        return
    except Exception as e:
        print(f"Chat error: {type(e).__name__}: {str(e)}")
        yield f"Error communicating with agent: {type(e).__name__}: {str(e)}"
        return

def on_gradio_app_load(request: gr.Request):
    # Use the same session retrieval logic as chat function
    username = request.request.session.get("username")
    
    # Fallback to session store if not found in regular session
    if not username:
        session_id = request.request.session.get("_session_id")
        if session_id and session_id in session_store:
            session_data = session_store[session_id]
            username = session_data.get("username", "User")
            print(f"on_gradio_app_load: Retrieved username from session store: {username}")
        else:
            username = "User"
            print(f"on_gradio_app_load: No username found in either session")
    else:
        print(f"on_gradio_app_load: Retrieved username from regular session: {username}")
    
    return f"Logout ({username})", [gr.ChatMessage(
        role="assistant",
        content=f"Hi {username}, I'm your friendly DQ Agent. Tell me how I can help. "
    )]

with gr.Blocks(head="""
<script>
// WebSocket connection for real-time updates
let ws = null;
let sessionId = null;
let username = null;

// Visual notification function
function showNotification(title, content) {
    console.log('Showing notification:', title);
    
    // Create notification element
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #4CAF50;
        color: white;
        padding: 15px 20px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        z-index: 10000;
        max-width: 400px;
        font-family: Arial, sans-serif;
        animation: slideIn 0.3s ease-out;
    `;
    
    notification.innerHTML = `
        <div style="font-weight: bold; margin-bottom: 5px;">🎉 ${title}</div>
        <div style="font-size: 14px; opacity: 0.9;">Your data analysis results are ready!</div>
    `;
    
    // Add CSS animation
    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
        @keyframes slideOut {
            from { transform: translateX(0); opacity: 1; }
            to { transform: translateX(100%); opacity: 0; }
        }
    `;
    document.head.appendChild(style);
    
    // Add to page
    document.body.appendChild(notification);
    
    // Auto-remove after 5 seconds
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease-in';
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 300);
    }, 5000);
    
    // Make it clickable to dismiss
    notification.addEventListener('click', () => {
        notification.style.animation = 'slideOut 0.3s ease-in';
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 300);
    });
}

function initWebSocket() {
    // Generate a session ID if not exists
    if (!sessionId) {
        sessionId = 'session_' + Math.random().toString(36).substr(2, 9);
    }
    
    const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/${sessionId}`;
    console.log('Connecting to WebSocket:', wsUrl);
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = function(event) {
        console.log('WebSocket connected');
        // Send auth info if we have username
        if (username) {
            ws.send(JSON.stringify({
                type: 'auth',
                username: username
            }));
        }
    };
    
    ws.onmessage = function(event) {
        console.log('WebSocket message received:', event.data);
        const message = JSON.parse(event.data);
        
        if (message.type === 'agent_response') {
            console.log('Agent response received via WebSocket, displaying directly');
            
            // Create a visual notification
            showNotification('New results available!', message.content);
            
            // Trigger a chat refresh to show the new message
            const chatInput = document.querySelector('textarea[placeholder*="Type a message"]');
            const submitButton = document.querySelector('button[aria-label="Submit"]');
            
            if (chatInput && submitButton) {
                // Store current value
                const currentValue = chatInput.value;
                // Set empty value to trigger refresh
                chatInput.value = '';
                // Trigger input event
                chatInput.dispatchEvent(new Event('input', { bubbles: true }));
                // Click submit to refresh
                submitButton.click();
                // Restore original value after a short delay
                setTimeout(() => {
                    chatInput.value = currentValue;
                    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
                }, 100);
            }
        } else if (message.type === 'chat_update') {
            console.log('Chat update received, triggering refresh');
            // Legacy support for chat_update messages
            const chatInput = document.querySelector('textarea[placeholder*="Type a message"]');
            const submitButton = document.querySelector('button[aria-label="Submit"]');
            
            if (chatInput && submitButton) {
                const currentValue = chatInput.value;
                chatInput.value = '';
                chatInput.dispatchEvent(new Event('input', { bubbles: true }));
                submitButton.click();
                setTimeout(() => {
                    chatInput.value = currentValue;
                    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
                }, 100);
            }
        }
    };
    
    ws.onclose = function(event) {
        console.log('WebSocket disconnected, attempting to reconnect in 3 seconds');
        setTimeout(initWebSocket, 3000);
    };
    
    ws.onerror = function(error) {
        console.error('WebSocket error:', error);
    };
}

// Initialize WebSocket when page loads
document.addEventListener('DOMContentLoaded', function() {
    console.log('DOM loaded, initializing WebSocket connection...');
    
    // Try multiple methods to extract username
    function extractUsername() {
        // Method 1: From logout button
        const logoutButton = document.querySelector('button[value*="Logout"]');
        if (logoutButton && logoutButton.value) {
            const match = logoutButton.value.match(/Logout \\((.+)\\)/);
            if (match) {
                username = match[1];
                console.log('Extracted username from logout button:', username);
                return true;
            }
        }
        
        // Method 2: From welcome message
        const welcomeMsg = document.querySelector('div[data-testid="bot"] p');
        if (welcomeMsg && welcomeMsg.textContent) {
            const match = welcomeMsg.textContent.match(/Hi ([^,]+),/);
            if (match) {
                username = match[1];
                console.log('Extracted username from welcome message:', username);
                return true;
            }
        }
        
        // Method 3: From any element containing username
        const allElements = document.querySelectorAll('*');
        for (let element of allElements) {
            if (element.textContent && element.textContent.includes('Hi ') && element.textContent.includes(', I\'m your friendly')) {
                const match = element.textContent.match(/Hi ([^,]+),/);
                if (match) {
                    username = match[1];
                    console.log('Extracted username from element:', username);
                    return true;
                }
            }
        }
        
        return false;
    }
    
    // Try to extract username immediately
    if (extractUsername()) {
        initWebSocket();
    } else {
        // Retry every 500ms for up to 10 seconds
        let attempts = 0;
        const maxAttempts = 20;
        const retryInterval = setInterval(() => {
            attempts++;
            console.log(`Attempting to extract username (attempt ${attempts}/${maxAttempts})`);
            
            if (extractUsername()) {
                clearInterval(retryInterval);
                initWebSocket();
            } else if (attempts >= maxAttempts) {
                clearInterval(retryInterval);
                console.warn('Could not extract username after maximum attempts, initializing WebSocket anyway');
                username = 'Unknown';
                initWebSocket();
            }
        }, 500);
    }
});
</script>
""") as gradio_app:
    header = gr.Markdown("""
    # 🚀 AP Analytics Data Platform
    ## Your Intelligent Data Quality Agent
    
    *Empowering data-driven decisions with advanced analytics and quality insights*
    """)

    # Use ChatInterface like the AWS reference implementation
    chat_interface = gr.ChatInterface(
        fn=chat,
        type="messages",
        chatbot=gr.Chatbot(
            type="messages",
            label="Do DQ with ease",
            avatar_images=(user_avatar, bot_avatar),
            placeholder="<b>Welcome to the AP Analytics Data Platform DQ Agent.</b>",
            height=600
        )
    )

    logout_button = gr.Button(value="Logout", variant="secondary")
    logout_button.click(
        fn=None,
        js="() => window.location.href='/logout'"
    )

    gradio_app.load(on_gradio_app_load, inputs=None, outputs=[logout_button, chat_interface.chatbot])

gr.mount_gradio_app(fastapi_app, gradio_app, path="/chat", auth_dependency=check_auth)

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8001))
    print(f"🚀 Starting DQ Web App on port {port}")
    print(f"📍 Agent endpoint: {os.getenv('AGENT_ENDPOINT_URL')}")
    print(f"🔐 Cognito client ID: {os.getenv('COGNITO_CLIENT_ID')}")
    uvicorn.run(fastapi_app, host="0.0.0.0", port=port, log_level="info")
