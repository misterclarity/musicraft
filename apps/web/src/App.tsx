import { ActionIcon, AppShell, Container, Group, Stack, Text, Title, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconSettings } from "@tabler/icons-react";
import { SettingsModal } from "./components/SettingsModal";

export function App() {
  const [settingsOpen, settings] = useDisclosure(false);
  return (
    <AppShell header={{ height: 52 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="xs">
            <img src="/icon.svg" alt="" width={26} height={26} />
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
        <Container size="sm" py="xl">
          <Stack>
            <Title order={2}>Welcome</Title>
            <Text>Open Settings to connect Musicraft to your server.</Text>
          </Stack>
        </Container>
      </AppShell.Main>
      {settingsOpen && <SettingsModal opened={settingsOpen} onClose={settings.close} />}
    </AppShell>
  );
}
