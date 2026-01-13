from user import User
import jwt
from strands.tools.mcp.mcp_client import MCPClient
from mcp.client.streamable_http import streamablehttp_client
import os
import logging

jwt_signature_secret = os.environ['JWT_SIGNATURE_SECRET']
mcp_endpoint = os.getenv("MCP_ENDPOINT")

l = logging.getLogger(__name__)

mcp_tools = {}
mcp_clients = {}

# Shared MCP client cache (since all users use the same MCP server)
_shared_mcp_client = None
_shared_mcp_tools = None

def get_mcp_tools_for_user(user: User):
    import time
    start_time = time.time()
    
    # Use shared cache first (container-level optimization)
    global _shared_mcp_client, _shared_mcp_tools
    if _shared_mcp_client and _shared_mcp_tools:
        l.info(f"🚀 Using shared MCP client/tools (container cache hit)")
        return _shared_mcp_tools
    
    # Fallback to user-specific cache
    if user.id in mcp_tools and user.id in mcp_clients:
        l.info(f"existing mcp client/tools found for user.id={user.id}")
        return mcp_tools[user.id]

    l.info(f"mcp client/tools for user.id={user.id} not found. creating.")

    try:
        # Add timeout tracking for JWT creation
        jwt_start = time.time()
        token = jwt.encode({
            "sub":"DQ-agent",
            "user_id": user.id,
            "user_name": user.name,
        }, jwt_signature_secret, algorithm="HS256")
        l.info(f"JWT creation took {time.time() - jwt_start:.2f}s")

        # Add timeout tracking for MCP client creation with connection timeout
        client_start = time.time()
        mcp_client = MCPClient(lambda: streamablehttp_client(
            url=mcp_endpoint,
            headers={"Authorization": f"Bearer {token}"},
            timeout=10.0  # Add 10-second timeout for HTTP requests
        ))
        l.info(f"MCP client creation took {time.time() - client_start:.2f}s")

        # Add timeout tracking for MCP client start with timeout
        start_client_time = time.time()
        try:
            mcp_client.start()
            l.info(f"MCP client start took {time.time() - start_client_time:.2f}s")
        except Exception as start_error:
            l.warning(f"MCP client start failed after {time.time() - start_client_time:.2f}s: {start_error}")
            # Return empty tools if MCP server is unavailable
            return []

        # Add timeout tracking for tools listing with timeout
        tools_start = time.time()
        try:
            tools = mcp_client.list_tools_sync()
            l.info(f"MCP tools listing took {time.time() - tools_start:.2f}s")
        except Exception as tools_error:
            l.warning(f"MCP tools listing failed after {time.time() - tools_start:.2f}s: {tools_error}")
            # Return empty tools if listing fails
            return []

        # Store in both user-specific and shared cache
        mcp_clients[user.id] = mcp_client
        mcp_tools[user.id] = tools
        
        # Update shared cache for future requests
        _shared_mcp_client = mcp_client
        _shared_mcp_tools = tools
        
        total_time = time.time() - start_time
        l.info(f"Total MCP initialization took {total_time:.2f}s")
        
        return mcp_tools[user.id]
        
    except Exception as e:
        l.error(f"MCP client initialization failed after {time.time() - start_time:.2f}s: {e}")
        # Return empty tools list to prevent complete failure
        return []
