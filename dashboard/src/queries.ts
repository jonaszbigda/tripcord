import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { ApiKey, AuthConfig, Invite, Me, Member, Project, Role } from "./types";

export const queryKeys = {
  config: ["auth-config"] as const,
  me: ["me"] as const,
  projects: (orgId: string) => ["orgs", orgId, "projects"] as const,
  keys: (orgId: string, projectId: string) => ["orgs", orgId, "projects", projectId, "keys"] as const,
  members: (orgId: string) => ["orgs", orgId, "members"] as const,
  invites: (orgId: string) => ["orgs", orgId, "invites"] as const,
};

export function useAuthConfig() {
  return useQuery({ queryKey: queryKeys.config, queryFn: () => api<AuthConfig>("GET", "/api/auth/config") });
}

export function useMe() {
  return useQuery({ queryKey: queryKeys.me, queryFn: () => api<Me>("GET", "/api/me") });
}

export function useProjects(orgId: string) {
  return useQuery({
    queryKey: queryKeys.projects(orgId),
    queryFn: async () => (await api<{ projects: Project[] }>("GET", `/api/orgs/${orgId}/projects`)).projects,
  });
}

export function useKeys(orgId: string, projectId: string) {
  return useQuery({
    queryKey: queryKeys.keys(orgId, projectId),
    queryFn: async () =>
      (await api<{ keys: ApiKey[] }>("GET", `/api/orgs/${orgId}/projects/${projectId}/keys`)).keys,
  });
}

export function useMembers(orgId: string) {
  return useQuery({
    queryKey: queryKeys.members(orgId),
    queryFn: async () => (await api<{ members: Member[] }>("GET", `/api/orgs/${orgId}/members`)).members,
  });
}

/** Pending invites; only owners may list them, so pass `enabled: isOwner`. */
export function useInvites(orgId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.invites(orgId),
    queryFn: async () => (await api<{ invites: Invite[] }>("GET", `/api/orgs/${orgId}/invites`)).invites,
    enabled,
  });
}

/** The current user's role in the org, or undefined if they aren't a member. */
export function useOrgRole(orgId: string): Role | undefined {
  return useMe().data?.orgs.find((org) => org.id === orgId)?.role;
}
