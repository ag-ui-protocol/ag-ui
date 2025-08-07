package com.agui.event;

import io.workm8.agui.type.EventType;
import io.workm8.agui.event.BaseEvent;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

import java.util.Objects;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("BaseEvent")
public class BaseEventTest {

    private BaseEvent baseEvent;

    @Nested
    @DisplayName("Constructor Tests")
    class ConstructorTests {

        @Test
        @DisplayName("Should create BaseEvent with valid EventType")
        void shouldCreateBaseEventWithValidEventType() {
            EventType eventType = EventType.CUSTOM;

            baseEvent = new BaseEvent(eventType);

            assertThat(baseEvent).isNotNull();
            assertThat(eventType).isEqualTo(baseEvent.getType());
            assertThat(0).isEqualTo(baseEvent.getTimestamp());
            assertThat(baseEvent.getRawEvent()).isNull();
        }

        @ParameterizedTest
        @EnumSource(EventType.class)
        @DisplayName("Should create BaseEvent with all EventType values")
        void shouldCreateBaseEventWithAllEventTypes(EventType eventType) {
            baseEvent = new BaseEvent(eventType);

            assertThat(baseEvent).isNotNull();
            assertThat(eventType).isEqualTo(baseEvent.getType());
        }

    }

    @Nested
    @DisplayName("Getter and Setter Tests")
    class GetterSetterTests {

        @BeforeEach
        void setUp() {
            baseEvent = new BaseEvent(EventType.CUSTOM);
        }

        @Test
        @DisplayName("Should get type correctly")
        void shouldGetTypeCorrectly() {
            // Given
            EventType expectedType = EventType.CUSTOM;

            // When
            EventType actualType = baseEvent.getType();

            // Then
            assertThat(expectedType).isEqualTo(actualType);
        }

        @Test
        @DisplayName("Should set and get timestamp correctly")
        void shouldSetAndGetTimestampCorrectly() {
            int expectedTimestamp = 1234567890;

            baseEvent.setTimestamp(expectedTimestamp);
            int actualTimestamp = baseEvent.getTimestamp();

            assertThat(expectedTimestamp).isEqualTo(actualTimestamp);
        }

        @Test
        @DisplayName("Should handle zero timestamp")
        void shouldHandleZeroTimestamp() {
            int zeroTimestamp = 0;

            baseEvent.setTimestamp(zeroTimestamp);

            assertThat(zeroTimestamp).isEqualTo(baseEvent.getTimestamp());
        }

        @Test
        @DisplayName("Should set and get rawEvent correctly with String")
        void shouldSetAndGetRawEventWithString() {
            String expectedRawEvent = "test raw event";

            baseEvent.setRawEvent(expectedRawEvent);
            Object actualRawEvent = baseEvent.getRawEvent();

            assertThat(expectedRawEvent).isEqualTo(actualRawEvent);
        }

        @Test
        @DisplayName("Should set and get rawEvent correctly with complex object")
        void shouldSetAndGetRawEventWithComplexObject() {
            CustomTestObject expectedRawEvent = new CustomTestObject("test", 123);

            baseEvent.setRawEvent(expectedRawEvent);
            Object actualRawEvent = baseEvent.getRawEvent();

            assertThat(expectedRawEvent).isEqualTo(actualRawEvent);
            assertThat(actualRawEvent).isInstanceOf(CustomTestObject.class);

            CustomTestObject castObject = (CustomTestObject) actualRawEvent;
            assertThat("test").isEqualTo(castObject.name);
            assertThat(123).isEqualTo(castObject.value);
        }

        @Test
        @DisplayName("Should set rawEvent to null")
        void shouldSetRawEventToNull() {
            baseEvent.setRawEvent("initial value");
            baseEvent.setRawEvent(null);

            assertThat(baseEvent.getRawEvent()).isNull();
        }
    }

    private static class CustomTestObject {
        public final String name;
        public final int value;

        public CustomTestObject(String name, int value) {
            this.name = name;
            this.value = value;
        }

        @Override
        public boolean equals(Object obj) {
            if (this == obj) return true;
            if (obj == null || getClass() != obj.getClass()) return false;
            CustomTestObject that = (CustomTestObject) obj;
            return value == that.value &&
                    (Objects.equals(name, that.name));
        }

        @Override
        public int hashCode() {
            int result = name != null ? name.hashCode() : 0;
            result = 31 * result + value;
            return result;
        }
    }
}