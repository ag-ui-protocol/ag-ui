#!/bin/bash
# Quick task status checker for AG-UI Golang SDK

TASKS_FILE="proompts/tasks.yaml"

if [ ! -f "$TASKS_FILE" ]; then
    echo "Error: $TASKS_FILE not found!"
    exit 1
fi

echo "=== AG-UI Golang SDK Task Status ==="
echo ""

# Count tasks by status
echo "📊 Task Counts:"
echo "- ✅ Completed: $(grep -c "status: completed" "$TASKS_FILE")"
echo "- 🔄 In Progress: $(grep -c "status: in-progress" "$TASKS_FILE")"
echo "- ⏳ Pending: $(grep -c "status: pending" "$TASKS_FILE")"
echo "- 🚫 Blocked: $(grep -c "status: blocked" "$TASKS_FILE")"

echo ""
echo "=== 🔄 In-Progress Tasks ==="
if grep -q "status: in-progress" "$TASKS_FILE"; then
    awk '
    /- id:/ { id = $3 }
    /name:/ { 
        gsub(/"/,"", $0)
        name = substr($0, index($0, $2))
    }
    /status: in-progress/ { 
        print "  • " id " - " name
    }
    ' "$TASKS_FILE"
else
    echo "  No tasks currently in progress"
fi

echo ""
echo "=== ⏳ Next Available Tasks (pending with no dependencies) ==="
# This is a simplified version - actual dependency checking would be more complex
if grep -q "status: pending" "$TASKS_FILE"; then
    awk '
    /- id:/ { 
        id = $3
        has_deps = 0
    }
    /name:/ { 
        gsub(/"/,"", $0)
        name = substr($0, index($0, $2))
    }
    /dependencies: \[.*\]/ {
        if ($0 ~ /\[\]/ || $0 ~ /dependencies: \[\]/) {
            has_deps = 0
        } else {
            has_deps = 1
        }
    }
    /status: pending/ && has_deps == 0 { 
        print "  • " id " - " name
        count++
        if (count >= 5) exit
    }
    ' "$TASKS_FILE"
else
    echo "  No pending tasks found"
fi

echo ""
echo "=== 📈 Current Phase Progress ==="
# Get the current phase (phase with in-progress tasks)
current_phase=$(awk '/status: in-progress/ {getline; while (getline && !/phase:/) continue; if (/phase:/) {gsub(/"/,""); print $2; exit}}' "$TASKS_FILE")

if [ -n "$current_phase" ]; then
    echo "Current Phase: $current_phase"
    
    phase_total=$(awk -v phase="$current_phase" '$0 ~ "phase: \"" phase "\"" {count++} END {print count+0}' "$TASKS_FILE")
    phase_completed=$(awk -v phase="$current_phase" '/status: completed/ {getline; while (getline && !/phase:/) continue; if ($0 ~ "phase: \"" phase "\"") count++} END {print count+0}' "$TASKS_FILE")
    
    if [ "$phase_total" -gt 0 ]; then
        percentage=$((phase_completed * 100 / phase_total))
        echo "Progress: $phase_completed/$phase_total tasks completed ($percentage%)"
    fi
else
    echo "No active phase (no in-progress tasks)"
fi

echo ""
echo "=== 🎯 Quick Commands ==="
echo "To start a task: Update status to 'in-progress' in $TASKS_FILE"
echo "To complete a task: Update status to 'completed' and add update entry"
echo "To check dependencies: Search for task ID in dependencies arrays"

echo ""
echo "Last updated: $(date)" 