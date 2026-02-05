"""Tests for SessionManager."""

import pytest
import asyncio
from ag_ui_claude.session_manager import SessionManager


class TestSessionManager:
    """Test cases for SessionManager."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset session manager before and after each test."""
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.mark.asyncio
    async def test_get_or_create_session_new(self):
        """Test creating a new session."""
        manager = SessionManager.get_instance()
        
        session_state = await manager.get_or_create_session(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user",
            initial_state={"key": "value"}
        )
        
        assert session_state is not None
        assert isinstance(session_state, dict)

    @pytest.mark.asyncio
    async def test_get_or_create_session_existing(self):
        """Test getting an existing session."""
        manager = SessionManager.get_instance()
        
        # Create session
        await manager.get_or_create_session(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user",
            initial_state={"key": "value"}
        )
        
        # Get existing session
        session_state = await manager.get_or_create_session(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user"
        )
        
        assert session_state is not None

    @pytest.mark.asyncio
    async def test_update_session_state(self):
        """Test updating session state."""
        manager = SessionManager.get_instance()
        
        await manager.get_or_create_session(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user"
        )
        
        success = await manager.update_session_state(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user",
            state_updates={"new_key": "new_value"}
        )
        
        assert success is True
        
        state = await manager.get_session_state(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user"
        )
        
        assert state is not None
        assert state.get("new_key") == "new_value"

    @pytest.mark.asyncio
    async def test_get_state_value(self):
        """Test getting a specific state value."""
        manager = SessionManager.get_instance()
        
        await manager.get_or_create_session(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user",
            initial_state={"key": "value"}
        )
        
        value = await manager.get_state_value(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user",
            key="key"
        )
        
        assert value == "value"

    @pytest.mark.asyncio
    async def test_get_state_value_default(self):
        """Test getting state value with default."""
        manager = SessionManager.get_instance()
        
        await manager.get_or_create_session(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user"
        )
        
        value = await manager.get_state_value(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user",
            key="nonexistent",
            default="default_value"
        )
        
        assert value == "default_value"

    @pytest.mark.asyncio
    async def test_set_state_value(self):
        """Test setting a specific state value."""
        manager = SessionManager.get_instance()
        
        await manager.get_or_create_session(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user"
        )
        
        success = await manager.set_state_value(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user",
            key="test_key",
            value="test_value"
        )
        
        assert success is True
        
        value = await manager.get_state_value(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user",
            key="test_key"
        )
        
        assert value == "test_value"

    @pytest.mark.asyncio
    async def test_remove_state_keys(self):
        """Test removing state keys."""
        manager = SessionManager.get_instance()
        
        await manager.get_or_create_session(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user",
            initial_state={"key1": "value1", "key2": "value2"}
        )
        
        success = await manager.remove_state_keys(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user",
            keys=["key1"]
        )
        
        assert success is True
        
        value = await manager.get_state_value(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user",
            key="key1"
        )
        
        assert value is None

    @pytest.mark.asyncio
    async def test_mark_messages_processed(self):
        """Test marking messages as processed."""
        manager = SessionManager.get_instance()
        
        manager.mark_messages_processed(
            app_name="test_app",
            session_id="test_session",
            message_ids=["msg_1", "msg_2"]
        )
        
        processed = manager.get_processed_message_ids("test_app", "test_session")
        assert "msg_1" in processed
        assert "msg_2" in processed

    @pytest.mark.asyncio
    async def test_get_processed_message_ids(self):
        """Test getting processed message IDs."""
        manager = SessionManager.get_instance()
        
        manager.mark_messages_processed(
            app_name="test_app",
            session_id="test_session",
            message_ids=["msg_1"]
        )
        
        processed = manager.get_processed_message_ids("test_app", "test_session")
        assert "msg_1" in processed

    def test_make_session_key(self):
        """Test session key generation."""
        manager = SessionManager.get_instance()
        
        key = manager._make_session_key("test_app", "test_session")
        assert key == "test_app:test_session"

    def test_get_session_count(self):
        """Test getting session count."""
        manager = SessionManager.get_instance()
        
        # Initially should be 0
        count = manager.get_session_count()
        assert count == 0

    def test_get_user_session_count(self):
        """Test getting user session count."""
        manager = SessionManager.get_instance()
        
        count = manager.get_user_session_count("test_user")
        assert count == 0

    @pytest.mark.asyncio
    async def test_clear_session_state(self):
        """Test clearing session state."""
        manager = SessionManager.get_instance()
        
        await manager.get_or_create_session(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user",
            initial_state={"key1": "value1", "key2": "value2"}
        )
        
        success = await manager.clear_session_state(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user"
        )
        
        assert success is True
        
        state = await manager.get_session_state(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user"
        )
        
        # State should be cleared or minimal
        assert state is None or len(state) == 0

    @pytest.mark.asyncio
    async def test_clear_session_state_preserve_prefixes(self):
        """Test clearing session state with preserved prefixes."""
        manager = SessionManager.get_instance()
        
        await manager.get_or_create_session(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user",
            initial_state={"keep_this": "value", "remove_this": "value"}
        )
        
        success = await manager.clear_session_state(
            session_id="test_session",
            app_name="test_app",
            user_id="test_user",
            preserve_prefixes=["keep_"]
        )
        
        assert success is True

    def test_singleton_pattern(self):
        """Test that SessionManager is a singleton."""
        manager1 = SessionManager.get_instance()
        manager2 = SessionManager.get_instance()
        
        assert manager1 is manager2

    def test_reset_instance(self):
        """Test resetting the singleton instance."""
        manager1 = SessionManager.get_instance()
        SessionManager.reset_instance()
        manager2 = SessionManager.get_instance()
        
        assert manager1 is not manager2

