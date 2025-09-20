package com.agui.chatapp.java.ui;

import android.app.AlertDialog;
import android.os.Bundle;
import android.view.LayoutInflater;
import android.view.MenuItem;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowCompat;
import androidx.recyclerview.widget.LinearLayoutManager;

import com.agui.chatapp.java.databinding.ActivitySettingsBinding;
import com.agui.chatapp.java.databinding.DialogAgentFormBinding;
import com.agui.chatapp.java.model.AgentProfile;
import com.agui.chatapp.java.model.AuthMethod;
import com.agui.chatapp.java.repository.MultiAgentRepository;
import com.agui.chatapp.java.ui.adapter.AgentListAdapter;

import java.util.UUID;

/**
 * Settings activity for managing multiple agent profiles.
 * Includes full CRUD functionality with agent creation/editing dialogs.
 */
public class SettingsActivity extends AppCompatActivity implements AgentListAdapter.OnAgentActionListener {
    
    private ActivitySettingsBinding binding;
    private MultiAgentRepository repository;
    private AgentListAdapter agentAdapter;
    
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // Enable edge-to-edge display
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        
        binding = ActivitySettingsBinding.inflate(getLayoutInflater());
        setContentView(binding.getRoot());
        
        // Setup toolbar
        setSupportActionBar(binding.toolbar);
        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
        }
        
        // Setup edge-to-edge window insets
        setupEdgeToEdgeInsets();

        // Initialize repository using the getInstance() method
        repository = MultiAgentRepository.getInstance(this);
        
        // Setup RecyclerView
        setupRecyclerView();
        
        // Setup listeners
        setupListeners();
        
        // Observe data
        observeData();
    }
    
    private void setupRecyclerView() {
        agentAdapter = new AgentListAdapter();
        agentAdapter.setOnAgentActionListener(this);
        
        binding.recyclerAgents.setAdapter(agentAdapter);
        binding.recyclerAgents.setLayoutManager(new LinearLayoutManager(this));
    }
    
    private void setupListeners() {
        // Floating action button
        binding.fabAddAgent.setOnClickListener(v -> showAgentDialog(null));
    }
    
    private void observeData() {
        // Observe agents list
        repository.getAgents().observe(this, agents -> {
            agentAdapter.submitList(agents);
            
            // Show/hide empty state
            if (agents.isEmpty()) {
                binding.recyclerAgents.setVisibility(android.view.View.GONE);
                binding.layoutEmptyState.setVisibility(android.view.View.VISIBLE);
            } else {
                binding.recyclerAgents.setVisibility(android.view.View.VISIBLE);
                binding.layoutEmptyState.setVisibility(android.view.View.GONE);
            }
        });
        
        // Observe active agent
        repository.getActiveAgent().observe(this, activeAgent -> {
            String activeAgentId = activeAgent != null ? activeAgent.getId() : null;
            agentAdapter.setActiveAgentId(activeAgentId);
        });
    }
    
    @Override
    public void onActivateAgent(AgentProfile agent) {
        android.util.Log.d("SettingsActivity", "=== ACTIVATING AGENT ===");
        android.util.Log.d("SettingsActivity", "Agent Name: " + agent.getName());
        android.util.Log.d("SettingsActivity", "Agent ID: " + agent.getId());
        android.util.Log.d("SettingsActivity", "Agent URL: " + agent.getUrl());
        
        repository.setActiveAgent(agent)
            .whenComplete((result, throwable) -> {
                runOnUiThread(() -> {
                    if (throwable != null) {
                        android.util.Log.e("SettingsActivity", "Failed to activate agent", throwable);
                        Toast.makeText(this, "Failed to activate agent: " + throwable.getMessage(), 
                                Toast.LENGTH_SHORT).show();
                    } else {
                        android.util.Log.d("SettingsActivity", "Agent activation complete: " + agent.getName());
                        Toast.makeText(this, "Agent activated: " + agent.getName(), 
                                Toast.LENGTH_SHORT).show();
                    }
                });
            });
    }
    
    @Override
    public void onEditAgent(AgentProfile agent) {
        showAgentDialog(agent);
    }
    
    @Override
    public void onDeleteAgent(AgentProfile agent) {
        // Simple confirmation for now
        new android.app.AlertDialog.Builder(this)
            .setTitle("Delete Agent")
            .setMessage("Are you sure you want to delete \"" + agent.getName() + "\"?")
            .setPositiveButton("Delete", (dialog, which) -> {
                repository.deleteAgent(agent.getId())
                    .whenComplete((result, throwable) -> {
                        runOnUiThread(() -> {
                            if (throwable != null) {
                                Toast.makeText(this, "Failed to delete agent: " + throwable.getMessage(), 
                                        Toast.LENGTH_SHORT).show();
                            } else {
                                Toast.makeText(this, "Agent deleted", Toast.LENGTH_SHORT).show();
                            }
                        });
                    });
            })
            .setNegativeButton("Cancel", null)
            .show();
    }
    
    private void showAgentDialog(AgentProfile existingAgent) {
        DialogAgentFormBinding dialogBinding = DialogAgentFormBinding.inflate(LayoutInflater.from(this));
        
        // Auth type options
        String[] authTypes = {"None", "API Key", "Bearer Token", "Basic Auth"};
        ArrayAdapter<String> authAdapter = new ArrayAdapter<>(this, 
                android.R.layout.simple_dropdown_item_1line, authTypes);
        dialogBinding.autoCompleteAuthType.setAdapter(authAdapter);
        
        // Pre-fill if editing
        if (existingAgent != null) {
            dialogBinding.editAgentName.setText(existingAgent.getName());
            dialogBinding.editAgentUrl.setText(existingAgent.getUrl());
            if (existingAgent.getDescription() != null) {
                dialogBinding.editAgentDescription.setText(existingAgent.getDescription());
            }
            if (existingAgent.getSystemPrompt() != null) {
                dialogBinding.editSystemPrompt.setText(existingAgent.getSystemPrompt());
            }
            
            // Set auth type and fields
            setAuthTypeInDialog(dialogBinding, existingAgent.getAuthMethod());
        } else {
            // Default to "None" for new agents
            dialogBinding.autoCompleteAuthType.setText(authTypes[0], false);
            updateAuthFieldsVisibility(dialogBinding, new AuthMethod.None());
        }
        
        // Auth type selection handler
        dialogBinding.autoCompleteAuthType.setOnItemClickListener((parent, view, position, id) -> {
            AuthMethod authMethod = getAuthMethodFromIndex(position);
            updateAuthFieldsVisibility(dialogBinding, authMethod);
        });
        
        // Handle text changes (for test scenarios or manual typing)
        dialogBinding.autoCompleteAuthType.addTextChangedListener(new android.text.TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            
            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {}
            
            @Override
            public void afterTextChanged(android.text.Editable s) {
                String text = s.toString();
                AuthMethod authMethod = getAuthMethodFromString(text, dialogBinding);
                updateAuthFieldsVisibility(dialogBinding, authMethod);
            }
        });
        
        AlertDialog dialog = new AlertDialog.Builder(this)
            .setTitle(existingAgent != null ? "Edit Agent" : "Add Agent")
            .setView(dialogBinding.getRoot())
            .setPositiveButton(existingAgent != null ? "Update" : "Add", null)
            .setNegativeButton("Cancel", null)
            .create();
        
        dialog.setOnShowListener(dialogInterface -> {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
                if (validateAndSaveAgent(dialogBinding, existingAgent)) {
                    dialog.dismiss();
                }
            });
        });
        
        dialog.show();
    }
    
    private void setAuthTypeInDialog(DialogAgentFormBinding dialogBinding, AuthMethod authMethod) {
        if (authMethod instanceof AuthMethod.None) {
            dialogBinding.autoCompleteAuthType.setText("None", false);
            updateAuthFieldsVisibility(dialogBinding, authMethod);
        } else if (authMethod instanceof AuthMethod.ApiKey) {
            AuthMethod.ApiKey apiKey = (AuthMethod.ApiKey) authMethod;
            dialogBinding.autoCompleteAuthType.setText("API Key", false);
            dialogBinding.editApiKey.setText(apiKey.getKey());
            updateAuthFieldsVisibility(dialogBinding, authMethod);
        } else if (authMethod instanceof AuthMethod.BearerToken) {
            AuthMethod.BearerToken bearerToken = (AuthMethod.BearerToken) authMethod;
            dialogBinding.autoCompleteAuthType.setText("Bearer Token", false);
            dialogBinding.editBearerToken.setText(bearerToken.getToken());
            updateAuthFieldsVisibility(dialogBinding, authMethod);
        } else if (authMethod instanceof AuthMethod.BasicAuth) {
            AuthMethod.BasicAuth basicAuth = (AuthMethod.BasicAuth) authMethod;
            dialogBinding.autoCompleteAuthType.setText("Basic Auth", false);
            dialogBinding.editBasicUsername.setText(basicAuth.getUsername());
            dialogBinding.editBasicPassword.setText(basicAuth.getPassword());
            updateAuthFieldsVisibility(dialogBinding, authMethod);
        }
    }
    
    private AuthMethod getAuthMethodFromIndex(int index) {
        switch (index) {
            case 0: return new AuthMethod.None();
            case 1: return new AuthMethod.ApiKey(""); // Will be filled later
            case 2: return new AuthMethod.BearerToken(""); // Will be filled later
            case 3: return new AuthMethod.BasicAuth("", ""); // Will be filled later
            default: return new AuthMethod.None();
        }
    }
    
    private void updateAuthFieldsVisibility(DialogAgentFormBinding dialogBinding, AuthMethod authMethod) {
        // Hide all auth fields first
        dialogBinding.textInputApiKey.setVisibility(View.GONE);
        dialogBinding.textInputBearerToken.setVisibility(View.GONE);
        dialogBinding.textInputBasicUsername.setVisibility(View.GONE);
        dialogBinding.textInputBasicPassword.setVisibility(View.GONE);
        
        // Show relevant fields based on auth type
        if (authMethod instanceof AuthMethod.ApiKey) {
            dialogBinding.textInputApiKey.setVisibility(View.VISIBLE);
        } else if (authMethod instanceof AuthMethod.BearerToken) {
            dialogBinding.textInputBearerToken.setVisibility(View.VISIBLE);
        } else if (authMethod instanceof AuthMethod.BasicAuth) {
            dialogBinding.textInputBasicUsername.setVisibility(View.VISIBLE);
            dialogBinding.textInputBasicPassword.setVisibility(View.VISIBLE);
        }
        // No additional fields for None
    }
    
    private boolean validateAndSaveAgent(DialogAgentFormBinding dialogBinding, AgentProfile existingAgent) {
        // Clear previous errors
        dialogBinding.textInputAgentName.setError(null);
        dialogBinding.textInputAgentUrl.setError(null);
        dialogBinding.textInputApiKey.setError(null);
        dialogBinding.textInputBearerToken.setError(null);
        dialogBinding.textInputBasicUsername.setError(null);
        dialogBinding.textInputBasicPassword.setError(null);
        
        // Validate required fields
        String name = dialogBinding.editAgentName.getText().toString().trim();
        if (name.isEmpty()) {
            dialogBinding.textInputAgentName.setError("Agent name is required");
            return false;
        }
        
        String url = dialogBinding.editAgentUrl.getText().toString().trim();
        if (url.isEmpty()) {
            dialogBinding.textInputAgentUrl.setError("Agent URL is required");
            return false;
        }
        
        // Get auth method
        String selectedAuthType = dialogBinding.autoCompleteAuthType.getText().toString();
        AuthMethod authMethod = getAuthMethodFromString(selectedAuthType, dialogBinding);
        
        // Validate auth method
        if (!authMethod.isValid()) {
            if (authMethod instanceof AuthMethod.ApiKey) {
                dialogBinding.textInputApiKey.setError("API key is required");
            } else if (authMethod instanceof AuthMethod.BearerToken) {
                dialogBinding.textInputBearerToken.setError("Bearer token is required");
            } else if (authMethod instanceof AuthMethod.BasicAuth) {
                if (dialogBinding.editBasicUsername.getText().toString().trim().isEmpty()) {
                    dialogBinding.textInputBasicUsername.setError("Username is required");
                }
                if (dialogBinding.editBasicPassword.getText().toString().trim().isEmpty()) {
                    dialogBinding.textInputBasicPassword.setError("Password is required");
                }
            }
            return false;
        }
        
        // Create agent profile
        String description = dialogBinding.editAgentDescription.getText().toString().trim();
        String systemPrompt = dialogBinding.editSystemPrompt.getText().toString().trim();
        
        AgentProfile.Builder builder;
        if (existingAgent != null) {
            builder = existingAgent.toBuilder();
        } else {
            builder = new AgentProfile.Builder()
                .setId(UUID.randomUUID().toString())
                .setCreatedAt(System.currentTimeMillis());
        }
        
        AgentProfile agent = builder
            .setName(name)
            .setUrl(url)
            .setDescription(description.isEmpty() ? null : description)
            .setSystemPrompt(systemPrompt.isEmpty() ? null : systemPrompt)
            .setAuthMethod(authMethod)
            .build();
        
        // Save agent
        if (existingAgent != null) {
            repository.updateAgent(agent)
                .whenComplete((result, throwable) -> {
                    runOnUiThread(() -> {
                        if (throwable != null) {
                            Toast.makeText(this, "Failed to update agent: " + throwable.getMessage(), 
                                    Toast.LENGTH_SHORT).show();
                        } else {
                            Toast.makeText(this, "Agent updated", Toast.LENGTH_SHORT).show();
                        }
                    });
                });
        } else {
            repository.addAgent(agent)
                .whenComplete((result, throwable) -> {
                    runOnUiThread(() -> {
                        if (throwable != null) {
                            Toast.makeText(this, "Failed to add agent: " + throwable.getMessage(), 
                                    Toast.LENGTH_SHORT).show();
                        } else {
                            Toast.makeText(this, "Agent added", Toast.LENGTH_SHORT).show();
                        }
                    });
                });
        }
        
        return true;
    }
    
    private AuthMethod getAuthMethodFromString(String authTypeString, DialogAgentFormBinding dialogBinding) {
        switch (authTypeString) {
            case "None":
                return new AuthMethod.None();
            case "API Key":
                String apiKey = dialogBinding.editApiKey.getText().toString().trim();
                return new AuthMethod.ApiKey(apiKey);
            case "Bearer Token":
                String bearerToken = dialogBinding.editBearerToken.getText().toString().trim();
                return new AuthMethod.BearerToken(bearerToken);
            case "Basic Auth":
                String username = dialogBinding.editBasicUsername.getText().toString().trim();
                String password = dialogBinding.editBasicPassword.getText().toString().trim();
                return new AuthMethod.BasicAuth(username, password);
            default:
                return new AuthMethod.None();
        }
    }
    
    private void setupEdgeToEdgeInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(binding.getRoot(), (v, insets) -> {
            Insets systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            
            // Since we're using a simple layout without AppBarLayout, we need to handle the toolbar differently
            // Apply padding to the whole root view for status bar
            binding.getRoot().setPadding(
                0,
                systemBars.top,
                0,
                0
            );
            
            // Apply bottom padding to RecyclerView for navigation bar
            binding.recyclerAgents.setPadding(
                binding.recyclerAgents.getPaddingLeft(),
                binding.recyclerAgents.getPaddingTop(),
                binding.recyclerAgents.getPaddingRight(),
                systemBars.bottom
            );
            binding.recyclerAgents.setClipToPadding(false);
            
            // Apply bottom padding to empty state for navigation bar
            binding.layoutEmptyState.setPadding(
                binding.layoutEmptyState.getPaddingLeft(),
                binding.layoutEmptyState.getPaddingTop(),
                binding.layoutEmptyState.getPaddingRight(),
                systemBars.bottom
            );
            
            // Apply bottom margin to FAB to avoid nav bar overlap
            binding.fabAddAgent.setTranslationY(-systemBars.bottom);
            
            return insets;
        });
    }

    @Override
    public boolean onOptionsItemSelected(@NonNull MenuItem item) {
        if (item.getItemId() == android.R.id.home) {
            finish();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }
    
    @Override
    protected void onDestroy() {
        super.onDestroy();
        binding = null;
    }
}