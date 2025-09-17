#!/usr/bin/env python
"""Tests for FastAPI endpoint functionality."""

import pytest
import asyncio
from unittest.mock import MagicMock, patch, AsyncMock
from fastapi import FastAPI
from fastapi.testclient import TestClient
from fastapi.responses import StreamingResponse

from ag_ui.core import RunAgentInput, UserMessage, RunStartedEvent, RunErrorEvent, EventType
from ag_ui.encoder import EventEncoder
from ag_ui_adk.endpoint import add_adk_fastapi_endpoint, create_adk_app
from ag_ui_adk.adk_agent import ADKAgent


class TestAddADKFastAPIEndpoint:
    """Tests for add_adk_fastapi_endpoint function."""

    @pytest.fixture
    def mock_agent(self):
        """Create a mock ADKAgent."""
        agent = MagicMock(spec=ADKAgent)
        return agent

    @pytest.fixture
    def app(self):
        """Create a FastAPI app."""
        return FastAPI()

    @pytest.fixture
    def sample_input(self):
        """Create sample RunAgentInput."""
        return RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[
                UserMessage(id="1", role="user", content="Hello")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

    def test_add_endpoint_default_path(self, app, mock_agent):
        """Test adding endpoint with default path."""
        add_adk_fastapi_endpoint(app, mock_agent)

        # Check that endpoint was added
        routes = [route.path for route in app.routes]
        assert "/" in routes

    def test_add_endpoint_custom_path(self, app, mock_agent):
        """Test adding endpoint with custom path."""
        add_adk_fastapi_endpoint(app, mock_agent, path="/custom")

        # Check that endpoint was added
        routes = [route.path for route in app.routes]
        assert "/custom" in routes

    def test_endpoint_method_is_post(self, app, mock_agent):
        """Test that endpoint accepts POST requests."""
        add_adk_fastapi_endpoint(app, mock_agent, path="/test")

        # Find the route
        route = next(route for route in app.routes if route.path == "/test")
        assert "POST" in route.methods

    @patch('ag_ui_adk.endpoint.EventEncoder')
    def test_endpoint_creates_event_encoder(self, mock_encoder_class, app, mock_agent, sample_input):
        """Test that endpoint creates EventEncoder with correct accept header."""
        mock_encoder = MagicMock()
        mock_encoder.encode.return_value = "encoded_event"
        mock_encoder.get_content_type.return_value = "text/event-stream"
        mock_encoder_class.return_value = mock_encoder

        # Mock agent to return an event
        mock_event = RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id="test_thread",
            run_id="test_run"
        )
        mock_agent.run = AsyncMock(return_value=AsyncMock(__aiter__=AsyncMock(return_value=iter([mock_event]))))

        add_adk_fastapi_endpoint(app, mock_agent, path="/test")

        client = TestClient(app)
        response = client.post(
            "/test",
            json=sample_input.model_dump(),
            headers={"accept": "text/event-stream"}
        )

        # EventEncoder should be created with accept header
        mock_encoder_class.assert_called_once_with(accept="text/event-stream")
        assert response.status_code == 200

    @patch('ag_ui_adk.endpoint.EventEncoder')
    def test_endpoint_agent_id_extraction(self, mock_encoder_class, app, mock_agent, sample_input):
        """Test that agent_id is extracted from path."""
        mock_encoder = MagicMock()
        mock_encoder.encode.return_value = "encoded_event"
        mock_encoder.get_content_type.return_value = "text/event-stream"
        mock_encoder_class.return_value = mock_encoder

        # Mock agent to return an event
        mock_event = RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id="test_thread",
            run_id="test_run"
        )
        mock_agent.run = AsyncMock(return_value=AsyncMock(__aiter__=AsyncMock(return_value=iter([mock_event]))))

        add_adk_fastapi_endpoint(app, mock_agent, path="/agent123")

        client = TestClient(app)
        response = client.post("/agent123", json=sample_input.model_dump())

        # Agent should be called with just the input data
        mock_agent.run.assert_called_once_with(sample_input)
        assert response.status_code == 200

    @patch('ag_ui_adk.endpoint.EventEncoder')
    def test_endpoint_root_path_agent_id(self, mock_encoder_class, app, mock_agent, sample_input):
        """Test agent_id extraction for root path."""
        mock_encoder = MagicMock()
        mock_encoder.encode.return_value = "encoded_event"
        mock_encoder.get_content_type.return_value = "text/event-stream"
        mock_encoder_class.return_value = mock_encoder

        # Mock agent to return an event
        mock_event = RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id="test_thread",
            run_id="test_run"
        )
        mock_agent.run = AsyncMock(return_value=AsyncMock(__aiter__=AsyncMock(return_value=iter([mock_event]))))

        add_adk_fastapi_endpoint(app, mock_agent, path="/")

        client = TestClient(app)
        response = client.post("/", json=sample_input.model_dump())

        # Agent should be called with just the input data
        mock_agent.run.assert_called_once_with(sample_input)
        assert response.status_code == 200

    @patch('ag_ui_adk.endpoint.EventEncoder')
    @patch('ag_ui_adk.endpoint.logger')
    def test_endpoint_successful_event_streaming(self, mock_logger, mock_encoder_class, app, mock_agent, sample_input):
        """Test successful event streaming."""
        mock_encoder = MagicMock()
        mock_encoder.encode.return_value = "data: encoded_event\n\n"
        mock_encoder.get_content_type.return_value = "text/event-stream"
        mock_encoder_class.return_value = mock_encoder

        # Mock agent to return multiple events
        mock_event1 = RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id="test_thread",
            run_id="test_run"
        )
        mock_event2 = RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id="test_thread",
            run_id="test_run"
        )

        async def mock_agent_run(input_data):
            yield mock_event1
            yield mock_event2

        mock_agent.run = mock_agent_run

        add_adk_fastapi_endpoint(app, mock_agent, path="/test")

        client = TestClient(app)
        response = client.post("/test", json=sample_input.model_dump())

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")

        # Check that events were encoded and logged
        assert mock_encoder.encode.call_count == 2
        assert mock_logger.debug.call_count == 2

    @patch('ag_ui_adk.endpoint.EventEncoder')
    @patch('ag_ui_adk.endpoint.logger')
    def test_endpoint_encoding_error_handling(self, mock_logger, mock_encoder_class, app, mock_agent, sample_input):
        """Test handling of encoding errors."""
        mock_encoder = MagicMock()
        mock_encoder.encode.side_effect = [
            ValueError("Encoding failed"),
            "data: error_event\n\n"  # Error event encoding succeeds
        ]
        mock_encoder.get_content_type.return_value = "text/event-stream"
        mock_encoder_class.return_value = mock_encoder

        # Mock agent to return an event
        mock_event = RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id="test_thread",
            run_id="test_run"
        )

        async def mock_agent_run(input_data):
            yield mock_event

        mock_agent.run = mock_agent_run

        add_adk_fastapi_endpoint(app, mock_agent, path="/test")

        client = TestClient(app)
        response = client.post("/test", json=sample_input.model_dump())

        assert response.status_code == 200

        # Should log encoding error
        mock_logger.error.assert_called_once()
        assert "Event encoding error" in str(mock_logger.error.call_args)

        # Should create and encode RunErrorEvent
        assert mock_encoder.encode.call_count == 2

        # Check that second call was for error event
        error_event_call = mock_encoder.encode.call_args_list[1]
        error_event = error_event_call[0][0]
        assert isinstance(error_event, RunErrorEvent)
        assert error_event.code == "ENCODING_ERROR"

    @patch('ag_ui_adk.endpoint.EventEncoder')
    @patch('ag_ui_adk.endpoint.logger')
    def test_endpoint_encoding_error_double_failure(self, mock_logger, mock_encoder_class, app, mock_agent, sample_input):
        """Test handling when both event and error event encoding fail."""
        mock_encoder = MagicMock()
        mock_encoder.encode.side_effect = ValueError("Always fails")
        mock_encoder.get_content_type.return_value = "text/event-stream"
        mock_encoder_class.return_value = mock_encoder

        # Mock agent to return an event
        mock_event = RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id="test_thread",
            run_id="test_run"
        )

        async def mock_agent_run(input_data):
            yield mock_event

        mock_agent.run = mock_agent_run

        add_adk_fastapi_endpoint(app, mock_agent, path="/test")

        client = TestClient(app)
        response = client.post("/test", json=sample_input.model_dump())

        assert response.status_code == 200

        # Should log both encoding errors
        assert mock_logger.error.call_count == 2
        assert "Event encoding error" in str(mock_logger.error.call_args_list[0])
        assert "Failed to encode error event" in str(mock_logger.error.call_args_list[1])

        # Should yield basic SSE error
        response_text = response.text
        assert 'event: error\ndata: {"error": "Event encoding failed"}\n\n' in response_text

    @patch('ag_ui_adk.endpoint.EventEncoder')
    @patch('ag_ui_adk.endpoint.logger')
    def test_endpoint_agent_error_handling(self, mock_logger, mock_encoder_class, app, mock_agent, sample_input):
        """Test handling of agent execution errors."""
        mock_encoder = MagicMock()
        mock_encoder.encode.return_value = "data: error_event\n\n"
        mock_encoder.get_content_type.return_value = "text/event-stream"
        mock_encoder_class.return_value = mock_encoder

        # Mock agent to raise an error
        async def mock_agent_run(input_data):
            raise RuntimeError("Agent failed")

        mock_agent.run = mock_agent_run

        add_adk_fastapi_endpoint(app, mock_agent, path="/test")

        client = TestClient(app)
        response = client.post("/test", json=sample_input.model_dump())

        assert response.status_code == 200

        # Should log agent error
        mock_logger.error.assert_called_once()
        assert "ADKAgent error" in str(mock_logger.error.call_args)

        # Should create and encode RunErrorEvent
        error_event_call = mock_encoder.encode.call_args
        error_event = error_event_call[0][0]
        assert isinstance(error_event, RunErrorEvent)
        assert error_event.code == "AGENT_ERROR"
        assert "Agent execution failed" in error_event.message

    @patch('ag_ui_adk.endpoint.EventEncoder')
    @patch('ag_ui_adk.endpoint.logger')
    def test_endpoint_agent_error_encoding_failure(self, mock_logger, mock_encoder_class, app, mock_agent, sample_input):
        """Test handling when agent error event encoding fails."""
        mock_encoder = MagicMock()
        mock_encoder.encode.side_effect = ValueError("Encoding failed")
        mock_encoder.get_content_type.return_value = "text/event-stream"
        mock_encoder_class.return_value = mock_encoder

        # Mock agent to raise an error
        async def mock_agent_run(input_data):
            raise RuntimeError("Agent failed")

        mock_agent.run = mock_agent_run

        add_adk_fastapi_endpoint(app, mock_agent, path="/test")

        client = TestClient(app)
        response = client.post("/test", json=sample_input.model_dump())

        assert response.status_code == 200

        # Should log both errors
        assert mock_logger.error.call_count == 2
        assert "ADKAgent error" in str(mock_logger.error.call_args_list[0])
        assert "Failed to encode agent error event" in str(mock_logger.error.call_args_list[1])

        # Should yield basic SSE error
        response_text = response.text
        assert 'event: error\ndata: {"error": "Agent execution failed"}\n\n' in response_text

    @patch('ag_ui_adk.endpoint.EventEncoder')
    def test_endpoint_returns_streaming_response(self, mock_encoder_class, app, mock_agent, sample_input):
        """Test that endpoint returns StreamingResponse."""
        mock_encoder = MagicMock()
        mock_encoder.encode.return_value = "data: event\n\n"
        mock_encoder.get_content_type.return_value = "text/event-stream"
        mock_encoder_class.return_value = mock_encoder

        # Mock agent to return an event
        mock_event = RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id="test_thread",
            run_id="test_run"
        )

        async def mock_agent_run(input_data):
            yield mock_event

        mock_agent.run = mock_agent_run

        add_adk_fastapi_endpoint(app, mock_agent, path="/test")

        client = TestClient(app)
        response = client.post("/test", json=sample_input.model_dump())

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")

    def test_endpoint_input_validation(self, app, mock_agent):
        """Test that endpoint validates input as RunAgentInput."""
        add_adk_fastapi_endpoint(app, mock_agent, path="/test")

        client = TestClient(app)

        # Send invalid JSON
        response = client.post("/test", json={"invalid": "data"})

        # Should return 422 for validation error
        assert response.status_code == 422

    @patch('ag_ui_adk.endpoint.EventEncoder')
    def test_endpoint_no_accept_header(self, mock_encoder_class, app, mock_agent, sample_input):
        """Test endpoint behavior when no accept header is provided."""
        mock_encoder = MagicMock()
        mock_encoder.encode.return_value = "data: event\n\n"
        mock_encoder.get_content_type.return_value = "text/event-stream"
        mock_encoder_class.return_value = mock_encoder

        # Mock agent to return an event
        mock_event = RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id="test_thread",
            run_id="test_run"
        )

        async def mock_agent_run(input_data):
            yield mock_event

        mock_agent.run = mock_agent_run

        add_adk_fastapi_endpoint(app, mock_agent, path="/test")

        client = TestClient(app)
        response = client.post("/test", json=sample_input.model_dump())

        # EventEncoder should be created with default accept header from TestClient
        mock_encoder_class.assert_called_once_with(accept="*/*")
        assert response.status_code == 200


