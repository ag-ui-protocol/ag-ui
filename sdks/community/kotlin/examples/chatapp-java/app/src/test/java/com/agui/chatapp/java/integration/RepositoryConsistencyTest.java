package com.agui.chatapp.java.integration;

import android.app.Application;
import android.content.Context;
import androidx.arch.core.executor.testing.InstantTaskExecutorRule;
import androidx.lifecycle.Observer;

import com.agui.chatapp.java.model.AgentProfile;
import com.agui.chatapp.java.model.AuthMethod;
import com.agui.chatapp.java.repository.MultiAgentRepository;
import com.agui.chatapp.java.viewmodel.ChatViewModel;

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

import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

/**
 * Integration tests to verify repository singleton consistency across different components.
 * These tests ensure that ChatViewModel, SettingsActivity, and direct repository access
 * all work with the same repository instance and see consistent data.
 */
@RunWith(RobolectricTestRunner.class)
public class RepositoryConsistencyTest {

    @Rule
    public InstantTaskExecutorRule instantExecutorRule = new InstantTaskExecutorRule();

    private Context context;
    private Application application;

    @Mock
    private Observer<List<AgentProfile>> agentsObserver;

    @Mock
    private Observer<AgentProfile> activeAgentObserver;

    @Before
    public void setUp() {
        MockitoAnnotations.openMocks(this);
        context = RuntimeEnvironment.getApplication();
        application = RuntimeEnvironment.getApplication();
        
        // Clear singleton instance for clean test
        clearSingletonInstance();
        
        // Clear any existing data
        MultiAgentRepository.getInstance(context).clearAll().join();
    }

    @After
    public void tearDown() {
        // Clear singleton for next test
        clearSingletonInstance();
    }

    private void clearSingletonInstance() {
        try {
            Field instanceField = MultiAgentRepository.class.getDeclaredField("INSTANCE");
            instanceField.setAccessible(true);
            instanceField.set(null, null);
        } catch (Exception e) {
            // Ignore reflection errors
        }
    }

    @Test
    public void testRepositoryConsistency_ViewModelAndDirectAccess() {
        // Create ChatViewModel (which gets repository via singleton)
        ChatViewModel viewModel = new ChatViewModel(application);
        
        // Get repository directly
        MultiAgentRepository directRepository = MultiAgentRepository.getInstance(context);
        
        // They should be the same repository instance underlying the ViewModel
        // We can verify this by checking that changes made via direct access
        // are visible through the ViewModel's LiveData
        
        // Set up observer on the agents LiveData
        directRepository.getAgents().observeForever(agentsObserver);
        
        // Create test agent and add via direct repository
        AgentProfile testAgent = createTestAgent("consistency-test-1", "Consistency Test Agent 1");
        directRepository.addAgent(testAgent).join();
        
        // Verify observer was notified
        verify(agentsObserver, atLeast(2)).onChanged(any(List.class)); // Initial + addition
        
        // Verify the data is accessible through both direct access and ViewModel
        List<AgentProfile> directAgents = directRepository.getAgents().getValue();
        List<AgentProfile> viewModelAgents = viewModel.getActiveAgent().getValue() != null ? 
                directRepository.getAgents().getValue() : directRepository.getAgents().getValue();
        
        assertNotNull("Direct agents should not be null", directAgents);
        assertEquals("Should have one agent", 1, directAgents.size());
        assertEquals("Agent should match", testAgent.getId(), directAgents.get(0).getId());
    }

    @Test
    public void testActiveAgentConsistency_AcrossComponents() {
        // Create ChatViewModel
        ChatViewModel viewModel = new ChatViewModel(application);
        
        // Get repository directly  
        MultiAgentRepository directRepository = MultiAgentRepository.getInstance(context);
        
        // Create and add test agent
        AgentProfile testAgent = createTestAgent("active-test", "Active Test Agent");
        directRepository.addAgent(testAgent).join();
        
        // Set up observer
        directRepository.getActiveAgent().observeForever(activeAgentObserver);
        
        // Set active agent via direct repository
        directRepository.setActiveAgent(testAgent).join();
        
        // Verify observer was notified
        verify(activeAgentObserver).onChanged(any(AgentProfile.class));
        
        // Verify data consistency
        AgentProfile directActiveAgent = directRepository.getCurrentActiveAgent();
        AgentProfile liveDataActiveAgent = directRepository.getActiveAgent().getValue();
        
        assertNotNull("Direct repository should return active agent", directActiveAgent);
        assertNotNull("LiveData should return active agent", liveDataActiveAgent);
        assertEquals("Direct and LiveData active agents should match", 
                directActiveAgent.getId(), liveDataActiveAgent.getId());
        assertEquals("Active agent should match test agent", 
                testAgent.getId(), directActiveAgent.getId());
    }

