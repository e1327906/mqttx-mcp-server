const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const mqtt = require("mqtt");

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
    console.log(`[MQTTX] New session created: ${sessionId}`);
    return sessionId;
  },
  
  get(sessionId) {
    return this.sessions.get(sessionId);
  },
  
  remove(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session && session.mqttClient) {
      session.mqttClient.end();
    }
    this.sessions.delete(sessionId);
    console.log(`[MQTTX] Session closed: ${sessionId}`);
  }
};

// MQTT Handler
const MQTTHandler = {
  async connect(session, args) {
    // Disconnect previous client if exists
    if (session.mqttClient) {
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
      const client = mqtt.connect(url, options);
      
      // Return a promise that resolves when connected or rejects on error
      return new Promise((resolve, reject) => {
        client.once('connect', () => {
          console.log(`[MQTTX] Connected to ${url}`);
          session.mqttClient = client;
          
          // Handle incoming messages
          client.on('message', (topic, message) => {
            console.log(`[MQTTX] Received message on topic ${topic}: ${message.toString()}`);
            // Forward to client via SSE
            this.sendMessageEvent(session.sseRes, {
              method: "notifications/message",
              params: {
                topic: topic,
                payload: message.toString()
              }
            });
          });
          
          resolve({
            type: "text",
            text: `Successfully connected to MQTT broker at ${args.host}:${args.port} with client ID ${args.clientId}`
          });
        });
        
        client.once('error', (err) => {
          console.log(`[MQTTX] Connection error: ${err.message}`);
          reject(err);
        });
      });
    } catch (error) {
      console.log(`[MQTTX] Connection error: ${error.message}`);
      throw error;
    }
  },
  
  async subscribe(session, args) {
    if (!session.mqttClient) {
      throw new Error("Not connected to an MQTT broker");
    }
    
    const qos = args.qos || 0;
    
    return new Promise((resolve, reject) => {
      session.mqttClient.subscribe(args.topic, { qos }, (err) => {
        if (err) {
          console.log(`[MQTTX] Subscription error: ${err.message}`);
          reject(err);
        } else {
          console.log(`[MQTTX] Subscribed to topic ${args.topic} with QoS ${qos}`);
          resolve({
            type: "text",
            text: `Successfully subscribed to MQTT topic '${args.topic}' with QoS ${qos}`
          });
        }
      });
    });
  },
  
  async publish(session, args) {
    if (!session.mqttClient) {
      throw new Error("Not connected to an MQTT broker");
    }
    
    const qos = args.qos || 0;
    const retain = args.retain || false;
    
    return new Promise((resolve, reject) => {
      session.mqttClient.publish(args.topic, args.payload, { qos, retain }, (err) => {
        if (err) {
          console.log(`[MQTTX] Publish error: ${err.message}`);
          reject(err);
        } else {
          console.log(`[MQTTX] Published message to topic ${args.topic}`);
          resolve({
            type: "text",
            text: `Successfully published message to MQTT topic '${args.topic}' with QoS ${qos}, retain: ${retain}`
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
  }
};

// Response Handler
const ResponseHandler = {
  // Send JSON-RPC error response
  sendError(sseRes, id, code, message) {
    const errorRes = {
      jsonrpc: "2.0",
      id: id,
      error: { code, message }
    };
    MQTTHandler.sendMessageEvent(sseRes, errorRes);
  },
  
  // Send JSON-RPC success response
  sendResult(sseRes, id, result) {
    const successRes = {
      jsonrpc: "2.0",
      id: id,
      result
    };
    MQTTHandler.sendMessageEvent(sseRes, successRes);
  },
  
  // Send capabilities response
  sendCapabilities(sseRes, id) {
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
          }
        ],
        count: 3
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
  console.log("[MQTTX] New SSE connection established");

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Create a new session
  const sessionId = SessionManager.create(res);

  // Send endpoint information to client
  res.write(`event: endpoint\n`);
  res.write(`data: /mqttx/message?sessionId=${sessionId}\n\n`);

  // Send heartbeat every 10 seconds
  const heartbeat = setInterval(() => {
    res.write(`event: heartbeat\ndata: ${Date.now()}\n\n`);
  }, 10000);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    SessionManager.remove(sessionId);
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
  
  console.log(`[MQTTX] Received ${method} request for session ${sessionId}`);

  // Validate session
  if (!sessionId) {
    return res.status(400).json({ error: "Missing sessionId in query parameters" });
  }
  
  const session = SessionManager.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "No active session with that sessionId" });
  }

  // Validate JSON-RPC format
  if (!rpc || rpc.jsonrpc !== "2.0" || !rpc.method) {
    return res.json({
      jsonrpc: "2.0",
      id: rpc?.id ?? null,
      error: {
        code: -32600,
        message: "Invalid JSON-RPC request"
      }
    });
  }

  // Send minimal HTTP acknowledgment
  res.json({
    jsonrpc: "2.0",
    id: rpc.id,
    result: { ack: `Received ${rpc.method}` }
  });

  // Process the request
  try {
    await handleRequest(rpc, session);
  } catch (error) {
    console.error(`[MQTTX] Error handling request: ${error.message}`);
    ResponseHandler.sendError(session.sseRes, rpc.id, -32000, error.message);
  }
});

// Request handler function
async function handleRequest(rpc, session) {
  const { method, id } = rpc;
  const sseRes = session.sseRes;
  
  switch (method) {
    case "initialize":
      session.initialized = true;
      console.log(`[MQTTX] Initializing session`);
      ResponseHandler.sendCapabilities(sseRes, id);
      break;
      
    case "tools/list":
      console.log(`[MQTTX] Listing MQTT tools`);
      ResponseHandler.sendToolsList(sseRes, id);
      break;
      
    case "tools/call":
      const toolName = rpc.params?.name;
      const args = rpc.params?.arguments || {};
      console.log(`[MQTTX] Tool call: ${toolName}`);
      
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
            
          default:
            console.log(`[MQTTX] Unknown tool: ${toolName}`);
            ResponseHandler.sendError(sseRes, id, -32601, `No such tool '${toolName}'`);
        }
      } catch (error) {
        console.error(`[MQTTX] Tool error: ${error.message}`);
        ResponseHandler.sendError(sseRes, id, -32000, `MQTT operation error: ${error.message}`);
      }
      break;
      
    case "notifications/initialized":
      console.log(`[MQTTX] Client initialized`);
      // No response needed
      break;
      
    default:
      console.log(`[MQTTX] Unknown method: ${method}`);
      ResponseHandler.sendError(sseRes, id, -32601, `Method '${method}' not recognized`);
  }
}

// Start the server
app.listen(port, () => {
  console.log(`[MQTTX] Server running at http://localhost:${port}`);
  console.log(`[MQTTX] Endpoints:`);
  console.log(`  - GET  /mqttx/sse - establishes SSE connection`);
  console.log(`  - POST /mqttx/message?sessionId=xxx - handles MQTT commands`);
});
