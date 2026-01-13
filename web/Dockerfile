# Use AWS Lambda Python runtime as base image
FROM public.ecr.aws/lambda/python:3.12

# Set environment variables for Lambda optimization
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV GRADIO_SERVER_NAME=0.0.0.0
ENV GRADIO_SERVER_PORT=7860

# Copy requirements and install dependencies with optimizations
COPY requirements-complete.txt ${LAMBDA_TASK_ROOT}/
RUN pip install --no-cache-dir --only-binary=all -r requirements-complete.txt && \
    pip cache purge && \
    find /var/lang/lib/python3.12/site-packages -name "*.pyc" -delete && \
    find /var/lang/lib/python3.12/site-packages -name "__pycache__" -type d -exec rm -rf {} + || true

# Copy application code
COPY app.py ${LAMBDA_TASK_ROOT}/
COPY lambda_handler.py ${LAMBDA_TASK_ROOT}/
COPY websocket_handler.py ${LAMBDA_TASK_ROOT}/
COPY oauth.py ${LAMBDA_TASK_ROOT}/
COPY arch.png ${LAMBDA_TASK_ROOT}/

# Set Lambda handler
CMD ["lambda_handler.handler"]
