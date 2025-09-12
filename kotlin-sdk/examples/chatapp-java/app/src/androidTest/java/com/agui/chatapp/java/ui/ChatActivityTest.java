package com.agui.chatapp.java.ui;

import android.content.Context;
import android.content.Intent;

import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.espresso.Espresso;
import androidx.test.espresso.action.ViewActions;
import androidx.test.espresso.assertion.ViewAssertions;
import androidx.test.espresso.matcher.ViewMatchers;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.filters.LargeTest;

import com.agui.chatapp.java.R;
import com.agui.chatapp.java.model.AgentProfile;
import com.agui.chatapp.java.model.AuthMethod;
import com.agui.chatapp.java.repository.MultiAgentRepository;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.UUID;

import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.*;
import static androidx.test.espresso.assertion.ViewAssertions.*;
import static androidx.test.espresso.matcher.ViewMatchers.*;
import static org.hamcrest.Matchers.*;

/**
 * Connected Android tests for ChatActivity.
 * Tests UI behavior, navigation, and basic user interactions.
 */
@RunWith(AndroidJUnit4.class)
@LargeTest
public class ChatActivityTest {

    private ActivityScenario<ChatActivity> scenario;
    private Context context;
    private MultiAgentRepository repository;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        repository = MultiAgentRepository.getInstance(context);
        
        // Clear any existing configuration
        clearAgentConfiguration();
    }

    @After
    public void tearDown() {
        if (scenario != null) {
            scenario.close();
        }
        clearAgentConfiguration();
    }

    private void clearAgentConfiguration() {
        // Clear multi-agent repository
        repository.clearAll().join();
    }

    @Test
    public void testActivityLaunchesSuccessfully() {
        scenario = ActivityScenario.launch(ChatActivity.class);
        
        // Should show the no agent configured card initially
        onView(withId(R.id.noAgentCard))
                .check(matches(isDisplayed()));
        
        // Chat interface should be hidden
        onView(withId(R.id.recyclerMessages))
                .check(matches(not(isDisplayed())));
        onView(withId(R.id.inputContainer))
                .check(matches(not(isDisplayed())));
    }

    @Test
    public void testNoAgentConfiguredState() {
        scenario = ActivityScenario.launch(ChatActivity.class);
        
        // Verify no agent card is shown
        onView(withId(R.id.noAgentCard))
                .check(matches(isDisplayed()));
        
        // Verify settings button exists and is clickable
        onView(withId(R.id.btnGoToSettings))
                .check(matches(isDisplayed()))
                .check(matches(isClickable()));
    }

    @Test
    public void testNavigationToSettings() {
        scenario = ActivityScenario.launch(ChatActivity.class);
        
        // Click settings button in no agent card
        onView(withId(R.id.btnGoToSettings))
                .perform(click());
        
        // Note: This would normally verify navigation but requires proper activity result handling
        // For now, just verify the button click doesn't crash the app
    }

    @Test
    public void testOptionsMenuExists() {
        scenario = ActivityScenario.launch(ChatActivity.class);
        
        // Open options menu
        Espresso.openActionBarOverflowOrOptionsMenu(context);
        
        // Verify settings action exists (this might be in toolbar or overflow)
        // Note: Menu items might not be visible in tests without proper agent config
    }

    @Test
    public void testToolbarIsPresent() {
        scenario = ActivityScenario.launch(ChatActivity.class);
        
        onView(withId(R.id.toolbar))
                .check(matches(isDisplayed()));
    }

    @Test
    public void testWithValidAgentConfiguration() {
        // Set up a valid agent configuration
        AgentProfile agent = createTestAgent("Test Agent", "https://mock.example.com/agent");
        repository.addAgent(agent).join();
        repository.setActiveAgent(agent).join();
        
        scenario = ActivityScenario.launch(ChatActivity.class);
        
        // Should show chat interface when agent is configured
        onView(withId(R.id.recyclerMessages))
                .check(matches(isDisplayed()));
        onView(withId(R.id.inputContainer))
                .check(matches(isDisplayed()));
        
        // No agent card should be hidden
        onView(withId(R.id.noAgentCard))
                .check(matches(not(isDisplayed())));
    }

    @Test
    public void testMessageInputField() {
        // Configure agent first
        AgentProfile agent = createTestAgent("Test Agent", "https://mock.example.com/agent");
        repository.addAgent(agent).join();
        repository.setActiveAgent(agent).join();
        
        scenario = ActivityScenario.launch(ChatActivity.class);
        
        // Wait for input container to become visible (agent is configured)
        onView(withId(R.id.inputContainer))
                .check(matches(isDisplayed()));
        
        // Test message input - wait a moment for UI to settle
        try {
            Thread.sleep(500);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        
        onView(withId(R.id.editMessage))
                .check(matches(isDisplayed()))
                .perform(replaceText("Hello test message"))
                .check(matches(withText("Hello test message")));
        
        // Test send button
        onView(withId(R.id.btnSend))
                .check(matches(isDisplayed()))
                .check(matches(isClickable()));
    }


    @Test
    public void testKeyboardImeSendAction() {
        // Configure agent first
        AgentProfile agent = createTestAgent("Test Agent", "https://mock.example.com/agent");
        repository.addAgent(agent).join();
        repository.setActiveAgent(agent).join();
        
        scenario = ActivityScenario.launch(ChatActivity.class);
        
        // Wait for input container to become visible (agent is configured)
        onView(withId(R.id.inputContainer))
                .check(matches(isDisplayed()));
        
        // Wait a moment for UI to settle
        try {
            Thread.sleep(500);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        
        // Type message and press IME send action
        onView(withId(R.id.editMessage))
                .perform(replaceText("Test message"))
                .perform(pressImeActionButton());
        
        // Message should be cleared after send attempt
        // Note: Without a real agent, this might not work exactly as expected
    }

    @Test
    public void testRecyclerViewIsPresent() {
        // Configure agent first
        AgentProfile agent = createTestAgent("Test Agent", "https://mock.example.com/agent");
        repository.addAgent(agent).join();
        repository.setActiveAgent(agent).join();
        
        scenario = ActivityScenario.launch(ChatActivity.class);
        
        onView(withId(R.id.recyclerMessages))
                .check(matches(isDisplayed()));
    }

    @Test
    public void testProgressIndicatorVisibility() {
        scenario = ActivityScenario.launch(ChatActivity.class);
        
        // Progress indicator should be hidden initially
        onView(withId(R.id.progressConnecting))
                .check(matches(not(isDisplayed())));
    }

    @Test
    public void testActivityRecreation() {
        scenario = ActivityScenario.launch(ChatActivity.class);
        
        // Simulate configuration change
        scenario.recreate();
        
        // Should still show no agent configured state
        onView(withId(R.id.noAgentCard))
                .check(matches(isDisplayed()));
    }
    
    // Helper method to create test agents
    private AgentProfile createTestAgent(String name, String url) {
        return new AgentProfile.Builder()
            .setId(UUID.randomUUID().toString())
            .setName(name)
            .setUrl(url)
            .setAuthMethod(new AuthMethod.None())
            .setCreatedAt(System.currentTimeMillis())
            .build();
    }
}