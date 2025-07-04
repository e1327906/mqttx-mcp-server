# MQTT MCP Server (Python with FastMCP)

An implementation of the Model-Context Protocol (MCP) that enables MQTT operations using the FastMCP framework.

## About MCP

The Model-Context Protocol (MCP) is a standardized protocol that allows AI assistants to interact with external tools and services. This server implements the MCP specification using the FastMCP framework, providing MQTT broker connectivity capabilities.

## Features

- Implements MCP protocol version 2024-11-05
- Uses FastMCP framework for simplified MCP server development
- Provides MQTT operations through MCP tools:
  - Connect to MQTT brokers
  - Subscribe to MQTT topics
  - Publish messages to MQTT topics
  - Get received messages from subscriptions
  - View connection status
- Message storage and retrieval for subscribed topics
- Simplified architecture following MCP best practices

## Getting Started

### Prerequisites

- Python 3.8 or later
- pip

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/mqttx-mcp-server.git
cd mqttx-mcp-server

# Install dependencies
pip install -r requirements.txt
```

### Running the Server

```bash
# Run with Python directly (uses defaults from environment or arguments)
python server.py

# Run with command line arguments
python server.py --host test.mosquitto.org --port 1883 --client-id my-client

# Run with authentication
python server.py --host broker.example.com --username myuser --password mypass

# The server uses stdio transport by default (MCP standard)
# For testing with Claude Desktop or other MCP clients
```

### Command Line Arguments

The server supports the following command line arguments for default MQTT connection settings:

```bash
python server.py [options]

Options:
  --host HOST           MQTT broker hostname or IP address
  --port PORT           MQTT broker port (default: 1883)
  --client-id CLIENT_ID MQTT client identifier
  --username USERNAME   MQTT username for authentication
  --password PASSWORD   MQTT password for authentication
```

### Environment Variables

You can also configure defaults using environment variables:

```bash
# Set environment variables
export MQTT_HOST=test.mosquitto.org
export MQTT_PORT=1883
export MQTT_CLIENT_ID=my-client
export MQTT_USERNAME=myuser
export MQTT_PASSWORD=mypass

