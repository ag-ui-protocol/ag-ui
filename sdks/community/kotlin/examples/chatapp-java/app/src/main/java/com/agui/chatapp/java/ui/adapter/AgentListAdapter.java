package com.agui.chatapp.java.ui.adapter;

import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import androidx.annotation.NonNull;
import androidx.recyclerview.widget.DiffUtil;
import androidx.recyclerview.widget.ListAdapter;
import androidx.recyclerview.widget.RecyclerView;
import com.agui.chatapp.java.databinding.ItemAgentCardBinding;
import com.agui.example.chatapp.data.model.AgentConfig;
import com.agui.example.chatapp.data.model.AuthMethod;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class AgentListAdapter extends ListAdapter<AgentConfig, AgentListAdapter.AgentViewHolder> {

    public interface OnAgentActionListener {
        void onActivateAgent(AgentConfig agent);
        void onEditAgent(AgentConfig agent);
        void onDeleteAgent(AgentConfig agent);
    }

    private final SimpleDateFormat formatter = new SimpleDateFormat("MMM dd, HH:mm", Locale.getDefault());
    private OnAgentActionListener actionListener;
    private String activeAgentId;

    public AgentListAdapter() {
        super(DIFF_CALLBACK);
    }

    public void setOnAgentActionListener(OnAgentActionListener listener) {
        this.actionListener = listener;
    }

    public void setActiveAgentId(String id) {
        this.activeAgentId = id;
        notifyDataSetChanged();
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

    public class AgentViewHolder extends RecyclerView.ViewHolder {
        private final ItemAgentCardBinding binding;

        AgentViewHolder(ItemAgentCardBinding binding) {
            super(binding.getRoot());
            this.binding = binding;
        }

        void bind(AgentConfig agent) {
            boolean isActive = agent.getId().equals(activeAgentId);

            binding.textAgentName.setText(agent.getName());
            binding.textAgentUrl.setText(agent.getUrl());

            if (agent.getDescription() != null && !agent.getDescription().isEmpty()) {
                binding.textAgentDescription.setVisibility(View.VISIBLE);
                binding.textAgentDescription.setText(agent.getDescription());
            } else {
                binding.textAgentDescription.setVisibility(View.GONE);
            }

            binding.chipAuthMethod.setText(labelForAuth(agent.getAuthMethod()));

            if (agent.getLastUsedAt() != null) {
                long millis = agent.getLastUsedAt().toEpochMilliseconds();
                binding.textLastUsed.setVisibility(View.VISIBLE);
                binding.textLastUsed.setText("Last used: " + formatter.format(new Date(millis)));
            } else {
                binding.textLastUsed.setVisibility(View.GONE);
            }

            binding.iconActive.setVisibility(isActive ? View.VISIBLE : View.GONE);

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

            binding.btnEdit.setOnClickListener(v -> {
                if (actionListener != null) {
                    actionListener.onEditAgent(agent);
                }
            });

            binding.btnDelete.setOnClickListener(v -> {
                if (actionListener != null) {
                    actionListener.onDeleteAgent(agent);
                }
            });
        }

        private String labelForAuth(AuthMethod method) {
            if (method instanceof AuthMethod.ApiKey) {
                return "API Key";
            } else if (method instanceof AuthMethod.BearerToken) {
                return "Bearer Token";
            } else if (method instanceof AuthMethod.BasicAuth) {
                return "Basic Auth";
            } else {
                return "No Auth";
            }
        }
    }

    private static final DiffUtil.ItemCallback<AgentConfig> DIFF_CALLBACK =
            new DiffUtil.ItemCallback<AgentConfig>() {
                @Override
                public boolean areItemsTheSame(@NonNull AgentConfig oldItem, @NonNull AgentConfig newItem) {
                    return oldItem.getId().equals(newItem.getId());
                }

                @Override
                public boolean areContentsTheSame(@NonNull AgentConfig oldItem, @NonNull AgentConfig newItem) {
                    return oldItem.equals(newItem);
                }
            };
}
