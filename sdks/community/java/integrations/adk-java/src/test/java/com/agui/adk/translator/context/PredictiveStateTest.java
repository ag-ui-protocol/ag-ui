package com.agui.adk.translator.context;

import com.agui.adk.translator.PredictStateMapping;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class PredictiveStateTest {

    private PredictiveState predictiveState;
    private PredictStateMapping mapping1;
    private PredictStateMapping mapping2;
    private PredictStateMapping mapping3;

    @BeforeEach
    void setUp() {
        // Mock PredictStateMapping instances
        mapping1 = mock(PredictStateMapping.class);
        when(mapping1.toolName()).thenReturn("toolA");
        when(mapping1.emitConfirmTool()).thenReturn(true);

        mapping2 = mock(PredictStateMapping.class);
        when(mapping2.toolName()).thenReturn("toolB");
        when(mapping2.emitConfirmTool()).thenReturn(false);

        mapping3 = mock(PredictStateMapping.class);
        when(mapping3.toolName()).thenReturn("toolA"); // Same tool as mapping1
        when(mapping3.emitConfirmTool()).thenReturn(false); // Different confirm setting

        // Initialize PredictiveState with a list of these mappings
        List<PredictStateMapping> config = List.of(mapping1, mapping2, mapping3);
        predictiveState = new PredictiveState(config);
    }

    @Test
    void shouldPopulateMappingsCorrectly_whenConstructedWithMappings() {
        // Assert that mappings for toolA are grouped correctly
        List<PredictStateMapping> toolAMappings = predictiveState.getMappingsForTool("toolA");
        assertNotNull(toolAMappings);
        assertEquals(2, toolAMappings.size());
        assertTrue(toolAMappings.contains(mapping1));
        assertTrue(toolAMappings.contains(mapping3));

        // Assert that mappings for toolB are grouped correctly
        List<PredictStateMapping> toolBMappings = predictiveState.getMappingsForTool("toolB");
        assertNotNull(toolBMappings);
        assertEquals(1, toolBMappings.size());
        assertTrue(toolBMappings.contains(mapping2));

        // Assert that a non-existent tool returns an empty list
        assertTrue(predictiveState.getMappingsForTool("toolC").isEmpty());
    }

    @Test
    void shouldReturnTrue_whenToolConfigured() {
        assertTrue(predictiveState.hasToolConfig("toolA"));
        assertTrue(predictiveState.hasToolConfig("toolB"));
    }

    @Test
    void shouldReturnFalse_whenToolNotConfigured() {
        assertFalse(predictiveState.hasToolConfig("toolC"));
    }

    @Test
    void shouldMarkAndCheckEmittedState_whenToolIsEmitted() {
        String toolName = "toolX";
        assertFalse(predictiveState.hasEmittedForTool(toolName));
        predictiveState.markAsEmittedForTool(toolName);
        assertTrue(predictiveState.hasEmittedForTool(toolName));
    }

    @Test
    void shouldMarkAndCheckEmittedConfirmState_whenToolIsEmitted() {
        String toolName = "toolY";
        assertFalse(predictiveState.hasEmittedConfirmForTool(toolName));
        predictiveState.markAsEmittedConfirmForTool(toolName);
        assertTrue(predictiveState.hasEmittedConfirmForTool(toolName));
    }

    @Test
    void shouldReturnTrue_ifAnyMappingConfirmsEmission() {
        // mapping1 for toolA returns true for emitConfirmTool
        assertTrue(predictiveState.shouldEmitConfirmForTool("toolA"));
    }

    @Test
    void shouldReturnFalse_ifNoMappingConfirmsEmission() {
        // mapping2 for toolB returns false for emitConfirmTool
        assertFalse(predictiveState.shouldEmitConfirmForTool("toolB"));
    }

    @Test
    void shouldReturnCorrectMappings_whenToolIsConfigured() {
        List<PredictStateMapping> toolAMappings = predictiveState.getMappingsForTool("toolA");
        assertEquals(2, toolAMappings.size());
        assertTrue(toolAMappings.contains(mapping1));
        assertTrue(toolAMappings.contains(mapping3));
    }

    @Test
    void shouldReturnEmptyList_whenToolIsNotConfigured() {
        assertTrue(predictiveState.getMappingsForTool("toolC").isEmpty());
    }
    
    @Test
    void shouldInitializeEmpty_whenConstructedWithNullConfig() {
        PredictiveState emptyState = new PredictiveState(null);
        assertFalse(emptyState.hasToolConfig("anyTool"));
        assertTrue(emptyState.getMappingsForTool("anyTool").isEmpty());
        assertFalse(emptyState.hasEmittedForTool("anyTool"));
    }

    @Test
    void shouldInitializeEmpty_whenConstructedWithEmptyConfig() {
        PredictiveState emptyState = new PredictiveState(List.of());
        assertFalse(emptyState.hasToolConfig("anyTool"));
        assertTrue(emptyState.getMappingsForTool("anyTool").isEmpty());
        assertFalse(emptyState.hasEmittedForTool("anyTool"));
    }
}
