import { useCallback, useEffect, useState } from "react";
import type { Action } from "../../../../packages/shared/actions";
import type { Snapshot } from "../../../../packages/shared/types";
export function useRelay() {
  const [state, setState] = useState<Snapshot>();
  const [error, setError] = useState("");
  const perform = useCallback(async (action: Action) => {
    try {
      const result = await window.relay.invoke(action);
      if (!result.ok) {
        setError(result.error ?? "Action failed.");
        return false;
      }
      if (result.data) setState(result.data);
      setError("");
      return true;
    } catch (error) {
      setError(String(error));
      return false;
    }
  }, []);
  useEffect(() => {
    void perform({ type: "snapshot" });
    return window.relay.subscribe(setState);
  }, [perform]);

  return { state, error, perform, dismissError: () => setError("") };
}
