#!/usr/bin/env python
"""Test endpoint error handling improvements."""
import pytest

from unittest.mock import AsyncMock, MagicMock, patch
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient


from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint
from ag_ui.core import EventType

class TestEndpointErrorHandling:
    """Tests for endpoint error handling improvements."""

    @pytest.fixture(
        params=[FastAPI, APIRouter]
    )
    def app(self, request):
        """Create a FastAPI app or APIRouter."""
        return request.param()

    def get_test_app(self, app):
        """Return app suitable for TestClient (wrap APIRouter in FastAPI if needed).

        Note: This must be called AFTER routes are added to the router,
        since include_router copies routes at the time of inclusion.
        """
        if isinstance(app, APIRouter):
            fastapi_app = FastAPI()
            fastapi_app.include_router(app)
            return fastapi_app
        return app

    async def test_encoding_error_handling(self, app):
        """Test that encoding errors are properly handled."""
        print("🧪 Testing encoding error handling...")

        # Create a mock ADK agent
        mock_agent = AsyncMock(spec=ADKAgent)

        # Create a mock event whose model_dump_json raises to simulate the
        # per-event encoding failure path in the endpoint.
        mock_event = MagicMock()
        mock_event.type = EventType.RUN_STARTED
        mock_event.thread_id = "test"
        mock_event.run_id = "test"
        mock_event.model_dump_json.side_effect = Exception("Encoding failed!")

        # Mock the agent to yield the problematic event
        async def mock_run(input_data):
            yield mock_event

        mock_agent.run = mock_run

        # Create FastAPI app with endpoint
        add_adk_fastapi_endpoint(app, mock_agent, path="/test")

        # Create test input
        test_input = {
            "thread_id": "test_thread",
            "run_id": "test_run",
            "messages": [
                {
                    "id": "msg1",
                    "role": "user",
                    "content": "Test message"
                }
            ],
            "context": [],
            "state": {},
            "tools": [],
            "forwarded_props": {}
        }

        # Test the endpoint
        with TestClient(self.get_test_app(app)) as client:
            response = client.post(
                "/test",
                json=test_input,
                headers={"Accept": "text/event-stream"}
            )

            print(f"📊 Response status: {response.status_code}")

            if response.status_code == 200:
                # Read the response content
                content = response.text
                print(f"📄 Response content preview: {content[:100]}...")

                # Check if error handling worked
                if "Event encoding failed" in content or "ENCODING_ERROR" in content:
                    print("✅ Encoding error properly handled and communicated")
                    return True
                else:
                    print("⚠️ Error handling may not be working as expected")
                    print(f"   Full content: {content}")
                    return False
            else:
                print(f"❌ Unexpected status code: {response.status_code}")
                return False


    async def test_agent_error_handling(self, app):
        """Test that agent errors are properly handled."""
        print("\n🧪 Testing agent error handling...")

        # Create a mock ADK agent that raises an error
        mock_agent = AsyncMock(spec=ADKAgent)

        async def mock_run_error(input_data):
            raise Exception("Agent failed!")
            yield  # This will never be reached

        mock_agent.run = mock_run_error

        # Create FastAPI app with endpoint
        add_adk_fastapi_endpoint(app, mock_agent, path="/test")

        # Create test input
        test_input = {
            "thread_id": "test_thread",
            "run_id": "test_run",
            "messages": [
                {
                    "id": "msg1",
                    "role": "user",
                    "content": "Test message"
                }
            ],
            "context": [],
            "state": {},
            "tools": [],
            "forwarded_props": {}
        }

        # Test the endpoint
        with TestClient(self.get_test_app(app)) as client:
            response = client.post(
                "/test",
                json=test_input,
                headers={"Accept": "text/event-stream"}
            )

            print(f"📊 Response status: {response.status_code}")

            if response.status_code == 200:
                # Read the response content
                content = response.text
                print(f"📄 Response content preview: {content[:100]}...")

                # Check if error handling worked
                if "Agent execution failed" in content or "AGENT_ERROR" in content:
                    print("✅ Agent error properly handled and communicated")
                    return True
                else:
                    print("⚠️ Agent error handling may not be working as expected")
                    print(f"   Full content: {content}")
                    return False
            else:
                print(f"❌ Unexpected status code: {response.status_code}")
                return False


    async def test_successful_event_handling(self, app):
        """Test that normal events are handled correctly."""
        print("\n🧪 Testing successful event handling...")

        # Create a mock ADK agent that yields normal events
        mock_agent = AsyncMock(spec=ADKAgent)

        # Create real event objects instead of mocks
        from ag_ui.core import RunStartedEvent, RunFinishedEvent

        mock_run_started = RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id="test",
            run_id="test"
        )

        mock_run_finished = RunFinishedEvent(
            type=EventType.RUN_FINISHED,
            thread_id="test",
            run_id="test"
        )

        async def mock_run_success(input_data):
            yield mock_run_started
            yield mock_run_finished

        mock_agent.run = mock_run_success

        # Create FastAPI app with endpoint
        add_adk_fastapi_endpoint(app, mock_agent, path="/test")

        # Create test input
        test_input = {
            "thread_id": "test_thread",
            "run_id": "test_run",
            "messages": [
                {
                    "id": "msg1",
                    "role": "user",
                    "content": "Test message"
                }
            ],
            "context": [],
            "state": {},
            "tools": [],
            "forwarded_props": {}
        }

        # Test the endpoint with real encoder
        with TestClient(self.get_test_app(app)) as client:
            response = client.post(
                "/test",
                json=test_input,
                headers={"Accept": "text/event-stream"}
            )

            print(f"📊 Response status: {response.status_code}")

            if response.status_code == 200:
                # Read the response content
                content = response.text
                print(f"📄 Response content preview: {content[:100]}...")

                # Check if normal handling worked
                if "RUN_STARTED" in content and "RUN_FINISHED" in content:
                    print("✅ Normal event handling works correctly")
                    return True
                else:
                    print("⚠️ Normal event handling may not be working")
                    print(f"   Full content: {content}")
                    return False
            else:
                print(f"❌ Unexpected status code: {response.status_code}")
                return False


    async def test_nested_encoding_error_handling(self, app):
        """Test handling of errors that occur when encoding error events."""
        print("\n🧪 Testing nested encoding error handling...")

        # Create a mock ADK agent
        mock_agent = AsyncMock(spec=ADKAgent)

        # Create a mock event whose model_dump_json raises, and patch
        # RunErrorEvent so the inner error-event encoding also fails. This
        # exercises the basic-SSE-fallback branch.
        mock_event = MagicMock()
        mock_event.type = EventType.RUN_STARTED
        mock_event.thread_id = "test"
        mock_event.run_id = "test"
        mock_event.model_dump_json.side_effect = Exception("All encoding failed!")

        async def mock_run(input_data):
            yield mock_event

        mock_agent.run = mock_run

        # Create FastAPI app with endpoint
        add_adk_fastapi_endpoint(app, mock_agent, path="/test")

        # Create test input
        test_input = {
            "thread_id": "test_thread",
            "run_id": "test_run",
            "messages": [
                {
                    "id": "msg1",
                    "role": "user",
                    "content": "Test message"
                }
            ],
            "context": [],
            "state": {},
            "tools": [],
            "forwarded_props": {}
        }

        # Patch RunErrorEvent so the error-event encoding also fails
        with patch('ag_ui.core.RunErrorEvent') as mock_run_error_event_cls:
            mock_error_event_instance = MagicMock()
            mock_error_event_instance.model_dump_json.side_effect = Exception(
                "Error event encoding also failed!"
            )
            mock_run_error_event_cls.return_value = mock_error_event_instance

            # Test the endpoint
            with TestClient(self.get_test_app(app)) as client:
                response = client.post(
                    "/test",
                    json=test_input,
                    headers={"Accept": "text/event-stream"}
                )

                print(f"📊 Response status: {response.status_code}")

                if response.status_code == 200:
                    # Read the response content
                    content = response.text
                    print(f"📄 Response content preview: {content[:100]}...")

                    # Should fallback to basic SSE error format
                    if "event: error" in content and "Event encoding failed" in content:
                        print("✅ Nested encoding error properly handled with SSE fallback")
                        return True
                    else:
                        print("⚠️ Nested encoding error handling may not be working")
                        print(f"   Full content: {content}")
                        return False
                else:
                    print(f"❌ Unexpected status code: {response.status_code}")
                    return False


    async def test_encoding_error_handling_alternative(self, app):
        """Test encoding error handling via ``event.model_dump_json`` side_effect.

        Historically this exercised a different patch location for the
        ``EventEncoder`` class. Since the endpoint no longer uses
        ``EventEncoder`` at all (SSE framing moved to
        ``fastapi.sse.EventSourceResponse``), this test now drives the same
        error branch by making the event itself unserializable, which is
        the direct equivalent of "encoding failed".
        """
        print("\n🧪 Testing encoding error handling (alternative approach)...")

        # Create a mock ADK agent
        mock_agent = AsyncMock(spec=ADKAgent)

        # Create a mock event whose model_dump_json raises
        mock_event = MagicMock()
        mock_event.type = EventType.RUN_STARTED
        mock_event.thread_id = "test"
        mock_event.run_id = "test"
        mock_event.model_dump_json.side_effect = Exception("Encoding failed!")

        # Mock the agent to yield the problematic event
        async def mock_run(input_data, agent_id=None):
            yield mock_event

        mock_agent.run = mock_run

        # Create FastAPI app with endpoint
        add_adk_fastapi_endpoint(app, mock_agent, path="/test")

        # Create test input
        test_input = {
            "thread_id": "test_thread",
            "run_id": "test_run",
            "messages": [
                {
                    "id": "msg1",
                    "role": "user",
                    "content": "Test message"
                }
            ],
            "context": [],
            "state": {},
            "tools": [],
            "forwarded_props": {}
        }

        # Test the endpoint
        with TestClient(self.get_test_app(app)) as client:
            response = client.post(
                "/test",
                json=test_input,
                headers={"Accept": "text/event-stream"}
            )

            print(f"📊 Response status: {response.status_code}")

            if response.status_code == 200:
                # Read the response content
                content = response.text
                print(f"📄 Response content preview: {content[:100]}...")

                # Check if error handling worked
                if "Event encoding failed" in content or "ENCODING_ERROR" in content or "error" in content:
                    print("✅ Encoding error properly handled")
                    return True
                else:
                    print("⚠️ Error handling may not be working")
                    return False
            else:
                print(f"❌ Unexpected status code: {response.status_code}")
                return False