# Run the server
python server.py
```

Or create a `.env` file (copy from `.env.template`):

```env
MQTT_HOST=test.mosquitto.org
MQTT_PORT=1883
MQTT_CLIENT_ID=my-client
MQTT_USERNAME=myuser
MQTT_PASSWORD=mypass
```

The server will start and listen for MCP client connections on stdin/stdout.

## Configuring with Claude Desktop

To use this MCP server with Claude Desktop, add the following configuration to your Claude Desktop settings:

### Basic Configuration (using environment variables)
```json
{
  "mcpServers": {
    "mqtt": {
      "command": "python",
      "args": ["path/to/server.py"],
      "cwd": "path/to/mqttx-mcp-server"
    }
  }
}
```

### Configuration with Command Line Arguments
```json
{
  "mcpServers": {
    "mqtt": {
      "command": "python",
      "args": [
        "path/to/server.py",
        "--host", "test.mosquitto.org",
        "--port", "1883",
        "--client-id", "claude-mqtt-client"
      ],
      "cwd": "path/to/mqttx-mcp-server"
    }
  }
}
```

### Configuration with Authentication
```json
{
  "mcpServers": {
    "mqtt": {
      "command": "python", 
      "args": [
        "path/to/server.py",
        "--host", "broker.example.com",
        "--username", "myuser",
        "--password", "mypass"
      ],
      "cwd": "path/to/mqttx-mcp-server"
    }
  }
}
```

## Available Tools

The server provides the following MCP tools:

### 1. mqtt_connect
Connects to an MQTT broker with optional parameters.

**Parameters (all optional - uses defaults from CLI args or env vars):**
- `host` (string, optional): MQTT broker hostname or IP address
- `port` (int, optional): MQTT broker port 
- `client_id` (string, optional): Unique client identifier
- `username` (string, optional): Username for authentication
- `password` (string, optional): Password for authentication

### 2. mqtt_connect_default
Connects to an MQTT broker using all default settings from command line arguments or environment variables.

**Parameters:** None

### 3. mqtt_get_default_settings
Shows the current default MQTT connection settings.

**Parameters:** None

### 4. mqtt_disconnect
Disconnects from the currently connected MQTT broker.

**Parameters:** None

### 5. mqtt_subscribe
Subscribes to an MQTT topic.

**Parameters:**
- `topic` (string): The MQTT topic to subscribe to (supports wildcards + and #)
- `qos` (int, optional): Quality of Service level (0, 1, or 2). Default is 0.

### 6. mqtt_unsubscribe
Unsubscribes from an MQTT topic.

**Parameters:**
- `topic` (string): The MQTT topic to unsubscribe from

### 7. mqtt_publish
Publishes a message to an MQTT topic with enhanced payload support.

**Parameters:**
- `topic` (string): The MQTT topic to publish to
- `payload` (string): The message payload to send. Supports multiple formats:
  - **Plain text**: Simple string messages
  - **JSON objects**: Use escaped JSON strings (e.g., `{\"key\":\"value\"}`)
  - **Multi-line text**: Text with line breaks
  - **Numbers/Booleans**: Passed as strings, automatically handled
- `qos` (int, optional): Quality of Service level (0, 1, or 2). Default is 0.
- `retain` (bool, optional): Whether the message should be retained by the broker. Default is False.

**Payload Examples:**
- Simple text: `"Hello World"`
- JSON object: `"{\"temperature\":25.5,\"humidity\":60}"`
- Complex JSON: `"{\"data\":{\"nested\":true}}"`
- Multi-line: `"Line 1\nLine 2\nLine 3"`

### Enhanced Payload Examples

The MQTT publish tool supports various payload formats:

1. **Simple text messages:**
   ```
   Publish "Temperature reading: 25.5°C" to topic "sensors/temp01"
   ```

2. **JSON sensor data:**
   ```
   Publish this JSON to topic "sensors/data": {"temperature":25.5,"humidity":60,"timestamp":"2025-01-27T16:45:00Z"}
   ```

3. **Complex nested JSON:**
   ```
   Send this transit ticket data to topic "transport/tickets": {"payloadHashMac":"abc123","payload":{"ticketId":12345,"status":"validated"}}
   ```

4. **Array data:**
   ```
   Publish this device list to "devices/inventory": [{"id":1,"name":"Sensor A"},{"id":2,"name":"Sensor B"}]
   ```

5. **Multi-line status reports:**
   ```
   Publish to "system/status":
   System Status Report
   CPU: 75%
   Memory: 60%
   Disk: 45%
   Status: OK
   ```

**Note:** For JSON payloads, ensure proper escaping of quotes when passing complex objects directly.

### 8. mqtt_get_received_messages
Gets recently received messages from subscribed topics.

**Parameters:**
- `topic_filter` (string, optional): Topic filter to match against (supports simple wildcards)
- `limit` (int, optional): Maximum number of messages to return (default 10, max 100)

### 9. mqtt_status
Gets the current status of the MQTT connection and subscriptions.

**Parameters:** None

## Usage Examples

Once connected to a Claude Desktop session with this MCP server configured:

1. **Check default settings:**
   ```
   Show me the default MQTT connection settings
   ```

2. **Connect using defaults:**
   ```
   Connect to MQTT using the default settings
   ```

3. **Connect to a specific broker:**
   ```
   Connect to the MQTT broker at test.mosquitto.org on port 1883 with client ID "claude-test"
   ```

4. **Connect with authentication:**
   ```
   Connect to MQTT broker at broker.example.com with username "myuser" and password "mypass"
   ```

5. **Subscribe to a topic:**
   ```
   Subscribe to the topic "sensors/temperature" with QoS 1
   ```

6. **Publish a message:**
   ```
   Publish "Hello World" to the topic "test/message"
   ```

7. **Check received messages:**
   ```
   Show me the recent messages received on all subscribed topics
   ```

8. **Filter messages by topic:**
   ```
   Show me messages from topics matching "sensors/*"
   ```

9. **Check connection status:**
   ```
   What's the current MQTT connection status?
   ```

## Development

### Project Structure

```
mqttx-mcp-server/
├── server.py              # Main Python server implementation using FastMCP
├── requirements.txt       # Python dependencies
├── README.md              # This file
├── test_server.py         # Test script for server functionality
└── LICENSE               # License file
```

### Key Components

- **FastMCP**: Framework for building MCP servers with simple decorators
- **MQTTConnection**: Dataclass managing MQTT client state and subscriptions
- **Global State Management**: Thread-safe handling of MQTT connections and message storage
- **Tool Functions**: Individual MCP tools decorated with `@mcp.tool()`

### Dependencies

- **mcp**: Model Context Protocol framework (FastMCP)
- **paho-mqtt**: MQTT client library for Python
- **python-dotenv**: Environment variable management

### Running in Development

```bash
# Install in development mode
pip install -r requirements.txt

# Run the server
python server.py

# Test with MCP client or use the inspector
npx @modelcontextprotocol/inspector python server.py
```

## Environment Variables

You can configure the server using a `.env` file:

```env
# MQTT connection defaults (optional)
MQTT_HOST=localhost
MQTT_PORT=1883
MQTT_CLIENT_ID=mqtt-mcp-server
```

## Testing

### Manual Testing

Use the MCP Inspector to test the server:

```bash
# Install the MCP Inspector
npm install -g @modelcontextprotocol/inspector

# Run the inspector with your server
npx @modelcontextprotocol/inspector python server.py
```

### Integration Testing

The server can be tested with any MCP-compatible client. The standard testing approach is to:

1. Connect to an MQTT broker (like test.mosquitto.org)
2. Subscribe to a test topic
3. Publish messages to verify round-trip functionality
4. Check received messages

## Troubleshooting

### Common Issues

1. **Import errors**: Make sure you have installed the `mcp` package
2. **MQTT connection failed**: Check broker host, port, and network connectivity
3. **Permission denied**: Ensure Python has necessary permissions

### Logging

The server provides detailed logging output. To increase verbosity, modify the logging level in `server.py`:

```python
logging.basicConfig(
    level=logging.DEBUG,  # Change to DEBUG for more verbose output
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
```

## Architecture Changes

This version has been completely rewritten to follow FastMCP patterns:

### Key Changes from Previous Version:
- **Transport**: Moved from SSE to stdio (standard MCP transport)
- **Framework**: Replaced FastAPI with FastMCP
- **Session Management**: Simplified to single global connection state
- **Message Handling**: Added persistent message storage for received MQTT messages
- **Tool Definition**: Used FastMCP decorators for cleaner tool definitions

### Benefits:
- **Simpler Architecture**: Less complex than SSE-based implementation
- **Standard Compliance**: Follows MCP best practices
- **Better Integration**: Works seamlessly with Claude Desktop and other MCP clients
- **Easier Testing**: Can use standard MCP testing tools

## License

This project is licensed under the ISC License - see the LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## Changelog

### v1.0.0 (Python)
- Converted from Node.js to Python implementation
- Uses FastAPI instead of Express
- Async/await support throughout
- Improved error handling and logging
- Pydantic models for request validation
- Better session management with thread safety
