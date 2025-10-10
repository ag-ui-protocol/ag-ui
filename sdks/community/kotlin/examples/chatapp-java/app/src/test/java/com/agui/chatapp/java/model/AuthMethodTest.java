package com.agui.chatapp.java.model;

import org.junit.Test;
import static org.junit.Assert.*;

/**
 * Unit tests for AuthMethod and its subclasses.
 */
public class AuthMethodTest {

    @Test
    public void testNoneAuthMethod() {
        AuthMethod.None none = new AuthMethod.None();
        
        assertEquals("none", none.getType());
        assertTrue(none.isValid());
        
        // Test equality
        AuthMethod.None another = new AuthMethod.None();
        assertEquals(none, another);
        assertEquals(none.hashCode(), another.hashCode());
        
        // Test toString
        assertNotNull(none.toString());
        assertTrue(none.toString().contains("None"));
    }

    @Test
    public void testApiKeyAuthMethod() {
        // Test with default header
        AuthMethod.ApiKey apiKey1 = new AuthMethod.ApiKey("test-key");
        
        assertEquals("api_key", apiKey1.getType());
        assertEquals("test-key", apiKey1.getKey());
        assertEquals("X-API-Key", apiKey1.getHeaderName());
        assertTrue(apiKey1.isValid());
        
        // Test with custom header
        AuthMethod.ApiKey apiKey2 = new AuthMethod.ApiKey("another-key", "Custom-Header");
        
        assertEquals("api_key", apiKey2.getType());
        assertEquals("another-key", apiKey2.getKey());
        assertEquals("Custom-Header", apiKey2.getHeaderName());
        assertTrue(apiKey2.isValid());
        
        // Test equality
        AuthMethod.ApiKey apiKey3 = new AuthMethod.ApiKey("test-key", "X-API-Key");
        assertEquals(apiKey1, apiKey3);
        assertEquals(apiKey1.hashCode(), apiKey3.hashCode());
        assertNotEquals(apiKey1, apiKey2);
        
        // Test toString (should hide key)
        String toString = apiKey1.toString();
        assertNotNull(toString);
        assertTrue(toString.contains("ApiKey"));
        assertTrue(toString.contains("***"));
        assertFalse(toString.contains("test-key"));
    }

    @Test
    public void testApiKeyValidation() {
        // Valid cases
        assertTrue(new AuthMethod.ApiKey("valid-key").isValid());
        assertTrue(new AuthMethod.ApiKey("valid-key", "Valid-Header").isValid());
        
        // Invalid cases - empty/null key
        assertFalse(new AuthMethod.ApiKey("").isValid());
        assertFalse(new AuthMethod.ApiKey("   ").isValid());
        
        // Invalid cases - empty/null header
        assertFalse(new AuthMethod.ApiKey("valid-key", "").isValid());
        assertFalse(new AuthMethod.ApiKey("valid-key", "   ").isValid());
    }

    @Test
    public void testBearerTokenAuthMethod() {
        AuthMethod.BearerToken token = new AuthMethod.BearerToken("test-token");
        
        assertEquals("bearer_token", token.getType());
        assertEquals("test-token", token.getToken());
        assertTrue(token.isValid());
        
        // Test equality
        AuthMethod.BearerToken token2 = new AuthMethod.BearerToken("test-token");
        assertEquals(token, token2);
        assertEquals(token.hashCode(), token2.hashCode());
        
        AuthMethod.BearerToken token3 = new AuthMethod.BearerToken("different-token");
        assertNotEquals(token, token3);
        
        // Test toString (should hide token)
        String toString = token.toString();
        assertNotNull(toString);
        assertTrue(toString.contains("BearerToken"));
        assertTrue(toString.contains("***"));
        assertFalse(toString.contains("test-token"));
    }

    @Test
    public void testBearerTokenValidation() {
        // Valid cases
        assertTrue(new AuthMethod.BearerToken("valid-token").isValid());
        
        // Invalid cases
        assertFalse(new AuthMethod.BearerToken("").isValid());
        assertFalse(new AuthMethod.BearerToken("   ").isValid());
    }

    @Test
    public void testBasicAuthMethod() {
        AuthMethod.BasicAuth basicAuth = new AuthMethod.BasicAuth("username", "secret123");
        
        assertEquals("basic_auth", basicAuth.getType());
        assertEquals("username", basicAuth.getUsername());
        assertEquals("secret123", basicAuth.getPassword());
        assertTrue(basicAuth.isValid());
        
        // Test equality
        AuthMethod.BasicAuth basicAuth2 = new AuthMethod.BasicAuth("username", "secret123");
        assertEquals(basicAuth, basicAuth2);
        assertEquals(basicAuth.hashCode(), basicAuth2.hashCode());
        
        AuthMethod.BasicAuth basicAuth3 = new AuthMethod.BasicAuth("different", "secret123");
        assertNotEquals(basicAuth, basicAuth3);
        
        // Test toString (should hide password value)
        String toString = basicAuth.toString();
        assertNotNull(toString);
        assertTrue(toString.contains("BasicAuth"));
        assertTrue(toString.contains("username"));
        assertTrue(toString.contains("***"));
        assertFalse(toString.contains("secret123")); // Check actual password value isn't shown
    }

    @Test
    public void testBasicAuthValidation() {
        // Valid cases
        assertTrue(new AuthMethod.BasicAuth("user", "pass").isValid());
        
        // Invalid cases - empty/null username
        assertFalse(new AuthMethod.BasicAuth("", "pass").isValid());
        assertFalse(new AuthMethod.BasicAuth("   ", "pass").isValid());
        
        // Invalid cases - empty/null password
        assertFalse(new AuthMethod.BasicAuth("user", "").isValid());
        assertFalse(new AuthMethod.BasicAuth("user", "   ").isValid());
    }

    @Test
    public void testDifferentAuthMethodTypes() {
        AuthMethod none = new AuthMethod.None();
        AuthMethod apiKey = new AuthMethod.ApiKey("key");
        AuthMethod bearerToken = new AuthMethod.BearerToken("token");
        AuthMethod basicAuth = new AuthMethod.BasicAuth("user", "pass");
        
        // Different types should not be equal
        assertNotEquals(none, apiKey);
        assertNotEquals(apiKey, bearerToken);
        assertNotEquals(bearerToken, basicAuth);
        assertNotEquals(basicAuth, none);
        
        // All should be valid
        assertTrue(none.isValid());
        assertTrue(apiKey.isValid());
        assertTrue(bearerToken.isValid());
        assertTrue(basicAuth.isValid());
        
        // Check types
        assertEquals("none", none.getType());
        assertEquals("api_key", apiKey.getType());
        assertEquals("bearer_token", bearerToken.getType());
        assertEquals("basic_auth", basicAuth.getType());
    }
}