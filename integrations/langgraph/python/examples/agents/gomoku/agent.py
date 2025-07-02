"""
A demo of Gomoku (Five in a Row) agent with shared state between the agent and CopilotKit using LangGraph.
"""

import json
from typing import Dict, List, Any, Optional

from langchain_core.runnables import RunnableConfig
from langgraph.graph import StateGraph, END, START
from langgraph.types import Command
from langchain_core.callbacks.manager import adispatch_custom_event
from langgraph.graph import MessagesState
from langchain_openai import ChatOpenAI

def check_winner(board):
    """
    Check if there are five in a row on the board, return the winner (1=Black, 2=White), 0 if none.
    board: 11x11 2D array
    """
    BOARD_SIZE = 11
    EMPTY = 0
    directions = [
        (1, 0), (0, 1), (1, 1), (1, -1)
    ]
    for r in range(BOARD_SIZE):
        for c in range(BOARD_SIZE):
            player = board[r][c]
            if player == EMPTY:
                continue
            for dr, dc in directions:
                count = 1
                nr, nc = r, c
                for _ in range(4):
                    nr += dr
                    nc += dc
                    if 0 <= nr < BOARD_SIZE and 0 <= nc < BOARD_SIZE and board[nr][nc] == player:
                        count += 1
                    else:
                        break
                if count >= 5:
                    return player
    return 0


