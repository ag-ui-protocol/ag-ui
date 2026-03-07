"use client";
import {
  useAgent,
  useCopilotKit,
  CopilotSidebar,
} from "@copilotkit/react-core/v2";
import { CopilotKit } from "@copilotkit/react-core";
import React, { useState } from "react";
import "@copilotkit/react-core/v2/styles.css";
import "./style.css";

const BOARD_SIZE = 11;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

interface GomokuState {
  board: number[][];
  current_player: number;
  winner?: number | null;
  last_move?: { row: number; col: number } | null;
}

const INITIAL_STATE: GomokuState = {
  board: Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(EMPTY)),
  current_player: BLACK,
  winner: EMPTY,
  last_move: null,
};

const ZEN_QUOTES = [
  "Observe the changes with a calm mind 🍃",
  "A game ends, mind like still water 🪷",
  "Victory and defeat are common, peace of mind is key 🧘‍♂️",
  "Like fallen cherry blossoms, the game concludes 🌸",
  "Wind leaves no trace, but the game's spirit remains 🏯",
  "Meeting through Go, endless zen 🪨",
  "Watching quietly, mind wanders far 🏞️",
];

const USER_MESSAGES = [
  "Stone placed at {row}, {col}. The game flows like water.",
  "Moving to {row}, {col}. Like a leaf in the wind.",
  "Position {row}, {col} chosen. The path reveals itself.",
  "Stone at {row}, {col}. Silence speaks volumes.",
  "Playing {row}, {col}. Each move, a new beginning.",
];

const ZEN_EMOJIS = ["🌸", "🍃", "🪷", "🏯", "🧘‍♂️", "🪨", "🏞️", "🎋", "⛩️"];

export default function GomokuPage({ params }: { params: Promise<{ integrationId: string }> }) {
  const { integrationId } = React.use(params);
  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      agent="gomoku"
    >
      <div className="gomoku-page">
        <GomokuGame />
        <CopilotSidebar
          agentId="gomoku"
          defaultOpen={true}
          labels={{
            modalHeaderTitle: "Gomoku AI Assistant",
          }}
        />
      </div>
    </CopilotKit>
  );
}

function GomokuGame() {
  const { agent } = useAgent({
    agentId: "gomoku",
  });
  const { copilotkit } = useCopilotKit();

  const agentState = (agent.state as GomokuState | undefined) ?? INITIAL_STATE;
  const isLoading = agent.isRunning;

  const [showModal, setShowModal] = useState(false);
  const [zenMsg, setZenMsg] = useState("");
  const [zenEmoji, setZenEmoji] = useState("");
  const [footerQuote] = useState(() => ZEN_QUOTES[Math.floor(Math.random() * ZEN_QUOTES.length)]);

  React.useEffect(() => {
    if (agentState?.winner && !showModal) {
      const msg = ZEN_QUOTES[Math.floor(Math.random() * ZEN_QUOTES.length)];
      const emoji = ZEN_EMOJIS[Math.floor(Math.random() * ZEN_EMOJIS.length)];
      setZenMsg(msg);
      setZenEmoji(emoji);
      setTimeout(() => setShowModal(true), 600);
    }
    if (!agentState?.winner) {
      setShowModal(false);
    }
  }, [agentState?.winner]);

  const handleCellClick = (row: number, col: number) => {
    if (!isLoading && !agentState.winner && agentState.board[row][col] === EMPTY) {
      const newBoard = agentState.board.map((rowArr, r) =>
        rowArr.map((cell, c) => (r === row && c === col ? agentState.current_player : cell)),
      );
      const newState: GomokuState = {
        ...agentState,
        last_move: { row, col },
        board: newBoard,
        current_player: agentState.current_player === BLACK ? WHITE : BLACK,
      };
      agent.setState(newState);

      const randomMessage = USER_MESSAGES[Math.floor(Math.random() * USER_MESSAGES.length)]
        .replace("{row}", row.toString())
        .replace("{col}", col.toString());

      agent.addMessage({
        id: crypto.randomUUID(),
        role: "user",
        content: randomMessage,
      });
      copilotkit.runAgent({ agent });
    }
  };

  const renderCell = (row: number, col: number) => {
    const value = agentState.board[row][col];
    let cellClass = "gomoku-cell";
    if (agentState.last_move && agentState.last_move.row === row && agentState.last_move.col === col) {
      cellClass += " gomoku-last-move";
    }
    return (
      <div
        key={`${row}-${col}`}
        className={cellClass}
        onClick={() => handleCellClick(row, col)}
      >
        {value === BLACK && <span className="gomoku-stone gomoku-black" />}
        {value === WHITE && <span className="gomoku-stone gomoku-white" />}
      </div>
    );
  };

  return (
    <div className="gomoku-zen-container">
      <h2 className="section-title">Gomoku <span className="zen-sakura">🌸</span></h2>
      <div className="gomoku-status">
        {agentState.winner !== EMPTY
          ? `Winner: ${agentState.winner === BLACK ? "Black (You)" : "White (AI)"}`
          : isLoading
            ? "AI is thinking..."
            : `Current Player: ${agentState.current_player === BLACK ? "Black (You)" : "White (AI)"}`}
      </div>
      {showModal && (
        <div className="zen-message">
          <span className="zen-message-emoji">{zenEmoji}</span>
          <span className="zen-message-text">{zenMsg}</span>
        </div>
      )}
      <div className={`gomoku-board-zen${isLoading ? " gomoku-board-loading" : ""}`}>
        {agentState.board.map((rowArr, row) => (
          <div key={row} className="gomoku-row-zen">
            {rowArr.map((_, col) => renderCell(row, col))}
          </div>
        ))}
      </div>
      {agentState.winner !== EMPTY && (
        <button
          className="zen-restart-btn"
          onClick={() => agent.setState(INITIAL_STATE)}
        >
          Play Again 🍵
        </button>
      )}
      <div className="zen-footer">{footerQuote}</div>
    </div>
  );
}