class TestCreateADKApp:
    """Tests for create_adk_app function."""

    @pytest.fixture
    def mock_agent(self):
        """Create a mock ADKAgent."""
        return MagicMock(spec=ADKAgent)

    def test_create_app_basic(self, mock_agent):
        """Test creating app with basic configuration."""
        app = create_adk_app(mock_agent)

        assert isinstance(app, FastAPI)
        assert app.title == "ADK Middleware for AG-UI Protocol"

        # Check that endpoint was added
        routes = [route.path for route in app.routes]
        assert "/" in routes

    def test_create_app_custom_path(self, mock_agent):
        """Test creating app with custom path."""
        app = create_adk_app(mock_agent, path="/custom")

        assert isinstance(app, FastAPI)

        # Check that endpoint was added with custom path
        routes = [route.path for route in app.routes]
        assert "/custom" in routes

    @patch('ag_ui_adk.endpoint.add_adk_fastapi_endpoint')
    def test_create_app_calls_add_endpoint(self, mock_add_endpoint, mock_agent):
        """Test that create_adk_app calls add_adk_fastapi_endpoint."""
        app = create_adk_app(mock_agent, path="/test")

        # Should call add_adk_fastapi_endpoint with correct parameters
        mock_add_endpoint.assert_called_once_with(app, mock_agent, "/test")

    def test_create_app_default_path(self, mock_agent):
        """Test creating app with default path."""
        app = create_adk_app(mock_agent)

        routes = [route.path for route in app.routes]
        assert "/" in routes

    @patch('ag_ui_adk.endpoint.EventEncoder')
    def test_create_app_functional_test(self, mock_encoder_class, mock_agent):
        """Test that created app is functional."""
        mock_encoder = MagicMock()
        mock_encoder.encode.return_value = "data: event\n\n"
        mock_encoder.get_content_type.return_value = "text/event-stream"
        mock_encoder_class.return_value = mock_encoder

        # Mock agent to return an event
        mock_event = RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id="test_thread",
            run_id="test_run"
        )

        async def mock_agent_run(input_data):
            yield mock_event

        mock_agent.run = mock_agent_run

        app = create_adk_app(mock_agent)

        client = TestClient(app)
        sample_input = RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[UserMessage(id="1", role="user", content="Hello")],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        response = client.post("/", json=sample_input.model_dump())

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")


