package com.agui.chatapp.java.model;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

/**
 * Base class for different authentication methods supported by agents.
 * This is a Java implementation of the Kotlin sealed class from the compose app.
 */
public abstract class AuthMethod {
    
    /**
     * Get the type identifier for this auth method.
     */
    public abstract String getType();
    
    /**
     * Check if this auth method is valid and can be used.
     */
    public abstract boolean isValid();
    
    /**
     * No authentication required.
     */
    public static class None extends AuthMethod {
        @Override
        public String getType() {
            return "none";
        }
        
        @Override
        public boolean isValid() {
            return true;
        }
        
        @Override
        public boolean equals(Object obj) {
            return obj instanceof None;
        }
        
        @Override
        public int hashCode() {
            return getType().hashCode();
        }
        
        @Override
        public String toString() {
            return "AuthMethod.None{}";
        }
    }
    
    /**
     * API Key authentication with configurable header name.
     */
    public static class ApiKey extends AuthMethod {
        private final String key;
        private final String headerName;
        
        public ApiKey(@NonNull String key, @NonNull String headerName) {
            this.key = key;
            this.headerName = headerName;
        }
        
        public ApiKey(@NonNull String key) {
            this(key, "X-API-Key");
        }
        
        @NonNull
        public String getKey() {
            return key;
        }
        
        @NonNull
        public String getHeaderName() {
            return headerName;
        }
        
        @Override
        public String getType() {
            return "api_key";
        }
        
        @Override
        public boolean isValid() {
            return key != null && !key.trim().isEmpty() && 
                   headerName != null && !headerName.trim().isEmpty();
        }
        
        @Override
        public boolean equals(Object obj) {
            if (this == obj) return true;
            if (!(obj instanceof ApiKey)) return false;
            ApiKey apiKey = (ApiKey) obj;
            return key.equals(apiKey.key) && headerName.equals(apiKey.headerName);
        }
        
        @Override
        public int hashCode() {
            return key.hashCode() * 31 + headerName.hashCode();
        }
        
        @Override
        public String toString() {
            return "AuthMethod.ApiKey{key='***', headerName='" + headerName + "'}";
        }
    }
    
    /**
     * Bearer Token authentication.
     */
    public static class BearerToken extends AuthMethod {
        private final String token;
        
        public BearerToken(@NonNull String token) {
            this.token = token;
        }
        
        @NonNull
        public String getToken() {
            return token;
        }
        
        @Override
        public String getType() {
            return "bearer_token";
        }
        
        @Override
        public boolean isValid() {
            return token != null && !token.trim().isEmpty();
        }
        
        @Override
        public boolean equals(Object obj) {
            if (this == obj) return true;
            if (!(obj instanceof BearerToken)) return false;
            BearerToken that = (BearerToken) obj;
            return token.equals(that.token);
        }
        
        @Override
        public int hashCode() {
            return token.hashCode();
        }
        
        @Override
        public String toString() {
            return "AuthMethod.BearerToken{token='***'}";
        }
    }
    
    /**
     * Basic Auth with username and password.
     */
    public static class BasicAuth extends AuthMethod {
        private final String username;
        private final String password;
        
        public BasicAuth(@NonNull String username, @NonNull String password) {
            this.username = username;
            this.password = password;
        }
        
        @NonNull
        public String getUsername() {
            return username;
        }
        
        @NonNull
        public String getPassword() {
            return password;
        }
        
        @Override
        public String getType() {
            return "basic_auth";
        }
        
        @Override
        public boolean isValid() {
            return username != null && !username.trim().isEmpty() && 
                   password != null && !password.trim().isEmpty();
        }
        
        @Override
        public boolean equals(Object obj) {
            if (this == obj) return true;
            if (!(obj instanceof BasicAuth)) return false;
            BasicAuth basicAuth = (BasicAuth) obj;
            return username.equals(basicAuth.username) && password.equals(basicAuth.password);
        }
        
        @Override
        public int hashCode() {
            return username.hashCode() * 31 + password.hashCode();
        }
        
        @Override
        public String toString() {
            return "AuthMethod.BasicAuth{username='" + username + "', password='***'}";
        }
    }
}