# DQ Utility AI - Data Quality Agent on AWS ECS

This repository contains an AI-powered Data Quality (DQ) Agent that helps users analyze and query data using natural language. The system is built on AWS ECS with a modern microservices architecture for scalability and reliability.

## 🏗️ Architecture Overview
<img width="1408" height="736" alt="image" src="https://github.com/user-attachments/assets/b51552ab-fd5e-493b-afb1-b0c51534f74f" />

### Core Services (ECS Fargate)

#### **1. Web Application Service**
- **Technology**: Gradio + FastAPI + WebSocket
- **Port**: 8001
- **Purpose**: User interface and real-time notifications
- **Features**:
  - OAuth 2.0 authentication via Cognito
  - WebSocket for live query updates
  - Session management with S3 backend
  - Responsive chat interface

#### **2. DQ Agent Service**
- **Technology**: Python + Bedrock + MCP Client
- **Port**: 8000
- **Purpose**: AI-powered query processing and coordination
- **Features**:
  - Natural language to SQL conversion
  - Intelligent query routing (Athena vs Glue)
  - User context awareness
  - Session state management

#### **3. MCP Server Service**
- **Technology**: Node.js + MCP SDK + AWS SDK
- **Port**: 3001
- **Purpose**: Data access tools and query execution
- **Features**:
  - Standardized tool interface (MCP protocol)
  - Cross-account data access
  - Async job management
  - Comprehensive logging

### Supporting Services

#### **4. Lambda Poller (VPC-enabled)**
- **Purpose**: Monitor long-running Glue jobs
- **Trigger**: Invoked by MCP Server when Glue job starts
- **Function**: Polls job status and notifies Agent when complete
- **Timeout**: 15 minutes with configurable polling interval

#### **5. AWS Glue Jobs**
- **Purpose**: Execute complex SQL queries on large datasets
- **Configuration**: Glue 5.0, G.2X workers, Python 3
- **Output**: Results stored in S3 with session-based partitioning

#### **6. Amazon Athena**
- **Purpose**: Fast SQL queries for smaller datasets
- **Configuration**: Custom workgroup with service role
- **Integration**: Direct execution from MCP Server

### Data Storage & Networking

#### **7. Amazon S3 Buckets**
- **Session Storage**: Agent conversation state
- **Query Results**: Athena and Glue job outputs
- **Glue Scripts**: Dynamic SQL executor scripts

#### **8. VPC Architecture**
- **Shared VPC**: All ECS services in same network
- **Private Subnets**: Services isolated from internet
- **NAT Gateway**: Outbound internet access for containers
- **Security Groups**: Service-to-service communication rules

### Authentication & Authorization Flow

```
User Login → Cognito → JWT Token → Web App → Agent → MCP Server
     │                    │           │        │         │
     └─OAuth 2.0──────────┘           │        │         │
                                      │        │         │
                              Session │        │ Shared  │
                              Storage │        │ Secret  │
                                  S3  │        │   JWT   │
                                      ▼        ▼         ▼
                              User Context → Agent Context → Tool Context
```

### Query Execution Patterns

#### **Pattern 1: Fast Queries (Athena)**
```
User Query → Agent → MCP Server → Athena → Results (sync)
                                     │
                                     ▼
                              S3 Results Storage
```

#### **Pattern 2: Large Dataset Queries (Glue)**
```
User Query → Agent → MCP Server → Glue Job → Lambda Poller
                                     │             │
                                     ▼             ▼
                              S3 Results ← Notification → Agent → WebSocket → User
```

### Scalability & Reliability Features

#### **Auto Scaling Configuration**
- **Min Capacity**: 1 container per service
- **Max Capacity**: 5-10 containers per service
- **Scaling Metrics**: CPU utilization (70% threshold)
- **Scale Out**: 60 seconds cooldown
- **Scale In**: 300 seconds cooldown

#### **Health Check Strategy**
- **Health Endpoints**: `/health` on all services
- **Check Interval**: 30 seconds
- **Timeout**: 10 seconds
- **Healthy Threshold**: 2 consecutive successes
- **Unhealthy Threshold**: 5 consecutive failures

#### **Load Balancer Configuration**
- **Idle Timeout**: 900 seconds (15 minutes)
- **Deregistration Delay**: 300 seconds (5 minutes)
- **Connection Draining**: Graceful shutdown support
- **Health Check**: Application-level validation

