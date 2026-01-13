import json
import boto3
import os
from typing import Dict

# Initialize API Gateway Management API client
def get_api_gateway_client(event):
    """Get API Gateway Management API client for the current connection"""
    domain_name = event['requestContext']['domainName']
    stage = event['requestContext']['stage']
    endpoint_url = f"https://{domain_name}/{stage}"
    
    return boto3.client('apigatewaymanagementapi', endpoint_url=endpoint_url)

# In-memory connection store (in production, use DynamoDB)
connections: Dict[str, str] = {}  # connection_id -> username mapping
user_connections: Dict[str, str] = {}  # username -> connection_id mapping

def handler(event, context):
    """
    WebSocket Lambda handler for managing connections and messages
    """
    route_key = event['requestContext']['routeKey']
    connection_id = event['requestContext']['connectionId']
    
    print(f"WebSocket event: {route_key}, connection: {connection_id}")
    
    try:
        if route_key == '$connect':
            return handle_connect(event, context)
        elif route_key == '$disconnect':
            return handle_disconnect(event, context)
        elif route_key == '$default':
            return handle_message(event, context)
        else:
            return {'statusCode': 400, 'body': 'Unknown route'}
            
    except Exception as e:
        print(f"WebSocket handler error: {e}")
        return {'statusCode': 500, 'body': str(e)}

def handle_connect(event, context):
    """Handle new WebSocket connection"""
    connection_id = event['requestContext']['connectionId']
    
    # Store connection (in production, use DynamoDB)
    connections[connection_id] = None  # Username will be set later via auth message
    
    print(f"WebSocket connected: {connection_id}")
    return {'statusCode': 200, 'body': 'Connected'}

def handle_disconnect(event, context):
    """Handle WebSocket disconnection"""
    connection_id = event['requestContext']['connectionId']
    
    # Remove connection and user mapping
    username = connections.get(connection_id)
    if username and username in user_connections:
        del user_connections[username]
    
    if connection_id in connections:
        del connections[connection_id]
    
    print(f"WebSocket disconnected: {connection_id}")
    return {'statusCode': 200, 'body': 'Disconnected'}

def handle_message(event, context):
    """Handle incoming WebSocket messages"""
    connection_id = event['requestContext']['connectionId']
    
    try:
        # Parse message body
        body = json.loads(event.get('body', '{}'))
        message_type = body.get('type')
        
        if message_type == 'auth':
            # Handle authentication message
            username = body.get('username')
            if username:
                connections[connection_id] = username
                user_connections[username] = connection_id
                print(f"WebSocket auth: {username} -> {connection_id}")
                
                # Send confirmation
                api_client = get_api_gateway_client(event)
                api_client.post_to_connection(
                    ConnectionId=connection_id,
                    Data=json.dumps({
                        'type': 'auth_success',
                        'message': f'Authenticated as {username}'
                    })
                )
        
        return {'statusCode': 200, 'body': 'Message processed'}
        
    except Exception as e:
        print(f"Error handling message: {e}")
        return {'statusCode': 500, 'body': str(e)}

def send_notification_to_user(username: str, message: str, api_gateway_endpoint: str):
    """
    Send notification to a specific user via WebSocket
    This function can be called by other Lambda functions
    """
    try:
        if username not in user_connections:
            print(f"User {username} not connected to WebSocket")
            return False
        
        connection_id = user_connections[username]
        
        # Create API Gateway client
        api_client = boto3.client('apigatewaymanagementapi', endpoint_url=api_gateway_endpoint)
        
        # Send message
        api_client.post_to_connection(
            ConnectionId=connection_id,
            Data=json.dumps({
                'type': 'notification',
                'message': message,
                'timestamp': context.aws_request_id if 'context' in globals() else 'unknown'
            })
        )
        
        print(f"WebSocket notification sent to {username}")
        return True
        
    except Exception as e:
        print(f"Error sending WebSocket notification: {e}")
        # Clean up stale connection
        if username in user_connections:
            del user_connections[username]
        return False
