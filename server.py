"""
MQTT MCP Server - Python Implementation using FastMCP
A Model Context Protocol server that provides MQTT operations
"""

from typing import Any, Optional, Dict, Union
import paho.mqtt.client as mqtt
from mcp.server.fastmcp import FastMCP
import sys
import logging
import os
import argparse
from dotenv import load_dotenv
import threading
import time
import asyncio
from concurrent.futures import ThreadPoolExecutor
import uuid
import json
from dataclasses import dataclass

# Load environment variables from .env file
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('mqtt-mcp-server')

# Initialize server
mcp = FastMCP("MQTT Client")

# Parse command line arguments for MQTT connection defaults
parser = argparse.ArgumentParser(description="MQTT MCP server")
parser.add_argument(
    "--host",
    dest="host",
    default=os.getenv("MQTT_HOST"),
    help="MQTT broker hostname or IP address"
)
parser.add_argument(
    "--port",
    dest="port",
    type=int,
    default=int(os.getenv("MQTT_PORT", "1883")),
    help="MQTT broker port (default: 1883)"
)
parser.add_argument(
    "--client-id",
    dest="client_id", 
    default=os.getenv("MQTT_CLIENT_ID"),
    help="MQTT client identifier"
)
parser.add_argument(
    "--username",
    dest="username",
    default=os.getenv("MQTT_USERNAME"),
    help="MQTT username for authentication"
)
parser.add_argument(
    "--password",
    dest="password",
    default=os.getenv("MQTT_PASSWORD"),
    help="MQTT password for authentication"
)
args, _ = parser.parse_known_args()

# Default MQTT connection parameters
DEFAULT_MQTT_HOST = args.host
DEFAULT_MQTT_PORT = args.port
DEFAULT_MQTT_CLIENT_ID = args.client_id
DEFAULT_MQTT_USERNAME = args.username
DEFAULT_MQTT_PASSWORD = args.password

logger.info(
    "Starting MQTT MCP server – default connection %s",
    (f"to {DEFAULT_MQTT_HOST}:{DEFAULT_MQTT_PORT}" if DEFAULT_MQTT_HOST else "(not set)")
)

# Global MQTT client management
@dataclass
class MQTTConnection:
    client: mqtt.Client
    connected: bool = False
    subscriptions: Dict[str, int] = None
    
    def __post_init__(self):
        if self.subscriptions is None:
            self.subscriptions = {}

# Global connection state
_mqtt_connection: Optional[MQTTConnection] = None
_connection_lock = threading.Lock()

# Message storage for subscribed topics
_received_messages = []
_message_lock = threading.Lock()

logger.info("Starting MQTT MCP server")

def get_mqtt_client() -> Optional[MQTTConnection]:
    """Get the current MQTT connection"""
    global _mqtt_connection
    with _connection_lock:
        return _mqtt_connection

def set_mqtt_client(connection: Optional[MQTTConnection]):
    """Set the current MQTT connection"""
    global _mqtt_connection
    with _connection_lock:
        if _mqtt_connection and _mqtt_connection != connection:
            # Clean up old connection
            try:
                _mqtt_connection.client.disconnect()
                _mqtt_connection.client.loop_stop()
            except Exception as e:
                logger.error(f"Error cleaning up old MQTT connection: {e}")
        _mqtt_connection = connection

def add_received_message(topic: str, payload: str):
    """Add a received message to the storage"""
    global _received_messages
    with _message_lock:
        timestamp = time.time()
        message = {
            "timestamp": timestamp,
            "topic": topic,
            "payload": payload
        }
        _received_messages.append(message)
        # Keep only last 100 messages
        if len(_received_messages) > 100:
            _received_messages = _received_messages[-100:]
        logger.info(f"Received message on topic '{topic}': {payload[:100]}{'...' if len(payload) > 100 else ''}")

