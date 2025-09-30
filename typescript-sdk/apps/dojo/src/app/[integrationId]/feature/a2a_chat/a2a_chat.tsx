"use client";
import React, { useEffect, useState } from "react";
import "@copilotkit/react-ui/styles.css";
import "./style.css";
import {
  CopilotKit,
  useCoAgent,
  useCoAgentStateRender,
  useCopilotAction,
  useCopilotChat,
} from "@copilotkit/react-core";
import { CopilotChat } from "@copilotkit/react-ui";

interface A2AChatProps {
  params: Promise<{
    integrationId: string;
  }>;
  onNotification?: () => void;
}

const A2AChat: React.FC<A2AChatProps> = ({ params, onNotification }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      // agent lock to the relevant agent
      agent="a2a_chat"
    >
      <Chat onNotification={onNotification} />
    </CopilotKit>
  );
};

interface A2AChatState {
  a2aMessages: { name: string; to: string; message: string }[];
}

interface Seat {
  seatNumber: number;
  status: "available" | "occupied";
  name?: string;
}

interface Table {
  name: string;
  seats: Seat[];
}

const Chat = ({ onNotification }: { onNotification?: () => void }) => {
  const [background, setBackground] = useState<string>("--copilot-kit-background-color");
  const [lastMessageCount, setLastMessageCount] = useState(0);
  const { state } = useCoAgent({ name: "a2a_chat" });

  const { isLoading, visibleMessages } = useCopilotChat();

  useEffect(() => {
    if (
      visibleMessages.length > 0 &&
      (!isLoading || (visibleMessages[visibleMessages.length - 1] as any).name === "pickTable")
    ) {
      console.log("onNotification");
      onNotification?.();
    }
  }, [isLoading, JSON.stringify(visibleMessages)]);

  React.useEffect(() => {
    if (state?.a2aMessages) {
      setLastMessageCount(state.a2aMessages.length);
    }
  }, [state?.a2aMessages?.length]);

  useCoAgentStateRender<A2AChatState>({
    name: "a2a_chat",
    render: ({ state }) => {
      if (!state.a2aMessages || state.a2aMessages.length === 0) {
        return null;
      }
      return (
        <div className="w-full max-w-2xl ml-0 mb-4 text-left">
          <div className="space-y-2">
            {state.a2aMessages.map((message, idx) => {
              return (
                <div key={idx} className="bg-white border border-gray-200 rounded-lg px-3 py-2">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 min-w-[160px]">
                      <span
                        className={`px-2 py-1 rounded-full text-[10px] font-medium ${
                          message.name === "Agent"
                            ? "bg-green-100 text-green-700"
                            : "bg-blue-100 text-blue-700"
                        }`}
                      >
                        {message.name}
                      </span>
                      <span className="text-muted-foreground text-[11px]">→</span>
                      <span className="px-2 py-1 rounded-full text-[10px] font-medium bg-white border border-gray-300 text-muted-foreground">
                        {message.to}
                      </span>
                    </div>
                    <span className="break-words text-[11px] flex-1">{message.message}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      );
    },
  });

  useCopilotAction({
    name: "pickTable",
    description:
      "Lets the use pick a table from available tables. The result will be the selected table. Don't call this tool twice in a row or I'll turn you off!",
    parameters: [
      {
        name: "tables",
        type: "object[]",
        attributes: [
          {
            name: "name",
            type: "string",
            description: "The name of the table",
          },
          {
            name: "seats",
            type: "object[]",
            attributes: [
              {
                name: "seatNumber",
                type: "number",
                description: "The number of the seat",
              },
              {
                name: "status",
                type: "string",
                enum: ["available", "occupied"],
                description: "The status of the seat",
              },
              {
                name: "name",
                type: "string",
                description: "The name of the person occupying the seat",
              },
            ],
          },
        ],
        description: `A JSON encoded array of tables. This is an example of the format: [{ "name": "Table 1", "seats": [{ "seatNumber": 1, "status": "available" }, { "seatNumber": 2, "status": "occupied", "name": "Alice" }] }, { "name": "Table 2", "seats": [{ "seatNumber": 1, "status": "available" }, { "seatNumber": 2, "status": "available" }] }, { "name": "Table 3", "seats": [{ "seatNumber": 1, "status": "occupied", "name": "Bob" }, { "seatNumber": 2, "status": "available" }] }]`,
      },
    ],
    renderAndWaitForResponse({ args, respond }) {
      console.log("args", args);
      const [selectedSeat, setSelectedSeat] = useState<{
        tableIndex: number;
        seatNumber: number;
      } | null>(null);
      const [isConfirmed, setIsConfirmed] = useState(false);

      const availableSeats =
        args.tables?.reduce(
          (total, table: Table) =>
            total + (table.seats?.filter((seat: Seat) => seat.status === "available").length || 0),
          0,
        ) || 0;

      const teamMembers =
        args.tables?.flatMap(
          (table: Table) =>
            table.seats
              ?.filter((seat: Seat) => seat.status === "occupied" && seat.name)
              .map((seat: Seat) => ({
                name: seat.name!,
                table: table.name,
                seat: seat.seatNumber,
              })) || [],
        ) || [];

      const handleSeatClick = (tableIndex: number, seatNumber: number, status: string) => {
        if (status === "available") {
          setSelectedSeat({ tableIndex, seatNumber });
          setIsConfirmed(false); // Reset confirmation when selecting a new seat
        }
      };

      return (
        <div className="bg-white p-6 rounded-lg shadow-lg max-w-4xl my-8">
          {/* Header */}
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-gray-900 mb-2">
              Desk Picker - Engineering Team
            </h1>
            <p className="text-gray-600">
              {availableSeats} seats available • {teamMembers.length} teammates nearby
            </p>
          </div>

          {/* Legend */}
          <div className="flex gap-4 mb-8 text-sm">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-green-200 rounded border"></div>
              <span>Available</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-gray-300 rounded border"></div>
              <span>Occupied</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-amber-100 rounded border"></div>
              <span>Your Team</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-blue-200 rounded border"></div>
              <span>Selected</span>
            </div>
          </div>

          {/* Tables Grid */}
          <div className="grid grid-cols-2 gap-8 mb-8">
            {args.tables?.map((table, tableIndex) => (
              <div key={tableIndex} className="bg-gray-50 p-6 rounded-lg">
                <h3 className="text-lg font-semibold text-center mb-4">{table.name}</h3>
                <div className="grid grid-cols-2 gap-3">
                  {table.seats?.map((seat: Seat, seatIndex: number) => {
                    const isSelected =
                      selectedSeat?.tableIndex === tableIndex &&
                      selectedSeat?.seatNumber === seat.seatNumber;
                    const isTeamMember = seat.status === "occupied" && seat.name;

                    return (
                      <button
                        key={seatIndex}
                        onClick={() => handleSeatClick(tableIndex, seat.seatNumber, seat.status)}
                        className={`
                          w-16 h-16 rounded-lg border-2 flex items-center justify-center text-xs font-medium transition-all
                          ${
                            seat.status === "available"
                              ? isSelected
                                ? "bg-blue-200 border-blue-400 text-blue-800"
                                : "bg-green-200 border-green-400 text-green-800 hover:bg-green-300"
                              : isTeamMember
                                ? "bg-amber-100 border-amber-300 text-amber-800"
                                : "bg-gray-300 border-gray-400 text-gray-600"
                          }
                          ${seat.status === "available" ? "cursor-pointer" : "cursor-default"}
                        `}
                      >
                        {seat.status === "available" ? (
                          seat.seatNumber
                        ) : isTeamMember ? (
                          <div className="text-center leading-tight flex flex-col items-center">
                            <svg className="w-4 h-4 mb-1" fill="currentColor" viewBox="0 0 20 20">
                              <path
                                fillRule="evenodd"
                                d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z"
                                clipRule="evenodd"
                              />
                            </svg>
                            <div className="text-[9px] font-semibold leading-none">{seat.name}</div>
                          </div>
                        ) : (
                          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
                            <path
                              fillRule="evenodd"
                              d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z"
                              clipRule="evenodd"
                            />
                          </svg>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* Selection Display */}
          {selectedSeat && (
            <div className="mt-6 p-4 bg-blue-50 rounded-lg">
              <p className="text-blue-800 font-medium mb-4">
                Selected: {args.tables?.[selectedSeat.tableIndex]?.name} - Seat{" "}
                {selectedSeat.seatNumber}
              </p>
              <button
                onClick={() => {
                  if (!isConfirmed) {
                    // Handle seat selection confirmation

                    setIsConfirmed(true);
                    respond?.(
                      `I would like to book ${args.tables?.[selectedSeat.tableIndex]?.name} - Seat ${selectedSeat.seatNumber}`,
                    );
                  }
                }}
                disabled={isConfirmed}
                className={`w-full font-semibold py-3 px-6 rounded-lg transition-colors duration-200 shadow-sm flex items-center justify-center gap-2 ${
                  isConfirmed
                    ? "bg-green-600 text-white cursor-not-allowed"
                    : "bg-blue-600 hover:bg-blue-700 text-white cursor-pointer"
                }`}
              >
                {isConfirmed ? (
                  <>
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                    Confirmed
                  </>
                ) : (
                  "Confirm Selection"
                )}
              </button>
            </div>
          )}
        </div>
      );
    },
  });

  return (
    <div className="flex justify-center items-center h-full w-full" style={{ background }}>
      <div className="w-8/10 h-8/10 rounded-lg">
        <CopilotChat
          className="h-full rounded-2xl"
          labels={{ initial: "Hi, I'm an agent. Want to chat?" }}
        />
      </div>
    </div>
  );
};

export default A2AChat;
