import { ActionIcon, AppShell, Group, Title, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconSettings } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import { HomeView } from "./components/HomeView";
import { ProjectView } from "./components/ProjectView";
import { ScanImport } from "./components/ScanImport";
import { SettingsModal } from "./components/SettingsModal";
import { DialogHost } from "./lib/modals";

type Route = { view: "home" } | { view: "project"; id: string };

function parseHash(): Route {
  const match = /^#\/project\/([\w-]+)/.exec(window.location.hash);
  return match ? { view: "project", id: match[1]! } : { view: "home" };
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [settingsOpen, settings] = useDisclosure(false);
  const [scans, setScans] = useState<File[] | null>(null);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const openProject = useCallback((id: string) => {
    window.location.hash = `#/project/${id}`;
  }, []);
  const goHome = useCallback(() => {
    window.location.hash = "#/";
  }, []);

  return (
    <>
      {route.view === "project" ? (
        <ProjectView key={route.id} projectId={route.id} onBack={goHome} onOpenSettings={settings.open} />
      ) : (
        <AppShell header={{ height: 56 }} padding="md">
          <AppShell.Header>
            <Group h="100%" px="md" justify="space-between">
              <Group gap="xs">
                <img src="/icon.svg" alt="" width={28} height={28} />
                <Title order={4}>Musicraft</Title>
              </Group>
              <Tooltip label="Settings">
                <ActionIcon variant="subtle" size="lg" onClick={settings.open} aria-label="Settings">
                  <IconSettings size={20} />
                </ActionIcon>
              </Tooltip>
            </Group>
          </AppShell.Header>
          <AppShell.Main>
            <HomeView onOpenProject={openProject} onScans={setScans} onOpenSettings={settings.open} />
          </AppShell.Main>
        </AppShell>
      )}
      {scans && (
        <ScanImport
          files={scans}
          onClose={() => setScans(null)}
          onDone={(id) => {
            setScans(null);
            openProject(id);
          }}
          onOpenSettings={settings.open}
        />
      )}
      {settingsOpen && <SettingsModal opened={settingsOpen} onClose={settings.close} />}
      <DialogHost />
    </>
  );
}
