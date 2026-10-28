import { useEffect, useState } from "react";
export interface PanelLayout {
  left: boolean;
  right: boolean;
  top: boolean;
}
export function usePanelLayout() {
  const [layout, setLayout] = useState<PanelLayout>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem("relay.panelLayout") ?? "null",
      );
      return {
        left: saved?.left === true,
        right: saved?.right === true,
        top: saved?.top === true,
      };
    } catch {
      return { left: false, right: false, top: false };
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("relay.panelLayout", JSON.stringify(layout));
    } catch {}
  }, [layout]);
  const togglePanel = (side: keyof typeof layout) =>
    setLayout((previous) => ({ ...previous, [side]: !previous[side] }));

  return { layout, togglePanel };
}