@mcp.tool()
def mqtt_connect(host: Optional[str] = None, port: Optional[int] = None, client_id: Optional[str] = None, username: Optional[str] = None, password: Optional[str] = None) -> str:
    """Connect to an MQTT broker.
    
    Args:
        host: MQTT broker hostname or IP address (uses default from --host or MQTT_HOST if not provided)
        port: MQTT broker port (uses default from --port or MQTT_PORT if not provided, typically 1883 for non-TLS, 8883 for TLS)
        client_id: Unique client identifier (uses default from --client-id or MQTT_CLIENT_ID if not provided)
        username: Optional username for authentication (uses default from --username or MQTT_USERNAME if not provided)
        password: Optional password for authentication (uses default from --password or MQTT_PASSWORD if not provided)
    """
    try:
        # Use provided parameters or fall back to defaults
        final_host = host or DEFAULT_MQTT_HOST
        final_port = port or DEFAULT_MQTT_PORT
        final_client_id = client_id or DEFAULT_MQTT_CLIENT_ID
        final_username = username or DEFAULT_MQTT_USERNAME
        final_password = password or DEFAULT_MQTT_PASSWORD
        
        # Validate required parameters
        if not final_host:
            return "Error: MQTT host is required. Provide --host argument or set MQTT_HOST environment variable."
        
        if not final_port:
            return "Error: MQTT port is required. Provide --port argument or set MQTT_PORT environment variable."
        
        if not final_client_id:
            # Generate a random client ID if not provided
            final_client_id = f"mqtt-mcp-{uuid.uuid4().hex[:8]}"
            logger.info(f"Generated client ID: {final_client_id}")
        
        logger.info(f"Connecting to MQTT broker at {final_host}:{final_port} with client ID '{final_client_id}'")
        
        # Create new MQTT client
        client = mqtt.Client(final_client_id)
        
        # Set up authentication if provided
        if final_username:
            client.username_pw_set(final_username, final_password)
            logger.debug(f"Set authentication for user: {final_username}")
        
        # Connection result tracking
        connection_result = {"success": False, "error": None}
        connection_event = threading.Event()
        
        def on_connect(client, userdata, flags, rc):
            if rc == 0:
                logger.info(f"Successfully connected to MQTT broker")
                connection_result["success"] = True
            else:
                error_msg = f"Connection failed with return code {rc}"
                logger.error(error_msg)
                connection_result["error"] = error_msg
            connection_event.set()
        
        def on_disconnect(client, userdata, rc):
            logger.info(f"Disconnected from MQTT broker with return code {rc}")
            mqtt_conn = get_mqtt_client()
            if mqtt_conn:
                mqtt_conn.connected = False
        
        def on_message(client, userdata, msg):
            try:
                topic = msg.topic
                payload = msg.payload.decode('utf-8')
                add_received_message(topic, payload)
            except Exception as e:
                logger.error(f"Error processing received message: {e}")
        
        # Set callbacks
        client.on_connect = on_connect
        client.on_disconnect = on_disconnect
        client.on_message = on_message
        
        # Connect to broker
        client.connect(final_host, final_port, 60)
        client.loop_start()
        
        # Wait for connection result (with timeout)
        if not connection_event.wait(timeout=10):
            client.loop_stop()
            return "Connection timeout - failed to connect to MQTT broker within 10 seconds"
        
        if not connection_result["success"]:
            client.loop_stop()
            return f"Failed to connect: {connection_result['error']}"
        
        # Store the connection
        mqtt_conn = MQTTConnection(client=client, connected=True)
        set_mqtt_client(mqtt_conn)
        
        return f"Successfully connected to MQTT broker at {final_host}:{final_port} with client ID '{final_client_id}'"
        
    except Exception as e:
        error_msg = f"Connection error: {str(e)}"
        logger.error(error_msg)
        return error_msg

@mcp.tool()
def mqtt_disconnect() -> str:
    """Disconnect from the currently connected MQTT broker."""
    try:
        mqtt_conn = get_mqtt_client()
        if not mqtt_conn or not mqtt_conn.connected:
            return "Not connected to any MQTT broker"
        
        logger.info("Disconnecting from MQTT broker")
        
        mqtt_conn.client.disconnect()
        mqtt_conn.client.loop_stop()
        mqtt_conn.connected = False
        
        set_mqtt_client(None)
        
        logger.info("Successfully disconnected from MQTT broker")
        return "Successfully disconnected from MQTT broker"
        
    except Exception as e:
        error_msg = f"Disconnect error: {str(e)}"
        logger.error(error_msg)
        return error_msg

