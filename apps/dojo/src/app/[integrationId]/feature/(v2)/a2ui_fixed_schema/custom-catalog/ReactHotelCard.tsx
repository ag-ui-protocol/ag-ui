import { createReactComponent } from "@copilotkit/a2ui-renderer";
import { HotelCardApi } from "./HotelCardApi";

export const ReactHotelCard = createReactComponent(
  HotelCardApi,
  ({ props }) => {
    const rating = typeof props.rating === "number" ? props.rating : 0;
    const maxStars = 5;
    const stars = [];
    for (let i = 1; i <= maxStars; i++) {
      if (rating >= i) stars.push("filled");
      else if (rating >= i - 0.5) stars.push("half");
      else stars.push("empty");
    }

    return (
      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: "16px",
          padding: "20px",
          background: "#fff",
          minWidth: 240,
          maxWidth: 320,
          flex: "1 1 240px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        }}
      >
        {/* Hotel name */}
        <span style={{ fontWeight: 700, fontSize: "1.05rem", color: "#111" }}>
          {props.name as string}
        </span>

        {/* Location */}
        <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>
          {props.location as string}
        </span>

        <hr style={{ border: "none", borderTop: "1px solid #f3f4f6", margin: 0 }} />

        {/* Star rating */}
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <span style={{ fontSize: "12px", color: "#666", fontWeight: 500 }}>Guest Rating</span>
          <div style={{ display: "flex", alignItems: "center", gap: "2px" }}>
            {stars.map((type, i) => (
              <span
                key={i}
                style={{ fontSize: "20px", color: type === "empty" ? "#d1d5db" : "#f59e0b", lineHeight: 1 }}
              >
                {type === "empty" ? "☆" : "★"}
              </span>
            ))}
            <span style={{ fontSize: "14px", color: "#374151", fontWeight: 600, marginLeft: "8px" }}>
              {rating.toFixed(1)}
            </span>
          </div>
        </div>

        <hr style={{ border: "none", borderTop: "1px solid #f3f4f6", margin: 0 }} />

        {/* Price */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>per night</span>
          <span style={{ fontWeight: 700, fontSize: "1.15rem", color: "#111" }}>{props.price as string}</span>
        </div>

        {/* Book button */}
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
          Book
        </button>
      </div>
    );
  },
);
