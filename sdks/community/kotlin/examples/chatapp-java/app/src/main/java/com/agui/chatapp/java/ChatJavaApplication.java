package com.agui.chatapp.java;

import android.app.Application;
import com.agui.example.chatapp.util.AndroidPlatformKt;

public class ChatJavaApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        AndroidPlatformKt.initializeAndroid(this);
    }
}