@mcp.tool()
def mqtt_subscribe(topic: str, qos: int = 0) -> str:
    """Subscribe to an MQTT topic.
    
    Args:
        topic: The MQTT topic to subscribe to (supports wildcards + and #)
        qos: Quality of Service level (0, 1, or 2). Default is 0.
    """
    try:
        mqtt_conn = get_mqtt_client()
        if not mqtt_conn or not mqtt_conn.connected:
            return "Error: Not connected to an MQTT broker. Use mqtt_connect first."
        
        if qos not in [0, 1, 2]:
            return "Error: QoS must be 0, 1, or 2"
        
        logger.info(f"Subscribing to topic '{topic}' with QoS {qos}")
        
        # Subscribe to topic
        result, mid = mqtt_conn.client.subscribe(topic, qos)
        
        if result != mqtt.MQTT_ERR_SUCCESS:
            return f"Error: Failed to subscribe to topic '{topic}'. Error code: {result}"
        
        # Store subscription
        mqtt_conn.subscriptions[topic] = qos
        
        logger.info(f"Successfully subscribed to topic '{topic}' with QoS {qos}")
        return f"Successfully subscribed to topic '{topic}' with QoS {qos}"
        
    except Exception as e:
        error_msg = f"Subscribe error: {str(e)}"
        logger.error(error_msg)
        return error_msg

@mcp.tool()
def mqtt_unsubscribe(topic: str) -> str:
    """Unsubscribe from an MQTT topic.
    
    Args:
        topic: The MQTT topic to unsubscribe from
    """
    try:
        mqtt_conn = get_mqtt_client()
        if not mqtt_conn or not mqtt_conn.connected:
            return "Error: Not connected to an MQTT broker"
        
        logger.info(f"Unsubscribing from topic '{topic}'")
        
        # Unsubscribe from topic
        result, mid = mqtt_conn.client.unsubscribe(topic)
        
        if result != mqtt.MQTT_ERR_SUCCESS:
            return f"Error: Failed to unsubscribe from topic '{topic}'. Error code: {result}"
        
        # Remove from subscriptions
        if topic in mqtt_conn.subscriptions:
            del mqtt_conn.subscriptions[topic]
        
        logger.info(f"Successfully unsubscribed from topic '{topic}'")
        return f"Successfully unsubscribed from topic '{topic}'"
        
    except Exception as e:
        error_msg = f"Unsubscribe error: {str(e)}"
        logger.error(error_msg)
        return error_msg

def serialize_payload(payload: Any) -> str:
    """Convert any payload type to a string for MQTT publishing.
    
    Args:
        payload: The payload to serialize (can be dict, list, str, int, float, bool, etc.)
        
    Returns:
        String representation of the payload
    """
    if isinstance(payload, str):
        return payload
    elif isinstance(payload, (dict, list)):
        try:
            return json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
        except (TypeError, ValueError) as e:
            logger.warning(f"Failed to serialize payload as JSON: {e}. Converting to string.")
            return str(payload)
    elif isinstance(payload, (int, float, bool)):
        return str(payload)
    elif payload is None:
        return ""
    else:
        # For any other type, convert to string
        return str(payload)

def detect_payload_type(payload: Any) -> str:
    """Detect the type of payload for better logging and reporting."""
    if isinstance(payload, str):
        # Check if it's a JSON string
        stripped = payload.strip()
        if stripped.startswith(('{', '[')):
            try:
                json.loads(payload)
                return "json-string"
            except (json.JSONDecodeError, TypeError):
                pass
        # Check for boolean strings
        if stripped.lower() in ('true', 'false'):
            return "boolean-string"
        # Check for numeric strings
        try:
            float(stripped)
            return "numeric-string"
        except ValueError:
            pass
        return "string"
    elif isinstance(payload, dict):
        return "dict"
    elif isinstance(payload, list):
        return "list"
    elif isinstance(payload, bool):
        return "boolean"
    elif isinstance(payload, int):
        return "integer"
    elif isinstance(payload, float):
        return "float"
    elif payload is None:
        return "null"
    else:
        return type(payload).__name__

