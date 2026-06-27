type TabId = "chat" | "history" | "templates" | "websearch" | "actions" | "settings";

const STRIP_ITEMS: Array<{ label: string; tab: TabId; icon: () => JSX.Element }> = [
  { label: "Chat",      tab: "chat",      icon: ChatIcon },
  { label: "History",   tab: "history",   icon: HistoryIcon },
  { label: "Templates", tab: "templates", icon: TemplatesIcon },
  { label: "Web",       tab: "websearch", icon: WebIcon },
  { label: "Actions",   tab: "actions",   icon: ActionsIcon },
  { label: "Settings",  tab: "settings",  icon: SettingsIcon },
];

interface Props {
  position: "left" | "right";
  onTabRequest?: (tab: TabId) => void;
}

export function CollapsedStrip({ position, onTabRequest }: Props) {
  const chevron = position === "right" ? "‹" : "›";

  return (
    <div
      onMouseEnter={() => window.sideai?.stripMouseEnter?.()}
      onMouseLeave={() => window.sideai?.stripMouseLeave?.()}
      style={{
        width: "48px",
        height: "100vh",
        background: "var(--panel-bg)",
        borderLeft: position === "right" ? "1px solid var(--panel-border)" : "none",
        borderRight: position === "left" ? "1px solid var(--panel-border)" : "none",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        paddingTop: "12px",
        paddingBottom: "12px",
        gap: "2px",
        userSelect: "none",
        WebkitUserSelect: "none",
        flexShrink: 0,
      }}
    >
      {/* Duck logo mark */}
      <div
        style={{
          width: "32px",
          height: "32px",
          borderRadius: "10px",
          background: "color-mix(in srgb, var(--panel-accent) 15%, transparent)",
          border: "1px solid color-mix(in srgb, var(--panel-accent) 25%, var(--panel-border))",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: "10px",
          color: "var(--panel-accent)",
          flexShrink: 0,
        }}
        title="DuckAI"
      >
        <DuckLogo />
      </div>

      {/* Tab icon buttons */}
      {STRIP_ITEMS.map(({ label, tab, icon: Icon }) => (
        <IconButton
          key={tab}
          label={label}
          onClick={() => onTabRequest?.(tab)}
        >
          <Icon />
        </IconButton>
      ))}

      <div style={{ flex: 1 }} />

      {/* Expand chevron */}
      <button
        title={`Expand DuckAI (⌘⇧A)`}
        onClick={() => onTabRequest?.("chat")}
        style={{
          width: "32px",
          height: "32px",
          borderRadius: "8px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "16px",
          fontWeight: 700,
          color: "var(--panel-accent)",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          transition: "background 120ms",
          lineHeight: 1,
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--panel-surface-hover)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
      >
        {chevron}
      </button>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={label}
      type="button"
      onClick={onClick}
      style={{
        width: "36px",
        height: "36px",
        borderRadius: "10px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: "none",
        color: "var(--panel-muted)",
        transition: "background 120ms, color 120ms",
        cursor: "pointer",
        flexShrink: 0,
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLButtonElement;
        el.style.background = "var(--panel-surface-hover)";
        el.style.color = "var(--panel-text)";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLButtonElement;
        el.style.background = "transparent";
        el.style.color = "var(--panel-muted)";
      }}
    >
      {children}
    </button>
  );
}

function DuckLogo() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <ellipse cx="9" cy="7.5" rx="4" ry="3.5" fill="currentColor" />
      <ellipse cx="5.5" cy="8.5" rx="2.5" ry="2" fill="currentColor" opacity="0.8" />
      <circle cx="10.5" cy="6" r="1" fill="var(--panel-bg)" />
      <path d="M3.5 9.5 L1.5 10 L3.5 10.5 Z" fill="currentColor" opacity="0.9" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path fillRule="evenodd" d="M4.848 2.771A49.144 49.144 0 0 1 12 2.25c2.43 0 4.817.178 7.152.52 1.978.292 3.348 2.024 3.348 3.97v6.02c0 1.946-1.37 3.678-3.348 3.97a48.901 48.901 0 0 1-3.476.383.39.39 0 0 0-.297.17l-2.755 4.133a.75.75 0 0 1-1.248 0l-2.755-4.133a.39.39 0 0 0-.297-.17 48.9 48.9 0 0 1-3.476-.384c-1.978-.29-3.348-2.024-3.348-3.97V6.741c0-1.946 1.37-3.68 3.348-3.97Z" clipRule="evenodd" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path fillRule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25ZM12.75 6a.75.75 0 0 0-1.5 0v6c0 .414.336.75.75.75h4.5a.75.75 0 0 0 0-1.5h-3.75V6Z" clipRule="evenodd" />
    </svg>
  );
}

function TemplatesIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M5.625 1.5c-1.036 0-1.875.84-1.875 1.875v17.25c0 1.035.84 1.875 1.875 1.875h12.75c1.035 0 1.875-.84 1.875-1.875V12.75A3.75 3.75 0 0 0 16.5 9h-1.875a1.875 1.875 0 0 1-1.875-1.875V5.25A3.75 3.75 0 0 0 9 1.5H5.625Z" />
      <path d="M12.971 1.816A5.23 5.23 0 0 1 14.25 5.25v1.875c0 .207.168.375.375.375H16.5a5.23 5.23 0 0 1 3.434 1.279 9.768 9.768 0 0 0-6.963-6.963Z" />
    </svg>
  );
}

function WebIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path fillRule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25ZM6.262 6.072a8.25 8.25 0 1 0 10.562-.766 4.5 4.5 0 0 1-1.318 1.357L14.25 7.5l.165.33a.809.809 0 0 1-1.086 1.085l-.604-.302a1.125 1.125 0 0 0-1.298.21l-.132.131c-.439.44-.439 1.152 0 1.591l.296.296c.256.257.622.374.98.314l1.17-.195c.323-.054.654.036.905.245l1.33 1.108c.32.267.46.694.358 1.1a8.7 8.7 0 0 1-2.288 4.04l-.723.724a1.125 1.125 0 0 1-1.298.21l-.153-.076a1.125 1.125 0 0 1-.622-1.006v-1.089c0-.298-.119-.585-.33-.796l-1.347-1.347a1.125 1.125 0 0 1 .21-1.298L9.75 12l-.06-.06a1.125 1.125 0 0 1 0-1.591l.108-.107a1.125 1.125 0 0 1 1.68.014l.329.33a8.25 8.25 0 0 0-5.545-4.114Z" clipRule="evenodd" />
    </svg>
  );
}

function ActionsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path fillRule="evenodd" d="M14.615 1.595a.75.75 0 0 1 .359.852L12.982 9.75h7.268a.75.75 0 0 1 .548 1.262l-10.5 11.25a.75.75 0 0 1-1.272-.71l1.992-7.302H3.818a.75.75 0 0 1-.548-1.262l10.5-11.25a.75.75 0 0 1 .845-.143Z" clipRule="evenodd" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path fillRule="evenodd" d="M11.078 2.25c-.917 0-1.699.663-1.85 1.567L9.05 4.889c-.02.12-.115.26-.297.348a7.493 7.493 0 0 0-.986.57c-.166.115-.334.126-.45.083L6.3 5.508a1.875 1.875 0 0 0-2.282.819l-.922 1.597a1.875 1.875 0 0 0 .432 2.385l.84.692c.095.078.17.229.154.43a7.598 7.598 0 0 0 0 1.139c.015.2-.059.352-.153.43l-.841.692a1.875 1.875 0 0 0-.432 2.385l.922 1.597a1.875 1.875 0 0 0 2.282.818l1.019-.382c.115-.043.283-.031.45.082.312.214.641.405.985.57.182.088.277.228.297.35l.178 1.071c.151.904.933 1.567 1.85 1.567h1.844c.916 0 1.699-.663 1.85-1.567l.178-1.072c.02-.12.114-.26.297-.349.344-.165.673-.356.985-.57.167-.114.335-.125.45-.082l1.02.382a1.875 1.875 0 0 0 2.28-.819l.923-1.597a1.875 1.875 0 0 0-.432-2.385l-.84-.692c-.095-.078-.17-.229-.154-.43a7.614 7.614 0 0 0 0-1.139c-.016-.2.059-.352.153-.43l.84-.692c.708-.582.891-1.59.433-2.385l-.922-1.597a1.875 1.875 0 0 0-2.282-.818l-1.02.382c-.114.043-.282.031-.449-.083a7.49 7.49 0 0 0-.985-.57c-.183-.087-.277-.227-.297-.348l-.179-1.072a1.875 1.875 0 0 0-1.85-1.567h-1.843ZM12 15.75a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5Z" clipRule="evenodd" />
    </svg>
  );
}
