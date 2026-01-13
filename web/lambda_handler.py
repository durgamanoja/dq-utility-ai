import json
import base64
from mangum import Mangum

# Lazy import to avoid loading Gradio during Lambda init
def get_fastapi_app():
    from app import fastapi_app
    return fastapi_app

# Global variable for the Mangum handler
_handler = None

def get_handler():
    global _handler
    if _handler is None:
        print("Initializing Mangum handler...")
        app = get_fastapi_app()
        _handler = Mangum(
            app, 
            lifespan="off",
            api_gateway_base_path="/",
            text_mime_types=["application/json", "text/plain", "text/html"]
        )
        print("Mangum handler initialized successfully")
    return _handler

def lambda_handler(event, context):
    """
    AWS Lambda handler that adapts FastAPI app to Lambda
    """
    try:
        # Get the lazily-loaded handler
        mangum_handler = get_handler()
        # Use Mangum to handle the Lambda event
        response = mangum_handler(event, context)
        return response
    except Exception as e:
        print(f"Error in lambda_handler: {e}")
        import traceback
        traceback.print_exc()
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)}),
            "headers": {
                "Content-Type": "application/json"
            }
        }

# Alias for Lambda runtime
handler = lambda_handler
