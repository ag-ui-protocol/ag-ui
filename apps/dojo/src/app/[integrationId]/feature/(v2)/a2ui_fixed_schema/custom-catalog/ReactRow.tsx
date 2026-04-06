import { createReactComponent } from "@copilotkit/a2ui-renderer";
import { RowApi } from "./RowApi";

export const ReactRow = createReactComponent(
  RowApi,
  ({ props, buildChild }) => {
    const justifyMap: Record<string, string> = {
      start: "flex-start",
      center: "center",
      end: "flex-end",
      spaceBetween: "space-between",
    };
    const items = Array.isArray(props.children) ? props.children : [];
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          gap: `${props.gap ?? 24}px`,
          alignItems: props.align ?? "stretch",
          justifyContent: justifyMap[props.justify ?? "start"] ?? "flex-start",
          overflowX: "auto",
          width: "100%",
        }}
      >
        {items.map((item: any, i: number) => {
          if (typeof item === "string")
            return (
              <div key={`${item}-${i}`} style={{ flexShrink: 0 }}>
                {buildChild(item)}
              </div>
            );
          if (item && typeof item === "object" && "id" in item)
            return (
              <div key={`${item.id}-${i}`} style={{ flexShrink: 0 }}>
                {buildChild(item.id, item.basePath)}
              </div>
            );
          return null;
        })}
      </div>
    );
  },
);
