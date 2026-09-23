// JSON shapes of the server's /api responses (dates arrive as ISO strings).

export type Role = "owner" | "member";

export interface AuthConfig {
  signup: "open" | "invite-only";
  bootstrapped: boolean;
  github: boolean;
}

export interface UserOrg {
  id: string;
  name: string;
  role: Role;
}

export interface Me {
  user: { id: string; email: string; name: string; hasPassword: boolean; githubConnected: boolean };
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
  createdByName: string;
}

export interface InvitePreview {
  orgName: string;
  role: Role;
}
