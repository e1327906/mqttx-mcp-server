const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const mqtt = require("mqtt");

// Custom Logger
class Logger {
  static LEVELS = {
    DEBUG: { value: 0, label: 'DEBUG', color: '\x1b[36m' }, // Cyan
    INFO: { value: 1, label: 'INFO', color: '\x1b[32m' },   // Green
    WARN: { value: 2, label: 'WARN', color: '\x1b[33m' },   // Yellow
    ERROR: { value: 3, label: 'ERROR', color: '\x1b[31m' }, // Red
  };
  
  static currentLevel = Logger.LEVELS.INFO;
  
  static formatTime() {
    const now = new Date();
    return now.toISOString();
  }
  
  static formatMessage(level, context, message, data = null) {
    const reset = '\x1b[0m';
    let logMessage = `${level.color}[${level.label}]\x1b[0m [${this.formatTime()}] [MQTTX:${context}] ${message}`;
    
    if (data) {
      if (typeof data === 'object') {
        try {
          // Limit object depth and handle circular references
          const safeJson = JSON.stringify(data, (key, value) => {
            if (key === 'mqttClient' || key === 'sseRes') return '[Object]';
            return value;
          }, 2);
          logMessage += `\n${safeJson}`;
        } catch (e) {
          logMessage += ` [Object: Unable to stringify]`;
        }
      } else {
        logMessage += ` ${data}`;
      }
    }
    
    return logMessage;
  }
  
  static debug(context, message, data = null) {
    if (Logger.currentLevel.value <= Logger.LEVELS.DEBUG.value) {
      console.log(this.formatMessage(Logger.LEVELS.DEBUG, context, message, data));
    }
  }
  
  static info(context, message, data = null) {
    if (Logger.currentLevel.value <= Logger.LEVELS.INFO.value) {
      console.log(this.formatMessage(Logger.LEVELS.INFO, context, message, data));
    }
  }
  
  static warn(context, message, data = null) {
    if (Logger.currentLevel.value <= Logger.LEVELS.WARN.value) {
      console.warn(this.formatMessage(Logger.LEVELS.WARN, context, message, data));
    }
  }
  
  static error(context, message, error = null) {
    if (Logger.currentLevel.value <= Logger.LEVELS.ERROR.value) {
      if (error instanceof Error) {
        console.error(this.formatMessage(Logger.LEVELS.ERROR, context, message, error.stack));
      } else {
        console.error(this.formatMessage(Logger.LEVELS.ERROR, context, message, error));
      }
    }
  }
}

// Initialize Express app
const app = express();
const port = 4000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Session management
const SessionManager = {
  sessions: new Map(),
  
  create(res) {
    const sessionId = uuidv4();
    this.sessions.set(sessionId, { 
      sseRes: res, 
      initialized: false,
      mqttClient: null
    });
    Logger.info("SessionManager", `New session created: ${sessionId}`);
    return sessionId;
  },
  
  get(sessionId) {
    return this.sessions.get(sessionId);
  },
  
  remove(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session && session.mqttClient) {
      Logger.debug("SessionManager", `Cleaning up MQTT client for session ${sessionId}`);
      session.mqttClient.end();
    }
    this.sessions.delete(sessionId);
    Logger.info("SessionManager", `Session closed: ${sessionId}`);
  },
  
  stats() {
    return {
      activeSessions: this.sessions.size,
      sessionsWithMqttConnections: [...this.sessions.values()].filter(s => s.mqttClient).length
    };
  }
};

