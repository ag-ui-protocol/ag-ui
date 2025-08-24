package com.agui.chatapp.java.repository;

import android.content.Context;
import androidx.arch.core.executor.testing.InstantTaskExecutorRule;
import androidx.lifecycle.Observer;

import com.agui.chatapp.java.model.AgentProfile;
import com.agui.chatapp.java.model.AuthMethod;
import com.agui.chatapp.java.model.ChatSession;

import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;

import java.lang.reflect.Field;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

/**
 * Comprehensive tests for MultiAgentRepository singleton pattern.
 * Tests singleton behavior, data consistency, LiveData observation, and CRUD operations.
 */
@RunWith(RobolectricTestRunner.class)
public class MultiAgentRepositoryTest {

    @Rule
    public InstantTaskExecutorRule instantExecutorRule = new InstantTaskExecutorRule();

    private Context context;
    private MultiAgentRepository repository;

    @Mock
    private Observer<List<AgentProfile>> agentsObserver;

    @Mock
    private Observer<AgentProfile> activeAgentObserver;

    @Mock
    private Observer<ChatSession> sessionObserver;

    @Before
    public void setUp() {
        MockitoAnnotations.openMocks(this);
        context = RuntimeEnvironment.getApplication();
        
        // Clear any existing singleton instance using reflection
        clearSingletonInstance();
        
        // Get fresh instance
        repository = MultiAgentRepository.getInstance(context);
        
        // Clear all data for clean test environment
        repository.clearAll().join();
    }

    @After
    public void tearDown() {
        // Clear data and singleton for next test
        if (repository != null) {
            repository.clearAll().join();
        }
        clearSingletonInstance();
    }

    /**
     * Clear singleton instance using reflection for testing
     */
    private void clearSingletonInstance() {
        try {
            Field instanceField = MultiAgentRepository.class.getDeclaredField("INSTANCE");
            instanceField.setAccessible(true);
            instanceField.set(null, null);
        } catch (Exception e) {
            // Ignore reflection errors in tests
        }
    }

    // ===== SINGLETON PATTERN TESTS =====

    @Test
    public void testSingletonInstance_SameInstance() {
        MultiAgentRepository instance1 = MultiAgentRepository.getInstance(context);
        MultiAgentRepository instance2 = MultiAgentRepository.getInstance(context);
        
        assertSame("Should return same instance", instance1, instance2);
    }

    @Test
    public void testSingletonInstance_DifferentContexts() {
        Context appContext = context.getApplicationContext();
        Context activityContext = context; // In tests, both are same, but verifies behavior
        
        MultiAgentRepository instance1 = MultiAgentRepository.getInstance(appContext);
        MultiAgentRepository instance2 = MultiAgentRepository.getInstance(activityContext);
        
        assertSame("Should return same instance regardless of context type", instance1, instance2);
    }

    @Test
    public void testSingletonInstance_ThreadSafety() throws InterruptedException {
        final int numThreads = 10;
        final CountDownLatch latch = new CountDownLatch(numThreads);
        final AtomicReference<MultiAgentRepository>[] instances = new AtomicReference[numThreads];
        
        // Initialize array
        for (int i = 0; i < numThreads; i++) {
            instances[i] = new AtomicReference<>();
        }
        
        // Create multiple threads to test concurrent access
        Thread[] threads = new Thread[numThreads];
        for (int i = 0; i < numThreads; i++) {
            final int index = i;
            threads[i] = new Thread(() -> {
                instances[index].set(MultiAgentRepository.getInstance(context));
                latch.countDown();
            });
        }
        
        // Start all threads
        for (Thread thread : threads) {
            thread.start();
        }
        
        // Wait for completion
        assertTrue("Threads should complete within timeout", latch.await(5, TimeUnit.SECONDS));
        
        // Verify all instances are the same
        MultiAgentRepository firstInstance = instances[0].get();
        for (int i = 1; i < numThreads; i++) {
            assertSame("All instances should be the same", firstInstance, instances[i].get());
        }
    }

    // ===== DATA CONSISTENCY TESTS =====

