import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Container,
  Group,
  Menu,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconCamera,
  IconCopy,
  IconDots,
  IconDownload,
  IconFileMusic,
  IconFilePlus,
  IconFolderOpen,
  IconPencil,
  IconPlugConnected,
  IconTrash,
  IconUpload,
} from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { downloadBlob, safeFileName } from "../lib/files";
import { importFiles } from "../lib/importFiles";
import { modals } from "../lib/modals";
import {
  createProject,
  deleteProject,
  duplicateProject,
  exportProjectFile,
  listProjects,
  renameProject,
  storageEstimate,
  type ProjectSummary,
} from "../lib/projects";
import { isServerConfigured, useSettings } from "../lib/settings";
import { NewScoreModal } from "./NewScoreModal";

const ACCEPT = ".musicxml,.xml,.mxl,.musicraft,.pdf,image/*";

export function HomeView({
  onOpenProject,
  onScans,
  onOpenSettings,
}: {
  onOpenProject: (id: string) => void;
  onScans: (files: File[]) => void;
  onOpenSettings: () => void;
}) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [newOpen, newScore] = useDisclosure(false);
  const [storage, setStorage] = useState<{ usage: number; quota: number; persisted: boolean }>();
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const settings = useSettings();

  const refresh = useCallback(async () => {
    setProjects(await listProjects());
    setStorage(await storageEstimate());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleFiles(files: File[]) {
    if (!files.length) return;
    setBusy(true);
    try {
      const outcome = await importFiles(files);
      if (outcome.scans) {
        onScans(outcome.scans);
        return;
      }
      if (outcome.warnings.length) {
        notifications.show({
          color: "yellow",
          title: "Opened with notes",
          message: outcome.warnings.slice(0, 3).join(" "),
          autoClose: 12000,
        });
      }
      if (outcome.projectId) onOpenProject(outcome.projectId);
    } catch (error) {
      notifications.show({ color: "red", title: "Couldn't open the file", message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function rename(project: ProjectSummary) {
    const name = await modals.prompt("Rename project", project.name);
    if (name && name !== project.name) {
      await renameProject(project.id, name);
      void refresh();
    }
  }

  async function remove(project: ProjectSummary) {
    if (await modals.confirm(`Delete "${project.name}"?`, "The project and its history are removed from this browser.")) {
      await deleteProject(project.id);
      void refresh();
    }
  }

  async function exportFile(project: ProjectSummary) {
    downloadBlob(await exportProjectFile(project.id), `${safeFileName(project.name)}.musicraft`);
  }

  return (
    <Container size="lg" py="lg">
      <Stack gap="lg">
        <Stack gap={4}>
          <Title order={2}>Your scores</Title>
          <Text c="dimmed">
            Open MusicXML, a PDF or a photo of sheet music, or start a new score. Everything is stored in this browser.
          </Text>
        </Stack>

        {!isServerConfigured(settings) && (
          <Alert icon={<IconPlugConnected size={18} />} title="Connect your server" color="blue" variant="light">
            <Group justify="space-between" align="center">
              <Text size="sm">Reading PDFs and photos and the AI assistant need your server. MusicXML works without it.</Text>
              <Button size="xs" variant="light" onClick={onOpenSettings}>
                Open settings
              </Button>
            </Group>
          </Alert>
        )}

        <Dropzone
          onDrop={handleFiles}
          loading={busy}
          multiple
          accept={{
            "application/vnd.recordare.musicxml+xml": [".musicxml"],
            "application/vnd.recordare.musicxml": [".mxl"],
            "application/xml": [".xml", ".musicxml"],
            "text/xml": [".xml"],
            "application/pdf": [".pdf"],
            "image/*": [],
            "application/zip": [".musicraft"],
            "application/octet-stream": [".musicraft", ".mxl"],
          }}
          data-testid="dropzone"
        >
          <Group justify="center" gap="xl" mih={110} style={{ pointerEvents: "none" }}>
            <Dropzone.Accept>
              <IconUpload size={42} stroke={1.5} />
            </Dropzone.Accept>
            <Dropzone.Reject>
              <IconFileMusic size={42} stroke={1.5} />
            </Dropzone.Reject>
            <Dropzone.Idle>
              <IconFileMusic size={42} stroke={1.5} />
            </Dropzone.Idle>
            <div>
              <Text size="lg" inline>
                Drop sheet music here
              </Text>
              <Text size="sm" c="dimmed" mt={6}>
                MusicXML (.musicxml, .mxl), Musicraft projects, PDFs or photos
              </Text>
            </div>
          </Group>
        </Dropzone>

        <Group>
          <Button leftSection={<IconFolderOpen size={16} />} variant="default" onClick={() => fileInput.current?.click()}>
            Open file…
          </Button>
          <Button leftSection={<IconCamera size={16} />} variant="default" onClick={() => cameraInput.current?.click()}>
            Take photos
          </Button>
          <Button leftSection={<IconFilePlus size={16} />} onClick={newScore.open}>
            New score
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            data-testid="file-input"
            onChange={(e) => {
              void handleFiles(Array.from(e.currentTarget.files ?? []));
              e.currentTarget.value = "";
            }}
          />
          <input
            ref={cameraInput}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.currentTarget.files ?? []);
              e.currentTarget.value = "";
              if (files.length) onScans(files);
            }}
          />
        </Group>

        {projects && projects.length > 0 && (
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
            {projects.map((p) => (
              <Card key={p.id} withBorder padding="md" radius="md" data-testid="project-card">
                <Group justify="space-between" align="flex-start" wrap="nowrap">
                  <Stack gap={4} style={{ minWidth: 0, cursor: "pointer" }} onClick={() => onOpenProject(p.id)}>
                    <Text fw={600} truncate>
                      {p.name}
                    </Text>
                    <Text size="sm" c="dimmed" lineClamp={2}>
                      {p.parts}
                    </Text>
                    <Group gap={6}>
                      <Badge variant="light" size="sm">
                        {p.measures} bars
                      </Badge>
                      {p.source === "scan" && (
                        <Badge variant="light" color="grape" size="sm">
                          scanned
                        </Badge>
                      )}
                      <Text size="xs" c="dimmed">
                        {new Date(p.updatedAt).toLocaleString()}
                      </Text>
                    </Group>
                  </Stack>
                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target>
                      <ActionIcon variant="subtle" aria-label="Project actions">
                        <IconDots size={18} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item leftSection={<IconFolderOpen size={14} />} onClick={() => onOpenProject(p.id)}>
                        Open
                      </Menu.Item>
                      <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => void rename(p)}>
                        Rename
                      </Menu.Item>
                      <Menu.Item
                        leftSection={<IconCopy size={14} />}
                        onClick={async () => {
                          await duplicateProject(p.id);
                          void refresh();
                        }}
                      >
                        Duplicate
                      </Menu.Item>
                      <Menu.Item leftSection={<IconDownload size={14} />} onClick={() => void exportFile(p)}>
                        Save project file
                      </Menu.Item>
                      <Menu.Divider />
                      <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => void remove(p)}>
                        Delete
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </Group>
              </Card>
            ))}
          </SimpleGrid>
        )}
        {projects && projects.length === 0 && (
          <Text c="dimmed" ta="center" py="xl">
            No scores yet.
          </Text>
        )}

        {storage && (
          <Text size="xs" c="dimmed">
            Browser storage: {(storage.usage / 1024 / 1024).toFixed(1)} MB used
            {storage.persisted
              ? " · protected from automatic clean-up"
              : " · may be cleared by the browser if space runs low — save project files as backups"}
            .
          </Text>
        )}
      </Stack>
      {newOpen && (
        <NewScoreModal
          opened={newOpen}
          onClose={newScore.close}
          onCreate={async (name, score) => {
            newScore.close();
            onOpenProject(await createProject(name, score, "new"));
          }}
        />
      )}
    </Container>
  );
}
