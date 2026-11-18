import { useEffect, useState } from "react";
import { Link, NavLink, useMatch } from "react-router-dom";
import { pages, routePath, workspaceKey } from "./routes.js";
export default function MainNavigation() {
  const match = useMatch("/:workspace/*");
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  if (!ready) return null;
  const workspace = workspaceKey(match?.params.workspace || "dev");
  return Object.entries(pages).map(
    ([page, [category, label, icon]], index, all) => (
      <div key={page}>
        {(!index || all[index - 1][1][0] !== category) && (
          <p className="eyebrow">{category}</p>
        )}
        <NavLink to={routePath({ workspace, page })} end={page === "overview"}>
          <img className="glyph" src={"/icons/" + icon + ".svg"} alt="" />
          {label}
        </NavLink>
      </div>
    ),
  );
}

export function ConsoleBrand() {
  const match = useMatch("/:workspace/*");
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const workspace = workspaceKey(
    ready ? match?.params.workspace || "dev" : "dev",
  );
  return (
    <Link className="brand" to={routePath({ workspace, page: "overview" })}>
      <img src="/graphene-logo.png" alt="" />
      <span>
        <strong>Graphene</strong>
        <small>Node console</small>
      </span>
    </Link>
  );
}
