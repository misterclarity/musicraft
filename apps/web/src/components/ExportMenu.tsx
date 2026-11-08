import { Button, Checkbox, Group, Menu, Modal, Progress, SegmentedControl, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { prettyName, type Score } from "@musicraft/score-core";
import { IconChevronDown, IconDownload, IconFileTypePdf, IconMusic, IconPackage, IconPrinter } from "@tabler/icons-react";
import { useState } from "react";
import {
  downloadMei,
  downloadMidi,
  downloadMusicXml,
  downloadMxl,
  downloadPartsPdf,
  downloadScorePdf,
  engravePages,
  printPages,
  type PitchMode,
} from "../export/exports";
import { downloadBlob, safeFileName } from "../lib/files";
import { exportProjectFile } from "../lib/projects";
import type { PageSize } from "../render/renderer";

type PdfMode = "score" | "parts" | "print";

export function ExportMenu({ score, name, projectId }: { score: Score; name: string; projectId: string }) {
  const [pdfMode, setPdfMode] = useState<PdfMode | null>(null);
  const safe = (fn: () => unknown) => async () => {
    try {
      await fn();
    } catch (error) {
      notifications.show({ color: "red", title: "Export failed", message: (error as Error).message });
    }
  };
  return (
    <>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <Button size="xs" variant="default" leftSection={<IconDownload size={14} />} rightSection={<IconChevronDown size={12} />}>
            Export
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>Print</Menu.Label>
          <Menu.Item leftSection={<IconFileTypePdf size={14} />} onClick={() => setPdfMode("score")}>
            PDF — full score…
          </Menu.Item>
          <Menu.Item leftSection={<IconFileTypePdf size={14} />} onClick={() => setPdfMode("parts")}>
            PDF — parts…
          </Menu.Item>
          <Menu.Item leftSection={<IconPrinter size={14} />} onClick={() => setPdfMode("print")}>
            Print…
          </Menu.Item>
          <Menu.Label>Files</Menu.Label>
          <Menu.Item leftSection={<IconMusic size={14} />} onClick={safe(() => downloadMusicXml(score, name))}>
            MusicXML (.musicxml)
          </Menu.Item>
          <Menu.Item leftSection={<IconMusic size={14} />} onClick={safe(() => downloadMusicXml(score, `${name} (concert pitch)`, "concert"))}>
            MusicXML in concert pitch
          </Menu.Item>
          <Menu.Item leftSection={<IconMusic size={14} />} onClick={safe(() => downloadMxl(score, name))}>
            Compressed MusicXML (.mxl)
          </Menu.Item>
          <Menu.Item leftSection={<IconMusic size={14} />} onClick={safe(() => downloadMidi(score, name))}>
            MIDI (.mid)
          </Menu.Item>
          <Menu.Item leftSection={<IconMusic size={14} />} onClick={safe(() => downloadMei(score, name))}>
            MEI (.mei)
          </Menu.Item>
          <Menu.Divider />
          <Menu.Item
            leftSection={<IconPackage size={14} />}
            onClick={safe(async () => downloadBlob(await exportProjectFile(projectId), `${safeFileName(name)}.musicraft`))}
          >
            Project file (.musicraft)
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
      {pdfMode && <PdfModal mode={pdfMode} onClose={() => setPdfMode(null)} score={score} name={name} />}
    </>
  );
}

function PdfModal({ mode, onClose, score, name }: { mode: PdfMode; onClose: () => void; score: Score; name: string }) {
  const [pageSize, setPageSize] = useState<PageSize>("a4");
  const [staff, setStaff] = useState(mode === "parts" ? "100" : score.parts.length > 3 ? "70" : "85");
  const [pitch, setPitch] = useState<PitchMode>("written");
  const [partIds, setPartIds] = useState<string[]>(score.parts.map((p) => p.id));
  const [progress, setProgress] = useState<number | null>(null);

  async function run() {
    const layout = { pageSize, staffSize: Number(staff), pitch };
    setProgress(0);
    try {
      const onProgress = (done: number, total: number) => setProgress(Math.round((done / total) * 100));
      if (mode === "score") await downloadScorePdf(score, name, layout, onProgress);
      else if (mode === "parts") await downloadPartsPdf(score, name, layout, partIds, onProgress);
      else await printPages(await engravePages(score, layout), pageSize);
      onClose();
    } catch (error) {
      notifications.show({ color: "red", title: "Export failed", message: (error as Error).message });
      setProgress(null);
    }
  }

  const title = mode === "score" ? "PDF of the full score" : mode === "parts" ? "PDF of the parts" : "Print";
  return (
    <Modal opened onClose={onClose} title={title}>
      <Stack>
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Paper
          </Text>
          <SegmentedControl value={pageSize} onChange={(v) => setPageSize(v as PageSize)} data={[{ value: "a4", label: "A4" }, { value: "letter", label: "Letter" }]} />
        </Stack>
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Staff size
          </Text>
          <SegmentedControl
            value={staff}
            onChange={setStaff}
            data={[
              { value: "60", label: "Tiny" },
              { value: "70", label: "Small" },
              { value: "85", label: "Medium" },
              { value: "100", label: "Large" },
            ]}
          />
        </Stack>
        {mode !== "parts" && (
          <Stack gap={4}>
            <Text size="sm" fw={500}>
              Pitch
            </Text>
            <SegmentedControl
              value={pitch}
              onChange={(v) => setPitch(v as PitchMode)}
              data={[
                { value: "written", label: "Transposed (as players read)" },
                { value: "concert", label: "Concert pitch" },
              ]}
            />
          </Stack>
        )}
        {mode === "parts" && (
          <Stack gap={4}>
            <Text size="sm" fw={500}>
              Parts (each starts on a new page; empty bars become multi-bar rests)
            </Text>
            {score.parts.map((p) => (
              <Checkbox
                key={p.id}
                label={prettyName(p.name)}
                checked={partIds.includes(p.id)}
                onChange={(e) => setPartIds((ids) => (e.currentTarget.checked ? [...ids, p.id] : ids.filter((id) => id !== p.id)))}
              />
            ))}
          </Stack>
        )}
        {mode === "print" && (
          <Text size="xs" c="dimmed">
            Choose "Save as PDF" in the print dialog for a vector PDF.
          </Text>
        )}
        {progress !== null && <Progress value={progress} animated />}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={run} loading={progress !== null} disabled={mode === "parts" && partIds.length === 0}>
            {mode === "print" ? "Print" : "Download PDF"}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
