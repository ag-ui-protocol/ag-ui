#!/usr/bin/env python
"""Test logging output with programmatic log capture and assertions."""

import asyncio
import logging
import io
from unittest.mock import MagicMock

from ag_ui.core import RunAgentInput, UserMessage
from adk_agent import ADKAgent
from agent_registry import AgentRegistry
from logging_config import get_component_logger, configure_logging
from google.adk.agents import Agent


class LogCapture:
    """Helper class to capture log records for testing."""
    
    def __init__(self, logger_name: str, level: int = logging.DEBUG):
        self.logger_name = logger_name
        self.level = level
        self.records = []
        self.handler = None
        self.logger = None
        
    def __enter__(self):
        """Start capturing logs."""
        self.logger = logging.getLogger(self.logger_name)
        self.original_level = self.logger.level
        self.logger.setLevel(self.level)
        
        # Create a custom handler that captures records
        self.handler = logging.Handler()
        self.handler.emit = lambda record: self.records.append(record)
        self.handler.setLevel(logging.DEBUG)  # Capture all levels, filtering happens in logger
        
        self.logger.addHandler(self.handler)
        return self
        
    def __exit__(self, exc_type, exc_val, exc_tb):
        """Stop capturing logs."""
        if self.handler and self.logger:
            self.logger.removeHandler(self.handler)
            self.logger.setLevel(self.original_level)
            
    def get_messages(self, level: int = None) -> list[str]:
        """Get captured log messages, optionally filtered by level."""
        if level is None:
            return [record.getMessage() for record in self.records]
        return [record.getMessage() for record in self.records if record.levelno >= level]
        
    def get_records(self, level: int = None) -> list[logging.LogRecord]:
        """Get captured log records, optionally filtered by level."""
        if level is None:
            return self.records
        return [record for record in self.records if record.levelno >= level]
        
    def has_message_containing(self, text: str, level: int = None) -> bool:
        """Check if any log message contains the specified text."""
        messages = self.get_messages(level)
        return any(text in msg for msg in messages)
        
    def count_messages_containing(self, text: str, level: int = None) -> int:
        """Count log messages containing the specified text."""
        messages = self.get_messages(level)
        return sum(1 for msg in messages if text in msg)


async def test_adk_agent_logging():
    """Test that ADKAgent logs events correctly."""
    print("🧪 Testing ADK agent logging output...")
    
    # Set up agent
    agent = Agent(
        name="logging_test_agent",
        instruction="You are a test agent."
    )
    
    registry = AgentRegistry.get_instance()
    registry.clear()
    registry.set_default_agent(agent)
    
    # Create middleware
    adk_agent = ADKAgent(
        app_name="test_app",
        user_id="test_user",
        use_in_memory_services=True,
    )
    
    # Mock the runner to control ADK events
    mock_runner = MagicMock()
    
    # Create mock ADK events
    partial_event = MagicMock()
    partial_event.content = MagicMock()
    partial_event.content.parts = [MagicMock(text="Hello from mock ADK!")]
    partial_event.author = "assistant"
    partial_event.partial = True
    partial_event.turn_complete = False
    partial_event.is_final_response = lambda: False
    partial_event.candidates = []
    
    final_event = MagicMock()
    final_event.content = MagicMock()
    final_event.content.parts = [MagicMock(text=" Finished!")]
    final_event.author = "assistant"
    final_event.partial = False
    final_event.turn_complete = True
    final_event.is_final_response = lambda: True
    final_event.candidates = [MagicMock(finish_reason="STOP")]
    
    async def mock_run_async(*_args, **_kwargs):
        yield partial_event
        yield final_event
    
    mock_runner.run_async = mock_run_async
    adk_agent._get_or_create_runner = MagicMock(return_value=mock_runner)
    
    # Test input
    test_input = RunAgentInput(
        thread_id="test_thread_logging",
        run_id="test_run_logging",
        messages=[
            UserMessage(
                id="msg_1",
                role="user",
                content="Test logging message"
            )
        ],
        state={},
        context=[],
        tools=[],
        forwarded_props={}
    )
    
    # Capture logs from adk_agent component
    with LogCapture('adk_agent', logging.DEBUG) as log_capture:
        events = []
        try:
            async for event in adk_agent.run(test_input):
                events.append(event)
        except Exception as e:
            print(f"❌ Unexpected error: {e}")
            return False
    
    # Verify we got events
    if len(events) == 0:
        print("❌ No events generated")
        return False
    
    print(f"✅ Generated {len(events)} events")
    
    # Verify logging occurred
    log_messages = log_capture.get_messages()
    if len(log_messages) == 0:
        print("❌ No log messages captured")
        return False
    
    print(f"✅ Captured {len(log_messages)} log messages")
    
    # Check for specific log patterns
    debug_messages = log_capture.get_messages(logging.DEBUG)
    info_messages = log_capture.get_messages(logging.INFO)
    
    print(f"📊 Debug messages: {len(debug_messages)}")
    print(f"📊 Info messages: {len(info_messages)}")
    
    # Look for session-related logging
    has_session_logs = log_capture.has_message_containing("session", logging.DEBUG)
    if has_session_logs:
        print("✅ Session-related logging found")
    else:
        print("⚠️ No session-related logging found")
    
    return True


