import MainNavigation, { ConsoleBrand } from "./navigation.jsx";
export default function ConsoleLayout() {
  return (
    <>
      <div id="gate" className="gate">
        <section className="surface">
          <img src="/graphene-logo.png" alt="" width="48" />
          <p className="eyebrow">Local workspace</p>
          <h1 id="gate-title">Loading your node console…</h1>
          <p id="gate-status" role="status">
            Restoring your session and loading workspaces.
          </p>
          <div id="gate-help" hidden>
            <p>
              Run the launcher on your node host, then open the private link
              printed in your terminal.
            </p>
            <code>npm start</code>
          </div>
          <p id="gate-error" role="alert"></p>
          <button id="gate-retry" type="button" hidden>
            Retry loading
          </button>
        </section>
      </div>
      <div id="shell" hidden>
        <button id="scrim" aria-label="Close navigation" hidden></button>
        <aside id="sidebar">
          <ConsoleBrand />
          <div className="workspace">
            <label className="eyebrow" htmlFor="network">
              Workspace
            </label>
            <select id="network" aria-label="Deployment stage"></select>
          </div>
          <nav aria-label="Main navigation" id="nav">
            <MainNavigation />
          </nav>
          <footer>
            <div className="local-panel">
              <strong>
                <i className="dot"></i> Local control plane
              </strong>
              <small>
                Node identities and signing history stay on the selected
                deployment host.
              </small>
            </div>
            <div className="footline">
              <span>
                <i className="dot"></i>127.0.0.1
              </span>
              <button id="theme" className="icon" aria-label="Switch theme">
                ☀
              </button>
            </div>
          </footer>
        </aside>
        <div className="workspace-body">
          <header>
            <div>
              <button
                id="menu"
                className="icon"
                aria-expanded="false"
                aria-controls="sidebar"
                aria-label="Open navigation"
              >
                ☰
              </button>
              <span className="muted">Workspace</span>
              <span className="divider">/</span>
              <strong id="crumb"></strong>
            </div>
            <div>
              <span id="stage" className="badge"></span>
              <button
                id="refresh"
                className="icon"
                aria-label="Refresh dashboard"
              >
                <img className="glyph" src="/icons/refresh-cw.svg" alt="" />
              </button>
            </div>
          </header>
          <main>
            <p className="eyebrow" id="category"></p>
            <h1 id="title" tabIndex="-1"></h1>
            <p id="intro"></p>
            <p id="feedback" role="status" hidden></p>
            <div id="content"></div>
          </main>
        </div>
      </div>
      <dialog id="dialog" aria-labelledby="dialog-title">
        <form id="form">
          <div className="dialog-head">
            <p className="eyebrow" id="dialog-category"></p>
            <button
              type="button"
              id="close-dialog"
              className="icon"
              aria-label="Close dialog"
            >
              ×
            </button>
          </div>
          <h2 id="dialog-title"></h2>
          <div id="fields"></div>
          <p id="form-error" role="alert"></p>
          <div className="buttons">
            <button type="button" id="cancel">
              Cancel
            </button>
            <button className="primary" id="submit">
              Continue
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
