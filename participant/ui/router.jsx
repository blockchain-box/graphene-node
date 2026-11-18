import { useEffect, useLayoutEffect } from "react";
import { hydrateRoot } from "react-dom/client";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import ConsoleLayout from "./layout.jsx";
import {
  connectRouter,
  routePath,
  workspaceKey,
  publicWorkspaces,
  routeDefinitions,
} from "./routes.js";
function RouteController({ page }) {
  const params = useParams(),
    navigate = useNavigate(),
    location = useLocation();
  const valid =
    !params.workspace ||
    publicWorkspaces.includes(params.workspace) ||
    /^[a-f0-9]{64}$/.test(params.workspace);
  useLayoutEffect(() => {
    if (valid)
      connectRouter(
        {
          page,
          workspace: workspaceKey(params.workspace),
          node: params.node,
          step: params.step,
          tab: params.tab,
          run: params.run,
        },
        navigate,
      );
  }, [
    page,
    params.workspace,
    params.node,
    params.step,
    params.tab,
    params.run,
    location.key,
    navigate,
    valid,
  ]);
  return valid ? null : (
    <Navigate to={"/dev/overview" + location.hash} replace />
  );
}
function EntryRoute() {
  const location = useLocation();
  // Accept old bookmarks once; all generated navigation uses path routes.
  const legacy = new URLSearchParams(location.search);
  if (legacy.has("page") || legacy.has("network"))
    return (
      <Navigate
        replace
        to={
          routePath({
            workspace: legacy.get("network"),
            page: legacy.get("page") || "overview",
            node: legacy.get("node"),
            step: legacy.get("step"),
            tab: legacy.get("tab"),
            run: legacy.get("run"),
          }) + location.hash
        }
      />
    );
  return <RouteController page={null} />;
}
function ConsoleApp() {
  useEffect(() => {
    import("./app.js").catch((error) => {
      document.getElementById("gate-title").textContent =
        "Unable to load the console";
      document.getElementById("gate-error").textContent = error.message;
    });
  }, []);
  return (
    <>
      <ConsoleLayout />
      <Routes>
        <Route path="/" element={<EntryRoute />} />
        <Route
          path="/:workspace"
          element={<RouteController page="overview" />}
        />
        {routeDefinitions.map(([page, path]) => (
          <Route
            key={page}
            path={path}
            element={<RouteController page={page} />}
          />
        ))}
        <Route path="*" element={<Navigate replace to="/dev/overview" />} />
      </Routes>
    </>
  );
}
hydrateRoot(
  document.getElementById("console-root"),
  <BrowserRouter>
    <ConsoleApp />
  </BrowserRouter>,
);
