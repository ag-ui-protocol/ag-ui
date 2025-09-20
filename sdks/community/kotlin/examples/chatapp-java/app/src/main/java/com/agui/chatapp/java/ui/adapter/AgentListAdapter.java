package com.agui.chatapp.java.ui.adapter;

import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import androidx.annotation.NonNull;
import androidx.recyclerview.widget.DiffUtil;
import androidx.recyclerview.widget.ListAdapter;
import androidx.recyclerview.widget.RecyclerView;

import com.agui.chatapp.java.databinding.ItemAgentCardBinding;
import com.agui.chatapp.java.model.AgentProfile;
import com.agui.chatapp.java.model.AuthMethod;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * RecyclerView adapter for displaying agent profiles in a list.
 * Uses Material 3 design with agent cards showing basic info and action buttons.
 */
public class AgentListAdapter extends ListAdapter<AgentProfile, AgentListAdapter.AgentViewHolder> {
    
    private OnAgentActionListener actionListener;
    private String activeAgentId;
    
    public interface OnAgentActionListener {
        void onActivateAgent(AgentProfile agent);
        void onEditAgent(AgentProfile agent);
        void onDeleteAgent(AgentProfile agent);
    }
    
    public AgentListAdapter() {
        super(new AgentDiffCallback());
    }
    
    public void setOnAgentActionListener(OnAgentActionListener listener) {
        this.actionListener = listener;
    }
    
    public void setActiveAgentId(String activeAgentId) {
        this.activeAgentId = activeAgentId;
        notifyDataSetChanged(); // Refresh to update active state indicators
    }
    
    @NonNull
    @Override
    public AgentViewHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        ItemAgentCardBinding binding = ItemAgentCardBinding.inflate(
                LayoutInflater.from(parent.getContext()), parent, false);
        return new AgentViewHolder(binding);
    }
    
    @Override
    public void onBindViewHolder(@NonNull AgentViewHolder holder, int position) {
        holder.bind(getItem(position));
    }
    
    class AgentViewHolder extends RecyclerView.ViewHolder {
        private final ItemAgentCardBinding binding;
        
        public AgentViewHolder(@NonNull ItemAgentCardBinding binding) {
            super(binding.getRoot());
            this.binding = binding;
        }
        
        public void bind(AgentProfile agent) {
            boolean isActive = agent.getId().equals(activeAgentId);
            
            // Set basic info
            binding.textAgentName.setText(agent.getName());
            binding.textAgentUrl.setText(agent.getUrl());
            
            // Description (optional)
            if (agent.getDescription() != null && !agent.getDescription().isEmpty()) {
                binding.textAgentDescription.setText(agent.getDescription());
                binding.textAgentDescription.setVisibility(View.VISIBLE);
            } else {
                binding.textAgentDescription.setVisibility(View.GONE);
            }
            
            // Auth method chip
            binding.chipAuthMethod.setText(getAuthMethodLabel(agent.getAuthMethod()));
            
            // Last used info
            if (agent.getLastUsedAt() != null) {
                String lastUsed = formatDateTime(agent.getLastUsedAt());
                binding.textLastUsed.setText("Last used: " + lastUsed);
                binding.textLastUsed.setVisibility(View.VISIBLE);
            } else {
                binding.textLastUsed.setVisibility(View.GONE);
            }
            
            // Active indicator
            binding.iconActive.setVisibility(isActive ? View.VISIBLE : View.GONE);
            
            // Activate button (only show if not active)
            if (isActive) {
                binding.btnActivate.setVisibility(View.GONE);
            } else {
                binding.btnActivate.setVisibility(View.VISIBLE);
                binding.btnActivate.setOnClickListener(v -> {
                    if (actionListener != null) {
                        actionListener.onActivateAgent(agent);
                    }
                });
            }
            
            // Edit button
            binding.btnEdit.setOnClickListener(v -> {
                if (actionListener != null) {
                    actionListener.onEditAgent(agent);
                }
            });
            
            // Delete button
            binding.btnDelete.setOnClickListener(v -> {
                if (actionListener != null) {
                    actionListener.onDeleteAgent(agent);
                }
            });
            
            // Card highlighting for active agent
            // Use theme-appropriate colors with proper contrast
            if (isActive) {
                // Highlight active agent with elevated appearance
                binding.cardAgent.setCardBackgroundColor(
                    binding.getRoot().getContext().getColor(com.google.android.material.R.color.cardview_light_background));
                binding.cardAgent.setCardElevation(8f);
                binding.cardAgent.setStrokeWidth(2);
                binding.cardAgent.setStrokeColor(
                    binding.getRoot().getContext().getColor(com.google.android.material.R.color.design_default_color_primary));
            } else {
                // Default appearance for inactive agents
                binding.cardAgent.setCardBackgroundColor(
                    binding.getRoot().getContext().getColor(com.google.android.material.R.color.cardview_light_background));
                binding.cardAgent.setCardElevation(2f);
                binding.cardAgent.setStrokeWidth(0);
            }
        }
        
        private String getAuthMethodLabel(AuthMethod authMethod) {
            if (authMethod instanceof AuthMethod.None) {
                return "No Auth";
            } else if (authMethod instanceof AuthMethod.ApiKey) {
                return "API Key";
            } else if (authMethod instanceof AuthMethod.BearerToken) {
                return "Bearer Token";
            } else if (authMethod instanceof AuthMethod.BasicAuth) {
                return "Basic Auth";
            } else {
                return "Unknown";
            }
        }
        
        private String formatDateTime(Long timestamp) {
            SimpleDateFormat formatter = new SimpleDateFormat("MMM dd, HH:mm", Locale.getDefault());
            return formatter.format(new Date(timestamp));
        }
    }
    
    static class AgentDiffCallback extends DiffUtil.ItemCallback<AgentProfile> {
        @Override
        public boolean areItemsTheSame(@NonNull AgentProfile oldItem, @NonNull AgentProfile newItem) {
            return oldItem.getId().equals(newItem.getId());
        }
        
        @Override
        public boolean areContentsTheSame(@NonNull AgentProfile oldItem, @NonNull AgentProfile newItem) {
            return oldItem.equals(newItem);
        }
    }
}