import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { filtersToParams, type TimelineFilters } from "./timelineFilters";
import type {
  ApiKey,
  AuthConfig,
  Invite,
  Me,
  Member,
  Project,
  Range,
  Role,
  TagCount,
  TimelineDetail,
  TimelinePage,
  TimelineSummary,
} from "./types";

export const queryKeys = {
  config: ["auth-config"] as const,
  me: ["me"] as const,
  projects: (orgId: string) => ["orgs", orgId, "projects"] as const,
  keys: (orgId: string, projectId: string) => ["orgs", orgId, "projects", projectId, "keys"] as const,
  members: (orgId: string) => ["orgs", orgId, "members"] as const,
  invites: (orgId: string) => ["orgs", orgId, "invites"] as const,
  timelines: (orgId: string, projectId: string) => ["orgs", orgId, "projects", projectId, "timelines"] as const,
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

function timelinesPath(orgId: string, projectId: string, suffix = "", params?: URLSearchParams): string {
  const query = params?.toString();
  return `/api/orgs/${orgId}/projects/${projectId}/timelines${suffix}${query ? `?${query}` : ""}`;
}

/** The viewer's IANA time zone; the summary cuts days at its midnight. */
export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function useTimelines(orgId: string, projectId: string, filters: TimelineFilters) {
  return useInfiniteQuery({
    queryKey: [...queryKeys.timelines(orgId, projectId), "list", filters],
    queryFn: ({ pageParam }) => {
      const params = filtersToParams(filters);
      if (pageParam) params.set("cursor", pageParam);
      return api<TimelinePage>("GET", timelinesPath(orgId, projectId, "", params));
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

export function useTimelineSummary(orgId: string, projectId: string, filters: TimelineFilters) {
  const timeZone = viewerTimeZone();
  return useQuery({
    queryKey: [...queryKeys.timelines(orgId, projectId), "summary", filters, timeZone],
    queryFn: () => {
      const params = filtersToParams(filters);
      params.set("tz", timeZone);
      return api<TimelineSummary>("GET", timelinesPath(orgId, projectId, "/summary", params));
    },
  });
}

export function useTimelineTags(orgId: string, projectId: string, range: Range) {
  return useQuery({
    queryKey: [...queryKeys.timelines(orgId, projectId), "tags", range],
    queryFn: async () => {
      const params = range === "7d" ? undefined : new URLSearchParams({ range });
      return (await api<{ tags: TagCount[] }>("GET", timelinesPath(orgId, projectId, "/tags", params))).tags;
    },
  });
}

export function useTimeline(orgId: string, projectId: string, timelineId: string) {
  return useQuery({
    queryKey: [...queryKeys.timelines(orgId, projectId), "detail", timelineId],
    queryFn: () => api<TimelineDetail>("GET", timelinesPath(orgId, projectId, `/${timelineId}`)),
  });
}
