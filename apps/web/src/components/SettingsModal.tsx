import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  List,
  Modal,
  NumberInput,
  PasswordInput,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconAlertTriangle, IconCheck, IconPlugConnected } from "@tabler/icons-react";
import { useState } from "react";
import {
  detectLlm,
  detectOmr,
  llmBaseUrl,
  omrBaseUrl,
  type LlmCapabilities,
  type OmrHealth,
} from "../lib/server";
import { diagnoseRecognition, type Diagnosis } from "../lib/diagnose";
import { useSettings, type Settings, type VisionOverride } from "../lib/settings";

interface CheckResult {
  llm?: LlmCapabilities;
  llmError?: string;
  omr?: OmrHealth;
  omrProblem?: Diagnosis;
}

export function SettingsModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const settings = useSettings();
  const [draft, setDraft] = useState<Settings>(() => pick(settings));
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);

  const set = (changes: Partial<Settings>) => setDraft((d) => ({ ...d, ...changes }));

  async function testConnection() {
    setChecking(true);
    setResult(null);
    const [llm, omr] = await Promise.allSettled([detectLlm(draft), detectOmr(draft)]);
    setResult({
      llm: llm.status === "fulfilled" ? llm.value : undefined,
      llmError: llm.status === "rejected" ? errorText(llm.reason) : undefined,
      omr: omr.status === "fulfilled" ? omr.value : undefined,
      omrProblem: omr.status === "rejected" ? diagnoseRecognition(omr.reason, draft, llm.status === "fulfilled") : undefined,
    });
    setChecking(false);
  }

  function save() {
    settings.update(draft);
    onClose();
  }

  const modelOptions = [
    { value: "", label: "Automatic (first model the server lists)" },
    ...(result?.llm?.models ?? []).map((m) => ({ value: m.id, label: m.id })),
  ];
  if (draft.modelOverride && !modelOptions.some((o) => o.value === draft.modelOverride)) {
    modelOptions.push({ value: draft.modelOverride, label: draft.modelOverride });
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Settings" size="lg">
      <Stack gap="md">
        <TextInput
          label="Server URL"
          description="The address of your gateway, e.g. https://your-machine.your-tailnet.ts.net"
          placeholder="https://…"
          value={draft.serverUrl}
          onChange={(e) => set({ serverUrl: e.currentTarget.value })}
          autoComplete="url"
        />
        <PasswordInput
          label="API key"
          description="Stored only in this browser and sent only to the server above."
          value={draft.apiKey}
          onChange={(e) => set({ apiKey: e.currentTarget.value })}
          autoComplete="off"
        />
        <Group grow>
          <TextInput
            label="Language model path"
            value={draft.llmPath}
            onChange={(e) => set({ llmPath: e.currentTarget.value })}
          />
          <TextInput
            label="Recognition service path"
            value={draft.omrPath}
            onChange={(e) => set({ omrPath: e.currentTarget.value })}
          />
        </Group>
        <Text size="xs" c="dimmed">
          Requests go to {draft.serverUrl ? llmBaseUrl(draft) : "…/v1"} and{" "}
          {draft.serverUrl ? omrBaseUrl(draft) : "…/omr"}.
        </Text>

        <Group>
          <Button
            leftSection={<IconPlugConnected size={16} />}
            variant="light"
            loading={checking}
            onClick={testConnection}
            disabled={!draft.serverUrl.trim()}
          >
            Test connection
          </Button>
        </Group>

        {result && <ConnectionReport result={result} />}

        <Select
          label="Model"
          description="Detected automatically. Pick one only if your server serves several."
          data={modelOptions}
          value={draft.modelOverride}
          onChange={(v) => set({ modelOverride: v ?? "" })}
          allowDeselect={false}
        />
        <Group grow align="flex-start">
          <NumberInput
            label="Context size (tokens)"
            description="Leave empty to use the detected value."
            value={draft.contextOverride ?? ""}
            min={2048}
            step={1024}
            onChange={(v) => set({ contextOverride: typeof v === "number" ? v : null })}
          />
          <Stack gap={4}>
            <Text size="sm" fw={500}>
              Vision (images)
            </Text>
            <SegmentedControl
              value={draft.visionOverride}
              onChange={(v) => set({ visionOverride: v as VisionOverride })}
              data={[
                { value: "auto", label: "Auto" },
                { value: "on", label: "On" },
                { value: "off", label: "Off" },
              ]}
            />
          </Stack>
        </Group>

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save}>Save</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ConnectionReport({ result }: { result: CheckResult }) {
  return (
    <Stack gap="xs">
      {result.llm ? (
        <Alert color="green" icon={<IconCheck size={18} />} title="Language model reachable">
          <Stack gap={4}>
            <Text size="sm">
              Model: <b>{result.llm.model ?? "none listed"}</b>
              {result.llm.models.length > 1 ? ` (${result.llm.models.length} available)` : ""}
            </Text>
            <Group gap="xs">
              <Badge variant="light" color={result.llm.vision ? "green" : "gray"}>
                vision: {result.llm.vision === null ? "unknown" : result.llm.vision ? "yes" : "no"}
              </Badge>
              <Badge variant="light">
                context: {result.llm.contextSize ? `${result.llm.contextSize.toLocaleString()} tokens` : "unknown"}
              </Badge>
            </Group>
            {!result.llm.propsAvailable && (
              <Text size="xs" c="dimmed">
                /props isn't reachable through the gateway, so context size may be unknown. You can set it below.
              </Text>
            )}
          </Stack>
        </Alert>
      ) : (
        <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Language model not reachable">
          <Text size="sm">{result.llmError}</Text>
        </Alert>
      )}
      {result.omr ? (
        <Alert color="green" icon={<IconCheck size={18} />} title="Recognition service reachable">
          <Text size="sm">
            {result.omr.engine
              ? `${result.omr.engine.name} ${result.omr.engine.version ?? ""} on ${result.omr.engine.device ?? "?"}${
                  result.omr.engine.available ? "" : " (engine not installed!)"
                }`
              : "Service is up."}
          </Text>
          {result.omr.secondEngine && (
            <Text size="sm">
              Second reading: {result.omr.secondEngine.name} {result.omr.secondEngine.version ?? ""} on {result.omr.secondEngine.device ?? "?"}
            </Text>
          )}
        </Alert>
      ) : (
        <Alert color="orange" icon={<IconAlertTriangle size={18} />} title="Recognition service not reachable" data-testid="omr-problem">
          <Stack gap={6}>
            <Text size="sm">{result.omrProblem?.cause}</Text>
            <List size="sm" spacing={4}>
              {result.omrProblem?.steps.map((step) => (
                <List.Item key={step}>{step}</List.Item>
              ))}
            </List>
            {result.omrProblem && (
              <>
                <Text size="xs" c="dimmed">
                  To see what your gateway answers, run this anywhere (with your key):
                </Text>
                <Code block style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {result.omrProblem.curl}
                </Code>
              </>
            )}
            <Text size="xs" c="dimmed">
              You can still open MusicXML files; reading PDFs and photos needs this service.
            </Text>
          </Stack>
        </Alert>
      )}
    </Stack>
  );
}

function pick(s: Settings): Settings {
  return {
    serverUrl: s.serverUrl,
    apiKey: s.apiKey,
    llmPath: s.llmPath,
    omrPath: s.omrPath,
    modelOverride: s.modelOverride,
    contextOverride: s.contextOverride,
    visionOverride: s.visionOverride,
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