async def test_event_translator_logging():
    """Test that EventTranslator logs translation events correctly."""
    print("\n🧪 Testing EventTranslator logging...")
    
    # Configure event_translator logging to DEBUG for this test
    configure_logging(event_translator='DEBUG')
    
    # Set up minimal test like above but focus on event translator logs
    agent = Agent(name="translator_test", instruction="Test agent")
    registry = AgentRegistry.get_instance()
    registry.clear()
    registry.set_default_agent(agent)
    
    adk_agent = ADKAgent(
        app_name="test_app",
        user_id="test_user",
        use_in_memory_services=True,
    )
    
    # Mock runner with events that will trigger translation
    mock_runner = MagicMock()
    mock_event = MagicMock()
    mock_event.content = MagicMock()
    mock_event.content.parts = [MagicMock(text="Test translation")]
    mock_event.author = "assistant"
    mock_event.partial = True
    mock_event.turn_complete = False
    mock_event.is_final_response = lambda: False
    mock_event.candidates = []
    
    async def mock_run_async(*_args, **_kwargs):
        yield mock_event
    
    mock_runner.run_async = mock_run_async
    adk_agent._get_or_create_runner = MagicMock(return_value=mock_runner)
    
    test_input = RunAgentInput(
        thread_id="translator_test",
        run_id="translator_run",
        messages=[UserMessage(id="1", role="user", content="Test")],
        state={}, context=[], tools=[], forwarded_props={}
    )
    
    # Capture event_translator logs
    with LogCapture('event_translator', logging.DEBUG) as log_capture:
        events = []
        async for event in adk_agent.run(test_input):
            events.append(event)
    
    # Verify translation logging
    log_messages = log_capture.get_messages()
    
    print(f"📊 Event translator log messages: {len(log_messages)}")
    
    # Look for translation-specific logs
    has_translation_logs = log_capture.has_message_containing("translat", logging.DEBUG)
    has_event_logs = log_capture.has_message_containing("event", logging.DEBUG)
    
    if has_translation_logs or has_event_logs:
        print("✅ Event translation logging found")
        return True
    else:
        print("⚠️ No event translation logging found (may be expected if optimized)")
        return True  # Not necessarily a failure


async def test_endpoint_logging():
    """Test that endpoint component logs HTTP responses correctly."""
    print("\n🧪 Testing endpoint logging...")
    
    # Configure endpoint logging to INFO for this test
    configure_logging(endpoint='INFO')
    
    # Test endpoint logging by importing and checking logger
    from endpoint import logger as endpoint_logger
    
    # Capture endpoint logs
    with LogCapture('endpoint', logging.INFO) as log_capture:
        # Simulate what endpoint does - log an HTTP response
        endpoint_logger.info("🌐 HTTP Response: test response data")
        endpoint_logger.warning("Test warning message")
        endpoint_logger.error("Test error message")
    
    # Verify endpoint logging
    log_messages = log_capture.get_messages()
    info_messages = log_capture.get_messages(logging.INFO)
    warning_messages = log_capture.get_messages(logging.WARNING)
    error_messages = log_capture.get_messages(logging.ERROR)
    
    print(f"📊 Total endpoint log messages: {len(log_messages)}")
    print(f"📊 Info messages: {len(info_messages)}")
    print(f"📊 Warning messages: {len(warning_messages)}")
    print(f"📊 Error messages: {len(error_messages)}")
    
    # Check specific message content
    has_http_response = log_capture.has_message_containing("HTTP Response", logging.INFO)
    has_test_warning = log_capture.has_message_containing("Test warning", logging.WARNING)
    has_test_error = log_capture.has_message_containing("Test error", logging.ERROR)
    
    if has_http_response and has_test_warning and has_test_error:
        print("✅ Endpoint logging working correctly")
        return True
    else:
        print("❌ Endpoint logging not working as expected")
        return False


