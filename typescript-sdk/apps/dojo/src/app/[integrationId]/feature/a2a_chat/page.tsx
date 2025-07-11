"use client";
import React, { useState } from "react";
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
import untruncateJson from "untruncate-json";

interface A2AChatProps {
  params: Promise<{
    integrationId: string;
  }>;
}

const A2AChat: React.FC<A2AChatProps> = ({ params }) => {
  const { integrationId } = React.use(params);

  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${integrationId}`}
      showDevConsole={false}
      // agent lock to the relevant agent
      agent="a2a_chat"
    >
      <Chat />
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

const Chat = () => {
  const [background, setBackground] = useState<string>("--copilot-kit-background-color");
  const [lastMessageCount, setLastMessageCount] = useState(0);
  const { state } = useCoAgent({ name: "a2a_chat" });

  React.useEffect(() => {
    if (state?.a2aMessages) {
      setLastMessageCount(state.a2aMessages.length);
    }
  }, [state?.a2aMessages?.length]);

  useCopilotAction({
    name: "change_background",
    available: "frontend",
    description:
      "Change the background color of the chat. Can be anything that the CSS background attribute accepts. Regular colors, linear of radial gradients etc.",
    parameters: [
      {
        name: "background",
        type: "string",
        description: "The background. Prefer gradients.",
      },
    ],
    handler: ({ background }) => {
      setBackground(background);
    },
  });

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

  // useCopilotAction({
  //   name: "confirmSalary",
  //   description: "Confirm the salary for the employee.",
  //   parameters: [
  //     {
  //       name: "salary",
  //       type: "number",
  //       description: "The salary of the employee.",
  //     },
  //   ],
  //   renderAndWaitForResponse(props) {
  //     const [salary, setSalary] = useState(props.args.salary || 100000);
  //     const [isConfirmed, setIsConfirmed] = useState(false);

  //     const formatCurrency = (amount: number) => {
  //       return new Intl.NumberFormat("en-US", {
  //         style: "currency",
  //         currency: "USD",
  //         minimumFractionDigits: 0,
  //         maximumFractionDigits: 0,
  //       }).format(amount);
  //     };

  //     const handleIncrement = () => {
  //       setSalary((prev) => prev + 10000);
  //     };

  //     const handleDecrement = () => {
  //       setSalary((prev) => Math.max(0, prev - 10000));
  //     };

  //     const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
  //       const value = parseInt(e.target.value) || 0;
  //       setSalary(Math.max(0, value));
  //     };

  //     const handleConfirm = () => {
  //       if (!isConfirmed) {
  //         setIsConfirmed(true);
  //         props.respond?.(formatCurrency(salary));
  //       }
  //     };

  //     return (
  //       <div className="bg-white p-6 rounded-lg shadow-lg max-w-md my-8">
  //         <div className="mb-6">
  //           <h2 className="text-xl font-bold text-gray-900 mb-2">Set Employee Salary</h2>
  //           <p className="text-gray-600">
  //             Adjust the salary using the buttons or enter a custom amount
  //           </p>
  //         </div>

  //         {/* Salary Display */}
  //         <div className="mb-6">
  //           <div className="text-center p-4 bg-gray-50 rounded-lg border-2 border-dashed border-gray-300">
  //             <div className="text-3xl font-bold text-gray-900 mb-2">{formatCurrency(salary)}</div>
  //             <div className="text-sm text-gray-500">Annual Salary</div>
  //           </div>
  //         </div>

  //         {/* Controls */}
  //         <div className="space-y-4 mb-6">
  //           {/* Increment/Decrement Buttons */}
  //           <div className="flex items-center justify-center gap-4">
  //             <button
  //               onClick={handleDecrement}
  //               disabled={salary <= 0 || isConfirmed}
  //               className="flex items-center justify-center w-12 h-12 rounded-full bg-red-100 hover:bg-red-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
  //             >
  //               <svg
  //                 className="w-6 h-6 text-red-600"
  //                 fill="none"
  //                 stroke="currentColor"
  //                 viewBox="0 0 24 24"
  //               >
  //                 <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
  //               </svg>
  //             </button>

  //             <div className="text-center">
  //               <div className="text-sm text-gray-500 mb-1">Adjust by</div>
  //               <div className="text-lg font-semibold text-gray-900">$10,000</div>
  //             </div>

  //             <button
  //               onClick={handleIncrement}
  //               disabled={isConfirmed}
  //               className="flex items-center justify-center w-12 h-12 rounded-full bg-green-100 hover:bg-green-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
  //             >
  //               <svg
  //                 className="w-6 h-6 text-green-600"
  //                 fill="none"
  //                 stroke="currentColor"
  //                 viewBox="0 0 24 24"
  //               >
  //                 <path
  //                   strokeLinecap="round"
  //                   strokeLinejoin="round"
  //                   strokeWidth={2}
  //                   d="M12 6v6m0 0v6m0-6h6m-6 0H6"
  //                 />
  //               </svg>
  //             </button>
  //           </div>

  //           {/* Direct Input */}
  //           <div>
  //             <label className="block text-sm font-medium text-gray-700 mb-2">
  //               Or enter custom amount:
  //             </label>
  //             <div className="relative">
  //               <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
  //                 <span className="text-gray-500 text-lg">$</span>
  //               </div>
  //               <input
  //                 type="number"
  //                 value={salary}
  //                 onChange={handleInputChange}
  //                 disabled={isConfirmed}
  //                 className="block w-full pl-8 pr-3 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed text-lg"
  //                 placeholder="100000"
  //                 min="0"
  //                 step="1000"
  //               />
  //             </div>
  //           </div>
  //         </div>

  //         {/* Confirm Button */}
  //         <button
  //           onClick={handleConfirm}
  //           disabled={isConfirmed}
  //           className={`w-full font-semibold py-3 px-6 rounded-lg transition-colors duration-200 shadow-sm flex items-center justify-center gap-2 ${
  //             isConfirmed
  //               ? "bg-green-600 text-white cursor-not-allowed"
  //               : "bg-blue-600 hover:bg-blue-700 text-white cursor-pointer"
  //           }`}
  //         >
  //           {isConfirmed ? (
  //             <>
  //               <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
  //                 <path
  //                   fillRule="evenodd"
  //                   d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
  //                   clipRule="evenodd"
  //                 />
  //               </svg>
  //               Confirmed
  //             </>
  //           ) : (
  //             "Confirm Salary"
  //           )}
  //         </button>
  //       </div>
  //     );
  //   },
  // });

  useCopilotAction({
    name: "pickTable",
    description: "Lets the use pick a table from available tables.",
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
