package com.agui.chatapp.java.model;

import org.junit.Test;
import static org.junit.Assert.*;

/**
 * Unit tests for AgentProfile and its Builder.
 */
public class AgentProfileTest {

    @Test
    public void testAgentProfileBuilder() {
        long createdTime = System.currentTimeMillis();
        
        AgentProfile profile = new AgentProfile.Builder()
            .setName("Test Agent")
            .setUrl("https://api.example.com/agent")
            .setDescription("A test agent")
            .setAuthMethod(new AuthMethod.ApiKey("test-key"))
            .setActive(true)
            .setCreatedAt(createdTime)
            .setSystemPrompt("You are a helpful assistant")
            .build();
        
        assertNotNull(profile.getId()); // ID should be auto-generated
        assertEquals("Test Agent", profile.getName());
        assertEquals("https://api.example.com/agent", profile.getUrl());
        assertEquals("A test agent", profile.getDescription());
        assertTrue(profile.getAuthMethod() instanceof AuthMethod.ApiKey);
        assertTrue(profile.isActive());
        assertEquals(createdTime, profile.getCreatedAt());
        assertNull(profile.getLastUsedAt());
        assertEquals("You are a helpful assistant", profile.getSystemPrompt());
        assertTrue(profile.isValid());
    }

    @Test
    public void testAgentProfileWithCustomId() {
        AgentProfile profile = new AgentProfile.Builder()
            .setId("custom-id")
            .setName("Test Agent")
            .setUrl("https://api.example.com/agent")
            .build();
        
        assertEquals("custom-id", profile.getId());
        assertEquals("Test Agent", profile.getName());
        assertEquals("https://api.example.com/agent", profile.getUrl());
    }

    @Test
    public void testAgentProfileDefaults() {
        AgentProfile profile = new AgentProfile.Builder()
            .setName("Test Agent")
            .setUrl("https://api.example.com/agent")
            .build();
        
        assertNotNull(profile.getId());
        assertNull(profile.getDescription());
        assertTrue(profile.getAuthMethod() instanceof AuthMethod.None);
        assertFalse(profile.isActive());
        assertTrue(profile.getCreatedAt() > 0);
        assertNull(profile.getLastUsedAt());
        assertNull(profile.getSystemPrompt());
    }

    @Test
    public void testAgentProfileValidation() {
        // Valid profile
        AgentProfile validProfile = new AgentProfile.Builder()
            .setName("Valid Agent")
            .setUrl("https://api.example.com/agent")
            .setAuthMethod(new AuthMethod.ApiKey("valid-key"))
            .build();
        assertTrue(validProfile.isValid());
        
        // Invalid - missing name
        AgentProfile invalidName = new AgentProfile.Builder()
            .setName("")
            .setUrl("https://api.example.com/agent")
            .build();
        assertFalse(invalidName.isValid());
        
        // Invalid - missing URL
        AgentProfile invalidUrl = new AgentProfile.Builder()
            .setName("Test Agent")
            .setUrl("")
            .build();
        assertFalse(invalidUrl.isValid());
        
        // Invalid - invalid auth method
        AgentProfile invalidAuth = new AgentProfile.Builder()
            .setName("Test Agent")
            .setUrl("https://api.example.com/agent")
            .setAuthMethod(new AuthMethod.ApiKey("")) // empty key
            .build();
        assertFalse(invalidAuth.isValid());
    }

    @Test
    public void testAgentProfileCopyOperations() {
        AgentProfile original = new AgentProfile.Builder()
            .setName("Original Agent")
            .setUrl("https://api.example.com/agent")
            .setActive(false)
            .build();
        
        // Test withActive
        AgentProfile activated = original.withActive(true);
        assertFalse(original.isActive()); // Original unchanged
        assertTrue(activated.isActive());
        assertEquals(original.getName(), activated.getName());
        assertEquals(original.getUrl(), activated.getUrl());
        
        // Test withLastUsedAt
        long lastUsedTime = System.currentTimeMillis();
        AgentProfile withLastUsed = original.withLastUsedAt(lastUsedTime);
        assertNull(original.getLastUsedAt()); // Original unchanged
        assertEquals(Long.valueOf(lastUsedTime), withLastUsed.getLastUsedAt());
    }

    @Test
    public void testAgentProfileToBuilder() {
        long createdTime = System.currentTimeMillis();
        long lastUsedTime = createdTime + 1000;
        
        AgentProfile original = new AgentProfile.Builder()
            .setId("test-id")
            .setName("Test Agent")
            .setUrl("https://api.example.com/agent")
            .setDescription("Description")
            .setAuthMethod(new AuthMethod.BearerToken("token"))
            .setActive(true)
            .setCreatedAt(createdTime)
            .setLastUsedAt(lastUsedTime)
            .setSystemPrompt("System prompt")
            .build();
        
        // Create a copy using toBuilder
        AgentProfile copy = original.toBuilder()
            .setName("Modified Agent")
            .build();
        
        assertEquals("test-id", copy.getId());
        assertEquals("Modified Agent", copy.getName()); // Changed
        assertEquals("https://api.example.com/agent", copy.getUrl()); // Same
        assertEquals("Description", copy.getDescription()); // Same
        assertTrue(copy.getAuthMethod() instanceof AuthMethod.BearerToken); // Same
        assertTrue(copy.isActive()); // Same
        assertEquals(createdTime, copy.getCreatedAt()); // Same
        assertEquals(Long.valueOf(lastUsedTime), copy.getLastUsedAt()); // Same
        assertEquals("System prompt", copy.getSystemPrompt()); // Same
    }

    @Test
    public void testAgentProfileEquality() {
        long createdTime = System.currentTimeMillis();
        
        AgentProfile profile1 = new AgentProfile.Builder()
            .setId("same-id")
            .setName("Test Agent")
            .setUrl("https://api.example.com/agent")
            .setAuthMethod(new AuthMethod.ApiKey("key"))
            .setCreatedAt(createdTime)
            .build();
        
        AgentProfile profile2 = new AgentProfile.Builder()
            .setId("same-id")
            .setName("Test Agent")
            .setUrl("https://api.example.com/agent")
            .setAuthMethod(new AuthMethod.ApiKey("key"))
            .setCreatedAt(createdTime)
            .build();
        
        AgentProfile profile3 = new AgentProfile.Builder()
            .setId("different-id")
            .setName("Test Agent")
            .setUrl("https://api.example.com/agent")
            .setAuthMethod(new AuthMethod.ApiKey("key"))
            .setCreatedAt(createdTime)
            .build();
        
        assertEquals(profile1, profile2);
        assertEquals(profile1.hashCode(), profile2.hashCode());
        assertNotEquals(profile1, profile3);
    }

    @Test
    public void testGenerateId() {
        String id1 = AgentProfile.generateId();
        String id2 = AgentProfile.generateId();
        
        assertNotNull(id1);
        assertNotNull(id2);
        assertNotEquals(id1, id2); // Should be unique
        assertTrue(id1.startsWith("agent_"));
        assertTrue(id2.startsWith("agent_"));
    }

    @Test
    public void testAgentProfileToString() {
        AgentProfile profile = new AgentProfile.Builder()
            .setName("Test Agent")
            .setUrl("https://api.example.com/agent")
            .build();
        
        String toString = profile.toString();
        assertNotNull(toString);
        assertTrue(toString.contains("AgentProfile"));
        assertTrue(toString.contains("Test Agent"));
        assertTrue(toString.contains("https://api.example.com/agent"));
    }
}