    @Test
    public void testDataConsistency_AcrossMultipleReferences() {
        // Get two references to the repository
        MultiAgentRepository repo1 = MultiAgentRepository.getInstance(context);
        MultiAgentRepository repo2 = MultiAgentRepository.getInstance(context);
        
        // They should be the same instance
        assertSame("Repository instances should be the same", repo1, repo2);
        
        // Create test agent
        AgentProfile testAgent = createTestAgent("test-agent-1", "Test Agent 1");
        
        // Set up observer on second reference before adding agent
        repo2.getAgents().observeForever(agentsObserver);
        
        // Add agent through first reference
        repo1.addAgent(testAgent).join();
        
        // Verify observer was notified (at least twice: initial empty + addition)
        verify(agentsObserver, atLeast(2)).onChanged(any(List.class));
        
        // Verify current value is correct
        List<AgentProfile> agents = repo2.getAgents().getValue();
        assertNotNull("Agents list should not be null", agents);
        assertEquals("Should have one agent", 1, agents.size());
        assertEquals("Agent should match", testAgent.getId(), agents.get(0).getId());
    }

    @Test
    public void testActiveAgentConsistency_AcrossReferences() {
        MultiAgentRepository repo1 = MultiAgentRepository.getInstance(context);
        MultiAgentRepository repo2 = MultiAgentRepository.getInstance(context);
        
        // Create and add test agent
        AgentProfile testAgent = createTestAgent("test-agent-1", "Test Agent 1");
        repo1.addAgent(testAgent).join();
        
        // Set up observer on second reference
        repo2.getActiveAgent().observeForever(activeAgentObserver);
        
        // Set active agent through first reference
        repo1.setActiveAgent(testAgent).join();
        
        // Verify observer was notified
        verify(activeAgentObserver).onChanged(any(AgentProfile.class));
        
        // Verify current value is correct
        AgentProfile activeAgent = repo2.getActiveAgent().getValue();
        assertNotNull("Active agent should not be null", activeAgent);
        assertEquals("Active agent should match", testAgent.getId(), activeAgent.getId());
        
        // Also verify synchronous access is consistent
        AgentProfile directActiveAgent = repo1.getCurrentActiveAgent();
        assertEquals("Direct and LiveData active agents should match", 
                activeAgent.getId(), directActiveAgent.getId());
    }

    // ===== LIVEDATA OBSERVATION TESTS =====

    @Test
    public void testLiveDataObservation_AgentAddition() {
        // Set up observer before any operations
        repository.getAgents().observeForever(agentsObserver);
        
        // Initial call should happen immediately with empty list
        verify(agentsObserver).onChanged(any(List.class));
        reset(agentsObserver); // Reset to count new calls
        
        // Create and add agent
        AgentProfile testAgent = createTestAgent("test-agent", "Test Agent");
        repository.addAgent(testAgent).join();
        
        // Observer should be notified of the addition
        verify(agentsObserver).onChanged(any(List.class));
        
        // Verify current value is correct
        List<AgentProfile> agents = repository.getAgents().getValue();
        assertNotNull("Agents should not be null", agents);
        assertEquals("Should have one agent", 1, agents.size());
        assertEquals("Agent should match", testAgent.getId(), agents.get(0).getId());
    }

    @Test
    public void testLiveDataObservation_AgentActivation() {
        // Create and add test agent
        AgentProfile testAgent = createTestAgent("test-agent", "Test Agent");
        repository.addAgent(testAgent).join();
        
        // Set up observer
        repository.getActiveAgent().observeForever(activeAgentObserver);
        
        // Activate agent
        repository.setActiveAgent(testAgent).join();
        
        // Observer should be notified
        verify(activeAgentObserver).onChanged(any(AgentProfile.class));
        
        // Verify current value is correct
        AgentProfile activeAgent = repository.getActiveAgent().getValue();
        assertNotNull("Active agent should not be null", activeAgent);
        assertEquals("Active agent should match", testAgent.getId(), activeAgent.getId());
    }

    @Test
    public void testLiveDataInstances_SameAcrossReferences() {
        MultiAgentRepository repo1 = MultiAgentRepository.getInstance(context);
        MultiAgentRepository repo2 = MultiAgentRepository.getInstance(context);
        
        // LiveData instances should be the same since repositories are the same
        assertSame("Agents LiveData should be same instance", 
                repo1.getAgents(), repo2.getAgents());
        assertSame("Active agent LiveData should be same instance", 
                repo1.getActiveAgent(), repo2.getActiveAgent());
        assertSame("Current session LiveData should be same instance", 
                repo1.getCurrentSession(), repo2.getCurrentSession());
    }

    // ===== CRUD OPERATION TESTS =====

