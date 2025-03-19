# MQTTX SSE Server

An implementation of the Model-Context Protocol (MCP) that enables MQTT operations over Server-Sent Events (SSE) transport.

## About MCP

The Model-Context Protocol (MCP) is a standardized protocol that allows AI assistants to interact with external tools and services. This server implements the MCP specification using SSE (Server-Sent Events) as the transport layer, providing MQTT broker connectivity capabilities.

## Features

- Implements MCP protocol version 2024-11-05
- Uses SSE (Server-Sent Events) as the transport layer
- Provides MQTT operations through MCP tools:
  - Connect to MQTT brokers
  - Subscribe to MQTT topics
  - Publish messages to MQTT topics
- Real-time message delivery from subscribed topics
- Session management for multiple clients

## Getting Started

### Prerequisites

- Node.js (v14 or later)
- npm

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/mqttx-sse-server.git
cd mqttx-sse-server

# Install dependencies
npm install
```

### Running the Server

```bash
npm start
```

The server will start on port 4000 by default.

## Configuring MQTTX

To use this MCP server with MQTTX, add the following configuration to your MQTTX settings:

```json
{
  "mcpServers": {
    "mqttx-server": {
      "url": "http://localhost:4000/mqttx/sse"
    }
  }
}
```

## MCP Protocol Implementation

This server implements the Model-Context Protocol with the following components:

- **SSE Connection**: Establishes persistent connection for real-time updates
- **JSON-RPC API**: Handles tool calls and responses according to MCP spec
- **Tools Interface**: Provides MQTT functionality through standardized MCP tools
- **Session Management**: Tracks client sessions and their MQTT connections

## API Reference

### SSE Connection

Establishes a persistent connection for receiving server events.

```plaintext
GET /mqttx/sse
```

Response events:

- `endpoint`: Contains the URL for making JSON-RPC calls
- `heartbeat`: Regular ping to keep the connection alive
- `message`: Contains JSON-RPC responses

### JSON-RPC Commands

All commands are sent to the message endpoint with your session ID:

```plaintext
POST /mqttx/message?sessionId=xxx
```

#### Initialize

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize"
}
```

#### List Tools

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list"
}
```

#### MQTT Connect

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "mqttConnect",
    "arguments": {
      "host": "broker.example.com",
      "port": 1883,
      "clientId": "mqttx-client"
    }
  }
}
```

#### MQTT Subscribe

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
      "name": "mqttSubscribe",
      "arguments": {
        "topic": "test/topic",
        "qos": 0
      }
  }
}
```

#### MQTT Publish

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
      "name": "mqttPublish",
      "arguments": {
        "topic": "test/topic",
        "payload": "Hello MQTT!",
        "qos": 0,
        "retain": false
      }
  }
}
```
