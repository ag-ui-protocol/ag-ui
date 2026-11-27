//! Provider-compatible placement of tool results in conversation history.
use crate::types::{Message, Role, ToolCallId};
use std::collections::HashMap;

/// Keep results next to their issuing calls without guessing when reused call
/// IDs make an early result ambiguous. Reasoning stays with the following text.
/// Already adjacent results retain their position and parallel result order.
pub fn keep_tool_results_with_calls(messages: &mut Vec<Message>) {
    #[derive(Clone, Copy)]
    struct Slot {
        issuer: usize,
        answered: bool,
    }
    let mut slots: HashMap<ToolCallId, Vec<Slot>> = HashMap::new();
    let mut detached: HashMap<ToolCallId, Vec<usize>> = HashMap::new();
    let mut early: HashMap<ToolCallId, Vec<usize>> = HashMap::new();
    let mut anchor = None;
    for (index, message) in messages.iter().enumerate() {
        if let Message::Tool { tool_call_id, .. } = message {
            let Some(id_slots) = slots.get_mut(tool_call_id) else {
                early.entry(tool_call_id.clone()).or_default().push(index);
                continue;
            };
            let in_place = id_slots
                .iter_mut()
                .rev()
                .take_while(|slot| Some(slot.issuer) == anchor)
                .filter(|slot| !slot.answered)
                .last();
            if let Some(slot) = in_place {
                slot.answered = true;
            } else {
                detached
                    .entry(tool_call_id.clone())
                    .or_default()
                    .push(index);
            }
        } else if !matches!(message.role(), Role::Activity | Role::Reasoning) {
            anchor = Some(index);
            if let Some(calls) = message.tool_calls() {
                for call in calls {
                    slots.entry(call.id.clone()).or_default().push(Slot {
                        issuer: index,
                        answered: false,
                    });
                }
            }
        }
    }
    let mut owed: HashMap<usize, Vec<usize>> = HashMap::new();
    let mut moved = vec![false; messages.len()];
    for (id, results) in detached {
        let id_slots = slots.get_mut(&id).expect("detached results have a slot");
        let mut cursor = id_slots.len();
        for index in results.into_iter().rev() {
            while cursor > 0
                && (id_slots[cursor - 1].answered || id_slots[cursor - 1].issuer >= index)
            {
                cursor -= 1;
            }
            if cursor == 0 {
                break;
            }
            let slot = &mut id_slots[cursor - 1];
            slot.answered = true;
            owed.entry(slot.issuer).or_default().push(index);
            moved[index] = true;
        }
    }
    for (id, results) in early {
        if let Some(id_slots) = slots.get(&id)
            && id_slots.len() == 1
            && !id_slots[0].answered
        {
            let index = results[0];
            owed.entry(id_slots[0].issuer).or_default().push(index);
            moved[index] = true;
        }
    }
    if owed.is_empty() {
        return;
    }
    for indices in owed.values_mut() {
        indices.sort_unstable();
    }
    fn flush(repaired: &mut Vec<Message>, pending: &mut Option<Vec<usize>>, original: &[Message]) {
        if let Some(indices) = pending.take() {
            let mut at = repaired.len();
            for (index, message) in repaired.iter().enumerate().rev() {
                match message.role() {
                    Role::Reasoning => at = index,
                    Role::Activity => {}
                    _ => break,
                }
            }
            repaired.splice(
                at..at,
                indices.into_iter().map(|index| original[index].clone()),
            );
        }
    }
    let mut repaired = Vec::with_capacity(messages.len());
    let mut pending = None;
    for (index, message) in messages.iter().enumerate() {
        if moved[index] {
            continue;
        }
        if !matches!(
            message.role(),
            Role::Tool | Role::Activity | Role::Reasoning
        ) {
            flush(&mut repaired, &mut pending, messages);
        }
        repaired.push(message.clone());
        if let Some(indices) = owed.remove(&index) {
            pending = Some(indices);
        }
    }
    flush(&mut repaired, &mut pending, messages);
    *messages = repaired;
}
