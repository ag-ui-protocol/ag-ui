package com.agui.client;

import com.agui.event.BaseEvent;
import com.agui.message.BaseMessage;
import io.reactivex.Observable;
import io.reactivex.subjects.BehaviorSubject;

import java.util.List;

public class TestAgent extends AbstractAgent {

    private final BehaviorSubject<BaseEvent> subject;

    public TestAgent(String agentId, String description, String threadId, List<BaseMessage> messages, State state, boolean debug) {
        super(agentId, description, threadId, messages, state, debug);

        this.subject = BehaviorSubject.create();
    }

    @Override
    protected Observable<BaseEvent> run(com.agui.types.RunAgentInput input) {
        return this.subject;
    }

    public void emit(final BaseEvent event) {
        this.subject.onNext(event);
    }

    public void complete() {
        this.subject.onComplete();
    }

    public void fail(Throwable t) {
        this.subject.onError(t);
    }
}
