#!/bin/bash

# Simple test client script
# For testing Claude Agent SDK TypeScript server

BASE_URL="http://localhost:3000"

# Color definitions
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Claude Agent SDK TypeScript - Test Client${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Test 1: Health check
echo -e "${YELLOW}[Test 1]${NC} Health check..."
HEALTH_RESPONSE=$(curl -s "$BASE_URL/health")
if echo "$HEALTH_RESPONSE" | grep -q "ok"; then
    echo -e "${GREEN}✓${NC} Server health status OK"
    echo "   Response: $HEALTH_RESPONSE"
else
    echo -e "${RED}✗${NC} Health check failed"
    echo "   Response: $HEALTH_RESPONSE"
    exit 1
fi
echo ""

# Test 2: Simple conversation
echo -e "${YELLOW}[Test 2]${NC} Simple conversation test..."
echo -e "${BLUE}Sending message:${NC} 'Hello, please introduce yourself'"
echo ""

curl -N -X POST "$BASE_URL/api/chat" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "test_agent",
    "threadId": "test_thread_1",
    "messages": [
      {
        "id": "msg_1",
        "role": "user",
        "content": "Hello, please introduce yourself in one sentence"
      }
    ],
    "context": {}
  }' 2>/dev/null | while IFS= read -r line; do
    if [[ $line == data:* ]]; then
        # Extract JSON after data:
        json_data="${line#data: }"
        # Try to parse and format output
        event_type=$(echo "$json_data" | grep -o '"type":"[^"]*"' | cut -d'"' -f4)
        
        case $event_type in
            "run_started")
                echo -e "\n${GREEN}▶ Execution started${NC}"
                ;;
            "text_message_content")
                text=$(echo "$json_data" | grep -o '"text":"[^"]*"' | cut -d'"' -f4 | sed 's/\\n/\n/g')
                echo -n "$text"
                ;;
            "run_finished")
                echo -e "\n${GREEN}✓ Execution completed${NC}"
                ;;
            "error")
                error=$(echo "$json_data" | grep -o '"error":"[^"]*"' | cut -d'"' -f4)
                echo -e "\n${RED}✗ Error: $error${NC}"
                ;;
        esac
    fi
done

echo ""
echo ""

# Test 3: Multi-turn conversation
echo -e "${YELLOW}[Test 3]${NC} Multi-turn conversation test..."
echo -e "${BLUE}Round 1:${NC} 'My name is Zhang San'"
echo ""

curl -N -X POST "$BASE_URL/api/chat" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "test_agent",
    "threadId": "test_thread_2",
    "messages": [
      {
        "id": "msg_1",
        "role": "user",
        "content": "My name is Zhang San"
      }
    ],
    "context": {}
  }' 2>/dev/null | while IFS= read -r line; do
    if [[ $line == data:* ]]; then
        json_data="${line#data: }"
        event_type=$(echo "$json_data" | grep -o '"type":"[^"]*"' | cut -d'"' -f4)
        
        if [[ $event_type == "text_message_content" ]]; then
            text=$(echo "$json_data" | grep -o '"text":"[^"]*"' | cut -d'"' -f4)
            echo -n "$text"
        elif [[ $event_type == "run_finished" ]]; then
            echo ""
        fi
    fi
done

echo ""
echo ""
sleep 1

echo -e "${BLUE}Round 2:${NC} 'Do you remember my name?'"
echo ""

curl -N -X POST "$BASE_URL/api/chat" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "test_agent",
    "threadId": "test_thread_2",
    "messages": [
      {
        "id": "msg_1",
        "role": "user",
        "content": "My name is Zhang San"
      },
      {
        "id": "msg_2",
        "role": "assistant",
        "content": "Hello Zhang San! Nice to meet you."
      },
      {
        "id": "msg_3",
        "role": "user",
        "content": "Do you remember my name?"
      }
    ],
    "context": {}
  }' 2>/dev/null | while IFS= read -r line; do
    if [[ $line == data:* ]]; then
        json_data="${line#data: }"
        event_type=$(echo "$json_data" | grep -o '"type":"[^"]*"' | cut -d'"' -f4)
        
        if [[ $event_type == "text_message_content" ]]; then
            text=$(echo "$json_data" | grep -o '"text":"[^"]*"' | cut -d'"' -f4)
            echo -n "$text"
        elif [[ $event_type == "run_finished" ]]; then
            echo ""
        fi
    fi
done

echo ""
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✓ All tests completed!${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
