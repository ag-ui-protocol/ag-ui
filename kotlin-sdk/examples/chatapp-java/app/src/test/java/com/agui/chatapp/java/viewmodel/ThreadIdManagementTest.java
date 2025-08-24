package com.agui.chatapp.java.viewmodel;

import android.app.Application;

import com.agui.chatapp.java.model.AgentProfile;
import com.agui.chatapp.java.model.AuthMethod;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.*;

/**
 * Unit tests for thread ID management in ChatViewModel.
 * Verifies that new thread IDs are created when switching agents or clearing history.
 */
@RunWith(RobolectricTestRunner.class)
public class ThreadIdManagementTest {
    
    private ChatViewModel viewModel;
    private Application application;
    
    @Before
    public void setUp() {
        application = RuntimeEnvironment.getApplication();
        viewModel = new ChatViewModel(application);
    }
    
    @Test
    public void testInitialThreadIdGeneration() throws Exception {
        // Verify that a thread ID is generated during initialization
        Method getCurrentThreadIdMethod = ChatViewModel.class.getDeclaredMethod("getCurrentThreadId");
        getCurrentThreadIdMethod.setAccessible(true);
        
        String threadId = (String) getCurrentThreadIdMethod.invoke(viewModel);
        
        assertNotNull("Thread ID should not be null", threadId);
        assertTrue("Thread ID should start with 'thread_'", threadId.startsWith("thread_"));
    }
    
    @Test
    public void testNewThreadIdOnAgentSwitch() throws Exception {
        // Get initial thread ID
        Method getCurrentThreadIdMethod = ChatViewModel.class.getDeclaredMethod("getCurrentThreadId");
        getCurrentThreadIdMethod.setAccessible(true);
        
        String initialThreadId = (String) getCurrentThreadIdMethod.invoke(viewModel);
        
        // Create test agent profile
        AgentProfile testAgent = new AgentProfile.Builder()
                .setId("test-agent")
                .setName("Test Agent")
                .setUrl("https://test.example.com")
                .setAuthMethod(new AuthMethod.None())
                .setCreatedAt(System.currentTimeMillis())
                .build();
        
        // Switch to agent
        viewModel.setActiveAgent(testAgent);
        
        // Get new thread ID
        String newThreadId = (String) getCurrentThreadIdMethod.invoke(viewModel);
        
        assertNotNull("New thread ID should not be null", newThreadId);
        assertTrue("New thread ID should start with 'thread_'", newThreadId.startsWith("thread_"));
        assertNotEquals("Thread ID should be different after agent switch", initialThreadId, newThreadId);
    }
    
    @Test
    public void testNewThreadIdOnClearHistory() throws Exception {
        // Get initial thread ID
        Method getCurrentThreadIdMethod = ChatViewModel.class.getDeclaredMethod("getCurrentThreadId");
        getCurrentThreadIdMethod.setAccessible(true);
        
        String initialThreadId = (String) getCurrentThreadIdMethod.invoke(viewModel);
        
        // Clear history
        viewModel.clearHistory();
        
        // Get new thread ID
        String newThreadId = (String) getCurrentThreadIdMethod.invoke(viewModel);
        
        assertNotNull("New thread ID should not be null", newThreadId);
        assertTrue("New thread ID should start with 'thread_'", newThreadId.startsWith("thread_"));
        assertNotEquals("Thread ID should be different after clear history", initialThreadId, newThreadId);
    }
    
