import type { AppState } from "../shared/types";
import { validateInstructions } from "../agent-instructions/instructions";
export function initialState(
  path: string,
  text: string,
  shell: string,
): AppState {
  return {
    version: 1,
    agents: [],
    messages: [],
    batches: [],
    runs: [],
    tasks: [],
    sequence: 0,
    settings: {
      shell,
      timeoutMs: 120000,
    },
    instructions: { path, text, hash: validateInstructions(text) },
  };
}
