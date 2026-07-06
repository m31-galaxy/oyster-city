"use client";

import { useState } from "react";

/**
 * Client wrapper that makes the sidebar collapsible. The server component
 * passes the (server-rendered) sidebar content as `children`; this owns the
 * open/closed state and renders the collapsing `<aside>` plus a floating
 * toggle handle that stays visible (and slides) in both states. The aside is
 * an OVERLAY: it slides over the canvas (transform, no layout work) rather
 * than displacing it, and starts collapsed so the map gets the full stage.
 */
export default function CollapsibleSidebar({
  children,
}: {
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(true);

  return (
    <>
      <aside className={collapsed ? "sidebar sidebar--collapsed" : "sidebar"}>
        {/* Fixed-width inner so text doesn't reflow as the aside animates. */}
        <div className="sidebar-content">{children}</div>
      </aside>
      <button
        type="button"
        className={
          collapsed
            ? "sidebar-toggle sidebar-toggle--collapsed"
            : "sidebar-toggle"
        }
        onClick={() => setCollapsed((c) => !c)}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!collapsed}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? "›" : "‹"}
      </button>
    </>
  );
}