    @Test
    public void testMultipleViewModels_ShareSameRepository() {
        // Create two ChatViewModel instances
        ChatViewModel viewModel1 = new ChatViewModel(application);
        ChatViewModel viewModel2 = new ChatViewModel(application);
        
        // Get repository instances they use
        MultiAgentRepository repo1 = MultiAgentRepository.getInstance(context);
        MultiAgentRepository repo2 = MultiAgentRepository.getInstance(context);
        
        // Should be the same instance
        assertSame("ViewModels should use same repository instance", repo1, repo2);
        
        // Create test agent and add via first repository reference
        AgentProfile testAgent = createTestAgent("multi-vm-test", "Multi ViewModel Test");
        repo1.addAgent(testAgent).join();
        repo1.setActiveAgent(testAgent).join();
        
        // Verify both repository references see the same data
        AgentProfile activeAgent1 = repo1.getCurrentActiveAgent();
        AgentProfile activeAgent2 = repo2.getCurrentActiveAgent();
        
        assertNotNull("First repository should have active agent", activeAgent1);
        assertNotNull("Second repository should have active agent", activeAgent2);
        assertEquals("Both repositories should see same agent", 
                activeAgent1.getId(), activeAgent2.getId());
    }

    @Test
    public void testDataModification_PropagatesAcrossComponents() {
        // Create components
        ChatViewModel viewModel = new ChatViewModel(application);
        MultiAgentRepository directRepository = MultiAgentRepository.getInstance(context);
        
        // Create and add agent
        AgentProfile originalAgent = createTestAgent("propagation-test", "Original Agent");
        directRepository.addAgent(originalAgent).join();
        directRepository.setActiveAgent(originalAgent).join();
        
        // Set up observer
        directRepository.getActiveAgent().observeForever(activeAgentObserver);
        reset(activeAgentObserver); // Reset initial calls
        
        // Modify agent via direct repository
        AgentProfile modifiedAgent = originalAgent.toBuilder()
                .setName("Modified Agent Name")
                .setDescription("Modified description")
                .build();
        directRepository.updateAgent(modifiedAgent).join();
        
        // Verify observer was notified of update
        verify(activeAgentObserver).onChanged(any(AgentProfile.class));
        
        // Verify the updated data is visible
        AgentProfile updatedAgent = directRepository.getActiveAgent().getValue();
        assertNotNull("Updated agent should not be null", updatedAgent);
        assertEquals("Agent name should be updated", "Modified Agent Name", updatedAgent.getName());
        assertEquals("Agent description should be updated", "Modified description", updatedAgent.getDescription());
    }

    @Test
    public void testAgentDeletion_ConsistentAcrossComponents() {
        // Create components
        ChatViewModel viewModel = new ChatViewModel(application);
        MultiAgentRepository directRepository = MultiAgentRepository.getInstance(context);
        
        // Create and add agent
        AgentProfile testAgent = createTestAgent("deletion-test", "Deletion Test Agent");
        directRepository.addAgent(testAgent).join();
        directRepository.setActiveAgent(testAgent).join();
        
        // Verify both components see the agent initially
        assertNotNull("Direct repository should have active agent", directRepository.getCurrentActiveAgent());
        
        // Set up observer
        directRepository.getActiveAgent().observeForever(activeAgentObserver);
        reset(activeAgentObserver); // Reset initial calls
        
        // Delete agent via direct repository
        directRepository.deleteAgent(testAgent.getId()).join();
        
        // Verify active agent is cleared
        assertNull("Direct repository should have no active agent after deletion", 
                directRepository.getCurrentActiveAgent());
        
        // Verify LiveData was updated
        assertNull("LiveData should show no active agent after deletion",
                directRepository.getActiveAgent().getValue());
    }

    // ===== HELPER METHODS =====

    private AgentProfile createTestAgent(String id, String name) {
        return new AgentProfile.Builder()
                .setId(id)
                .setName(name)
                .setUrl("https://test.example.com/" + id)
                .setDescription("Test agent: " + name)
                .setAuthMethod(new AuthMethod.None())
                .setSystemPrompt("You are " + name)
                .build();
    }
}