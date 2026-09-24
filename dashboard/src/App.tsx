import { Navigate, Route, Routes } from "react-router";
import { AppShell } from "./components/AppShell";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage";
import { RequireAuth } from "./components/RequireAuth";
import { HomePage } from "./pages/HomePage";
import { InvitePage } from "./pages/InvitePage";
import { LoginPage } from "./pages/LoginPage";
import { MembersPage } from "./pages/MembersPage";
import { NewOrgPage } from "./pages/NewOrgPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OrgLayout } from "./pages/OrgLayout";
import { OrgSettingsPage } from "./pages/OrgSettingsPage";
import { ProjectKeysPage } from "./pages/ProjectKeysPage";
import { ProjectLayout } from "./pages/ProjectLayout";
import { ProjectSettingsPage } from "./pages/ProjectSettingsPage";
import { TimelinesPage } from "./pages/TimelinesPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";
import { SignupPage } from "./pages/SignupPage";
import { TimelinePage } from "./pages/TimelinePage";
import { UserSettingsPage } from "./pages/UserSettingsPage";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/reset-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/invite/:token" element={<InvitePage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<HomePage />} />
          <Route path="orgs/new" element={<NewOrgPage />} />
          <Route path="settings" element={<UserSettingsPage />} />
          <Route path="orgs/:orgId" element={<OrgLayout />}>
            <Route index element={<Navigate to="projects" replace />} />
            <Route path="projects" element={<ProjectsPage />} />
            <Route path="projects/:projectId" element={<ProjectLayout />}>
              <Route index element={<TimelinesPage />} />
              <Route path="keys" element={<ProjectKeysPage />} />
              <Route path="settings" element={<ProjectSettingsPage />} />
            </Route>
            <Route path="projects/:projectId/timelines/:timelineId" element={<TimelinePage />} />
            <Route path="members" element={<MembersPage />} />
            <Route path="settings" element={<OrgSettingsPage />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