// MQTT Handler
const MQTTHandler = {
  async connect(session, args) {
    const sessionId = [...SessionManager.sessions].find(([id, s]) => s === session)?.[0];
    Logger.info("MQTT", `Connecting to broker`, { sessionId, host: args.host, port: args.port, clientId: args.clientId });
    
    // Disconnect previous client if exists
    if (session.mqttClient) {
      Logger.debug("MQTT", `Disconnecting previous client`, { sessionId });
      session.mqttClient.end();
    }
    
    // Create connection options
    const options = {
      clientId: args.clientId,
      clean: true
    };
    
    if (args.username) options.username = args.username;
    if (args.password) options.password = args.password;
    
    // Create connection URL
    const protocol = args.port === 8883 ? 'mqtts' : 'mqtt';
    const url = `${protocol}://${args.host}:${args.port}`;
    
    try {
      // Connect to broker
      Logger.debug("MQTT", `Attempting connection to ${url}`, { sessionId, options: { ...options, password: options.password ? '****' : undefined } });
      const client = mqtt.connect(url, options);
      
      // Return a promise that resolves when connected or rejects on error
      return new Promise((resolve, reject) => {
        client.once('connect', () => {
          Logger.info("MQTT", `Connected to ${url}`, { sessionId, clientId: args.clientId });
          session.mqttClient = client;
          
          // Log all client events for debugging
          client.on('reconnect', () => {
            Logger.debug("MQTT", `Reconnecting to broker`, { sessionId });
          });
          
          client.on('close', () => {
            Logger.debug("MQTT", `Connection closed`, { sessionId });
          });
          
          client.on('error', (err) => {
            Logger.error("MQTT", `Client error`, { sessionId, error: err.message });
          });
          
          client.on('disconnect', () => {
            Logger.debug("MQTT", `Received disconnect packet`, { sessionId });
          });
          
          // Handle incoming messages
          client.on('message', (topic, message) => {
            const payload = message.toString();
            Logger.debug("MQTT", `Received message`, { 
              sessionId, 
              topic, 
              payload: payload.length > 200 ? payload.substring(0, 200) + '...' : payload,
              length: payload.length
            });
            
            // Forward to client via SSE
            this.sendMessageEvent(session.sseRes, {
              method: "notifications/message",
              params: {
                topic: topic,
                payload: payload
              }
            });
          });
          
          resolve({
            type: "text",
            text: `Successfully connected to MQTT broker at ${args.host}:${args.port} with client ID ${args.clientId}`
          });
        });
        
        client.once('error', (err) => {
          Logger.error("MQTT", `Connection error`, { sessionId, error: err.message });
          reject(err);
        });
      });
    } catch (error) {
      Logger.error("MQTT", `Connection error`, { sessionId, error: error.message });
      throw error;
    }
  },
  
  async subscribe(session, args) {
    const sessionId = [...SessionManager.sessions].find(([id, s]) => s === session)?.[0];
    
    if (!session.mqttClient) {
      Logger.error("MQTT", `Subscribe failed: Not connected`, { sessionId });
      throw new Error("Not connected to an MQTT broker");
    }
    
    const qos = args.qos || 0;
    Logger.info("MQTT", `Subscribing to topic`, { sessionId, topic: args.topic, qos });
    
    return new Promise((resolve, reject) => {
      session.mqttClient.subscribe(args.topic, { qos }, (err, granted) => {
        if (err) {
          Logger.error("MQTT", `Subscription error`, { sessionId, topic: args.topic, error: err.message });
          reject(err);
        } else {
          Logger.info("MQTT", `Subscribed to topic`, { 
            sessionId, 
            topic: args.topic, 
            qos,
            granted: granted
          });
          resolve({
            type: "text",
            text: `Successfully subscribed to MQTT topic '${args.topic}' with QoS ${qos}`
          });
        }
      });
    });
  },
  
  async publish(session, args) {
    const sessionId = [...SessionManager.sessions].find(([id, s]) => s === session)?.[0];
    
    if (!session.mqttClient) {
      Logger.error("MQTT", `Publish failed: Not connected`, { sessionId });
      throw new Error("Not connected to an MQTT broker");
    }
    
    const qos = args.qos || 0;
    const retain = args.retain || false;
    const payload = args.payload;
    
    Logger.info("MQTT", `Publishing message`, { 
      sessionId, 
      topic: args.topic, 
      payload: payload.length > 200 ? payload.substring(0, 200) + '...' : payload,
      length: payload.length,
      qos, 
      retain 
    });
    
    return new Promise((resolve, reject) => {
      session.mqttClient.publish(args.topic, payload, { qos, retain }, (err) => {
        if (err) {
          Logger.error("MQTT", `Publish error`, { sessionId, topic: args.topic, error: err.message });
          reject(err);
        } else {
          Logger.debug("MQTT", `Published message successfully`, { sessionId, topic: args.topic });
          resolve({
            type: "text",
            text: `Successfully published message to MQTT topic '${args.topic}' with QoS ${qos}, retain: ${retain}`
          });
        }
      });
    });
  },
  
  async disconnect(session) {
    const sessionId = [...SessionManager.sessions].find(([id, s]) => s === session)?.[0];
    
    if (!session.mqttClient) {
      Logger.warn("MQTT", `Disconnect called but not connected`, { sessionId });
      throw new Error("Not connected to an MQTT broker");
    }
    
    Logger.info("MQTT", `Disconnecting from broker`, { sessionId });
    
    return new Promise((resolve, reject) => {
      session.mqttClient.end(false, {}, (err) => {
        if (err) {
          Logger.error("MQTT", `Disconnect error`, { sessionId, error: err.message });
          reject(err);
        } else {
          Logger.info("MQTT", `Disconnected from MQTT broker`, { sessionId });
          session.mqttClient = null;
          resolve({
            type: "text",
            text: "Successfully disconnected from MQTT broker"
          });
        }
      });
    });
  },
  
  // Helper for sending events via SSE
  sendMessageEvent(sseRes, message) {
    if (!sseRes) return;
    
    const jsonMessage = typeof message === 'string' 
      ? message 
      : JSON.stringify(message);
      
    sseRes.write(`event: message\n`);
    sseRes.write(`data: ${jsonMessage}\n\n`);
    
    Logger.debug("SSE", `Sent message event`, { 
      messageType: message.method || 'unknown',
      messageLength: jsonMessage.length
    });
  }
};