### Frontend & Backend Connectivity Architecture

#### **Web Application Stack (Frontend)**
```
┌─────────────────────────────────────────────────────────────┐
│                    Web App (ECS Fargate)                   │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │     Gradio      │  │    FastAPI      │  │  WebSocket  │ │
│  │   (Frontend)    │  │   (Backend)     │  │  Manager    │ │
│  │                 │  │                 │  │             │ │
│  │ • Chat Interface│  │ • OAuth Handler │  │ • Real-time │ │
│  │ • User Input    │  │ • Session Mgmt  │  │   Updates   │ │
│  │ • Result Display│  │ • API Endpoints │  │ • Async     │ │
│  │                 │  │                 │  │   Messaging │ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
│           │                     │                    │     │
│           └─────────────────────┼────────────────────┘     │
│                                 │                          │
└─────────────────────────────────┼──────────────────────────┘
                                  │
                                  ▼
                    ┌─────────────────────────┐
                    │   Application LB        │
                    │   (15min timeout)       │
                    └─────────────────────────┘
```

#### **Backend Services Communication**
```
┌─────────────────────────────────────────────────────────────┐
│                 ECS Agent (Backend)                         │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │   Flask App     │  │  MCP Client     │  │  WebSocket  │ │
│  │                 │  │   Manager       │  │   Client    │ │
│  │ • /agent        │  │                 │  │             │ │
│  │ • /health       │  │ • Tool Calling  │  │ • Notify    │ │
│  │ • /system/*     │  │ • Auth Handling │  │   Web App   │ │
│  │                 │  │ • Session State │  │             │ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
│           │                     │                    │     │
│           └─────────────────────┼────────────────────┘     │
│                                 │                          │
└─────────────────────────────────┼──────────────────────────┘
                                  │
                                  ▼
                    ┌─────────────────────────┐
                    │   Application LB        │
                    │   (15min timeout)       │
                    └─────────────────────────┘
```

#### **Service-to-Service Communication Patterns**

**Pattern 1: Synchronous Request-Response**
```
Web App (FastAPI) → ECS Agent (Flask) → MCP Server (Node.js)
     │                      │                    │
     │ HTTP POST /agent     │ HTTP POST /mcp     │
     │ JWT Token            │ Shared Secret JWT  │
     │                      │                    │
     ▼                      ▼                    ▼
Response ◄─────────── Response ◄─────────── Tool Result
```

**Pattern 2: Asynchronous Notification**
```
Lambda Poller → ECS Agent → Web App → User Browser
     │              │          │           │
     │ HTTP POST     │ WebSocket│ WebSocket │
     │ /system/      │ Notify   │ Message   │
     │ glue-result   │          │           │
     │               │          │           │
     ▼               ▼          ▼           ▼
Job Complete → Process → Update UI → Show Results
```

#### **Frontend-Backend Integration Details**

**1. Web App Frontend (Gradio)**
- **Technology**: Python Gradio with custom JavaScript
- **Features**:
  - Chat interface with message history
  - Real-time WebSocket connection
  - OAuth 2.0 login integration
  - Responsive design with avatars

**2. Web App Backend (FastAPI)**
- **Technology**: Python FastAPI with async support
- **Endpoints**:
  - `GET /` - Root redirect to chat or login
  - `GET /health` - Health check for load balancer
  - `POST /api/notify` - Receive notifications from Agent
  - `WebSocket /ws/{session_id}` - Real-time communication

**3. Agent Backend (Flask)**
- **Technology**: Python Flask with threading support
- **Endpoints**:
  - `POST /agent` - Main query processing endpoint
  - `GET /health` - Health check for load balancer
  - `POST /system/glue-result` - Async job completion handler

**4. WebSocket Communication Protocol**
```javascript
// Frontend WebSocket Messages
{
  "type": "auth",
  "username": "alice"
}

{
  "type": "chat_update", 
  "message": "New results available",
  "timestamp": 1704067200000
}
```

#### **Data Flow Architecture**

**Synchronous Flow (Fast Queries)**
1. **User Input** → Gradio chat interface
2. **Frontend** → FastAPI backend via HTTP
3. **Web App** → ECS Agent via HTTP POST `/agent`
4. **Agent** → MCP Server via HTTP POST `/mcp`
5. **MCP Server** → Athena query execution
6. **Results** → Return through same chain
7. **Display** → Gradio updates chat interface