@mcp.tool()
def mqtt_publish(topic: str, payload: Any, qos: int = 0, retain: bool = False) -> str:
    """Publish a message to an MQTT topic with automatic payload handling.
    
    Args:
        topic: The MQTT topic to publish to
        payload: The message payload to send. Supports multiple formats:
                - Plain text: Simple string messages
                - JSON objects: Pass objects directly, auto-serialized to JSON
                - JSON arrays: Pass arrays directly, auto-serialized to JSON
                - Numbers: Pass directly or as strings
                - Booleans: Pass directly or as strings
                - Multi-line text: Text with line breaks
        qos: Quality of Service level (0, 1, or 2). Default is 0.
        retain: Whether the message should be retained by the broker. Default is False.
    """
    try:
        mqtt_conn = get_mqtt_client()
        if not mqtt_conn or not mqtt_conn.connected:
            return "Error: Not connected to an MQTT broker. Use mqtt_connect first."
        
        if qos not in [0, 1, 2]:
            return "Error: QoS must be 0, 1, or 2"
        
        # Enhanced payload processing - handle both direct objects and strings
        if isinstance(payload, (dict, list)):
            # Direct JSON objects/arrays - serialize them
            try:
                payload_str = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
                payload_type = "dict" if isinstance(payload, dict) else "list"
            except (TypeError, ValueError) as e:
                return f"Error: Cannot serialize payload as JSON: {e}"
        elif isinstance(payload, str):
            # String payload - could be plain text, escaped JSON, or JSON string
            payload_str = payload
            payload_type = detect_payload_type(payload)
        else:
            # Other types (numbers, booleans, etc.)
            payload_str = serialize_payload(payload)
            payload_type = detect_payload_type(payload)
        
        logger.info(f"Publishing {payload_type} message to topic '{topic}' with QoS {qos}, retain={retain}")
        logger.debug(f"Payload content: {payload_str[:200]}{'...' if len(payload_str) > 200 else ''}")
        
        # Publish message
        info = mqtt_conn.client.publish(topic, payload_str, qos, retain)
        
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            return f"Error: Failed to publish message to topic '{topic}'. Error code: {info.rc}"
        
        # Wait for publish to complete for QoS > 0
        if qos > 0:
            info.wait_for_publish(timeout=5.0)
        
        logger.info(f"Successfully published {payload_type} message to topic '{topic}'")
        return f"Successfully published {payload_type} message to topic '{topic}' with QoS {qos}, retain={retain}"
        
    except Exception as e:
        error_msg = f"Publish error: {str(e)}"
        logger.error(error_msg)
        return error_msg

