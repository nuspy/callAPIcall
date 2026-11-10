import { useEffect, useState } from "react";
import { Sidebar, SECTIONS_CONFIG, type SidebarSection } from "./components/Sidebar";
import { initBridgeApi } from "./lib/api/bridgeApi";
import { useStatusStore } from "./stores/statusStore";

export default function App() {
  const [activeSection, setActiveSection] = useState<SidebarSection>("session");
  const [ready, setReady] = useState(false);
  const startPolling = useStatusStore((s) => s.startPolling);
  const stopPolling = useStatusStore((s) => s.stopPolling);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await initBridgeApi(); // legge host/porta/token da config.json via Tauri
      if (cancelled) return;
      setReady(true);
      startPolling();
    })();
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [startPolling, stopPolling]);

  const ActiveComponent = SECTIONS_CONFIG[activeSection].component;

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar activeSection={activeSection} onSectionChange={setActiveSection} />
      <main className="flex-1 overflow-y-auto p-6">
        {ready ? (
          <ActiveComponent />
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="w-8 h-8 border-2 border-logo-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </main>
    </div>
  );
}
