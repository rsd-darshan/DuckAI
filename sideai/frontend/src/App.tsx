import { useEffect, useRef, useState } from "react";
import { useUser } from "@clerk/clerk-react";
import { Panel } from "./components/Panel";
import { CollapsedStrip } from "./components/CollapsedStrip";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Onboarding } from "./components/Onboarding";
import { AuthGate } from "./components/AuthGate";

type TabId = "chat" | "history" | "templates" | "websearch" | "actions" | "settings";

export interface AppShellProps {
  clerkEnabled: boolean;
  isClerkLoaded?: boolean;
}

export function AppShell({ clerkEnabled, isClerkLoaded = true }: AppShellProps) {
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingChecked, setOnboardingChecked] = useState(false);
  const [showAuthGate, setShowAuthGate] = useState(false);
  const [authGateFeature, setAuthGateFeature] = useState<string | undefined>();
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [sidebarPosition, setSidebarPosition] = useState<"left" | "right">("right");
  const pendingTabRef = useRef<TabId | null>(null);
  const [initialTab, setInitialTab] = useState<TabId | undefined>(undefined);

  useEffect(() => {
    const unsub = window.sideai?.onPanelState?.((payload: { collapsed: boolean }) => {
      setPanelCollapsed(payload.collapsed);
      if (!payload.collapsed && pendingTabRef.current) {
        setInitialTab(pendingTabRef.current);
        pendingTabRef.current = null;
      }
    });
    return () => unsub?.();
  }, []);

  useEffect(() => {
    fetch("http://127.0.0.1:8000/api/settings/sidebar_position")
      .then((r) => r.json())
      .then((d) => { if (d.value === "left" || d.value === "right") setSidebarPosition(d.value); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const alreadyOnboarded = localStorage.getItem("sideai_onboarded") === "1";
    if (alreadyOnboarded) {
      setOnboardingChecked(true);
      return;
    }

    const cleanup = window.sideai?.onFirstRun?.((payload) => {
      if (payload?.isFirstRun) setShowOnboarding(true);
      setOnboardingChecked(true);
    });

    if (!window.sideai?.onFirstRun) {
      setShowOnboarding(true);
    }
    setOnboardingChecked(true);
    return () => cleanup?.();
  }, []);

  function handleOnboardingComplete() {
    localStorage.setItem("sideai_onboarded", "1");
    setShowOnboarding(false);
    setOnboardingChecked(true);
  }

  useEffect(() => {
    (window as any).__sideai_requireAuth = (feature?: string) => {
      if (!clerkEnabled) return;
      setAuthGateFeature(feature);
      setShowAuthGate(true);
    };
    return () => { delete (window as any).__sideai_requireAuth; };
  }, [clerkEnabled]);

  function handleStripTabRequest(tab: TabId) {
    pendingTabRef.current = tab;
    setInitialTab(tab);
    setPanelCollapsed(false);
  }

  if (!isClerkLoaded || !onboardingChecked) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-[#0f0f13]">
        <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (showOnboarding) {
    return (
      <ErrorBoundary>
        <Onboarding clerkEnabled={clerkEnabled} onComplete={handleOnboardingComplete} />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      {panelCollapsed && (
        <CollapsedStrip position={sidebarPosition} onTabRequest={handleStripTabRequest} />
      )}
      <main
        className="h-screen w-full flex justify-end bg-panel-bg"
        role="application"
        aria-label="DuckAI"
        style={{ display: panelCollapsed ? "none" : "flex" }}
      >
        <Panel
          initialTab={initialTab}
          onSignInClick={(feature) => {
            if (!clerkEnabled) return;
            setAuthGateFeature(feature);
            setShowAuthGate(true);
          }}
        />
        {showAuthGate && clerkEnabled && (
          <AuthGate feature={authGateFeature} onDismiss={() => setShowAuthGate(false)} />
        )}
      </main>
    </ErrorBoundary>
  );
}

/** Used when Clerk is configured. */
export function AppWithClerk() {
  const { isLoaded } = useUser();
  return <AppShell clerkEnabled isClerkLoaded={isLoaded} />;
}

export default AppShell;
