import os
import json
import uuid
from typing import Dict, Set
from starlette.middleware.sessions import SessionMiddleware
from fastapi import FastAPI, Request, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, RedirectResponse
import dotenv
import httpx
import oauth

dotenv.load_dotenv()

AGENT_ENDPOINT_URL = os.getenv("AGENT_ENDPOINT_URL")
print(f"AGENT_ENDPOINT_URL={AGENT_ENDPOINT_URL}")

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

manager = ConnectionManager()

fastapi_app = FastAPI()
fastapi_app.add_middleware(SessionMiddleware, secret_key="secret")
oauth.add_oauth_routes(fastapi_app)

def check_auth(req: Request):
    if not "access_token" in req.session or not "username" in req.session:
        print("check_auth::not found, redirecting to /login")
        raise HTTPException(status_code=302, detail="Redirecting to login", headers={"Location": "/login"})

    username = req.session["username"]
    print(f"check_auth::auth found username: {username}")
    return username

# WebSocket endpoint for client connections
@fastapi_app.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    await manager.connect(websocket, session_id, session_id)
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            print(f"Received WebSocket message: {message}")
            
            if message.get("type") == "auth":
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
        data = await request.json()
        username = data.get("username")
        message = data.get("message")
        
        if not username or not message:
            raise HTTPException(status_code=400, detail="Missing username or message")
        
        success = await manager.send_to_user(username, {
            "type": "notification",
            "message": message,
            "timestamp": json.dumps({"$date": {"$numberLong": str(int(os.times().elapsed * 1000))}})
        })
        
        return {"success": success, "message": "Notification sent" if success else "User not connected"}
    
    except Exception as e:
        print(f"Error in notify_user: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@fastapi_app.get("/")
async def root():
    return RedirectResponse(url="/chat")

@fastapi_app.get("/chat")
async def chat_page(request: Request):
    """Simple chat interface without Gradio"""
    try:
        username = check_auth(request)
    except HTTPException:
        return RedirectResponse(url="/login")
    
    html_content = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>DQ Agent Chat</title>
        <style>
            body {{ font-family: Arial, sans-serif; margin: 20px; }}
            .chat-container {{ max-width: 800px; margin: 0 auto; }}
            .messages {{ height: 400px; border: 1px solid #ccc; padding: 10px; overflow-y: auto; margin-bottom: 10px; }}
            .input-container {{ display: flex; gap: 10px; }}
            input[type="text"] {{ flex: 1; padding: 10px; }}
            button {{ padding: 10px 20px; }}
            .message {{ margin: 10px 0; padding: 10px; border-radius: 5px; }}
            .user-message {{ background-color: #e3f2fd; text-align: right; }}
            .bot-message {{ background-color: #f5f5f5; }}
            .header {{ text-align: center; margin-bottom: 20px; }}
            .logout {{ float: right; }}
        </style>
    </head>
    <body>
        <div class="chat-container">
            <div class="header">
                <h1>AP Analytics Data Platform DQ Agent</h1>
                <div class="logout">
                    <span>Welcome, {username}</span>
                    <button onclick="logout()">Logout</button>
                </div>
            </div>
            <div id="messages" class="messages">
                <div class="message bot-message">
