package com.agui.chatapp.java.adapter;

import com.agui.client.StatefulAgUiAgent;
import com.agui.core.types.BaseEvent;

import io.reactivex.rxjava3.android.schedulers.AndroidSchedulers;
import io.reactivex.rxjava3.core.Observable;
import io.reactivex.rxjava3.disposables.Disposable;
import io.reactivex.rxjava3.schedulers.Schedulers;
import kotlinx.coroutines.flow.Flow;
import kotlinx.coroutines.reactive.ReactiveFlowKt;

import java.util.concurrent.CompletableFuture;

/**
 * Java adapter for AG-UI agent that provides callback-based and RxJava interfaces
 * for interacting with Kotlin Flow-based agent APIs.
 */
public class AgUiJavaAdapter {
    private final StatefulAgUiAgent agent;
    
    public AgUiJavaAdapter(StatefulAgUiAgent agent) {
        this.agent = agent;
    }
    
    /**
     * Send a message to the agent using callback interface
     * @param message The message to send
     * @param callback Callback for handling events
     * @return Disposable for canceling the subscription
     */
    public Disposable sendMessage(String message, EventCallback callback) {
        return sendMessageObservable(message)
                .subscribeOn(Schedulers.io())
                .observeOn(AndroidSchedulers.mainThread())
                .subscribe(
                    callback::onEvent,
                    callback::onError,
                    callback::onComplete
                );
    }
    
    /**
     * Send a message to the agent and return an RxJava Observable
     * @param message The message to send
     * @return Observable of events
     */
    public Observable<BaseEvent> sendMessageObservable(String message) {
        // Get the Kotlin Flow from the agent
        Flow<BaseEvent> kotlinFlow = agent.chat(message, "default");
        
        // Convert Kotlin Flow to RxJava Observable using kotlinx-coroutines-reactive
        return Observable.fromPublisher(ReactiveFlowKt.asPublisher(kotlinFlow));
    }
    
    /**
     * Send a message with custom thread ID
     * @param message The message to send
     * @param threadId Custom thread ID
     * @param callback Callback for handling events
     * @return Disposable for canceling the subscription
     */
    public Disposable sendMessage(String message, String threadId, EventCallback callback) {
        return sendMessageObservable(message, threadId)
                .subscribeOn(Schedulers.io())
                .observeOn(AndroidSchedulers.mainThread())
                .subscribe(
                    callback::onEvent,
                    callback::onError,
                    callback::onComplete
                );
    }
    
    /**
     * Send a message with custom thread ID and return an Observable
     * @param message The message to send
     * @param threadId Custom thread ID
     * @return Observable of events
     */
    public Observable<BaseEvent> sendMessageObservable(String message, String threadId) {
        Flow<BaseEvent> kotlinFlow = agent.chat(message, threadId);
        return Observable.fromPublisher(ReactiveFlowKt.asPublisher(kotlinFlow));
    }
    
    /**
     * Test connection to the agent
     * @return CompletableFuture that completes when connection test is done
     */
    public CompletableFuture<Boolean> testConnection() {
        CompletableFuture<Boolean> future = new CompletableFuture<>();
        
        sendMessage("Hello", new EventCallback() {
            @Override
            public void onEvent(BaseEvent event) {
                // If we receive any event, connection is working
                if (!future.isDone()) {
                    future.complete(true);
                }
            }
            
            @Override
            public void onError(Throwable error) {
                future.complete(false);
            }
            
            @Override
            public void onComplete() {
                if (!future.isDone()) {
                    future.complete(true);
                }
            }
        });
        
        return future;
    }
    
    /**
     * Close the agent and release resources
     */
    public void close() {
        agent.close();
    }
    
    /**
     * Get the current thread ID
     * @return Current thread ID
     */
    public String getCurrentThreadId() {
        return "default"; // StatefulAgUiAgent manages thread internally
    }
    
    /**
     * Clear conversation history
     */
    public void clearHistory() {
        agent.clearHistory(null); // Clear all threads
    }
}