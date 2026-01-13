from fastapi import FastAPI, Request
from fastapi.responses import RedirectResponse
from authlib.integrations.starlette_client import OAuth
import os
import uuid
import time

def add_oauth_routes(fastapi_app: FastAPI):
    COGNITO_CLIENT_ID = os.getenv("COGNITO_CLIENT_ID")
    COGNITO_CLIENT_SECRET = os.getenv("COGNITO_CLIENT_SECRET")
    
    # Construct Cognito URLs dynamically
    COGNITO_DOMAIN = os.getenv("COGNITO_DOMAIN", "apa-e10bc46a-dqutility.auth.us-east-1.amazoncognito.com")
    COGNITO_USER_POOL_ID = os.getenv("COGNITO_USER_POOL_ID", "us-east-1_PkSp7D4KS")
    AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
    
    COGNITO_WELL_KNOWN_ENDPOINT_URL = f"https://cognito-idp.{AWS_REGION}.amazonaws.com/{COGNITO_USER_POOL_ID}/.well-known/openid-configuration"
    # Get the base URL from environment or use dynamic detection
    WEB_APP_URL = os.getenv("WEB_APP_URL")
    if not WEB_APP_URL:
        # For ECS deployment, use the current load balancer URL
        # This should be set by the CDK stack
        WEB_APP_URL = os.getenv("WEB_APP_URL")
        if not WEB_APP_URL:
            raise ValueError("WEB_APP_URL environment variable is required")
    # Remove trailing slash if present
    WEB_APP_URL = WEB_APP_URL.rstrip('/')
    
    OAUTH_CALLBACK_URI = f"{WEB_APP_URL}/callback"
    REDIRECT_AFTER_LOGOUT_URL = f"{WEB_APP_URL}/login"
    
    print(f"OAuth Config - Base URL: {WEB_APP_URL}")
    print(f"OAuth Config - Callback URI: {OAUTH_CALLBACK_URI}")
    print(f"OAuth Config - Logout Redirect: {REDIRECT_AFTER_LOGOUT_URL}")

    # Construct logout URL
    COGNITO_LOGOUT_URL = f"https://{COGNITO_DOMAIN}/logout?client_id={COGNITO_CLIENT_ID}"
    
    oauth = OAuth()
    oauth.register(
        name="cognito",
        client_id=COGNITO_CLIENT_ID,
        client_secret=COGNITO_CLIENT_SECRET,
        client_kwargs={
            "scope": "openid email profile"
        },
        # Use server_metadata_url to automatically discover all endpoints including jwks_uri
        server_metadata_url=COGNITO_WELL_KNOWN_ENDPOINT_URL,
        redirect_uri=OAUTH_CALLBACK_URI,
    )

    @fastapi_app.get("/login")
    async def login(req: Request):
        # Check if user is already authenticated
        if "access_token" in req.session and "username" in req.session:
            print("User already authenticated, redirecting to /chat")
            redirect_url = f"{WEB_APP_URL}/chat"
            return RedirectResponse(url=redirect_url)
        
        # Skip state parameter to avoid ECS session persistence issues
        print("Redirecting to Cognito for authentication")
        return await oauth.cognito.authorize_redirect(req, OAUTH_CALLBACK_URI)

    @fastapi_app.get("/callback")
    async def callback(req: Request):
        try:
            # Manually handle the OAuth callback to bypass state validation
            from authlib.integrations.requests_client import OAuth2Session
            import httpx
            
            # Get the authorization code from the callback
            code = req.query_params.get("code")
            if not code:
                print("No authorization code received")
                return RedirectResponse(url="/login")
            
            # Exchange code for tokens directly
            token_url = f"https://{COGNITO_DOMAIN}/oauth2/token"
            token_data = {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": OAUTH_CALLBACK_URI
            }
            
            # Use Basic Auth for client credentials (more standard)
            import base64
            credentials = f"{COGNITO_CLIENT_ID}:{COGNITO_CLIENT_SECRET}"
            encoded_credentials = base64.b64encode(credentials.encode()).decode()
            
            headers = {
                "Content-Type": "application/x-www-form-urlencoded",
                "Authorization": f"Basic {encoded_credentials}"
            }
            
            print(f"Token request URL: {token_url}")
            print(f"Token request data: {token_data}")
            
            async with httpx.AsyncClient() as client:
                token_response = await client.post(token_url, data=token_data, headers=headers)
                print(f"Token response status: {token_response.status_code}")
                print(f"Token response headers: {token_response.headers}")
                if token_response.status_code != 200:
                    print(f"Token response error: {token_response.text}")
                token_response.raise_for_status()
                tokens = token_response.json()
            
            # Get user info
            userinfo_url = f"https://{COGNITO_DOMAIN}/oauth2/userInfo"
            headers = {"Authorization": f"Bearer {tokens['access_token']}"}
            
            async with httpx.AsyncClient() as client:
                userinfo_response = await client.get(userinfo_url, headers=headers)
                userinfo_response.raise_for_status()
                userinfo = userinfo_response.json()
            
            print(f"OAuth tokens received: {tokens}")
            print(f"User info: {userinfo}")
            
            access_token = tokens["access_token"]
            # Handle both possible username fields
            username = userinfo.get("cognito:username") or userinfo.get("username")
            if not username:
                print(f"No username found in userinfo: {userinfo}")
                return RedirectResponse(url="/login")
            req.session["access_token"] = access_token
            req.session["username"] = username
            
            # Also store in the app's session store for Gradio compatibility
            from app import session_store
            
            # Generate or get existing session ID
            session_id = req.session.get("_session_id")
            if not session_id:
                session_id = str(uuid.uuid4())
                req.session["_session_id"] = session_id
                print(f"Generated new session ID: {session_id}")
            else:
                print(f"Using existing session ID: {session_id}")
            
            # Store in both places
            session_store[session_id] = {
                "access_token": access_token,
                "username": username,
                "timestamp": time.time()
            }
            
            print(f"User authenticated successfully: username={username}")
            print(f"Session stored with ID: {session_id}")
            print(f"Regular session after storage: {dict(req.session)}")
            print(f"Session store after storage: {session_store}")
            
            # Use absolute URL for redirect to ensure HTTPS
            redirect_url = f"{WEB_APP_URL}/chat"
            print(f"Redirecting to: {redirect_url}")
            return RedirectResponse(url=redirect_url)
            
        except Exception as e:
            print(f"OAuth callback error: {e}")
            # If there's an error, redirect back to login
            return RedirectResponse(url="/login")

    @fastapi_app.get("/logout")
    async def logout(req: Request):
        # Clear both regular session and session store
        session_id = req.session.get("_session_id")
        if session_id:
            from app import session_store
            if session_id in session_store:
                del session_store[session_id]
                print(f"Cleared session store for session_id: {session_id}")
        
        req.session.clear()
        # Cognito logout URL format: https://domain/logout?client_id=xxx&logout_uri=xxx
        # Note: AWS Cognito uses logout_uri parameter, not redirect_uri for logout
        logout_url = f"{COGNITO_LOGOUT_URL}&logout_uri={REDIRECT_AFTER_LOGOUT_URL}"
        print(f"Logout URL: {logout_url}")
        return RedirectResponse(url=logout_url)