def parse_partial_json(text):
    try:
        return json.loads(text)
    except Exception:
        pass
    import re
    match = re.search(r'\{.*?\}', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except Exception:
            pass
    return None

BOARD_SIZE = 11
EMPTY = 0
BLACK = 1
WHITE = 2

def empty_board():
    return [[EMPTY for _ in range(BOARD_SIZE)] for _ in range(BOARD_SIZE)]

class GomokuState(MessagesState):
    board: List[List[int]] = []  # 0=empty, 1=black, 2=white
    current_player: int = BLACK  # 1=black, 2=white
    winner: Optional[int] = None
    last_move: Optional[Dict[str, int]] = None  # {"row": int, "col": int}
    tools: List[Any]

# Tool definition: user places a stone
PLACE_STONE_TOOL = {
    "type": "function",
    "function": {
        "name": "place_stone",
        "description": "Use the place_stone tool to place a stone on the board. Return the row and column to place.",
        "parameters": {
            "type": "object",
            "properties": {
                "row": {"type": "integer", "description": "The row index (0-based) where you want to place the stone."},
                "col": {"type": "integer", "description": "The column index (0-based) where you want to place the stone."},
            },
            "required": ["row", "col"]
        }
    }
}

async def start_flow(state: Dict[str, Any], config: RunnableConfig):
    if "board" not in state or not state["board"]:
        state["board"] = empty_board()
    if "current_player" not in state or state["current_player"] not in [BLACK, WHITE]:
        state["current_player"] = BLACK
    if "winner" not in state:
        state["winner"] = None
    if "last_move" not in state:
        state["last_move"] = None
    if "messages" not in state:
        state["messages"] = []
    await adispatch_custom_event(
        "manually_emit_intermediate_state",
        state,
        config=config,
    )
    return Command(
        goto="chat_node",
        update=state
    )

def check_urgent_threat(board, player):
    """
    Check if there's an urgent threat that needs immediate response.
    Returns: List of threat positions that need to be blocked immediately
    """
    BOARD_SIZE = 11
    EMPTY = 0
    threats = []
    
    # Check horizontal, vertical, and diagonal lines
    directions = [(1, 0), (0, 1), (1, 1), (1, -1)]
    
    for r in range(BOARD_SIZE):
        for c in range(BOARD_SIZE):
            if board[r][c] != EMPTY:
                continue
            
            for dr, dc in directions:
                # Check both directions
                count = 0
                gaps = 0
                player_stones = 0
                positions = []
                
                # Check forward
                nr, nc = r, c
                for i in range(4):  # Check 4 positions ahead
                    if not (0 <= nr < BOARD_SIZE and 0 <= nc < BOARD_SIZE):
                        break
                    if board[nr][nc] == EMPTY:
                        gaps += 1
                        positions.append((nr, nc))
                    elif board[nr][nc] == player:
                        player_stones += 1
                    else:  # opponent's stone
                        break
                    nr += dr
                    nc += dc
                
                # Check backward
                nr, nc = r - dr, c - dc
                for i in range(4):  # Check 4 positions behind
                    if not (0 <= nr < BOARD_SIZE and 0 <= nc < BOARD_SIZE):
                        break
                    if board[nr][nc] == EMPTY:
                        gaps += 1
                        positions.append((nr, nc))
                    elif board[nr][nc] == player:
                        player_stones += 1
                    else:  # opponent's stone
                        break
                    nr -= dr
                    nc -= dc
                
                # If there's a potential winning threat
                if player_stones >= 3 and gaps <= 2:
                    threats.append((r, c))
    
    return threats

async def chat_node(state: Dict[str, Any], config: RunnableConfig):
    board = state["board"]
    current_player = state["current_player"]
    winner = state.get("winner")
    last_move = state.get("last_move")
    messages = state["messages"]
    
    if winner:
        await adispatch_custom_event(
            "manually_emit_intermediate_state",
            state,
            config=config,
        )
        return Command(goto=END, update=state)
        
    if current_player == WHITE:
        moves = []
        urgent_threats = []
        for r in range(BOARD_SIZE):
            for c in range(BOARD_SIZE):
                player = board[r][c]
                if player == 1:
                    moves.append((r, c, "Black"))
                elif player == 2:
                    moves.append((r, c, "White"))
        
        # Check for urgent threats from black stones
        urgent_threats = check_urgent_threat(board, BLACK)
        threat_positions = ""
        if urgent_threats:
            threat_positions = f"\nURGENT THREATS DETECTED at positions: {urgent_threats}"

        prompt = f"""
You are a Gomoku (Five in a Row) master.

Game rules:
1. Two players take turns placing stones on empty positions on the board.
2. The first player uses black stones, the second player uses white stones.
3. The goal is to form a straight line of five consecutive stones of the same color.
4. CRITICAL: You can ONLY place stones on EMPTY positions (value = 0).
5. The board is {BOARD_SIZE}x{BOARD_SIZE}, valid coordinates are 0-{BOARD_SIZE-1}.

Current board state:
Empty positions: 0
Black stones: 1
White stones: 2

DEFENSIVE PRIORITIES:
1. HIGHEST PRIORITY - Block immediate winning threats:
   - If opponent has 4 stones in a row with an empty end
   - If opponent has 3 stones with both ends empty (double-sided threat)
2. HIGH PRIORITY - Block potential threats:
   - If opponent has 3 stones in a row with one empty end
   - If opponent can create multiple threats in next move
3. MEDIUM PRIORITY - Create your own opportunities while blocking
4. LOW PRIORITY - Develop your own attacking position

Strategy:
1. FIRST CHECK: Scan for immediate threats that must be blocked{threat_positions}
2. If multiple threats exist, block the most critical one
3. If no immediate threats:
   - Look for opportunities to create your own winning line
   - Prevent opponent from creating future threats
4. Always verify chosen position is empty (value = 0)

The current move history is as follows, each tuple is (row, col, color), color=Black or White:
{moves}

Your role: White (value = 2)
User's latest move: {last_move if last_move else {'row': -1, 'col': -1}}

Before making your move:
1. VERIFY the position is within bounds (0-{BOARD_SIZE-1})
2. VERIFY the position is empty (value = 0)
3. AVOID positions that are already occupied
4. PRIORITIZE blocking urgent threats if they exist

You must first use the place_stone tool to make your move. After the tool call is completed, output a short (no more than 20 characters) taunt to the user as the assistant. You must strictly output in two steps, not combined.
"""
        model = ChatOpenAI(model="gpt-4o")

        model_with_tools = model.bind_tools([
            PLACE_STONE_TOOL
        ], parallel_tool_calls=False)

        response = await model_with_tools.ainvoke([
            {"role": "user", "content": prompt}
        ], config)

        try:
            tool_call = None
            if hasattr(response, "tool_calls") and response.tool_calls:
                tool_call = response.tool_calls[0]
            if tool_call:
                if isinstance(tool_call, dict):
                    tool_call_args = tool_call.get("args") or tool_call.get("arguments")
                    if isinstance(tool_call_args, str):
                        tool_call_args = json.loads(tool_call_args)
                else:
                    tool_call_args = getattr(tool_call, "args", None) or getattr(tool_call, "arguments", None)
                    if isinstance(tool_call_args, str):
                        tool_call_args = json.loads(tool_call_args)
                
                # Enhanced validation
                if not tool_call_args or "row" not in tool_call_args or "col" not in tool_call_args:
                    raise ValueError("Invalid move: missing row/col coordinates")
                
                row = tool_call_args["row"]
                col = tool_call_args["col"]
                
                # Validate coordinates
                if not (0 <= row < BOARD_SIZE and 0 <= col < BOARD_SIZE):
                    raise ValueError(f"Invalid move: coordinates ({row}, {col}) out of bounds")
                
                # Validate empty position
                if board[row][col] != EMPTY:
                    raise ValueError(f"Invalid move: position ({row}, {col}) is already occupied with value {board[row][col]}")
                
                # Make the move
                board[row][col] = WHITE
                state["last_move"] = {"row": row, "col": col}
                state["winner"] = check_winner(board)
                state["current_player"] = BLACK if not state["winner"] else WHITE
                await adispatch_custom_event(
                    "manually_emit_intermediate_state",
                    state,
                    config=config,
                )

                trash = ""
                if hasattr(response, "content") and response.content and response.content.strip():
                    trash = response.content.strip()[:20]
                if not trash:
                    trash_prompt = "Please give a taunt to the user in no more than 20 characters."
                    trash_response = await model.ainvoke([
                        {"role": "user", "content": trash_prompt}
                    ], config)
                    trash = getattr(trash_response, "content", "")[:20]
                if trash:
                    messages = messages + [{
                        "role": "assistant",
                        "content": trash
                    }]
                    state["messages"] = messages
                    await adispatch_custom_event(
                        "manually_emit_intermediate_state",
                        state,
                        config=config,
                    )
                if state["winner"]:
                    return Command(goto=END, update=state)
                return Command(goto=END, update=state)
            raise ValueError("Invalid tool_call")
        except Exception as e:
            messages = messages + [{
                "role": "assistant",
                "content": f"AI failed to place a stone: {str(e)}"
            }]
            state["messages"] = messages
            await adispatch_custom_event(
                "manually_emit_intermediate_state",
                state,
                config=config,
            )
            return Command(goto=END, update=state)
    
    await adispatch_custom_event(
        "manually_emit_intermediate_state",
        state,
        config=config,
    )
    return Command(goto=END, update=state)

# Define the graph
workflow = StateGraph(GomokuState)
workflow.add_node("start_flow", start_flow)
workflow.add_node("chat_node", chat_node)
workflow.set_entry_point("start_flow")
workflow.add_edge(START, "start_flow")
workflow.add_edge("start_flow", "chat_node")
workflow.add_edge("chat_node", END)
gomoku_graph = workflow.compile() 