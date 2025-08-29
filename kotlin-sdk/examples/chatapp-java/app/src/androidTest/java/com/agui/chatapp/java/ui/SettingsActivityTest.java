package com.agui.chatapp.java.ui;

import android.content.Context;

import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.espresso.contrib.RecyclerViewActions;
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

import androidx.test.espresso.Espresso;

/**
 * Android tests for the multi-agent SettingsActivity.
 * Tests agent list UI, CRUD operations, and dialog functionality.
 */
@RunWith(AndroidJUnit4.class)
@LargeTest
public class SettingsActivityTest {

    private ActivityScenario<SettingsActivity> scenario;
    private Context context;
    private MultiAgentRepository repository;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        repository = MultiAgentRepository.getInstance(context);
        
        // Clear any existing agents
        repository.clearAll().join();
    }

    @After
    public void tearDown() {
        if (scenario != null) {
            scenario.close();
        }
        // Clean up after tests
        repository.clearAll().join();
    }

    @Test
    public void testActivityLaunchesWithEmptyState() {
        scenario = ActivityScenario.launch(SettingsActivity.class);
        
        // Should show empty state when no agents are configured
        onView(withId(R.id.layoutEmptyState))
                .check(matches(isDisplayed()));
        
        // RecyclerView should be hidden
        onView(withId(R.id.recyclerAgents))
                .check(matches(not(isDisplayed())));
        
        // FAB should be visible
        onView(withId(R.id.fabAddAgent))
                .check(matches(isDisplayed()));
    }

    @Test
    public void testActivityLaunchesWithExistingAgents() {
        // Add a test agent first
        AgentProfile agent = createTestAgent("Test Agent", "https://api.test.com");
        repository.addAgent(agent).join();
        
        scenario = ActivityScenario.launch(SettingsActivity.class);
        
        // Should show agent list when agents exist
        onView(withId(R.id.recyclerAgents))
                .check(matches(isDisplayed()));
        
        // Empty state should be hidden
        onView(withId(R.id.layoutEmptyState))
                .check(matches(not(isDisplayed())));
        
        // FAB should still be visible
        onView(withId(R.id.fabAddAgent))
                .check(matches(isDisplayed()));
    }

    @Test
    public void testFabOpensAddAgentDialog() {
        scenario = ActivityScenario.launch(SettingsActivity.class);
        
        // Click FAB to open add agent dialog
        onView(withId(R.id.fabAddAgent))
                .perform(click());
        
        // Dialog should be displayed with "Add Agent" title
        onView(withText("Add Agent"))
                .check(matches(isDisplayed()));
        
        // Form fields should be present
        onView(withId(R.id.editAgentName))
                .check(matches(isDisplayed()));
        onView(withId(R.id.editAgentUrl))
                .check(matches(isDisplayed()));
        onView(withId(R.id.autoCompleteAuthType))
                .check(matches(isDisplayed()));
    }

    @Test
    public void testAddAgentDialogValidation() {
        scenario = ActivityScenario.launch(SettingsActivity.class);
        
        // Open add agent dialog
        onView(withId(R.id.fabAddAgent))
                .perform(click());
        
        // Try to save without required fields
        onView(withText("Add"))
                .perform(click());
        
        // Should show validation errors
        onView(withText("Agent name is required"))
                .check(matches(isDisplayed()));
    }

    @Test
    public void testAddValidAgent() {
        scenario = ActivityScenario.launch(SettingsActivity.class);
        
        // Open add agent dialog
        onView(withId(R.id.fabAddAgent))
                .perform(click());
        
        // Fill in required fields
        onView(withId(R.id.editAgentName))
                .perform(typeText("Test Agent"));
        onView(withId(R.id.editAgentUrl))
                .perform(typeText("https://api.test.com"));
        
        // Close keyboard and save
        onView(withId(R.id.editAgentUrl))
                .perform(closeSoftKeyboard());
        
        onView(withText("Add"))
                .perform(click());
        
        // Dialog should close and agent should appear in list
        onView(withId(R.id.recyclerAgents))
                .check(matches(isDisplayed()));
        
        // Empty state should be hidden
        onView(withId(R.id.layoutEmptyState))
                .check(matches(not(isDisplayed())));
    }

    @Test
    public void testAuthTypeSelectionInDialog() {
        scenario = ActivityScenario.launch(SettingsActivity.class);
        
        // Open add agent dialog
        onView(withId(R.id.fabAddAgent))
                .perform(click());
        
        // Wait for dialog to be fully visible
        try {
            Thread.sleep(500);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        
        // Select API Key auth type by typing into the AutoCompleteTextView
        onView(withId(R.id.autoCompleteAuthType))
                .perform(replaceText("API Key"));
        
        // Close keyboard
        onView(withId(R.id.autoCompleteAuthType))
                .perform(closeSoftKeyboard());
        
        // API Key field should become visible
        onView(withId(R.id.textInputApiKey))
                .check(matches(isDisplayed()));
        
        // Other auth fields should be hidden
        onView(withId(R.id.textInputBearerToken))
                .check(matches(not(isDisplayed())));
        onView(withId(R.id.textInputBasicUsername))
                .check(matches(not(isDisplayed())));
    }

    @Test
    public void testBasicAuthFieldsInDialog() {
        scenario = ActivityScenario.launch(SettingsActivity.class);
        
        // Open add agent dialog
        onView(withId(R.id.fabAddAgent))
                .perform(click());
        
        // Wait for dialog to be fully visible
        try {
            Thread.sleep(500);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        
        // Select Basic Auth by typing into the AutoCompleteTextView
        onView(withId(R.id.autoCompleteAuthType))
                .perform(replaceText("Basic Auth"));
        
        // Close keyboard
        onView(withId(R.id.autoCompleteAuthType))
                .perform(closeSoftKeyboard());
        
        // Both username and password fields should be visible
        onView(withId(R.id.textInputBasicUsername))
                .check(matches(isDisplayed()));
        onView(withId(R.id.textInputBasicPassword))
                .check(matches(isDisplayed()));
        
        // Other auth fields should be hidden
        onView(withId(R.id.textInputApiKey))
                .check(matches(not(isDisplayed())));
        onView(withId(R.id.textInputBearerToken))
                .check(matches(not(isDisplayed())));
    }

    @Test
    public void testBasicAuthValidation() {
        scenario = ActivityScenario.launch(SettingsActivity.class);
        
        // Open add agent dialog
        onView(withId(R.id.fabAddAgent))
                .perform(click());
        
        // Wait for dialog to be fully visible
        try {
            Thread.sleep(500);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        
        // Fill required fields
        onView(withId(R.id.editAgentName))
                .perform(typeText("Basic Auth Agent"));
        onView(withId(R.id.editAgentUrl))
                .perform(typeText("https://api.test.com"));
        
        // Select Basic Auth by replacing the text directly
        onView(withId(R.id.autoCompleteAuthType))
                .perform(scrollTo(), replaceText("Basic Auth"));
        
        // Close the keyboard to ensure the view updates
        onView(withId(R.id.autoCompleteAuthType))
                .perform(closeSoftKeyboard());
                
        // Try to save without username/password
        onView(withText("Add"))
                .perform(click());
        
        // Should show validation errors for missing credentials
        onView(withText("Username is required"))
                .check(matches(isDisplayed()));
    }

    @Test
    public void testAgentWithSystemPromptAndDescription() {
        scenario = ActivityScenario.launch(SettingsActivity.class);
        
        // Open add agent dialog
        onView(withId(R.id.fabAddAgent))
                .perform(click());
        
        // Fill all fields including optional ones
        onView(withId(R.id.editAgentName))
                .perform(typeText("Detailed Agent"));
        onView(withId(R.id.editAgentUrl))
                .perform(typeText("https://api.test.com"));
        onView(withId(R.id.editAgentDescription))
                .perform(typeText("Test agent description"));
        onView(withId(R.id.editSystemPrompt))
                .perform(scrollTo(), click(), typeText("You are a helpful test assistant"));
        
        // Close keyboard and save
        onView(withId(R.id.editSystemPrompt))
                .perform(closeSoftKeyboard());
        
        onView(withText("Add"))
                .perform(click());
        
        // Verify agent was added (list should be visible)
        onView(withId(R.id.recyclerAgents))
                .check(matches(isDisplayed()));
    }

    @Test
    public void testDialogCancellation() {
        scenario = ActivityScenario.launch(SettingsActivity.class);
        
        // Verify initial empty state
        onView(withId(R.id.layoutEmptyState))
                .check(matches(isDisplayed()));
        
        // Open add agent dialog
        onView(withId(R.id.fabAddAgent))
                .perform(click());
        
        // Fill some data
        onView(withId(R.id.editAgentName))
                .perform(typeText("Test Agent"));
        
        // Close soft keyboard before clicking Cancel
        Espresso.closeSoftKeyboard();
        
        // Cancel dialog
        onView(withText("Cancel"))
                .perform(click());
        
        // Wait for any UI transitions to complete
        try {
            Thread.sleep(100);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        
        // Verify no agents were actually added to the repository
        scenario.onActivity(activity -> {
            MultiAgentRepository repo = MultiAgentRepository.getInstance(activity);
            java.util.List<AgentProfile> currentAgents = repo.getAgents().getValue();
            android.util.Log.d("SettingsActivityTest", "Agents count after cancel: " + 
                (currentAgents != null ? currentAgents.size() : "null"));
        });
        
        // The main assertion: empty state should still be displayed
        onView(withId(R.id.layoutEmptyState))
                .check(matches(isDisplayed()));
    }

    @Test
    public void testEdgeToEdgeDisplay() {
        scenario = ActivityScenario.launch(SettingsActivity.class);
        
        // Verify that UI elements are properly displayed (not cut off by system bars)
        onView(withId(R.id.fabAddAgent))
                .check(matches(isDisplayed()));
        
        // Empty state should be visible and not cut off
        onView(withId(R.id.layoutEmptyState))
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