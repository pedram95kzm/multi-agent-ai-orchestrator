export type Role = "actor" | "watcher";
export type BatchShell = "bash" | "powershell";
export type Recipient = Role | "operator" | "unknown";
export type ContextCheck = "readable" | "unavailable" | "not-established";
export interface Agent {
  id: string;
  name: string;
  provider: string;
  role: Role;
  conversation: string;
  connected: boolean;
  lastActivity: string;
  lastNumber: number;
  onboarding: "registered" | "packet-sent" | "role-selection" | "ready";
  automation: string;
  briefed: boolean;
  taskId?: string;
  error?: string;
  awaitingResponse?: boolean;
  staged?: boolean;
  manualHandover?: {
    reportId: string;
    responseNumber: number;
    instructionVersion: string;
    deliveryRulesVersion: number;
  };
  contextHealth?: {
    baselineEstablished: boolean;
    status: ContextCheck | "unknown";
    messageId: string;
    checkedAt: string;
    needsOnboarding: boolean;
  };
}
export interface Parsed {
  number?: number;
  sender?: Role | "setup";
  recipient: Recipient;
  summary?: string;
  operatorInput?: string;
  workingDirectory?: string;
  questions: { id: string; text: string }[];
  batches: string[];
  batchShells?: BatchShell[];
  issues: string[];
  approval: boolean;
  contextCheck?: ContextCheck;
  onboardingRole?: Role;
  handover?: boolean;
}
export interface Message {
  id: string;
  sequence: number;
  conversationId: string;
  agentId?: string;
  sender: string;
  recipient: Recipient | string;
  role?: Role;
  type: "response" | "operator" | "onboarding" | "terminal";
  content: string;
  originalCapture?: string;
  originalInput?: string;
  onboardingRole?: Role;
  parsed?: Parsed;
  timestamp: string;
  status: "received" | "pending" | "submitted" | "failed" | "uncertain";
  error?: string;
  taskId?: string;
  instructionVersion: string;
  deliveryRulesVersion?: number;
  purpose?: "handover" | "onboarding";
  handoverRole?: Role;
  replyToId?: string;
  sourceId?: string;
  captureRejected?: boolean;
}
export interface Batch {
  id: string;
  command: string;
  shell?: BatchShell;
  actorId?: string;
  requesterId: string;
  cwd?: string;
  proposalId: string;
  reviewId?: string;
  forwardedId?: string;
  state:
    | "proposed"
    | "reviewed"
    | "ready"
    | "running"
    | "executed"
    | "rejected";
  inspection: boolean;
}
export interface Run {
  id: string;
  batchId: string;
  agentId: string;
  taskId?: string;
  command: string;
  cwd: string;
  started: string;
  finished?: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string;
  status:
    | "running"
    | "completed"
    | "cancelled"
    | "timeout"
    | "interrupted"
    | "failed";
  truncated: boolean;
  logPath: string;
}
export interface Task {
  id: string;
  kind: string;
  title: string;
  operatingSystem?: string;
  created: string;
  onboarding?: {
    role: Role;
    url: string;
    preparerId?: string;
    watcherId?: string; // Earlier versions always requested packets from the Watcher.
    previousAgentId?: string;
    requestId?: string;
    packetId?: string;
    agentId?: string;
    deliveryId?: string;
    error?: string;
  };
}
export interface Settings {
  shell: string;
  timeoutMs: number;
}
export interface AppState {
  version: 1;
  agents: Agent[];
  messages: Message[];
  batches: Batch[];
  runs: Run[];
  tasks: Task[];
  activeTaskId?: string;
  sequence: number;
  settings: Settings;
  instructions: {
    path: string;
    text: string;
    hash: string;
    error?: string;
    changed?: boolean;
  };
}
export interface Snapshot extends AppState {
  chrome?: {
    connected: boolean;
    token: string;
    port: number;
    error?: string;
    extensionPath?: string;
  };
}

export type RegisterAgent = Pick<
  Agent,
  "name" | "role" | "conversation" | "lastNumber" | "automation" | "taskId"
> & { provider: "browser" };
