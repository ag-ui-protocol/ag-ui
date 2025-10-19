package com.agui.chatapp.java.ui.adapter;

import android.text.method.LinkMovementMethod;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.DiffUtil;
import androidx.recyclerview.widget.ListAdapter;
import androidx.recyclerview.widget.RecyclerView;

import com.agui.chatapp.java.R;
import com.agui.chatapp.java.model.ChatMessage;
import com.agui.example.chatapp.chat.MessageRole;
import io.noties.markwon.Markwon;

/**
 * RecyclerView adapter for displaying chat messages with different layouts
 * based on message type (user, assistant, system).
 */
public class MessageAdapter extends ListAdapter<ChatMessage, MessageAdapter.MessageViewHolder> {
    
    private static final int VIEW_TYPE_USER = 1;
    private static final int VIEW_TYPE_ASSISTANT = 2;
    private static final int VIEW_TYPE_SYSTEM = 3;

    private Markwon markwon;
    
    public MessageAdapter() {
        super(new MessageDiffCallback());
    }
    
    @Override
    public int getItemViewType(int position) {
        ChatMessage message = getItem(position);
        MessageRole role = message.getRole();
        if (role == MessageRole.USER) {
            return VIEW_TYPE_USER;
        } else if (role == MessageRole.ASSISTANT) {
            return VIEW_TYPE_ASSISTANT;
        } else {
            return VIEW_TYPE_SYSTEM;
        }
    }
    
    @NonNull
    @Override
    public MessageViewHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        LayoutInflater inflater = LayoutInflater.from(parent.getContext());
        View view;

        switch (viewType) {
            case VIEW_TYPE_USER:
                view = inflater.inflate(R.layout.item_message_user, parent, false);
                break;
            case VIEW_TYPE_ASSISTANT:
                view = inflater.inflate(R.layout.item_message_assistant, parent, false);
                break;
            case VIEW_TYPE_SYSTEM:
            default:
                view = inflater.inflate(R.layout.item_message_system, parent, false);
                break;
        }

        return new MessageViewHolder(view, viewType, getMarkwon(view));
    }
    
    @Override
    public void onBindViewHolder(@NonNull MessageViewHolder holder, int position) {
        ChatMessage message = getItem(position);
        holder.bind(message);
    }
    
    /**
     * Update a specific message (useful for streaming updates)
     */
    public void updateMessage(ChatMessage message) {
        int position = getCurrentList().indexOf(message);
        if (position >= 0) {
            notifyItemChanged(position);
        }
    }
    
    private Markwon getMarkwon(View view) {
        if (markwon == null) {
            markwon = Markwon.create(view.getContext());
        }
        return markwon;
    }

    static class MessageViewHolder extends RecyclerView.ViewHolder {
        private final TextView textSender;
        private final TextView textContent;
        private final TextView textTimestamp;
        private final ProgressBar progressTyping;
        private final int viewType;
        private final Markwon markwon;
        
        public MessageViewHolder(@NonNull View itemView, int viewType, Markwon markwon) {
            super(itemView);
            this.viewType = viewType;
            this.markwon = markwon;
            
            textSender = itemView.findViewById(R.id.textSender);
            textContent = itemView.findViewById(R.id.textContent);
            textTimestamp = itemView.findViewById(R.id.textTimestamp);
            progressTyping = itemView.findViewById(R.id.progressTyping);
        }
        
        public void bind(ChatMessage message) {
            // Set sender name
            if (textSender != null) {
                textSender.setText(message.getSenderDisplayName());
            }
            
            // Set message content
            if (textContent != null) {
                markwon.setMarkdown(textContent, message.getContent());
                textContent.setMovementMethod(LinkMovementMethod.getInstance());
            }
            
            // Set timestamp
            if (textTimestamp != null) {
                textTimestamp.setText(message.getFormattedTimestamp());
            }
            
            // Show/hide typing indicator for assistant messages
            if (progressTyping != null) {
                if (viewType == VIEW_TYPE_ASSISTANT && message.isStreaming()) {
                    progressTyping.setVisibility(View.VISIBLE);
                } else {
                    progressTyping.setVisibility(View.GONE);
                }
            }
        }
    }
    
    static class MessageDiffCallback extends DiffUtil.ItemCallback<ChatMessage> {
        @Override
        public boolean areItemsTheSame(@NonNull ChatMessage oldItem, @NonNull ChatMessage newItem) {
            return oldItem.getId().equals(newItem.getId());
        }
        
        @Override
        public boolean areContentsTheSame(@NonNull ChatMessage oldItem, @NonNull ChatMessage newItem) {
            // For streaming messages, we need to compare content changes
            return oldItem.getContent().equals(newItem.getContent()) &&
                   oldItem.isStreaming() == newItem.isStreaming() &&
                   oldItem.getSenderDisplayName().equals(newItem.getSenderDisplayName());
        }
    }
}