**Asynchronous Flow (Large Queries)**
1. **User Input** → Gradio chat interface
2. **Frontend** → FastAPI backend via HTTP
3. **Web App** → ECS Agent via HTTP POST `/agent`
4. **Agent** → MCP Server via HTTP POST `/mcp`
5. **MCP Server** → Glue job trigger + Lambda Poller
6. **Immediate Response** → "Query started" message
7. **Background Processing** → Glue job execution
8. **Job Completion** → Lambda Poller → Agent `/system/glue-result`
9. **Notification** → Agent → Web App `/api/notify`
10. **WebSocket Push** → Real-time update to user browser
11. **UI Update** → Gradio refreshes with results

```

This architecture ensures **seamless communication** between frontend and backend components while maintaining **real-time responsiveness** and **scalable performance** for data quality operations.

## 🚀 Key Features

### Intelligent Query Routing
- **Fast Queries** → Amazon Athena (seconds to minutes)
- **Large Datasets** → AWS Glue Jobs (minutes to hours)
- **Automatic Detection** - Agent chooses the best execution engine

### Real-time Notifications
- **WebSocket Integration** - Live updates during query execution
- **Async Processing** - Non-blocking query execution
- **Progress Tracking** - Real-time status updates

### Enterprise Security
- **OAuth 2.0** - Cognito-based authentication
- **JWT Authorization** - Secure service-to-service communication
- **Cross-Account Access** - Lake Formation integration
- **VPC Isolation** - Private networking for all services

## 🛠️ Technology Stack

### Frontend & API
- **Gradio** - Interactive web interface
- **FastAPI** - Web application framework
- **WebSocket** - Real-time communication

### AI & Processing
- **Amazon Bedrock** - Claude 3.5 Haiku for natural language processing
- **MCP (Model Context Protocol)** - Standardized tool integration
- **AWS Glue** - Distributed data processing
- **Amazon Athena** - Serverless SQL queries

### Infrastructure
- **AWS ECS Fargate** - Containerized microservices
- **Application Load Balancer** - Traffic distribution with 15-minute timeouts
- **Amazon VPC** - Private networking
- **AWS Lambda** - Event-driven functions

## 📋 Available Tools

### Data Discovery
- **`glue-get-table`** - Retrieve table schema and metadata
- **`athena-query-executor`** - Execute fast SQL queries
- **`glue-job-trigger`** - Launch distributed data processing jobs

### Data Access
- **`s3-connector`** - Access files and query results
- **`get-glue-job-status`** - Monitor job execution progress

## 🚀 Deployment Guide

### Prerequisites
- AWS CLI configured with appropriate permissions
- Docker installed
- Node.js 18+ installed
- Access to Amazon Bedrock Claude models in `us-east-1`

### 1. Clone Repository
```bash
git clone <repository-url>
cd dq_utility_ai
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Deploy Infrastructure
```bash
cdk deploy
```

This will create:
- ECS clusters and services
- Application Load Balancers
- Cognito User Pool
- S3 buckets
- Glue jobs and Athena workgroup
- Lambda functions

### 4. Configure Environment
```bash
./prep-web.sh
```

This script will:
- Set up Cognito user passwords (Alice/Bob with `Passw0rd@`)
- Generate environment configuration
- Configure service endpoints

### 5. Access the Application

The web application will be available at the ALB URL provided in the CDK outputs

## 🔐 Authentication

### User Login
- **Username**: `Alice` or `Bob`
- **Password**: `Passw0rd@`
- **Method**: OAuth 2.0 via Amazon Cognito

### Service Authentication
- **Agent ↔ MCP**: JWT with shared secret
- **User ↔ Agent**: Cognito JWT tokens
- **Cross-Account**: IAM role assumption

## 💬 Usage Examples

### Data Discovery
```
"What tables are available in the fin_datamart database?"
"Show me the schema for the vendor_details table"
```

### Data Analysis
```
"Get me the record count of vendor_details table"
"How many customers are in the customer_data table?"
"Show me the top 10 vendors by transaction volume"
```

