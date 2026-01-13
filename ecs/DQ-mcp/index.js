import './logging.js';
import log4js from 'log4js';
import express from 'express';
import transport from './transport.js';
import packageInfo from './package.json' with { type: 'json'};
import jwt from 'jsonwebtoken';
const JWT_SIGNATURE_SECRET = process.env.JWT_SIGNATURE_SECRET || 'jwt-signature-secret';

const l = log4js.getLogger();
const PORT = process.env.AWS_LWA_PORT || process.env.PORT || 3001;

// This function is using Lambda Web Adapter to run express.js on Lambda
// https://github.com/awslabs/aws-lambda-web-adapter
const app = express();

app.use(express.json());
app.use(async (req, res, next) => {
    l.debug(`> ${req.method} ${req.originalUrl}`);
    if (req.body && Object.keys(req.body).length > 0) {
        l.debug('Request body:', req.body);
    }
    // l.debug(req.headers);
    return next();
});

// Health check endpoint for ALB
app.get('/health', (req, res) => {
    try {
        const healthResponse = {
            status: 'healthy',
            service: 'dq-mcp-server',
            version: packageInfo.version || '0.0.1',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            memory: process.memoryUsage()
        };
        
        l.debug('Health check response:', healthResponse);
        res.status(200).json(healthResponse);
    } catch (error) {
        l.error('Health check error:', error);
        res.status(500).json({
            status: 'unhealthy',
            service: 'dq-mcp-server',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});
    
app.use('/mcp', async (req, res, next) => {
    // Validate authorization header
    const authorizationHeader = req.headers['authorization'];
    try {
        const jwtString = authorizationHeader.split(' ')[1];
        const claims = jwt.verify(jwtString, JWT_SIGNATURE_SECRET);
        // Inject authorization context into request 
        // object so MCP Server will pick it up automatically
        req.auth = claims;
    } catch (e) {
        l.warn(`Failed to parse authorization header, ${e}`);
        return res.status(401).send('Unauthorized');
    }

    return next();
});

await transport.bootstrap(app);

app.listen(PORT, () => {
    l.debug(`version=${packageInfo.version} :: listening on http://localhost:${PORT}`);
});