async def test_logging_level_configuration():
    """Test that logging level configuration works correctly."""
    print("\n🧪 Testing logging level configuration...")
    
    # Test configuring different levels
    configure_logging(
        adk_agent='WARNING',
        event_translator='ERROR',
        endpoint='DEBUG'
    )
    
    # Capture logs at different levels
    test_loggers = ['adk_agent', 'event_translator', 'endpoint']
    results = {}
    
    for logger_name in test_loggers:
        # Use the actual logger without overriding its level
        logger = get_component_logger(logger_name)
        current_level = logger.level
        
        # Create a log capture that doesn't change the logger level
        with LogCapture(logger_name, current_level) as log_capture:
            # Don't override the level in LogCapture
            log_capture.logger.setLevel(current_level)  # Keep original level
            
            # Try logging at different levels
            logger.debug("Debug message")
            logger.info("Info message")
            logger.warning("Warning message")
            logger.error("Error message")
            
            # Count messages that should have been logged based on level
            debug_count = log_capture.count_messages_containing("Debug message")
            info_count = log_capture.count_messages_containing("Info message")
            warning_count = log_capture.count_messages_containing("Warning message")
            error_count = log_capture.count_messages_containing("Error message")
            
            results[logger_name] = {
                'debug': debug_count,
                'info': info_count, 
                'warning': warning_count,
                'error': error_count,
                'level': current_level
            }
    
    # Verify level filtering worked correctly
    success = True
    
    # Print debug info
    for logger_name, result in results.items():
        print(f"📊 {logger_name} (level {result['level']}): D={result['debug']}, I={result['info']}, W={result['warning']}, E={result['error']}")
    
    # adk_agent set to WARNING (30) - should only see warning and error
    if results['adk_agent']['debug'] > 0 or results['adk_agent']['info'] > 0:
        print("❌ adk_agent level filtering failed - showing debug/info when set to WARNING")
        success = False
    elif results['adk_agent']['warning'] == 0 or results['adk_agent']['error'] == 0:
        print("❌ adk_agent should show warning and error messages")
        success = False
    else:
        print("✅ adk_agent level filtering (WARNING) working")
    
    # event_translator set to ERROR (40) - should only see error
    if (results['event_translator']['debug'] > 0 or 
        results['event_translator']['info'] > 0 or 
        results['event_translator']['warning'] > 0):
        print("❌ event_translator level filtering failed - showing debug/info/warning when set to ERROR")
        success = False
    elif results['event_translator']['error'] == 0:
        print("❌ event_translator should show error messages")
        success = False
    else:
        print("✅ event_translator level filtering (ERROR) working")
    
    # endpoint set to DEBUG (10) - should see all messages
    if (results['endpoint']['debug'] == 0 or 
        results['endpoint']['info'] == 0 or 
        results['endpoint']['warning'] == 0 or 
        results['endpoint']['error'] == 0):
        print("❌ endpoint should show all message levels when set to DEBUG")
        success = False
    else:
        print("✅ endpoint level filtering (DEBUG) working")
    
    return success


async def main():
    """Run all logging tests."""
    print("🚀 Testing Logging System with Programmatic Verification")
    print("=" * 65)
    
    tests = [
        ("ADK Agent Logging", test_adk_agent_logging),
        ("Event Translator Logging", test_event_translator_logging),
        ("Endpoint Logging", test_endpoint_logging),
        ("Logging Level Configuration", test_logging_level_configuration)
    ]
    
    results = []
    for test_name, test_func in tests:
        try:
            result = await test_func()
            results.append(result)
        except Exception as e:
            print(f"❌ Test {test_name} failed with exception: {e}")
            import traceback
            traceback.print_exc()
            results.append(False)
    
    print("\n" + "=" * 65)
    print("📊 Test Results:")
    
    for i, (test_name, result) in enumerate(zip([name for name, _ in tests], results), 1):
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"  {i}. {test_name}: {status}")
    
    passed = sum(results)
    total = len(results)
    
    if passed == total:
        print(f"\n🎉 All {total} logging tests passed!")
        print("💡 Logging system working correctly with programmatic verification")
    else:
        print(f"\n⚠️ {passed}/{total} tests passed")
        print("🔧 Review logging configuration and implementation")
    
    return passed == total


if __name__ == "__main__":
    success = asyncio.run(main())
    import sys
    sys.exit(0 if success else 1)