@mcp.tool()
def mqtt_publish_bulk(topic: str, payload: Any, count: int, qos: int = 0, retain: bool = False, increment_sequence: bool = True, delay_ms: int = 100) -> str:
    """Publish multiple identical or sequentially numbered messages to an MQTT topic.
    
    Args:
        topic: The MQTT topic to publish to
        payload: The base message payload (dict/JSON will have sequence numbers incremented if increment_sequence=True)
        count: Number of messages to send (max 1000 for safety)
        qos: Quality of Service level (0, 1, or 2). Default is 0.
        retain: Whether the messages should be retained by the broker. Default is False.
        increment_sequence: If True and payload is JSON with messageSequenceNumber, increment it for each message
        delay_ms: Delay between messages in milliseconds (default 100ms, min 10ms)
    """
    try:
        mqtt_conn = get_mqtt_client()
        if not mqtt_conn or not mqtt_conn.connected:
            return "Error: Not connected to an MQTT broker. Use mqtt_connect first."
        
        if qos not in [0, 1, 2]:
            return "Error: QoS must be 0, 1, or 2"
        
        if count <= 0 or count > 1000:
            return "Error: Count must be between 1 and 1000"
        
        if delay_ms < 10:
            delay_ms = 10
        
        logger.info(f"Starting bulk publish of {count} messages to topic '{topic}' with {delay_ms}ms delay")
        
        successful_publishes = 0
        failed_publishes = 0
        
        for i in range(1, count + 1):
            try:
                # Prepare payload for this iteration
                current_payload = payload
                payload_str = ""
                
                if isinstance(payload, dict) and increment_sequence:
                    # Create a copy and update sequence numbers
                    import copy
                    current_payload = copy.deepcopy(payload)
                    
                    # Update messageSequenceNumber if it exists
                    if ("payload" in current_payload and 
                        "messageHeader" in current_payload["payload"] and 
                        "messageSequenceNumber" in current_payload["payload"]["messageHeader"]):
                        current_payload["payload"]["messageHeader"]["messageSequenceNumber"] = i
                    
                    # Update deviceSequenceNumber if it exists
                    if ("payload" in current_payload and 
                        "messageHeader" in current_payload["payload"] and 
                        "deviceSequenceNumber" in current_payload["payload"]["messageHeader"]):
                        base_seq = current_payload["payload"]["messageHeader"]["deviceSequenceNumber"]
                        current_payload["payload"]["messageHeader"]["deviceSequenceNumber"] = base_seq + i - 1
                    
                    # Update timestamp if it exists
                    if ("payload" in current_payload and 
                        "messageHeader" in current_payload["payload"] and 
                        "transactionDateTime" in current_payload["payload"]["messageHeader"]):
                        import datetime
                        now = datetime.datetime.now()
                        timestamp = now + datetime.timedelta(seconds=i-1)
                        current_payload["payload"]["messageHeader"]["transactionDateTime"] = timestamp.strftime("%Y-%m-%d %H:%M:%S")
                    
                    # Update ticket number if it exists
                    if ("payload" in current_payload and 
                        "qrCodeTicketDataHeader" in current_payload["payload"] and 
                        "qrTicketNumber" in current_payload["payload"]["qrCodeTicketDataHeader"]):
                        base_ticket = current_payload["payload"]["qrCodeTicketDataHeader"]["qrTicketNumber"]
                        # Extract base and update the sequence part
                        if len(base_ticket) >= 10:
                            prefix = base_ticket[:-10]
                            suffix = f"{i:010d}"
                            current_payload["payload"]["qrCodeTicketDataHeader"]["qrTicketNumber"] = prefix + suffix
                
                # Serialize the payload
                if isinstance(current_payload, (dict, list)):
                    payload_str = json.dumps(current_payload, ensure_ascii=False, separators=(',', ':'))
                else:
                    payload_str = str(current_payload)
                
                # Publish the message
                info = mqtt_conn.client.publish(topic, payload_str, qos, retain)
                
                if info.rc == mqtt.MQTT_ERR_SUCCESS:
                    successful_publishes += 1
                    if qos > 0:
                        info.wait_for_publish(timeout=1.0)
                else:
                    failed_publishes += 1
                    logger.warning(f"Failed to publish message {i}, error code: {info.rc}")
                
                # Add delay between messages (except for the last one)
                if i < count:
                    time.sleep(delay_ms / 1000.0)
                
                # Log progress every 10 messages
                if i % 10 == 0:
                    logger.debug(f"Published {i}/{count} messages")
                    
            except Exception as e:
                failed_publishes += 1
                logger.error(f"Error publishing message {i}: {e}")
        
        payload_type = detect_payload_type(payload)
        logger.info(f"Bulk publish completed: {successful_publishes} successful, {failed_publishes} failed")
        
        result_msg = f"Bulk publish completed: {successful_publishes}/{count} messages successfully published to topic '{topic}'"
        if failed_publishes > 0:
            result_msg += f" ({failed_publishes} failed)"
        result_msg += f" with QoS {qos}, retain={retain}"
        if increment_sequence and isinstance(payload, dict):
            result_msg += " (with sequence number incrementation)"
        
        return result_msg
        
    except Exception as e:
        error_msg = f"Bulk publish error: {str(e)}"
        logger.error(error_msg)
        return error_msg

