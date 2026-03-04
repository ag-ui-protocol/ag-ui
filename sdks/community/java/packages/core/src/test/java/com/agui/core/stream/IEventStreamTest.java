package com.agui.core.stream;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@DisplayName("IEventStream")
class IEventStreamTest {

    @Test
    void shouldImplementBasicStreamOperations() {
        var stream = new TestEventStream();
        
        assertThat(stream.isCancelled()).isFalse();
        
        stream.next("item1");
        assertThat(stream.receivedItems).contains("item1");
        
        stream.complete();
        assertThat(stream.isCompleted).isTrue();
    }

    @Test
    void shouldHandleErrors() {
        var stream = new TestEventStream();
        var error = new RuntimeException("test error");
        
        stream.error(error);
        
        assertThat(stream.receivedError).isEqualTo(error);
    }

    @Test
    void shouldSupportCancellation() {
        var stream = new TestEventStream();
        
        assertThat(stream.isCancelled()).isFalse();
        
        stream.cancel();
        
        assertThat(stream.isCancelled()).isTrue();
    }

    @Test
    void shouldThrowWhenNextCalledAfterCompletion() {
        var stream = new TestEventStream();
        stream.complete();
        
        assertThatThrownBy(() -> stream.next("item"))
            .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void shouldThrowWhenErrorCalledAfterCompletion() {
        var stream = new TestEventStream();
        stream.complete();
        
        assertThatThrownBy(() -> stream.error(new RuntimeException()))
            .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void shouldThrowWhenCompleteCalledTwice() {
        var stream = new TestEventStream();
        stream.complete();
        
        assertThatThrownBy(stream::complete)
            .isInstanceOf(IllegalStateException.class);
    }

    static class TestEventStream implements IEventStream<String> {
        boolean isCompleted = false;
        boolean isCancelled = false;
        java.util.List<String> receivedItems = new java.util.ArrayList<>();
        Throwable receivedError;

        @Override
        public void next(String item) {
            if (isCompleted || isCancelled) {
                throw new IllegalStateException("Stream is terminated");
            }
            receivedItems.add(item);
        }

        @Override
        public void error(Throwable error) {
            if (isCompleted) {
                throw new IllegalStateException("Stream already completed");
            }
            receivedError = error;
        }

        @Override
        public void complete() {
            if (isCompleted) {
                throw new IllegalStateException("Stream already completed");
            }
            isCompleted = true;
        }

        @Override
        public boolean isCancelled() {
            return isCancelled;
        }

        @Override
        public void cancel() {
            isCancelled = true;
        }
    }
}