class TestEndpointIntegration:
    """Integration tests for endpoint functionality."""

    @pytest.fixture
    def mock_agent(self):
        """Create a mock ADKAgent."""
        return MagicMock(spec=ADKAgent)

    @pytest.fixture
    def sample_input(self):
        """Create sample RunAgentInput."""
        return RunAgentInput(
            thread_id="integration_thread",
            run_id="integration_run",
            messages=[
                UserMessage(id="1", role="user", content="Integration test message")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

    @patch('ag_ui_adk.endpoint.EventEncoder')
    def test_full_endpoint_flow(self, mock_encoder_class, mock_agent, sample_input):
        """Test complete endpoint flow from request to response."""
        mock_encoder = MagicMock()
        mock_encoder.encode.return_value = "data: test_event\n\n"
        mock_encoder.get_content_type.return_value = "text/event-stream"
        mock_encoder_class.return_value = mock_encoder

        # Mock agent to return multiple events
        events = [
            RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id="integration_thread",
                run_id="integration_run"
            ),
            RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id="integration_thread",
                run_id="integration_run"
            )
        ]

        call_args = []

        async def mock_agent_run(input_data):
            call_args.append(input_data)
            for event in events:
                yield event

        mock_agent.run = mock_agent_run

        app = create_adk_app(mock_agent, path="/integration")

        client = TestClient(app)
        response = client.post(
            "/integration",
            json=sample_input.model_dump(),
            headers={"accept": "text/event-stream"}
        )

        # Verify response
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")

        # Verify agent was called correctly
        assert len(call_args) == 1
        assert call_args[0] == sample_input

        # Verify events were encoded
        assert mock_encoder.encode.call_count == len(events)

    def test_endpoint_with_different_http_methods(self, mock_agent):
        """Test that endpoint only accepts POST requests."""
        app = create_adk_app(mock_agent, path="/test")

        client = TestClient(app)

        # POST should work
        response = client.post("/test", json={})
        assert response.status_code in [200, 422]  # 422 for validation error

        # GET should not work
        response = client.get("/test")
        assert response.status_code == 405  # Method not allowed

        # PUT should not work
        response = client.put("/test", json={})
        assert response.status_code == 405

        # DELETE should not work
        response = client.delete("/test")
        assert response.status_code == 405

    @patch('ag_ui_adk.endpoint.EventEncoder')
    def test_endpoint_with_long_running_stream(self, mock_encoder_class, mock_agent, sample_input):
        """Test endpoint with long-running event stream."""
        mock_encoder = MagicMock()
        mock_encoder.encode.return_value = "data: event\n\n"
        mock_encoder.get_content_type.return_value = "text/event-stream"
        mock_encoder_class.return_value = mock_encoder

        # Mock agent to return many events
        async def mock_agent_run(input_data):
            for i in range(10):
                yield RunStartedEvent(
                    type=EventType.RUN_STARTED,
                    thread_id=f"thread_{i}",
                    run_id=f"run_{i}"
                )

        mock_agent.run = mock_agent_run

        app = create_adk_app(mock_agent, path="/long_stream")

        client = TestClient(app)
        response = client.post("/long_stream", json=sample_input.model_dump())

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")

        # Should have encoded 10 events
        assert mock_encoder.encode.call_count == 10