    @Test
    public void testCRUDOperations_BasicFlow() throws InterruptedException {
        // Create
        AgentProfile agent = createTestAgent("crud-test", "CRUD Test Agent");
        repository.addAgent(agent).join();
        
        // Read
        AgentProfile retrieved = repository.getAgent(agent.getId()).join();
        assertEquals("Retrieved agent should match", agent.getId(), retrieved.getId());
        assertEquals("Retrieved agent name should match", agent.getName(), retrieved.getName());
        
        // Update
        AgentProfile updated = agent.toBuilder()
                .setName("Updated CRUD Test Agent")
                .setDescription("Updated description")
                .build();
        repository.updateAgent(updated).join();
        
        AgentProfile updatedRetrieved = repository.getAgent(agent.getId()).join();
        assertEquals("Updated name should match", "Updated CRUD Test Agent", updatedRetrieved.getName());
        assertEquals("Updated description should match", "Updated description", updatedRetrieved.getDescription());
        
        // Delete
        repository.deleteAgent(agent.getId()).join();
        
        try {
            repository.getAgent(agent.getId()).join();
            fail("Should throw exception for deleted agent");
        } catch (Exception e) {
            assertTrue("Should get IllegalArgumentException", e.getCause() instanceof IllegalArgumentException);
        }
    }

    @Test
    public void testActiveAgentDeletion_ClearsActiveAgent() throws InterruptedException {
        // Create and add agent
        AgentProfile agent = createTestAgent("delete-test", "Delete Test Agent");
        repository.addAgent(agent).join();
        repository.setActiveAgent(agent).join();
        
        // Verify agent is active
        assertNotNull("Agent should be active", repository.getCurrentActiveAgent());
        
        // Delete active agent
        repository.deleteAgent(agent.getId()).join();
        
        // Verify active agent is cleared
        assertNull("Active agent should be cleared after deletion", repository.getCurrentActiveAgent());
    }

    // ===== SESSION MANAGEMENT TESTS =====

    @Test
    public void testSessionCreation_OnAgentActivation() throws InterruptedException {
        AgentProfile agent = createTestAgent("session-test", "Session Test Agent");
        repository.addAgent(agent).join();
        
        // Initially no session
        assertNull("Should have no session initially", repository.getCurrentChatSession());
        
        // Activate agent
        repository.setActiveAgent(agent).join();
        
        // Should have session
        ChatSession session = repository.getCurrentChatSession();
        assertNotNull("Should have session after activation", session);
        assertEquals("Session should be for correct agent", agent.getId(), session.getAgentId());
        assertNotNull("Session should have thread ID", session.getThreadId());
    }

    @Test
    public void testNewSessionOnEachActivation() throws InterruptedException {
        AgentProfile agent = createTestAgent("session-test", "Session Test Agent");
        repository.addAgent(agent).join();
        
        // First activation
        repository.setActiveAgent(agent).join();
        ChatSession session1 = repository.getCurrentChatSession();
        assertNotNull("First session should exist", session1);
        
        // Deactivate
        repository.setActiveAgent(null).join();
        assertNull("Session should be cleared", repository.getCurrentChatSession());
        
        // Reactivate same agent
        repository.setActiveAgent(agent).join();
        ChatSession session2 = repository.getCurrentChatSession();
        assertNotNull("Second session should exist", session2);
        
        // Should be different sessions (different thread IDs)
        assertNotEquals("Sessions should have different thread IDs", 
                session1.getThreadId(), session2.getThreadId());
    }

    // ===== PERSISTENCE TESTS =====

    @Test
    public void testPersistence_AgentSurvivesInstanceRecreation() {
        // Add agent to current instance
        AgentProfile agent = createTestAgent("persist-test", "Persistence Test Agent");
        repository.addAgent(agent).join();
        repository.setActiveAgent(agent).join();
        
        // Clear singleton and create new instance
        clearSingletonInstance();
        MultiAgentRepository newRepository = MultiAgentRepository.getInstance(context);
        
        // Wait for the new repository to finish loading
        newRepository.waitForInitialization().join();
        
        // Verify agent persisted
        AgentProfile retrieved = newRepository.getCurrentActiveAgent();
        assertNotNull("Active agent should persist", retrieved);
        assertEquals("Persisted agent should match", agent.getId(), retrieved.getId());
        assertEquals("Persisted agent name should match", agent.getName(), retrieved.getName());
    }

    // ===== HELPER METHODS =====

    private AgentProfile createTestAgent(String id, String name) {
        return new AgentProfile.Builder()
                .setId(id)
                .setName(name)
                .setUrl("https://test.example.com/agent")
                .setDescription("Test agent description")
                .setAuthMethod(new AuthMethod.None())
                .setSystemPrompt("You are a test assistant")
                .build();
    }
}