### Complex debugging prompts
```
PROMPT 1: 
The SQL logic used to populate the AP Summary table is stored at:
s3://xxx/scripts/xxx/ap_summary.sql

This script is used to load the test table:
fin_datamart.ap_summary

The corresponding production table is:
fin_datamart_prod.ap_summary

The primary key for both tables is:
invoice_id

What I need you to do:

1)         Read and understand the SQL script from the S3 location provided.
2)         Identify all source and intermediate tables referenced in the script and review their structures using Glue.
3)         Compare the production and test tables for data from the last 3 days.
4)         Find invoice_id values that exist in production but are missing in the test table.
5)         Select 2 sample invoice_id values from these missing records.
6)         Trace each selected invoice_id through the SQL logic and source tables to determine where and why it was excluded from the final test table.

Final Output
Please provide:
The 2 missing invoice_id values
The table(s) or step(s) in the SQL logic where they were filtered out or dropped
A clear explanation of the exact condition or join that caused each invoice to be missing
Be concise, factual, and base your explanation strictly on the SQL logic and table data

PROMPT 2:
The SQL logic used to populate the AP Summary table is stored at:
 s3://xxx/scripts/xx/ap_xx_temp.sql

the Airflow DAG that runs this script is in
s3://xxx/dag_config/alpha/xxx_temp.yml

This script is used to load the test table:
fin_datamart.ap_xxx_temp

The corresponding production table is:
fin_datamart_prod.ap_xxx_temp

The primary key for both tables is:
invoice_id,defect_id,resolved_date

What I need you to do:
1)         Read and understand the SQL script from the S3 location provided.
2)         Identify all source and intermediate tables referenced in the script and review their structures using Glue.
3)         Compare the production and test tables for data from the last 3 days.
4)         Find invoice_id,defect_id,resolved_date comninations that exist in production but are missing in the test table.
5)         Select 2 sample primary key values from these missing records.
6)         Trace each selected primary key through the SQL logic and source tables to determine where and why it was excluded from the final test table.If any source table used in the SQL script is created in the DAG provided ,you must trace that too and give the final result why the primary keys are missed.

Final Output
Please provide:
The 2 missing primary key values
The table(s) or step(s) in the SQL logic where they were filtered out or dropped
A clear explanation of the exact condition or join that caused each invoice to be missing
Be concise, factual, and base your explanation strictly on the SQL logic and table data.
 
```

## 🔧 Configuration

### Environment Variables
Key configuration is managed through CDK and includes:
- **AGENT_ENDPOINT_URL** - ECS Agent service URL
- **MCP_ENDPOINT** - MCP Server service URL
- **COGNITO_CLIENT_ID** - Authentication configuration
- **ATHENA_WORKGROUP** - Query execution workgroup

### Timeout Settings
- **Load Balancer**: 15 minutes (for long-running queries)
- **Athena Queries**: 5 minutes maximum
- **Glue Jobs**: Up to 6 hours with polling

## 📊 Monitoring & Logging

### CloudWatch Logs
- `/ecs/dq-web-app` - Web application logs
- `/ecs/dq-agent` - Agent processing logs
- `/ecs/dq-mcp-server` - MCP server logs
- `/aws/lambda/GlueJobPollerLambda` - Poller function logs

### Health Checks
- **Web App**: `https://<alb-url>/health`
- **Agent**: `https://<agent-alb-url>/health`
- **MCP Server**: `https://<mcp-alb-url>/health`

## 🔄 Architecture Benefits

### Scalability
- **Auto Scaling** - ECS services scale based on CPU/memory
- **Load Balancing** - Distributed traffic across containers
- **Stateless Design** - Horizontal scaling without session affinity

### Reliability
- **Health Checks** - Automatic container replacement
- **Graceful Shutdowns** - 5-minute deregistration delay
- **Multi-AZ Deployment** - High availability across zones

### Performance
- **Container Optimization** - Fast startup and resource efficiency
- **Connection Pooling** - Efficient database connections
- **Async Processing** - Non-blocking query execution

## 🧹 Cleanup

To remove all resources:
```bash
cdk destroy
```

This will delete all ECS services, load balancers, and associated resources.

## 📝 License

This project is licensed under the MIT-0 License. See the LICENSE file for details.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📞 Support

For issues and questions:
1. Check CloudWatch logs for error details
2. Verify ECS service health in AWS Console
3. Review load balancer target group health
4. Check Cognito user pool configuration
