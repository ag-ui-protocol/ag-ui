import { createReactComponent } from "@copilotkit/a2ui-renderer";
import { FlightCardApi } from "./FlightCardApi";

export const ReactFlightCard = createReactComponent(
  FlightCardApi,
  ({ props }) => {
    const statusColors: Record<string, string> = {
      "On Time": "#22c55e",
      Delayed: "#eab308",
      Cancelled: "#ef4444",
    };
    const dotColor = statusColors[props.status as string] ?? "#22c55e";

    return (
      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: "16px",
          padding: "20px",
          background: "#fff",
          minWidth: 260,
          maxWidth: 340,
          flex: "1 1 260px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        }}
      >
        {/* Header: airline + price */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <img
              src={props.airlineLogo as string}
              alt={props.airline as string}
              style={{ width: 28, height: 28, borderRadius: "50%", objectFit: "contain" }}
            />
            <span style={{ fontWeight: 600, fontSize: "0.95rem" }}>{props.airline as string}</span>
          </div>
          <span style={{ fontWeight: 700, fontSize: "1.15rem", color: "#111" }}>{props.price as string}</span>
        </div>

        {/* Meta: flight number + date */}
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", color: "#6b7280" }}>
          <span>{props.flightNumber as string}</span>
          <span>{props.date as string}</span>
        </div>

        <hr style={{ border: "none", borderTop: "1px solid #f3f4f6", margin: 0 }} />

        {/* Times */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontWeight: 700, fontSize: "1.1rem" }}>{props.departureTime as string}</span>
          <span style={{ fontSize: "0.75rem", color: "#9ca3af" }}>{props.duration as string}</span>
          <span style={{ fontWeight: 700, fontSize: "1.1rem" }}>{props.arrivalTime as string}</span>
        </div>

        {/* Route */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.95rem", fontWeight: 600, color: "#374151" }}>
          <span>{props.origin as string}</span>
          <span style={{ color: "#9ca3af" }}>→</span>
          <span>{props.destination as string}</span>
        </div>

        <hr style={{ border: "none", borderTop: "1px solid #f3f4f6", margin: 0 }} />

        {/* Status */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, display: "inline-block" }} />
          <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>{props.status as string}</span>
        </div>

        {/* Select button */}
        <button
          style={{
            width: "100%",
            padding: "10px",
            borderRadius: "10px",
            border: "1px solid #e5e7eb",
            background: "#fff",
            fontSize: "0.9rem",
            fontWeight: 500,
            cursor: "pointer",
          }}
          onClick={props.action as any}
        >
          Select
        </button>
      </div>
    );
  },
);
