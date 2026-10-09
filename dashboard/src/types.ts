// JSON shapes of the server's /api responses (dates arrive as ISO strings).

export type Role = "owner" | "member";

export interface AuthConfig {
  signup: "open" | "invite-only";
  bootstrapped: boolean;
  github: boolean;
  passwordReset: boolean;
  emailVerification: boolean;
}

export interface UserOrg {
  id: string;
  name: string;
  role: Role;
}

export interface Me {
  user: {
    id: string;
    email: string;
    name: string;
    hasPassword: boolean;
    githubConnected: boolean;
    /** False only while the server requires verification and it hasn't happened. */
    emailVerified: boolean;
  };
  orgs: UserOrg[];
}

export interface Project {
  id: string;
  orgId: string;
  name: string;
  createdAt: string;
  activeKeyCount: number;
}

export interface CreatedProject {
  project: Omit<Project, "activeKeyCount">;
  key: string;
}

export interface ApiKey {
  id: string;
  projectId: string;
  prefix: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface CreatedApiKey {
  apiKey: ApiKey;
  key: string;
}

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: string;
}

export interface Invite {
  id: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
  /** null once the creator has deleted their account. */
  createdByName: string | null;
}

export interface InvitePreview {
  /** null for a signup invite, which creates a new account with its own org. */
  orgName: string | null;
  role: Role;
}

export type ReasonType = "error" | "unhandledrejection" | "manual";
export type Range = "24h" | "7d" | "30d";

export interface SessionRow {
  sessionId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  reasonTypes: ReasonType[];
  url: string | null;
  tags: string[];
  eventCount: number;
  captureCount: number;
}

export interface SessionPage {
  sessions: SessionRow[];
  nextCursor: string | null;
}

export interface VolumeBucket {
  start: string;
  error: number;
  unhandledrejection: number;
  manual: number;
}

export interface TopReason {
  key: string;
  type: ReasonType;
  name: string | null;
  message: string | null;
  count: number;
  lastSeen: string;
}

export interface TimelineSummary {
  projectHasTimelines: boolean;
  bucket: "hour" | "day";
  buckets: VolumeBucket[];
  topReasons: TopReason[];
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface TimelineEvent {
  id?: string;
  source?: string;
  timestamp: number;
  type: "custom" | "error" | "unhandledrejection" | "trace";
  name: string;
  data?: Record<string, unknown>;
}

export interface SessionCapture {
  id: string;
  receivedAt: string;
  occurredAt: string;
  reasonType: ReasonType;
  reason: { type: ReasonType; name?: string; message?: string; data?: Record<string, unknown> };
  meta: { url: string; userAgent: string; capturedAt: number };
  tags: string[];
}

export interface SessionDetail {
  session: {
    sessionId: string;
    firstSeenAt: string;
    lastSeenAt: string;
    url: string | null;
    tags: string[];
    events: TimelineEvent[];
  };
  captures: SessionCapture[];
}
