from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

class ProxyHeadersMiddleware(BaseHTTPMiddleware):
    """Middleware to handle X-Forwarded headers from load balancer"""
    
    async def dispatch(self, request: Request, call_next):
        # Handle X-Forwarded-Proto header
        if "x-forwarded-proto" in request.headers:
            proto = request.headers["x-forwarded-proto"]
            # Update the request URL scheme
            request.scope["scheme"] = proto
            
        # Handle X-Forwarded-Host header  
        if "x-forwarded-host" in request.headers:
            host = request.headers["x-forwarded-host"]
            # Update the request host
            request.scope["server"] = (host, None)
            
        response = await call_next(request)
        return response