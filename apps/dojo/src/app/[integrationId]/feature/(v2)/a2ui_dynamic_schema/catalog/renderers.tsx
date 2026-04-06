"use client";

import React from "react";
import { createReactComponent } from "@copilotkit/a2ui-renderer";
import { RowApi, HotelCardApi, ProductCardApi, TeamMemberCardApi } from "./apis";

// ─── Row ─────────────────────────────────────────────────────────────

export const Row = createReactComponent(RowApi, ({ props, buildChild }) => {
  const items = Array.isArray(props.children) ? props.children : [];
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        gap: `${props.gap ?? 24}px`,
        overflowX: "auto",
        width: "100%",
      }}
    >
      {items.map((item: any, i: number) => {
        if (typeof item === "string")
          return <div key={`${item}-${i}`} style={{ flexShrink: 0 }}>{buildChild(item)}</div>;
        if (item && typeof item === "object" && "id" in item)
          return <div key={`${item.id}-${i}`} style={{ flexShrink: 0 }}>{buildChild(item.id, item.basePath)}</div>;
        return null;
      })}
    </div>
  );
});

// ─── Shared styles ───────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
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
};

const btnStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px",
  borderRadius: "10px",
  border: "1px solid #e5e7eb",
  background: "#fff",
  fontSize: "0.85rem",
  fontWeight: 500,
  cursor: "pointer",
};

function Stars({ value, max = 5 }: { value: number; max?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "2px" }}>
      {Array.from({ length: max }, (_, i) => {
        const fill = Math.min(1, Math.max(0, value - i));
        return (
          <svg key={i} width="16" height="16" viewBox="0 0 24 24">
            <path
              d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
              fill="#e5e7eb"
            />
            <defs>
              <clipPath id={`sc-${i}-${value}`}>
                <rect x="0" y="0" width={24 * fill} height="24" />
              </clipPath>
            </defs>
            <path
              d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
              fill="#f59e0b"
              clipPath={`url(#sc-${i}-${value})`}
            />
          </svg>
        );
      })}
      <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "#111", marginLeft: "4px" }}>
        {value.toFixed(1)}
      </span>
    </div>
  );
}

// ─── HotelCard ───────────────────────────────────────────────────────

export const HotelCard = createReactComponent(HotelCardApi, ({ props }) => {
  const rating = typeof props.rating === "number" ? props.rating : 0;
  return (
    <div style={cardStyle}>
      <span style={{ fontWeight: 700, fontSize: "1.05rem", color: "#111" }}>{props.name as string}</span>
      <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>{props.location as string}</span>

      <Stars value={rating} />

      {props.amenities && (
        <span style={{ fontSize: "0.75rem", color: "#9ca3af", lineHeight: 1.4 }}>{props.amenities as string}</span>
      )}

      <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: "12px" }}>
        <hr style={{ border: "none", borderTop: "1px solid #f3f4f6", margin: 0 }} />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>per night</span>
          <span style={{ fontWeight: 700, fontSize: "1.15rem", color: "#111" }}>{props.pricePerNight as string}</span>
        </div>

        <button style={btnStyle} onClick={props.action as any}>Book</button>
      </div>
    </div>
  );
});

// ─── ProductCard ─────────────────────────────────────────────────────

export const ProductCard = createReactComponent(ProductCardApi, ({ props }) => {
  const rating = typeof props.rating === "number" ? props.rating : 0;
  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 700, fontSize: "1rem", color: "#111" }}>{props.name as string}</span>
        {props.badge && (
          <span style={{
            fontSize: "0.65rem", fontWeight: 500, background: "#dbeafe", color: "#1e40af",
            padding: "2px 8px", borderRadius: "9999px", whiteSpace: "nowrap",
          }}>
            {props.badge as string}
          </span>
        )}
      </div>

      <Stars value={rating} />

      {props.description && (
        <span style={{ fontSize: "0.8rem", color: "#6b7280", lineHeight: 1.4 }}>{props.description as string}</span>
      )}

      <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: "12px" }}>
        <hr style={{ border: "none", borderTop: "1px solid #f3f4f6", margin: 0 }} />

        <span style={{ fontWeight: 700, fontSize: "1.15rem", color: "#111" }}>{props.price as string}</span>

        <button style={btnStyle} onClick={props.action as any}>Select</button>
      </div>
    </div>
  );
});

// ─── TeamMemberCard ──────────────────────────────────────────────────

export const TeamMemberCard = createReactComponent(TeamMemberCardApi, ({ props }) => {
  const initials = String(props.name)
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        {props.avatarUrl ? (
          <img
            src={props.avatarUrl as string}
            alt={props.name as string}
            style={{ width: 48, height: 48, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
          />
        ) : (
          <div style={{
            width: 48, height: 48, borderRadius: "50%", background: "#e0e7ff",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontWeight: 600, fontSize: "0.9rem", color: "#4338ca", flexShrink: 0,
          }}>
            {initials}
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          <span style={{ fontWeight: 600, fontSize: "0.95rem", color: "#111" }}>{props.name as string}</span>
          <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>{props.role as string}</span>
        </div>
      </div>

      {props.department && (
        <span style={{
          display: "inline-block", fontSize: "0.7rem", fontWeight: 500,
          background: "#f3f4f6", color: "#374151", padding: "3px 10px",
          borderRadius: "9999px", alignSelf: "flex-start",
        }}>
          {props.department as string}
        </span>
      )}

      {props.email && (
        <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>{props.email as string}</span>
      )}

      <button style={btnStyle} onClick={props.action as any}>Contact</button>
    </div>
  );
});
