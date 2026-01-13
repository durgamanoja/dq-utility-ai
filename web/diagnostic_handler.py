import sys
import os
import traceback
import json

def handler(event, context):
    """Diagnostic handler to understand what's failing"""
    
    diagnostic_info = {
        "python_version": sys.version,
        "python_path": sys.path,
        "working_directory": os.getcwd(),
        "environment_vars": dict(os.environ),
        "files_in_lambda_task_root": [],
        "import_tests": {}
    }
    
    # List files in Lambda task root
    try:
        lambda_task_root = os.environ.get('LAMBDA_TASK_ROOT', '/var/task')
        if os.path.exists(lambda_task_root):
            diagnostic_info["files_in_lambda_task_root"] = os.listdir(lambda_task_root)
    except Exception as e:
        diagnostic_info["file_listing_error"] = str(e)
    
    # Test imports
    imports_to_test = ['json', 'fastapi', 'mangum', 'simple_app', 'simple_handler']
    
    for module_name in imports_to_test:
        try:
            if module_name == 'simple_handler':
                # Test the actual import that's failing
                from simple_handler import handler as simple_handler_func
                diagnostic_info["import_tests"][module_name] = "SUCCESS - handler function found"
            else:
                __import__(module_name)
                diagnostic_info["import_tests"][module_name] = "SUCCESS"
        except Exception as e:
            diagnostic_info["import_tests"][module_name] = f"FAILED: {str(e)}\n{traceback.format_exc()}"
    
    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(diagnostic_info, indent=2)
    }