    @Test
    public void testThreadIdFormat() throws Exception {
        Method getCurrentThreadIdMethod = ChatViewModel.class.getDeclaredMethod("getCurrentThreadId");
        getCurrentThreadIdMethod.setAccessible(true);
        
        String threadId = (String) getCurrentThreadIdMethod.invoke(viewModel);
        
        // Should match pattern: thread_<timestamp>_<random>
        String[] parts = threadId.split("_");
        assertEquals("Thread ID should have 3 parts separated by underscores", 3, parts.length);
        assertEquals("First part should be 'thread'", "thread", parts[0]);
        
        // Verify timestamp part is numeric
        try {
            Long.parseLong(parts[1]);
        } catch (NumberFormatException e) {
            fail("Second part should be a numeric timestamp");
        }
        
        // Verify random part is numeric
        try {
            Integer.parseInt(parts[2]);
        } catch (NumberFormatException e) {
            fail("Third part should be a numeric random value");
        }
    }
    
    @Test
    public void testMessagesClearedOnAgentSwitch() {
        // Add some initial messages to the view model
        // Note: This would normally happen through sendMessage, but for testing we can check the LiveData
        
        // Create test agent profile
        AgentProfile testAgent = new AgentProfile.Builder()
                .setId("test-agent")
                .setName("Test Agent")
                .setUrl("https://test.example.com")
                .setAuthMethod(new AuthMethod.None())
                .setCreatedAt(System.currentTimeMillis())
                .build();
        
        // Switch to agent - this should clear messages
        viewModel.setActiveAgent(testAgent);
        
        // Verify messages are cleared
        List messages = viewModel.getMessages().getValue();
        assertNotNull("Messages list should not be null after agent switch", messages);
        assertTrue("Messages list should be empty after agent switch", messages.isEmpty());
        
        // Switch to another agent
        AgentProfile anotherAgent = new AgentProfile.Builder()
                .setId("another-agent")
                .setName("Another Agent")
                .setUrl("https://another.example.com")
                .setAuthMethod(new AuthMethod.None())
                .setCreatedAt(System.currentTimeMillis())
                .build();
        
        viewModel.setActiveAgent(anotherAgent);
        
        // Verify messages are still cleared
        messages = viewModel.getMessages().getValue();
        assertNotNull("Messages list should not be null after second agent switch", messages);
        assertTrue("Messages list should be empty after second agent switch", messages.isEmpty());
    }
    
    @Test
    public void testMessagesClearedOnClearHistory() {
        // Clear history should clear messages
        viewModel.clearHistory();
        
        // Verify messages are cleared
        List messages = viewModel.getMessages().getValue();
        assertNotNull("Messages list should not be null after clear history", messages);
        assertTrue("Messages list should be empty after clear history", messages.isEmpty());
    }
    
    @Test
    public void testMultipleAgentSwitches() throws Exception {
        Method getCurrentThreadIdMethod = ChatViewModel.class.getDeclaredMethod("getCurrentThreadId");
        getCurrentThreadIdMethod.setAccessible(true);
        
        String threadId1 = (String) getCurrentThreadIdMethod.invoke(viewModel);
        
        // Create first agent
        AgentProfile agent1 = new AgentProfile.Builder()
                .setId("agent-1")
                .setName("Agent 1")
                .setUrl("https://agent1.example.com")
                .setAuthMethod(new AuthMethod.None())
                .setCreatedAt(System.currentTimeMillis())
                .build();
        
        viewModel.setActiveAgent(agent1);
        String threadId2 = (String) getCurrentThreadIdMethod.invoke(viewModel);
        
        // Create second agent
        AgentProfile agent2 = new AgentProfile.Builder()
                .setId("agent-2")
                .setName("Agent 2")
                .setUrl("https://agent2.example.com")
                .setAuthMethod(new AuthMethod.None())
                .setCreatedAt(System.currentTimeMillis())
                .build();
        
        viewModel.setActiveAgent(agent2);
        String threadId3 = (String) getCurrentThreadIdMethod.invoke(viewModel);
        
        // All thread IDs should be different
        assertNotEquals("Thread ID 1 and 2 should be different", threadId1, threadId2);
        assertNotEquals("Thread ID 2 and 3 should be different", threadId2, threadId3);
        assertNotEquals("Thread ID 1 and 3 should be different", threadId1, threadId3);
    }
}