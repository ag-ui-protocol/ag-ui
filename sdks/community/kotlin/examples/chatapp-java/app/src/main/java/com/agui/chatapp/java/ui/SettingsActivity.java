package com.agui.chatapp.java.ui;

import android.app.AlertDialog;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.LayoutInflater;
import android.view.MenuItem;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.recyclerview.widget.LinearLayoutManager;

import com.agui.chatapp.java.databinding.ActivitySettingsBinding;
import com.agui.chatapp.java.databinding.DialogAgentFormBinding;
import com.agui.chatapp.java.repository.MultiAgentRepository;
import com.agui.chatapp.java.ui.adapter.AgentListAdapter;
import com.agui.example.chatapp.data.model.AgentConfig;
import com.agui.example.chatapp.data.model.AuthMethod;

import java.util.List;
import java.util.concurrent.CompletableFuture;

import kotlin.collections.MapsKt;
import kotlinx.datetime.Clock;

public class SettingsActivity extends AppCompatActivity implements AgentListAdapter.OnAgentActionListener {

    private ActivitySettingsBinding binding;
    private MultiAgentRepository repository;
    private AgentListAdapter adapter;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        binding = ActivitySettingsBinding.inflate(getLayoutInflater());
        setContentView(binding.getRoot());

        setSupportActionBar(binding.toolbar);
        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
        }

        repository = MultiAgentRepository.getInstance(this);

        adapter = new AgentListAdapter();
        adapter.setOnAgentActionListener(this);
        binding.recyclerAgents.setLayoutManager(new LinearLayoutManager(this));
        binding.recyclerAgents.setAdapter(adapter);

        binding.fabAddAgent.setOnClickListener(v -> showAgentDialog(null));

        observeRepository();
    }

    private void observeRepository() {
        repository.getAgents().observe(this, agents -> {
            adapter.submitList(agents);
            if (agents == null || agents.isEmpty()) {
                binding.recyclerAgents.setVisibility(View.GONE);
                binding.layoutEmptyState.setVisibility(View.VISIBLE);
            } else {
                binding.recyclerAgents.setVisibility(View.VISIBLE);
                binding.layoutEmptyState.setVisibility(View.GONE);
            }
        });

        repository.getActiveAgent().observe(this, agent ->
            adapter.setActiveAgentId(agent != null ? agent.getId() : null));
    }

    @Override
    public void onActivateAgent(AgentConfig agent) {
        repository.setActiveAgent(agent).whenComplete((unused, throwable) ->
            runOnUiThread(() -> {
                if (throwable != null) {
                    Toast.makeText(this, "Failed: " + throwable.getMessage(), Toast.LENGTH_SHORT).show();
                } else {
                    Toast.makeText(this, "Agent activated: " + agent.getName(), Toast.LENGTH_SHORT).show();
                }
            })
        );
    }

    @Override
    public void onEditAgent(AgentConfig agent) {
        showAgentDialog(agent);
    }

    @Override
    public void onDeleteAgent(AgentConfig agent) {
        new AlertDialog.Builder(this)
            .setTitle("Delete Agent")
            .setMessage("Delete \"" + agent.getName() + "\"?")
            .setPositiveButton("Delete", (d, which) ->
                repository.deleteAgent(agent.getId()).whenComplete((unused, throwable) ->
                    runOnUiThread(() -> {
                        if (throwable != null) {
                            Toast.makeText(this, "Failed: " + throwable.getMessage(), Toast.LENGTH_SHORT).show();
                        } else {
                            Toast.makeText(this, "Agent deleted", Toast.LENGTH_SHORT).show();
                        }
                    })
                )
            )
            .setNegativeButton("Cancel", null)
            .show();
    }

    private void showAgentDialog(AgentConfig existing) {
        DialogAgentFormBinding dialogBinding = DialogAgentFormBinding.inflate(LayoutInflater.from(this));
        String[] authOptions = {"None", "API Key", "Bearer Token", "Basic Auth"};
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this, android.R.layout.simple_dropdown_item_1line, authOptions);
        dialogBinding.autoCompleteAuthType.setAdapter(adapter);

        if (existing != null) {
            dialogBinding.editAgentName.setText(existing.getName());
            dialogBinding.editAgentUrl.setText(existing.getUrl());
            dialogBinding.editAgentDescription.setText(existing.getDescription() != null ? existing.getDescription() : "");
            dialogBinding.editSystemPrompt.setText(existing.getSystemPrompt() != null ? existing.getSystemPrompt() : "");
            applyAuthToDialog(existing.getAuthMethod(), dialogBinding, authOptions);
        } else {
            dialogBinding.autoCompleteAuthType.setText(authOptions[0], false);
            updateAuthFieldVisibility(dialogBinding, authOptions[0]);
        }

        dialogBinding.autoCompleteAuthType.setOnItemClickListener((parent, view, position, id) ->
            updateAuthFieldVisibility(dialogBinding, authOptions[position]));
        dialogBinding.autoCompleteAuthType.addTextChangedListener(new SimpleTextWatcher() {
            @Override public void afterTextChanged(Editable editable) {
                updateAuthFieldVisibility(dialogBinding, editable.toString());
            }
        });

        AlertDialog dialog = new AlertDialog.Builder(this)
            .setTitle(existing != null ? "Edit Agent" : "Add Agent")
            .setView(dialogBinding.getRoot())
            .setPositiveButton(existing != null ? "Save" : "Add", null)
            .setNegativeButton("Cancel", null)
            .create();

        dialog.setOnShowListener(d ->
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v ->
                handleSaveAgent(dialog, dialogBinding, authOptions, existing))
        );

        dialog.show();
    }

    private void handleSaveAgent(AlertDialog dialog,
                                 DialogAgentFormBinding binding,
                                 String[] authOptions,
                                 AgentConfig existing) {
        String name = getTrimmed(binding.editAgentName.getText());
        String url = getTrimmed(binding.editAgentUrl.getText());
        String description = getTrimmed(binding.editAgentDescription.getText());
        String systemPrompt = getTrimmed(binding.editSystemPrompt.getText());
        String authSelection = getTrimmed(binding.autoCompleteAuthType.getText());

        boolean hasError = false;
        if (name.isEmpty()) {
            binding.textInputAgentName.setError("Name is required");
            hasError = true;
        } else {
            binding.textInputAgentName.setError(null);
        }

        if (url.isEmpty()) {
            binding.textInputAgentUrl.setError("URL is required");
            hasError = true;
        } else {
            binding.textInputAgentUrl.setError(null);
        }

        if (hasError) return;

        AuthMethod authMethod;
        switch (authSelection) {
            case "API Key":
                String apiKey = getTrimmed(binding.editApiKey.getText());
                if (apiKey.isEmpty()) {
                    binding.textInputApiKey.setError("API key required");
                    return;
                }
                binding.textInputApiKey.setError(null);
                authMethod = new AuthMethod.ApiKey(apiKey, "X-API-Key");
                break;
            case "Bearer Token":
                String token = getTrimmed(binding.editBearerToken.getText());
                if (token.isEmpty()) {
                    binding.textInputBearerToken.setError("Token required");
                    return;
                }
                binding.textInputBearerToken.setError(null);
                authMethod = new AuthMethod.BearerToken(token);
                break;
            case "Basic Auth":
                String username = getTrimmed(binding.editBasicUsername.getText());
                String password = getTrimmed(binding.editBasicPassword.getText());
                if (username.isEmpty()) {
                    binding.textInputBasicUsername.setError("Username required");
                    return;
                }
                if (password.isEmpty()) {
                    binding.textInputBasicPassword.setError("Password required");
                    return;
                }
                binding.textInputBasicUsername.setError(null);
                binding.textInputBasicPassword.setError(null);
                authMethod = new AuthMethod.BasicAuth(username, password);
                break;
            default:
                authMethod = new AuthMethod.None();
        }

        AgentConfig config = buildAgentConfig(existing, name, url,
                description.isEmpty() ? null : description,
                authMethod,
                systemPrompt.isEmpty() ? null : systemPrompt);

        CompletableFuture<Void> future = (existing == null)
                ? repository.addAgent(config)
                : repository.updateAgent(config);

        future.whenComplete((unused, throwable) -> runOnUiThread(() -> {
            if (throwable != null) {
                Toast.makeText(this, "Failed: " + throwable.getMessage(), Toast.LENGTH_SHORT).show();
            } else {
                Toast.makeText(this, "Agent saved", Toast.LENGTH_SHORT).show();
                dialog.dismiss();
            }
        }));
    }

    private AgentConfig buildAgentConfig(AgentConfig base,
                                         String name,
                                         String url,
                                         String description,
                                         AuthMethod authMethod,
                                         String systemPrompt) {
        String id = base != null ? base.getId() : AgentConfig.Companion.generateId();
        boolean active = base != null && base.isActive();
        return new AgentConfig(
                id,
                name,
                url,
                description,
                authMethod,
                active,
                base != null ? base.getCreatedAt() : Clock.System.INSTANCE.now(),
                base != null ? base.getLastUsedAt() : null,
                base != null ? base.getCustomHeaders() : kotlin.collections.MapsKt.emptyMap(),
                systemPrompt
        );
    }

    private void applyAuthToDialog(AuthMethod method, DialogAgentFormBinding binding, String[] authOptions) {
        if (method instanceof AuthMethod.ApiKey) {
            binding.autoCompleteAuthType.setText(authOptions[1], false);
            binding.editApiKey.setText(((AuthMethod.ApiKey) method).getKey());
            updateAuthFieldVisibility(binding, authOptions[1]);
        } else if (method instanceof AuthMethod.BearerToken) {
            binding.autoCompleteAuthType.setText(authOptions[2], false);
            binding.editBearerToken.setText(((AuthMethod.BearerToken) method).getToken());
            updateAuthFieldVisibility(binding, authOptions[2]);
        } else if (method instanceof AuthMethod.BasicAuth) {
            binding.autoCompleteAuthType.setText(authOptions[3], false);
            binding.editBasicUsername.setText(((AuthMethod.BasicAuth) method).getUsername());
            binding.editBasicPassword.setText(((AuthMethod.BasicAuth) method).getPassword());
            updateAuthFieldVisibility(binding, authOptions[3]);
        } else {
            binding.autoCompleteAuthType.setText(authOptions[0], false);
            updateAuthFieldVisibility(binding, authOptions[0]);
        }
    }

    private void updateAuthFieldVisibility(DialogAgentFormBinding binding, String selection) {
        boolean apiKey = "API Key".equalsIgnoreCase(selection);
        boolean bearer = "Bearer Token".equalsIgnoreCase(selection);
        boolean basic = "Basic Auth".equalsIgnoreCase(selection);

        binding.textInputApiKey.setVisibility(apiKey ? View.VISIBLE : View.GONE);
        binding.textInputBearerToken.setVisibility(bearer ? View.VISIBLE : View.GONE);
        binding.textInputBasicUsername.setVisibility(basic ? View.VISIBLE : View.GONE);
        binding.textInputBasicPassword.setVisibility(basic ? View.VISIBLE : View.GONE);
    }

    private static String getTrimmed(CharSequence text) {
        return text == null ? "" : text.toString().trim();
    }

    @Override
    public boolean onOptionsItemSelected(@NonNull MenuItem item) {
        if (item.getItemId() == android.R.id.home) {
            finish();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    private abstract static class SimpleTextWatcher implements TextWatcher {
        @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
        @Override public void onTextChanged(CharSequence s, int start, int before, int count) {}
    }
}