// Response Handler
const ResponseHandler = {
  // Send JSON-RPC error response
  sendError(sseRes, id, code, message) {
    Logger.warn("RPC", `Sending error response`, { id, code, message });
    const errorRes = {
      jsonrpc: "2.0",
      id: id,
      error: { code, message }
    };
    MQTTHandler.sendMessageEvent(sseRes, errorRes);
  },
  
  // Send JSON-RPC success response
  sendResult(sseRes, id, result) {
    Logger.debug("RPC", `Sending success response`, { id });
    const successRes = {
      jsonrpc: "2.0",
      id: id,
      result
    };
    MQTTHandler.sendMessageEvent(sseRes, successRes);
  },
  
  // Send capabilities response
  sendCapabilities(sseRes, id) {
    Logger.debug("RPC", `Sending capabilities response`, { id });
    const capabilities = {
      jsonrpc: "2.0",
      id: id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: { listChanged: true },
          resources: { subscribe: true, listChanged: true },
          prompts: { listChanged: true },
          logging: {}
        },
        serverInfo: {
          name: "mqtt-server",
          version: "1.0.0"
        }
      }
    };
    MQTTHandler.sendMessageEvent(sseRes, capabilities);
  },
  
  // Send list of available tools
  sendToolsList(sseRes, id) {
    Logger.debug("RPC", `Sending tools list response`, { id });
    const toolsList = {
      jsonrpc: "2.0",
      id: id,
      result: {
        tools: [
          {
            name: "mqttConnect",
            description: "Connects to an MQTT broker with the specified parameters.",
            inputSchema: {
              type: "object",
              properties: {
                host: { type: "string", description: "MQTT broker host" },
                port: { type: "number", description: "MQTT broker port" },
                clientId: { type: "string", description: "Client identifier" },
                username: { type: "string", description: "Authentication username (optional)" },
                password: { type: "string", description: "Authentication password (optional)" }
              },
              required: ["host", "port", "clientId"]
            }
          },
          {
            name: "mqttSubscribe",
            description: "Subscribes to the specified MQTT topic.",
            inputSchema: {
              type: "object",
              properties: {
                topic: { type: "string", description: "MQTT topic to subscribe to" },
                qos: { type: "number", description: "Quality of Service (0, 1, or 2)" }
              },
              required: ["topic"]
            }
          },
          {
            name: "mqttPublish",
            description: "Publishes a message to the specified MQTT topic.",
            inputSchema: {
              type: "object",
              properties: {
                topic: { type: "string", description: "MQTT topic to publish to" },
                payload: { type: "string", description: "Message payload" },
                qos: { type: "number", description: "Quality of Service (0, 1, or 2)" },
                retain: { type: "boolean", description: "Whether to retain the message" }
              },
              required: ["topic", "payload"]
            }
          },
          {
            name: "mqttDisconnect",
            description: "Disconnects from the currently connected MQTT broker.",
            inputSchema: {
              type: "object",
              properties: {}
            }
          }
        ],
        count: 4
      }
    };
    MQTTHandler.sendMessageEvent(sseRes, toolsList);
  }
};

/*
 * Route 1: SSE Connection
 * Establishes Server-Sent Events connection with the client
 */
app.get("/mqttx/sse", (req, res) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  Logger.info("HTTP", `New SSE connection established`, { clientIp });

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Create a new session
  const sessionId = SessionManager.create(res);

  // Send endpoint information to client
  res.write(`event: endpoint\n`);
  res.write(`data: /mqttx/message?sessionId=${sessionId}\n\n`);
  Logger.debug("SSE", `Sent endpoint info to client`, { sessionId });

  // Log session stats 
  Logger.info("Server", `Session stats`, SessionManager.stats());

  // Send heartbeat every 10 seconds
  const heartbeat = setInterval(() => {
    const timestamp = Date.now();
    res.write(`event: heartbeat\ndata: ${timestamp}\n\n`);
    Logger.debug("SSE", `Sent heartbeat`, { sessionId, timestamp });
  }, 10000);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    Logger.info("HTTP", `SSE connection closed`, { sessionId });
    SessionManager.remove(sessionId);
    Logger.info("Server", `Session stats after disconnect`, SessionManager.stats());
  });
});

/*
 * Route 2: Message Handler
 * Handles JSON-RPC requests from client
 */