@mcp.tool()
def mqtt_get_received_messages(topic_filter: Optional[str] = None, limit: int = 10) -> str:
    """Get recently received messages from subscribed topics.
    
    Args:
        topic_filter: Optional topic filter to match against (supports simple wildcards)
        limit: Maximum number of messages to return (default 10, max 100)
    """
    try:
        global _received_messages
        
        # Validate limit
        if limit <= 0 or limit > 100:
            limit = 10
        
        with _message_lock:
            messages = _received_messages.copy()
        
        if not messages:
            return "No messages received yet"
        
        # Filter messages by topic if specified
        if topic_filter:
            filtered_messages = []
            for msg in messages:
                if topic_matches_filter(msg["topic"], topic_filter):
                    filtered_messages.append(msg)
            messages = filtered_messages
        
        if not messages:
            return f"No messages found matching topic filter '{topic_filter}'"
        
        # Get the most recent messages up to the limit
        recent_messages = messages[-limit:]
        
        # Format output
        result_lines = [f"Recent MQTT Messages (showing {len(recent_messages)} of {len(messages)} total):"]
        result_lines.append("-" * 60)
        
        for msg in recent_messages:
            timestamp = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(msg["timestamp"]))
            result_lines.append(f"Time: {timestamp}")
            result_lines.append(f"Topic: {msg['topic']}")
            result_lines.append(f"Payload: {msg['payload']}")
            result_lines.append("-" * 60)
        
        return "\n".join(result_lines)
        
    except Exception as e:
        error_msg = f"Error retrieving messages: {str(e)}"
        logger.error(error_msg)
        return error_msg

@mcp.tool()
def mqtt_status() -> str:
    """Get the current status of the MQTT connection and subscriptions."""
    try:
        mqtt_conn = get_mqtt_client()
        
        if not mqtt_conn:
            return "Status: Not connected to any MQTT broker"
        
        status_lines = []
        status_lines.append(f"Connection Status: {'Connected' if mqtt_conn.connected else 'Disconnected'}")
        
        if mqtt_conn.subscriptions:
            status_lines.append(f"Active Subscriptions ({len(mqtt_conn.subscriptions)}):")
            for topic, qos in mqtt_conn.subscriptions.items():
                status_lines.append(f"  - {topic} (QoS {qos})")
        else:
            status_lines.append("Active Subscriptions: None")
        
        # Message count
        with _message_lock:
            message_count = len(_received_messages)
        status_lines.append(f"Received Messages: {message_count}")
        
        return "\n".join(status_lines)
        
    except Exception as e:
        error_msg = f"Error getting status: {str(e)}"
        logger.error(error_msg)
        return error_msg

@mcp.tool()
def mqtt_connect_default() -> str:
    """Connect to MQTT broker using default settings from command line arguments or environment variables."""
    return mqtt_connect()

@mcp.tool()
def mqtt_get_default_settings() -> str:
    """Get the current default MQTT connection settings from command line arguments or environment variables."""
    try:
        settings_lines = ["Default MQTT Connection Settings:"]
        settings_lines.append("-" * 40)
        settings_lines.append(f"Host: {DEFAULT_MQTT_HOST or '(not set)'}")
        settings_lines.append(f"Port: {DEFAULT_MQTT_PORT or '(not set)'}")
        settings_lines.append(f"Client ID: {DEFAULT_MQTT_CLIENT_ID or '(will be auto-generated)'}")
        settings_lines.append(f"Username: {DEFAULT_MQTT_USERNAME or '(not set)'}")
        settings_lines.append(f"Password: {'***' if DEFAULT_MQTT_PASSWORD else '(not set)'}")
        settings_lines.append("")
        settings_lines.append("You can override these by:")
        settings_lines.append("1. Using command line arguments: --host, --port, --client-id, --username, --password")
        settings_lines.append("2. Setting environment variables: MQTT_HOST, MQTT_PORT, MQTT_CLIENT_ID, MQTT_USERNAME, MQTT_PASSWORD")
        settings_lines.append("3. Providing parameters directly to mqtt_connect()")
        
        return "\n".join(settings_lines)
        
    except Exception as e:
        error_msg = f"Error getting default settings: {str(e)}"
        logger.error(error_msg)
        return error_msg

def topic_matches_filter(topic: str, topic_filter: str) -> bool:
    """Simple topic filter matching (basic wildcard support)"""
    if topic_filter == "*":
        return True
    if "*" in topic_filter:
        # Simple wildcard matching
        import fnmatch
        return fnmatch.fnmatch(topic, topic_filter)
    return topic == topic_filter

if __name__ == "__main__":
    try:
        logger.info("Starting MCP MQTT server...")
        mcp.run()
    except Exception as e:
        logger.error(f"Server error: {str(e)}")
        sys.exit(1)
