package com.agui.chatapp.java.ui;

import android.content.Intent;
import android.os.Bundle;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowCompat;
import androidx.lifecycle.ViewModelProvider;
import androidx.recyclerview.widget.LinearLayoutManager;

import com.agui.chatapp.java.R;
import com.agui.chatapp.java.databinding.ActivityChatBinding;
import com.agui.chatapp.java.model.AgentProfile;
import com.agui.chatapp.java.ui.adapter.MessageAdapter;
import com.agui.chatapp.java.viewmodel.ChatViewModel;
import com.google.android.material.snackbar.Snackbar;

import java.util.ArrayList;

/**
 * Main chat activity using Material 3 design with Android View system.
 * Demonstrates Java integration with the Kotlin multiplatform AG-UI library.
 */
public class ChatActivity extends AppCompatActivity {

    private ActivityChatBinding binding;
    private ChatViewModel viewModel;
    private MessageAdapter messageAdapter;
    private ActivityResultLauncher<Intent> settingsLauncher;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Enable edge-to-edge display
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        binding = ActivityChatBinding.inflate(getLayoutInflater());
        setContentView(binding.getRoot());

        // Setup edge-to-edge window insets
        setupEdgeToEdgeInsets();

        // Setup toolbar
        setSupportActionBar(binding.toolbar);

        // Initialize ViewModel
        viewModel = new ViewModelProvider(this).get(ChatViewModel.class);

        // Setup activity result launchers
        setupActivityResultLaunchers();

        // Setup RecyclerView
        setupRecyclerView();

        // Setup UI listeners
        setupUIListeners();