app.post("/mqttx/message", async (req, res) => {
  const sessionId = req.query.sessionId;
  const rpc = req.body;
  const method = rpc?.method || "unknown";
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  
  Logger.info("HTTP", `Received ${method} request`, { sessionId, clientIp, requestId: rpc?.id });

  // Validate session
  if (!sessionId) {
    Logger.error("HTTP", `Missing sessionId in request`, { clientIp });
    return res.status(400).json({ error: "Missing sessionId in query parameters" });
  }
  
  const session = SessionManager.get(sessionId);
  if (!session) {
    Logger.error("HTTP", `Invalid sessionId, no active session found`, { sessionId, clientIp });
    return res.status(404).json({ error: "No active session with that sessionId" });
  }

  // Validate JSON-RPC format
  if (!rpc || rpc.jsonrpc !== "2.0" || !rpc.method) {
    Logger.error("RPC", `Invalid JSON-RPC request`, { sessionId, request: JSON.stringify(rpc) });
    return res.json({
      jsonrpc: "2.0",
      id: rpc?.id ?? null,
      error: {
        code: -32600,
        message: "Invalid JSON-RPC request"
      }
    });
  }

  // Log received parameters if debug level
  Logger.debug("RPC", `Request parameters`, { 
    sessionId, 
    method: rpc.method,
    params: rpc.params 
  });

  // Send minimal HTTP acknowledgment
  res.json({
    jsonrpc: "2.0",
    id: rpc.id,
    result: { ack: `Received ${rpc.method}` }
  });
  Logger.debug("HTTP", `Sent acknowledgment response`, { sessionId, requestId: rpc.id });

  // Process the request
  try {
    const startTime = Date.now();
    await handleRequest(rpc, session);
    const processingTime = Date.now() - startTime;
    Logger.debug("RPC", `Request processing completed`, { 
      sessionId, 
      method: rpc.method, 
      requestId: rpc.id,
      processingTime: `${processingTime}ms` 
    });
  } catch (error) {
    Logger.error("RPC", `Error handling request`, { 
      sessionId, 
      method: rpc.method,
      requestId: rpc.id,
      error: error.message,
      stack: error.stack
    });
    ResponseHandler.sendError(session.sseRes, rpc.id, -32000, error.message);
  }
});

// Request handler function
async function handleRequest(rpc, session) {
  const { method, id } = rpc;
  const sseRes = session.sseRes;
  const sessionId = [...SessionManager.sessions].find(([id, s]) => s === session)?.[0];
  
  switch (method) {
    case "initialize":
      session.initialized = true;
      Logger.info("RPC", `Initializing session`, { sessionId, requestId: id });
      ResponseHandler.sendCapabilities(sseRes, id);
      break;
      
    case "tools/list":
      Logger.info("RPC", `Listing MQTT tools`, { sessionId, requestId: id });
      ResponseHandler.sendToolsList(sseRes, id);
      break;
      
    case "tools/call":
      const toolName = rpc.params?.name;
      const args = rpc.params?.arguments || {};
      Logger.info("RPC", `Tool call`, { sessionId, requestId: id, tool: toolName });
      
      try {
        let result;
        
        // Process tool calls
        switch (toolName) {
          case "mqttConnect":
            result = await MQTTHandler.connect(session, args);
            ResponseHandler.sendResult(sseRes, id, { content: [result] });
            break;
            
          case "mqttSubscribe":
            result = await MQTTHandler.subscribe(session, args);
            ResponseHandler.sendResult(sseRes, id, { content: [result] });
            break;
            
          case "mqttPublish":
            result = await MQTTHandler.publish(session, args);
            ResponseHandler.sendResult(sseRes, id, { content: [result] });
            break;
            
          case "mqttDisconnect":
            result = await MQTTHandler.disconnect(session);
            ResponseHandler.sendResult(sseRes, id, { content: [result] });
            break;
            
          default:
            Logger.warn("RPC", `Unknown tool requested`, { sessionId, requestId: id, tool: toolName });
            ResponseHandler.sendError(sseRes, id, -32601, `No such tool '${toolName}'`);
        }
      } catch (error) {
        Logger.error("RPC", `Tool error`, { sessionId, requestId: id, tool: toolName, error: error.message });
        ResponseHandler.sendError(sseRes, id, -32000, `MQTT operation error: ${error.message}`);
      }
      break;
      
    case "notifications/initialized":
      Logger.info("RPC", `Client initialized notification received`, { sessionId });
      // No response needed
      break;
      
    default:
      Logger.warn("RPC", `Unknown method called`, { sessionId, requestId: id, method });
      ResponseHandler.sendError(sseRes, id, -32601, `Method '${method}' not recognized`);
  }
}

// Start the server
app.listen(port, () => {
  Logger.info("Server", `Server started successfully on port ${port}`, { 
    endpoints: [
      `GET  /mqttx/sse - establishes SSE connection`,
      `POST /mqttx/message?sessionId=xxx - handles MQTT commands`
    ],
    version: "1.0.0",
    node: process.version
  });
});
