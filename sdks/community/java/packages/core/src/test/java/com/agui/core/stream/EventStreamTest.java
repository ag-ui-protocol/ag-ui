package com.agui.core.stream;

import com.agui.core.exception.AGUIException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatNoException;

@DisplayName("EventStream")
class EventStreamTest {

    @Test
    void shouldCreateSimpleEventStream() {
        EventStream<String> sut = new EventStream<>(
            value -> {},
            err -> {},
            () -> {}
        );

        assertThat(sut).isNotNull();
    }

    @Test
    void shouldCallOnNext() {
        var value = "next";

        EventStream<String> sut = new EventStream<>(
            v -> assertThat(v).isEqualTo(value),
            err -> {},
            () -> {}
        );

        sut.next(value);
    }

    @Test
    void shouldNotCallOnNextWhenCancelled() {
        AtomicBoolean onNextCalled = new AtomicBoolean(false);

        EventStream<String> sut = new EventStream<>(
            v -> onNextCalled.set(true),
            err -> {},
            () -> {}
        );

        sut.cancel();
        sut.next("next");

        assertThat(onNextCalled).isFalse();
        assertThat(sut.isCancelled()).isTrue();
    }

    @Test
    void shouldNotCallOnNextWhenCompleted() {
        AtomicBoolean onNextCalled = new AtomicBoolean(false);

        EventStream<String> sut = new EventStream<>(
            v -> onNextCalled.set(true),
            err -> {},
            () -> {}
        );

        sut.complete();
        sut.next("next");

        assertThat(onNextCalled).isFalse();
        assertThat(sut.isCompleted()).isTrue();
    }

    @Test
    void shouldCallOnError() {
        var error = new AGUIException("Error");

        EventStream<String> sut = new EventStream<>(
            value -> {},
            err -> assertThat(err).isEqualTo(error),
            () -> {}
        );

        sut.error(error);
    }

    @Test
    void shouldNotCallOnErrorWhenCancelled() {
        AtomicBoolean onErrorCalled = new AtomicBoolean(false);

        EventStream<String> sut = new EventStream<>(
            v -> {},
            err -> onErrorCalled.set(true),
            () -> {}
        );

        sut.cancel();

        sut.error(new AGUIException("Error"));

        assertThat(onErrorCalled).isFalse();
        assertThat(sut.isCancelled()).isTrue();
    }

    @Test
    void shouldNotCallOnErrorWhenCompleted() {
        AtomicBoolean onErrorCalled = new AtomicBoolean(false);

        EventStream<String> sut = new EventStream<>(
            v -> {},
            err -> onErrorCalled.set(true),
            () -> {}
        );

        sut.complete();
        sut.error(new AGUIException("Error"));

        assertThat(onErrorCalled).isFalse();
        assertThat(sut.isCompleted()).isTrue();
    }

    @Test
    void shouldComplete() {
        AtomicBoolean onCompleteCalled = new AtomicBoolean(false);

        EventStream<String> sut = new EventStream<>(
            v -> { },
            err -> { },
            () -> onCompleteCalled.set(true)
        );

        sut.complete();

        assertThat(onCompleteCalled).isTrue();
        assertThat(sut.isCompleted()).isTrue();
    }

    @Test
    void shouldNotCallOnCompleteWhenCancelled() {
        AtomicBoolean onCompleteCalled = new AtomicBoolean(false);

        EventStream<String> sut = new EventStream<>(
            v -> { },
            err -> { },
            () -> onCompleteCalled.set(true)
        );

        sut.cancel();
        sut.complete();
        assertThat(onCompleteCalled).isFalse();
    }

    @Test
    void shouldNotBubbleExceptionWhenOnCompleteThrowsException() {
        EventStream<String> sut = new EventStream<>(
            v -> { },
            err -> { },
            () -> {
                throw new RuntimeException("Exception");
            }
        );

        assertThatNoException().isThrownBy(sut::complete);
    }

    @Test
    void shouldNotBubbleExceptionWhenOnErrorThrowsException() {
        EventStream<String> sut = new EventStream<>(
            v -> { },
            err -> {
                throw new RuntimeException("Exception");
            },
            () -> { }
        );

        assertThatNoException().isThrownBy(() -> sut.error(new RuntimeException("Runtime exception")));
    }

    @Test
    void shouldCallOnErrorWhenOnNextThrowsException() throws InterruptedException {
        AtomicBoolean onErrorCalled = new AtomicBoolean(false);

        EventStream<String> sut = new EventStream<>(
            v -> {
                throw new RuntimeException("Exception");
            },
            err -> onErrorCalled.set(true),
            () -> { }
        );

        sut.next("Next");

        Thread.sleep(200L);
        assertThat(onErrorCalled).isTrue();
    }

}