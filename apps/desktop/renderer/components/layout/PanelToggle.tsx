export function PanelToggle({
  side,
  collapsed,
  controls,
  onClick,
}: {
  side: "left" | "right" | "top";
  collapsed: boolean;
  controls: string;
  onClick: () => void;
}) {
  const label = `${collapsed ? "Expand" : "Minimize"} ${side} panel`;
  return (
    <button
      type="button"
      className="panel-toggle"
      aria-label={label}
      title={label}
      aria-expanded={!collapsed}
      aria-controls={controls}
      onClick={onClick}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 20 20"
        fill="none"
        aria-hidden="true"
      >
        <rect x="2" y="3" width="16" height="14" rx="2" />
        <path
          d={
            side === "left"
              ? "M7 3v14"
              : side === "right"
                ? "M13 3v14"
                : "M2 8h16"
          }
        />
        {side === "top" ? (
          <path d={collapsed ? "m8 11 2 2 2-2" : "m8 13 2-2 2 2"} />
        ) : (
          <path
            d={
              (side === "left") === collapsed
                ? "m10 7 3 3-3 3"
                : "m11 7-3 3 3 3"
            }
          />
        )}
      </svg>
    </button>
  );
}
