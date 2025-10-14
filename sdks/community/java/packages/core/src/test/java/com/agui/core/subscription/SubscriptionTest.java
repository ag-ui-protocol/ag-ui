package com.agui.core.subscription;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("Subscription")
class SubscriptionTest {

    @Test
    void shouldUnsubscribe() {
        var subscription = new TestSubscription();
        
        assertThat(subscription.isUnsubscribed()).isFalse();
        
        subscription.unsubscribe();
        
        assertThat(subscription.isUnsubscribed()).isTrue();
    }

    @Test
    void shouldBeIdempotent() {
        var subscription = new TestSubscription();
        
        subscription.unsubscribe();
        subscription.unsubscribe(); // Should not throw or cause issues
        
        assertThat(subscription.isUnsubscribed()).isTrue();
        assertThat(subscription.unsubscribeCallCount).isEqualTo(2);
    }

    @Test
    void shouldCleanUpResources() {
        var subscription = new TestSubscription();
        subscription.addResource("resource1");
        subscription.addResource("resource2");
        
        assertThat(subscription.resources).hasSize(2);
        
        subscription.unsubscribe();
        
        assertThat(subscription.resources).isEmpty();
    }

    static class TestSubscription implements Subscription {
        private boolean unsubscribed = false;
        private final java.util.List<String> resources = new java.util.ArrayList<>();
        int unsubscribeCallCount = 0;

        @Override
        public void unsubscribe() {
            unsubscribeCallCount++;
            unsubscribed = true;
            resources.clear(); // Simulate resource cleanup
        }

        boolean isUnsubscribed() {
            return unsubscribed;
        }

        void addResource(String resource) {
            resources.add(resource);
        }
    }
}