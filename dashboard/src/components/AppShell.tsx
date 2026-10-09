import { useState } from "react";
import { Link, Outlet, useMatch, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe } from "../queries";
import { Sidebar } from "./Sidebar";
import { Wordmark } from "./ui";

export function AppShell() {
  const me = useMe().data!; // RequireAuth renders this only once "me" has loaded
  const matchedOrgId = useMatch("/orgs/:orgId/*")?.params.orgId;
  const currentOrgId = me.orgs.some((org) => org.id === matchedOrgId) ? matchedOrgId : undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);

  const logout = useMutation({
    mutationFn: () => api<void>("POST", "/api/auth/logout"),
    onSuccess: () => {
      navigate("/login", { replace: true });
      queryClient.clear();
    },
  });

  return (
    <div className="min-h-screen">
      {/* On phones the sidebar is an overlay; this bar holds the way in. */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border/60 bg-bg/80 px-4 py-3 backdrop-blur-xl lg:hidden">
        <button
          type="button"
          aria-label="Open navigation"
          onClick={() => setMenuOpen(true)}
          className="grid size-8 place-items-center rounded-lg border border-border text-muted transition hover:text-fg"
        >
          ☰
        </button>
        <Link to="/" aria-label="Tripcord" className="text-lg">
          <Wordmark />
        </Link>
      </header>

      {menuOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setMenuOpen(false)}
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
        />
      )}

      <Sidebar
        me={me}
        currentOrgId={currentOrgId}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onLogout={() => logout.mutate()}
        loggingOut={logout.isPending}
      />

      <div className="lg:pl-64">
        <main className="mx-auto max-w-6xl px-4 pt-6 pb-10">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
