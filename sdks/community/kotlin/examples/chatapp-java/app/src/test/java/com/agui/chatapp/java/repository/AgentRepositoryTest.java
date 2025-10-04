package com.agui.chatapp.java.repository;

import android.content.Context;
import android.content.SharedPreferences;

import org.junit.Test;
import org.junit.Before;
import org.junit.runner.RunWith;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;

import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Unit tests for AgentRepository class.
 * Tests configuration persistence and validation using Robolectric.
 */
@RunWith(RobolectricTestRunner.class)
public class AgentRepositoryTest {

    private AgentRepository repository;
    private Context context;

    @Before
    public void setUp() {
        MockitoAnnotations.openMocks(this);
        context = RuntimeEnvironment.getApplication();
        repository = new AgentRepository(context);
    }

    @Test
    public void testDefaultConfiguration() {
        AgentRepository.AgentConfig config = repository.loadAgentConfig();
        
        assertNotNull(config);
        assertFalse(config.isValid());
        assertEquals(AgentRepository.AuthType.NONE, config.getAuthType());
        assertEquals("", config.getAgentUrl());
        assertEquals("", config.getBearerToken());
        assertEquals("", config.getApiKey());
        assertEquals("x-api-key", config.getApiKeyHeader());
        assertEquals("", config.getSystemPrompt());
        assertFalse(config.isDebug());
    }

    @Test
    public void testSaveAndLoadConfiguration() {
        AgentRepository.AgentConfig config = new AgentRepository.AgentConfig();
        config.setAgentUrl("https://test.example.com/agent");
        config.setAuthType(AgentRepository.AuthType.BEARER);
        config.setBearerToken("test-token");
        config.setSystemPrompt("You are a test assistant");
        config.setDebug(true);

        repository.saveAgentConfig(config);

        AgentRepository.AgentConfig loaded = repository.loadAgentConfig();
        assertEquals("https://test.example.com/agent", loaded.getAgentUrl());
        assertEquals(AgentRepository.AuthType.BEARER, loaded.getAuthType());
        assertEquals("test-token", loaded.getBearerToken());
        assertEquals("You are a test assistant", loaded.getSystemPrompt());
        assertTrue(loaded.isDebug());
        assertTrue(loaded.isValid());
    }

    @Test
    public void testConfigurationValidation() {
        AgentRepository.AgentConfig config = new AgentRepository.AgentConfig();
        
        // Invalid - no URL
        assertFalse(config.isValid());
        
        // Valid - has URL
        config.setAgentUrl("https://example.com");
        assertTrue(config.isValid());
        
        // Still valid with authentication
        config.setAuthType(AgentRepository.AuthType.API_KEY);
        config.setApiKey("test-key");
        assertTrue(config.isValid());
    }

    @Test
    public void testHasAgentConfig() {
        assertFalse(repository.hasAgentConfig());

        AgentRepository.AgentConfig config = new AgentRepository.AgentConfig();
        config.setAgentUrl("https://test.com");
        repository.saveAgentConfig(config);

        assertTrue(repository.hasAgentConfig());
    }

    @Test
    public void testAuthTypeConversion() {
        AgentRepository.AgentConfig config = new AgentRepository.AgentConfig();
        
        config.setAuthType(AgentRepository.AuthType.NONE);
        repository.saveAgentConfig(config);
        assertEquals(AgentRepository.AuthType.NONE, repository.loadAgentConfig().getAuthType());

        config.setAuthType(AgentRepository.AuthType.BEARER);
        repository.saveAgentConfig(config);
        assertEquals(AgentRepository.AuthType.BEARER, repository.loadAgentConfig().getAuthType());

        config.setAuthType(AgentRepository.AuthType.API_KEY);
        repository.saveAgentConfig(config);
        assertEquals(AgentRepository.AuthType.API_KEY, repository.loadAgentConfig().getAuthType());
    }

    @Test
    public void testClearConfiguration() {
        // Save some config
        AgentRepository.AgentConfig config = new AgentRepository.AgentConfig();
        config.setAgentUrl("https://test.com");
        repository.saveAgentConfig(config);
        assertTrue(repository.hasAgentConfig());

        // Clear preferences to simulate reset
        context.getSharedPreferences("agent_settings", Context.MODE_PRIVATE)
               .edit()
               .clear()
               .apply();

        assertFalse(repository.hasAgentConfig());
        AgentRepository.AgentConfig cleared = repository.loadAgentConfig();
        assertFalse(cleared.isValid());
    }

    @Test
    public void testApiKeyHeaderCustomization() {
        AgentRepository.AgentConfig config = new AgentRepository.AgentConfig();
        config.setApiKeyHeader("Authorization");
        repository.saveAgentConfig(config);

        AgentRepository.AgentConfig loaded = repository.loadAgentConfig();
        assertEquals("Authorization", loaded.getApiKeyHeader());
    }

    @Test
    public void testEmptyStringHandling() {
        AgentRepository.AgentConfig config = new AgentRepository.AgentConfig();
        config.setAgentUrl("");
        config.setBearerToken("");
        config.setApiKey("");
        config.setSystemPrompt("");
        
        repository.saveAgentConfig(config);
        AgentRepository.AgentConfig loaded = repository.loadAgentConfig();
        
        assertFalse(loaded.isValid()); // Empty URL is invalid
        assertEquals("", loaded.getBearerToken());
        assertEquals("", loaded.getApiKey());
        assertEquals("", loaded.getSystemPrompt());
    }
}