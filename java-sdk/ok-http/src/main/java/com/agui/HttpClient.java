package com.agui;

import com.agui.event.BaseEvent;
import com.agui.types.RunAgentInput;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import io.reactivex.Observable;
import okhttp3.*;

import java.io.BufferedReader;
import java.io.IOException;
import java.util.concurrent.TimeUnit;

public class HttpClient {
    private final OkHttpClient client;

    private final String url;

    private final ObjectMapper objectMapper;

    public HttpClient(final String url) {
        this.client = new OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build();

        this.url = url;

        this.objectMapper = new ObjectMapper();
        this.objectMapper.disable(SerializationFeature.FAIL_ON_EMPTY_BEANS);
    }

    public Observable<BaseEvent> streamEvents(final RunAgentInput input) {
        return Observable.create(emitter -> {
            try {
                var body = RequestBody.create(objectMapper.writeValueAsString(input), MediaType.get("application/json"));

                Request request = new Request.Builder()
                        .url(url)
                        .header("Accept", "application/json")
                        .post(body)
                        .build();

                client.newCall(request).enqueue(new Callback() {
                    @Override
                    public void onResponse(Call call, Response response) {
                        try (BufferedReader reader = new BufferedReader(response.body().charStream())) {
                            String line;
                            while ((line = reader.readLine()) != null && !emitter.isDisposed()) {
                                if (line.trim().startsWith("data: ")) {
                                    BaseEvent event = objectMapper.readValue(line.trim().substring(6).trim(), BaseEvent.class);
                                    emitter.onNext(event);
                                }
                            }
                            emitter.onComplete();
                        } catch (IOException e) {
                            emitter.onError(e);
                        }
                    }

                    @Override
                    public void onFailure(Call call, IOException e) {
                        emitter.onError(e);
                    }
                });

            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
    }
}


