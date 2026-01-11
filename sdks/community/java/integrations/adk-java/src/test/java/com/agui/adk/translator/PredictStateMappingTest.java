package com.agui.adk.translator;

import org.junit.jupiter.api.Test;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class PredictStateMappingTest {

    @Test
    void shouldReturnCorrectValues_whenConstructedAndAccessed() {
        // Arrange
        String toolName = "testTool";
        boolean emitConfirm = true;
        Map<String, Object> payload = Map.of("key", "value");

        // Act
        PredictStateMapping mapping = new PredictStateMapping(toolName, emitConfirm, payload);

        // Assert
        assertEquals(toolName, mapping.toolName());
        assertEquals(emitConfirm, mapping.emitConfirmTool());
        assertEquals(payload, mapping.toPayload());
    }

    @Test
    void shouldBeDefensivelyCopied_whenToPayloadIsCalled() {
        // Arrange
        Map<String, Object> originalPayload = new HashMap<>();
        originalPayload.put("initial", "data");
        
        PredictStateMapping mapping = new PredictStateMapping("toolA", false, originalPayload);
        
        // Act
        originalPayload.put("new", "data"); // Modify the original map
        Map<String, Object> retrievedPayload = mapping.toPayload();

        // Assert
        assertNotSame(originalPayload, retrievedPayload, "Retrieved payload should not be the same instance as original");
        assertFalse(retrievedPayload.containsKey("new"), "Retrieved payload should not contain newly added data");
        assertTrue(retrievedPayload.containsKey("initial"));
        assertEquals("data", retrievedPayload.get("initial"));
    }

    @Test
    void shouldReturnEmptyMap_whenConstructedWithNullPayload() {
        // Arrange
        PredictStateMapping mapping = new PredictStateMapping("toolB", false, null);

        // Act
        Map<String, Object> payload = mapping.toPayload();

        // Assert
        assertNotNull(payload);
        assertTrue(payload.isEmpty());
        // Verify it's an unmodifiable empty map, if Map.copyOf(null) handles it that way
        assertThrows(UnsupportedOperationException.class, () -> payload.put("key", "value"));
    }
    
    @Test
    void shouldReturnUnmodifiableMap_whenToPayloadIsCalled() {
        // Arrange
        PredictStateMapping mapping = new PredictStateMapping("toolC", true, Map.of("data", "value"));
        
        // Act
        Map<String, Object> payload = mapping.toPayload();
        
        // Assert
        assertThrows(UnsupportedOperationException.class, () -> payload.put("newKey", "newValue"), "Returned payload should be unmodifiable");
    }
}
