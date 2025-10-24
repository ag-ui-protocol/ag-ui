"""
Flowise Agent for AG-UI
"""

import json
import requests
from typing import List, Dict, Any, Optional
from dataclasses import dataclass, asdict
from datetime import datetime

from ag_ui.core.events import (
    BaseEvent,
    EventType,
    RunStartedEvent,
    RunFinishedEvent,
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    MessagesSnapshotEvent
)
from ag_ui.core.types import Message


@dataclass
class FlowiseAgentConfig:
    """Configuration for Flowise Agent"""
    api_url: str
    flow_id: str
    api_key: Optional[str] = None
    headers: Optional[Dict[str, str]] = None


@dataclass
class FlowiseResponse:
    """Response from Flowise API"""
    text: str
    question: str
    chat_id: Optional[str] = None
    session_id: Optional[str] = None
    source_documents: Optional[List[Dict[str, Any]]] = None
    used_tools: Optional[List[Dict[str, Any]]] = None


class FlowiseAgent:
    """Flowise Agent for AG-UI"""
    
    def __init__(self, config: FlowiseAgentConfig):
        self.config = config
        self.api_url = config.api_url.replace('{flowId}', config.flow_id)
    
    def clone(self):
        """Create a clone of this agent"""
        return FlowiseAgent(self.config)
    
    def run(self, input_data: Dict[str, Any]) -> List[BaseEvent]:
        """
        Run the Flowise agent
        
        Args:
            input_data: Input data containing messages, threadId, runId, etc.
            
        Returns:
            List of AG-UI events
        """
        events: List[BaseEvent] = []
        
        try:
            # Emit run started event
            run_started_event = RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.get('threadId', ''),
                run_id=input_data.get('runId', '')
            )
            events.append(run_started_event)
            
            # Get the last user message
            last_user_message = self._get_last_user_message(input_data.get('messages', []))
            if not last_user_message:
                raise ValueError("No user message found")
            
            # Prepare the request to Flowise
            request_body = {
                'question': last_user_message.get('content', ''),
                'history': self._format_history(input_data.get('messages', [])),
                'overrideConfig': {
                    'sessionId': input_data.get('threadId', '')
                }
            }
            
            # Set up headers
            headers = {
                'Content-Type': 'application/json',
                **(self.config.headers or {})
            }
            
            if self.config.api_key:
                headers['Authorization'] = f'Bearer {self.config.api_key}'
            
            # Make the API call to Flowise
            response = requests.post(
                self.api_url,
                headers=headers,
                json=request_body,
                timeout=30
            )
            
            response.raise_for_status()
            flowise_response_data = response.json()
            
            # Create FlowiseResponse object
            flowise_response = FlowiseResponse(
                text=flowise_response_data.get('text', ''),
                question=flowise_response_data.get('question', ''),
                chat_id=flowise_response_data.get('chatId'),
                session_id=flowise_response_data.get('sessionId'),
                source_documents=flowise_response_data.get('sourceDocuments'),
                used_tools=flowise_response_data.get('usedTools')
            )
            
            # Emit text message events
            message_id = str(int(datetime.now().timestamp() * 1000))
            
            text_message_start_event = TextMessageStartEvent(
                type=EventType.TEXT_MESSAGE_START,
                message_id=message_id,
                role="assistant"
            )
            events.append(text_message_start_event)
            
            text_message_content_event = TextMessageContentEvent(
                type=EventType.TEXT_MESSAGE_CONTENT,
                message_id=message_id,
                delta=flowise_response.text
            )
            events.append(text_message_content_event)
            
            text_message_end_event = TextMessageEndEvent(
                type=EventType.TEXT_MESSAGE_END,
                message_id=message_id
            )
            events.append(text_message_end_event)
            
            # Emit messages snapshot
            messages_snapshot = list(input_data.get('messages', [])) + [{
                'id': message_id,
                'role': 'assistant',
                'content': flowise_response.text,
                'timestamp': datetime.now().isoformat()
            }]
            
            messages_snapshot_event = MessagesSnapshotEvent(
                type=EventType.MESSAGES_SNAPSHOT,
                messages=messages_snapshot
            )
            events.append(messages_snapshot_event)
            
            # Emit run finished event
            run_finished_event = RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input_data.get('threadId', ''),
                run_id=input_data.get('runId', '')
            )
            events.append(run_finished_event)
            
        except Exception as e:
            raise e
            
        return events
    
    def _get_last_user_message(self, messages: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        """Get the last user message from the messages list"""
        # Find the last user message by working backwards from the last message
        for i in range(len(messages) - 1, -1, -1):
            if messages[i].get('role') == 'user':
                return messages[i]
        return None
    
    def _format_history(self, messages: List[Dict[str, Any]]) -> List[Dict[str, str]]:
        """Format message history for Flowise API"""
        history = []
        for msg in messages:
            if msg.get('role') in ['user', 'assistant']:
                history.append({
                    'role': 'userMessage' if msg.get('role') == 'user' else 'apiMessage',
                    'content': msg.get('content', '')
                })
        return history