        // Observe ViewModel
        observeViewModel();
    }

    private void setupRecyclerView() {
        messageAdapter = new MessageAdapter();
        binding.recyclerMessages.setAdapter(messageAdapter);
        binding.recyclerMessages.setLayoutManager(new LinearLayoutManager(this));

        // Auto-scroll to bottom when new messages arrive
        messageAdapter.registerAdapterDataObserver(new androidx.recyclerview.widget.RecyclerView.AdapterDataObserver() {
            @Override
            public void onItemRangeInserted(int positionStart, int itemCount) {
                super.onItemRangeInserted(positionStart, itemCount);
                binding.recyclerMessages.scrollToPosition(messageAdapter.getItemCount() - 1);
            }
        });
    }

    private void setupUIListeners() {
        // Send button click
        binding.btnSend.setOnClickListener(v -> sendMessage());

        // Enter key in message input
        binding.editMessage.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_SEND) {
                sendMessage();
                return true;
            }
            return false;
        });

        // Go to settings button
        binding.btnGoToSettings.setOnClickListener(v -> openSettings());
    }

    private void observeViewModel() {
        // Observe messages
        viewModel.getMessages().observe(this, messages -> {
            // Submit a new list to ensure proper diff calculation
            messageAdapter.submitList(messages != null ? new ArrayList<>(messages) : new ArrayList<>());
        });

        // Observe connection state
        viewModel.getIsConnecting().observe(this, isConnecting -> {
            binding.progressConnecting.setVisibility(isConnecting ? View.VISIBLE : View.GONE);
            binding.btnSend.setEnabled(!isConnecting);
        });

        // Observe errors
        viewModel.getErrorMessage().observe(this, errorMessage -> {
            if (errorMessage != null && !errorMessage.isEmpty()) {
                Snackbar.make(binding.getRoot(), errorMessage, Snackbar.LENGTH_LONG)
                        .setAction("Settings", v -> openSettings())
                        .show();
            }
        });

        // Observe active agent changes
        viewModel.getActiveAgent().observe(this, agent -> {
            // The LiveData might emit null temporarily to force an update.
            // The ViewModel will handle clearing messages and generating new thread IDs.
            android.util.Log.d("ChatActivity", "=== AGENT OBSERVER TRIGGERED ===");
            android.util.Log.d("ChatActivity", "Agent: " + (agent != null ? agent.getName() + " (ID: " + agent.getId() + ")" : "null"));
            android.util.Log.d("ChatActivity", "URL: " + (agent != null ? agent.getUrl() : "null"));

            // Pass the agent (even if null) to the ViewModel.
            // The ViewModel is responsible for handling the state change.
            viewModel.setActiveAgent(agent);
        });

        // Observe agent configuration
        viewModel.getHasAgentConfig().observe(this, hasConfig -> {
            if (hasConfig) {
                // Show chat interface
                binding.recyclerMessages.setVisibility(View.VISIBLE);
                binding.inputContainer.setVisibility(View.VISIBLE);
                binding.noAgentCard.setVisibility(View.GONE);
            } else {
                // Show configuration prompt
                binding.recyclerMessages.setVisibility(View.GONE);
                binding.inputContainer.setVisibility(View.GONE);
                binding.noAgentCard.setVisibility(View.VISIBLE);
            }
        });
    }

    private void sendMessage() {
        String messageText = binding.editMessage.getText().toString().trim();

        if (messageText.isEmpty()) {
            return;
        }

        // Clear input
        binding.editMessage.setText("");

        // Hide keyboard
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm != null) {
            imm.hideSoftInputFromWindow(binding.editMessage.getWindowToken(), 0);
        }

        // Send message
        viewModel.sendMessage(messageText);
    }

    private void setupActivityResultLaunchers() {
        settingsLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    android.util.Log.d("ChatActivity", "=== RETURNING FROM SETTINGS ===");
                    // The LiveData observer will automatically pick up any changes
                    // to the active agent, so no special logic is needed here.
                }
        );
    }

    private void openSettings() {
        Intent intent = new Intent(this, SettingsActivity.class);
        settingsLauncher.launch(intent);
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.chat_menu, menu);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(@NonNull MenuItem item) {
        int itemId = item.getItemId();

        if (itemId == R.id.action_settings) {
            openSettings();
            return true;
        } else if (itemId == R.id.action_clear_history) {
            clearHistory();
            return true;
        }

        return super.onOptionsItemSelected(item);
    }

    private void clearHistory() {
        viewModel.clearHistory();
        Toast.makeText(this, "Chat history cleared", Toast.LENGTH_SHORT).show();
    }

    private void setupEdgeToEdgeInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(binding.getRoot(), (v, insets) -> {
            Insets systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            Insets imeInsets = insets.getInsets(WindowInsetsCompat.Type.ime());

            // Apply top padding to AppBarLayout to avoid status bar overlap
            View appBarLayout = (View) binding.toolbar.getParent();
            appBarLayout.setPadding(0, systemBars.top, 0, 0);

            // IME-aware input container positioning (float above keyboard)
            if (imeInsets.bottom > 0) {
                // Keyboard is visible - position input container above it
                binding.inputContainer.setTranslationY(-imeInsets.bottom);
                
                // Adjust RecyclerView to account for floating input container
                // Use measured height or fallback to estimated height
                binding.inputContainer.post(() -> {
                    int inputHeight = binding.inputContainer.getHeight();
                    if (inputHeight == 0) {
                        // Fallback estimation if not measured yet
                        inputHeight = (int) (64 * getResources().getDisplayMetrics().density); // ~64dp
                    }
                    
                    androidx.constraintlayout.widget.ConstraintLayout.LayoutParams recyclerParams = 
                            (androidx.constraintlayout.widget.ConstraintLayout.LayoutParams) binding.recyclerMessages.getLayoutParams();
                    recyclerParams.bottomMargin = inputHeight + 16; // Add 16dp spacing
                    binding.recyclerMessages.setLayoutParams(recyclerParams);
                    
                    // Scroll to bottom to show latest message
                    if (messageAdapter.getItemCount() > 0) {
                        binding.recyclerMessages.scrollToPosition(messageAdapter.getItemCount() - 1);
                    }
                });
                
                // Remove bottom padding from input container when floating
                binding.inputContainer.setPadding(
                        binding.inputContainer.getPaddingLeft(),
                        binding.inputContainer.getPaddingTop(),
                        binding.inputContainer.getPaddingRight(),
                        8 // Small padding for visual separation
                );
            } else {
                // Keyboard is hidden - reset to normal positioning
                binding.inputContainer.setTranslationY(0);
                
                // Reset RecyclerView bottom margin
                androidx.constraintlayout.widget.ConstraintLayout.LayoutParams recyclerParams = 
                        (androidx.constraintlayout.widget.ConstraintLayout.LayoutParams) binding.recyclerMessages.getLayoutParams();
                recyclerParams.bottomMargin = 0;
                binding.recyclerMessages.setLayoutParams(recyclerParams);
                
                // Apply system bar padding when not floating
                binding.inputContainer.setPadding(
                        binding.inputContainer.getPaddingLeft(),
                        binding.inputContainer.getPaddingTop(),
                        binding.inputContainer.getPaddingRight(),
                        systemBars.bottom + 8 // 8dp margin
                );
            }

            return insets;
        });
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        binding = null;
    }
}