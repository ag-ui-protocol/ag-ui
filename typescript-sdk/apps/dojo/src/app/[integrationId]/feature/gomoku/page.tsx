"use client";
import { CopilotKit, useCoAgent, useCopilotChat } from "@copilotkit/react-core";
import { CopilotSidebar } from "@copilotkit/react-ui";
import React, { useState } from "react";
import "@copilotkit/react-ui/styles.css";
import "./style.css";
import { Role, TextMessage } from "@copilotkit/runtime-client-gql";

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
          defaultOpen={true}
          labels={{
            title: "Gomoku AI Assistant",
            initial: "Welcome to Gomoku! Let's play a game.",
          }}
          clickOutsideToClose={false}
        />
      </div>
    </CopilotKit>
  );
}

function GomokuGame() {
  const { state: agentState, setState: setAgentState } = useCoAgent<GomokuState>({
    name: "gomoku",
    initialState: INITIAL_STATE,
  });
  const { appendMessage, isLoading } = useCopilotChat();
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

  if (!agentState) {
    return <div>Loading...</div>;
  }

  const handleCellClick = (row: number, col: number) => {
    if (!isLoading && !agentState.winner && agentState.board[row][col] === EMPTY) {
      setAgentState(prevState => ({
        ...prevState!,
        last_move: { row, col },
        board: prevState!.board.map((rowArr, r) =>
          rowArr.map((_, c) => (r === row && c === col ? prevState!.current_player : _)),
        ),
        current_player: prevState!.current_player === BLACK ? WHITE : BLACK,
      }));

      const randomMessage = USER_MESSAGES[Math.floor(Math.random() * USER_MESSAGES.length)]
        .replace("{row}", row.toString())
        .replace("{col}", col.toString());

      appendMessage(
        new TextMessage({
          content: randomMessage,
          role: Role.User,
        }),
      );
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
          onClick={() => setAgentState(INITIAL_STATE)}
        >
          Play Again 🍵
        </button>
      )}
      <div className="zen-footer">{footerQuote}</div>
    </div>
  );
} 