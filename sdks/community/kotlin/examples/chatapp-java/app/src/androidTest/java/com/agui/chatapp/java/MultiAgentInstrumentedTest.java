package com.agui.chatapp.java;

import android.content.Context;

import androidx.lifecycle.LiveData;
import androidx.lifecycle.Observer;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import com.agui.chatapp.java.model.AgentProfile;
import com.agui.chatapp.java.model.AuthMethod;
import com.agui.chatapp.java.repository.MultiAgentRepository;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.*;

/**
 * Instrumented test for multi-agent functionality.
 * Tests the MultiAgentRepository with actual SharedPreferences storage.
 */
@RunWith(AndroidJUnit4.class)
public class MultiAgentInstrumentedTest {
    
    private MultiAgentRepository repository;
    private Context context;
    
    @Before
    public void setUp() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        repository = MultiAgentRepository.getInstance(context);
        
        // Clear any existing data
        repository.clearAll().join();
    }
    
    @After
    public void tearDown() {
        // Clean up after tests
        repository.clearAll().join();
    }
    
    @Test
    public void testAddAgent() throws Exception {
        // Create a test agent
        AgentProfile agent = createTestAgent("Test Agent", "https://api.test.com");
        
        // Add the agent
        repository.addAgent(agent).get(5, TimeUnit.SECONDS);
        
        // Verify it was added
        List<AgentProfile> agents = getLiveDataValue(repository.getAgents());
        assertEquals(1, agents.size());
        assertEquals("Test Agent", agents.get(0).getName());
        assertEquals("https://api.test.com", agents.get(0).getUrl());
    }
    
    @Test
    public void testUpdateAgent() throws Exception {
        // Create and add an agent
        AgentProfile agent = createTestAgent("Original Name", "https://api.test.com");
        repository.addAgent(agent).get(5, TimeUnit.SECONDS);
        
        // Update the agent
        AgentProfile updatedAgent = agent.toBuilder()
            .setName("Updated Name")
            .setUrl("https://api.updated.com")
            .build();
        repository.updateAgent(updatedAgent).get(5, TimeUnit.SECONDS);
        
        // Verify the update
        List<AgentProfile> agents = getLiveDataValue(repository.getAgents());
        assertEquals(1, agents.size());
        assertEquals("Updated Name", agents.get(0).getName());
        assertEquals("https://api.updated.com", agents.get(0).getUrl());
    }
    
    @Test
    public void testDeleteAgent() throws Exception {
        // Create and add multiple agents
        AgentProfile agent1 = createTestAgent("Agent 1", "https://api1.test.com");
        AgentProfile agent2 = createTestAgent("Agent 2", "https://api2.test.com");
        repository.addAgent(agent1).get(5, TimeUnit.SECONDS);
        repository.addAgent(agent2).get(5, TimeUnit.SECONDS);
        
        // Verify both were added
        List<AgentProfile> agents = getLiveDataValue(repository.getAgents());
        assertEquals(2, agents.size());
        
        // Delete one agent
        repository.deleteAgent(agent1.getId()).get(5, TimeUnit.SECONDS);
        
        // Verify deletion
        agents = getLiveDataValue(repository.getAgents());
        assertEquals(1, agents.size());
        assertEquals("Agent 2", agents.get(0).getName());
    }
    
    @Test
    public void testSetActiveAgent() throws Exception {
        // Create and add an agent
        AgentProfile agent = createTestAgent("Active Agent", "https://api.test.com");
        repository.addAgent(agent).get(5, TimeUnit.SECONDS);
        
        // Set it as active
        repository.setActiveAgent(agent).get(5, TimeUnit.SECONDS);
        
        // Verify it's active
        AgentProfile activeAgent = getLiveDataValue(repository.getActiveAgent());
        assertNotNull(activeAgent);
        assertEquals("Active Agent", activeAgent.getName());
        
        // Verify last used timestamp was updated
        assertTrue(activeAgent.getLastUsedAt() != null);
        assertTrue(activeAgent.getLastUsedAt() > 0);
    }
    
    @Test
    public void testAuthMethodPersistence() throws Exception {
        // Test with API Key
        AuthMethod.ApiKey apiKey = new AuthMethod.ApiKey("test-key-123", "X-Custom-Header");
        AgentProfile agentWithApiKey = createTestAgentWithAuth("API Agent", "https://api.test.com", apiKey);
        repository.addAgent(agentWithApiKey).get(5, TimeUnit.SECONDS);
        
        // Test with Bearer Token
        AuthMethod.BearerToken bearerToken = new AuthMethod.BearerToken("bearer-token-456");
        AgentProfile agentWithBearer = createTestAgentWithAuth("Bearer Agent", "https://bearer.test.com", bearerToken);
        repository.addAgent(agentWithBearer).get(5, TimeUnit.SECONDS);
        
        // Test with Basic Auth
        AuthMethod.BasicAuth basicAuth = new AuthMethod.BasicAuth("testuser", "testpass");
        AgentProfile agentWithBasic = createTestAgentWithAuth("Basic Agent", "https://basic.test.com", basicAuth);
        repository.addAgent(agentWithBasic).get(5, TimeUnit.SECONDS);
        
        // Verify all auth methods are persisted correctly
        List<AgentProfile> agents = getLiveDataValue(repository.getAgents());
        assertEquals(3, agents.size());
        
        // Find and verify each agent's auth method
        for (AgentProfile agent : agents) {
            if (agent.getName().equals("API Agent")) {
                assertTrue(agent.getAuthMethod() instanceof AuthMethod.ApiKey);
                AuthMethod.ApiKey savedApiKey = (AuthMethod.ApiKey) agent.getAuthMethod();
                assertEquals("test-key-123", savedApiKey.getKey());
                assertEquals("X-Custom-Header", savedApiKey.getHeaderName());
            } else if (agent.getName().equals("Bearer Agent")) {
                assertTrue(agent.getAuthMethod() instanceof AuthMethod.BearerToken);
                AuthMethod.BearerToken savedBearer = (AuthMethod.BearerToken) agent.getAuthMethod();
                assertEquals("bearer-token-456", savedBearer.getToken());
            } else if (agent.getName().equals("Basic Agent")) {
                assertTrue(agent.getAuthMethod() instanceof AuthMethod.BasicAuth);
                AuthMethod.BasicAuth savedBasic = (AuthMethod.BasicAuth) agent.getAuthMethod();
                assertEquals("testuser", savedBasic.getUsername());
                assertEquals("testpass", savedBasic.getPassword());
            }
        }
    }
    
    @Test
    public void testSystemPromptPersistence() throws Exception {
        String systemPrompt = "You are a helpful assistant. Be concise and friendly.";
        
        AgentProfile agent = new AgentProfile.Builder()
            .setId(UUID.randomUUID().toString())
            .setName("Prompted Agent")
            .setUrl("https://api.test.com")
            .setSystemPrompt(systemPrompt)
            .setAuthMethod(new AuthMethod.None())
            .setCreatedAt(System.currentTimeMillis())
            .build();
        
        repository.addAgent(agent).get(5, TimeUnit.SECONDS);
        
        // Retrieve and verify
        List<AgentProfile> agents = getLiveDataValue(repository.getAgents());
        assertEquals(1, agents.size());
        assertEquals(systemPrompt, agents.get(0).getSystemPrompt());
    }
    
    @Test
    public void testDescriptionPersistence() throws Exception {
        String description = "This is a test agent for demonstration purposes.";
        
        AgentProfile agent = new AgentProfile.Builder()
            .setId(UUID.randomUUID().toString())
            .setName("Described Agent")
            .setUrl("https://api.test.com")
            .setDescription(description)
            .setAuthMethod(new AuthMethod.None())
            .setCreatedAt(System.currentTimeMillis())
            .build();
        
        repository.addAgent(agent).get(5, TimeUnit.SECONDS);
        
        // Retrieve and verify
        List<AgentProfile> agents = getLiveDataValue(repository.getAgents());
        assertEquals(1, agents.size());
        assertEquals(description, agents.get(0).getDescription());
    }
    
    @Test
    public void testPersistenceAcrossRepositoryInstances() throws Exception {
        // Add agents with first repository instance
        AgentProfile agent1 = createTestAgent("Persistent Agent 1", "https://api1.test.com");
        AgentProfile agent2 = createTestAgent("Persistent Agent 2", "https://api2.test.com");
        repository.addAgent(agent1).get(5, TimeUnit.SECONDS);
        repository.addAgent(agent2).get(5, TimeUnit.SECONDS);
        repository.setActiveAgent(agent1).get(5, TimeUnit.SECONDS);
        
        // Create a new repository instance (simulating app restart)
        MultiAgentRepository newRepository = MultiAgentRepository.getInstance(context);
        
        // Verify data persisted
        List<AgentProfile> agents = getLiveDataValue(newRepository.getAgents());
        assertEquals(2, agents.size());
        
        AgentProfile activeAgent = getLiveDataValue(newRepository.getActiveAgent());
        assertNotNull(activeAgent);
        assertEquals("Persistent Agent 1", activeAgent.getName());
    }
    
    // Helper methods
    
    private AgentProfile createTestAgent(String name, String url) {
        return new AgentProfile.Builder()
            .setId(UUID.randomUUID().toString())
            .setName(name)
            .setUrl(url)
            .setAuthMethod(new AuthMethod.None())
            .setCreatedAt(System.currentTimeMillis())
            .build();
    }
    
    private AgentProfile createTestAgentWithAuth(String name, String url, AuthMethod authMethod) {
        return new AgentProfile.Builder()
            .setId(UUID.randomUUID().toString())
            .setName(name)
            .setUrl(url)
            .setAuthMethod(authMethod)
            .setCreatedAt(System.currentTimeMillis())
            .build();
    }
    
    private <T> T getLiveDataValue(LiveData<T> liveData) throws InterruptedException {
        AtomicReference<T> value = new AtomicReference<>();
        CountDownLatch latch = new CountDownLatch(1);
        
        Observer<T> observer = new Observer<T>() {
            @Override
            public void onChanged(T t) {
                value.set(t);
                latch.countDown();
                liveData.removeObserver(this);
            }
        };
        
        // Observe on main thread
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            liveData.observeForever(observer);
        });
        
        assertTrue("LiveData value was not set within timeout", 
                latch.await(5, TimeUnit.SECONDS));
        return value.get();
    }
}