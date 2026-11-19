import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Chip,
  Group,
  Image,
  Loader,
  Modal,
  Progress,
  Select,
  SimpleGrid,
  Stack,
  Stepper,
  Text,
  TextInput,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  addScannedPart,
  aiBarLabels,
  checkScore,
  getInstrument,
  markPickup,
  matchInstrument,
  mergeScores,
  prettyName,
  repairRecognized,
  type Issue,
  type Score,
} from "@musicraft/score-core";
import {
  IconArrowDown,
  IconArrowUp,
  IconCrop,
  IconDownload,
  IconPhotoPlus,
  IconPlugConnected,
  IconRotate,
  IconRotateClockwise,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PageRecognition, PageRecord } from "../lib/db";
import { baseName, detectKind, downloadText, safeFileName } from "../lib/files";
import { deleteJob, detectCorners, getJob, getPageImage, startJob, type Corners, type OmrJob } from "../lib/omr";
import { openPdf } from "../lib/pdfPages";
import { createProject } from "../lib/projects";
import { readPage, type Reading } from "../lib/readings";
import { detectOmr, type OmrEngineInfo } from "../lib/server";
import { getSettings, isServerConfigured } from "../lib/settings";
import { CornerEditor } from "./CornerEditor";
import { instrumentOptions } from "./NewScoreModal";
import { Tip } from "./Tip";
import { unavailable } from "./unavailable";

interface PageItem {
  key: string;
  file: number;
  pdfPage?: number;
  label: string;
  thumb?: string;
  photo: boolean;
  corners?: Corners;
  detecting?: boolean;
  rotation: number;
  include: boolean;
}

interface Result {
  score: Score;
  pages: Omit<PageRecord, "id" | "projectId">[];
  issues: Issue[];
  failed: { index: number; error: string }[];
  warnings: string[];
  /** What was corrected automatically after recognition. */
  repairs: string[];
  /** What the recognition service returned for each page, for diagnosing recognition problems. */
  raw: { name: string; musicxml: string }[];
  /** Which reading of each page was kept, when every page was read twice. */
  readings: string[];
  /** The score before the automatic corrections, kept in the project's history. */
  unrepaired: Score;
}

const QUICK = ["piano", "trumpet-bb", "cornet-bb", "horn-f", "trombone", "tuba", "clarinet-bb", "alto-sax", "flute", "voice"];

/** A part scanned on its own, ready to join a score: the score with it, and its pages. */
export interface ScannedPart {
  score: Score;
  pages: Omit<PageRecord, "id" | "projectId" | "index">[];
  label: string;
}

export function ScanImport({
  files: initialFiles,
  onClose,
  onDone,
  onOpenSettings,
  addTo,
  onAddPart,
}: {
  files: File[];
  onClose: () => void;
  onDone: (projectId: string) => void;
  onOpenSettings: () => void;
  /** Read a part printed on its own and add it to this score, instead of making a new project. */
  addTo?: { name: string; score: Score };
  onAddPart?: (part: ScannedPart) => Promise<void>;
}) {
  const mobile = useMediaQuery("(max-width: 48em)");
  const settings = getSettings();
  const configured = isServerConfigured(settings);
  const [files, setFiles] = useState<File[]>(initialFiles);
  const [items, setItems] = useState<PageItem[]>([]);
  const [loadingPages, setLoadingPages] = useState(true);
  const [step, setStep] = useState(0);
  const [editing, setEditing] = useState<PageItem | null>(null);
  const guess = matchInstrument(baseName(initialFiles[0]?.name ?? ""))?.id;
  const [instrument, setInstrument] = useState(guess ?? "piano");
  const [title, setTitle] = useState(baseName(initialFiles[0]?.name ?? "Scanned score"));
  const [titleEdited, setTitleEdited] = useState(false);
  const [job, setJob] = useState<OmrJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [saving, setSaving] = useState(false);
  // A second homr on the server can read every page again; the better reading of each page is kept.
  const [secondEngine, setSecondEngine] = useState<OmrEngineInfo | null>(null);
  const [readTwice, setReadTwice] = useState(true);
  // Adding a part: the score's bar its first bar goes to.
  const [startBar, setStartBar] = useState(0);
  const cancelled = useRef(false);
  const addInput = useRef<HTMLInputElement>(null);
  const objectUrls = useRef<string[]>([]);

  // Expand the files into pages with thumbnails; detect page corners of photos.
  async function addFiles(newFiles: File[], offset: number) {
    const added: PageItem[] = [];
    for (let i = 0; i < newFiles.length; i++) {
      const file = newFiles[i]!;
      const index = offset + i;
      if (detectKind(file) === "pdf") {
        try {
          const pdf = await openPdf(file);
          for (let p = 0; p < pdf.pageCount; p++) {
            added.push({ key: `${index}-${p}`, file: index, pdfPage: p, label: `${file.name} · page ${p + 1}`, photo: false, rotation: 0, include: true });
          }
          void (async () => {
            for (let p = 0; p < pdf.pageCount; p++) {
              const thumb = await pdf.thumbnail(p);
              setItems((list) => list.map((it) => (it.key === `${index}-${p}` ? { ...it, thumb } : it)));
            }
            pdf.destroy();
          })();
        } catch {
          setError(`"${file.name}" could not be opened as a PDF.`);
        }
      } else {
        const url = URL.createObjectURL(file);
        objectUrls.current.push(url);
        added.push({ key: `${index}`, file: index, label: file.name, thumb: url, photo: true, rotation: 0, include: true, detecting: configured });
        if (configured) {
          void detectCorners(settings, file)
            .then((found) => {
              setItems((list) =>
                list.map((it) =>
                  it.key === `${index}` ? { ...it, detecting: false, corners: found.corners && found.confidence > 0.3 ? found.corners : undefined } : it,
                ),
              );
            })
            .catch(() => setItems((list) => list.map((it) => (it.key === `${index}` ? { ...it, detecting: false } : it))));
        }
      }
    }
    setItems((list) => [...list, ...added]);
  }

  useEffect(() => {
    if (!configured) return;
    const controller = new AbortController();
    detectOmr(settings, controller.signal)
      .then((health) => setSecondEngine(health.secondEngine?.available ? health.secondEngine : null))
      .catch(() => setSecondEngine(null));
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void addFiles(initialFiles, 0).finally(() => setLoadingPages(false));
    const urls = objectUrls.current;
    return () => {
      cancelled.current = true;
      for (const url of urls) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = items.filter((it) => it.include);

  function update(key: string, change: Partial<PageItem>) {
    setItems((list) => list.map((it) => (it.key === key ? { ...it, ...change } : it)));
  }

  function moveItem(key: string, delta: number) {
    setItems((list) => {
      const index = list.findIndex((it) => it.key === key);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= list.length) return list;
      const copy = [...list];
      [copy[index], copy[target]] = [copy[target]!, copy[index]!];
      return copy;
    });
  }

  async function recognise() {
    setStep(2);
    setError(null);
    setResult(null);
    cancelled.current = false;
    try {
      let current = await startJob(
        settings,
        files,
        selected.map((it) => ({ file: it.file, page: it.pdfPage ?? 0, corners: it.corners, rotation: it.rotation })),
        { second: readTwice && !!secondEngine },
      );
      setJob(current);
      while (!["done", "failed", "canceled"].includes(current.status)) {
        await new Promise((r) => setTimeout(r, 1500));
        if (cancelled.current) {
          await deleteJob(settings, current.id);
          return;
        }
        current = await getJob(settings, current.id);
        setJob(current);
      }
      if (current.status !== "done") throw new Error(current.error ?? "Recognition did not finish.");
      const built = await buildResult(current);
      setResult(built);
      setTitle(built.score.meta.title);
      void deleteJob(settings, current.id);
      setStep(3);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function buildResult(done: OmrJob): Promise<Result> {
    const scores: Score[] = [];
    const layouts: {
      page: number;
      staffs: OmrJob["pages"][number]["staffs"];
      systemStarts: number[];
      notePositions: Record<string, { x: number; y: number }>;
      staves: number;
      recognition?: PageRecognition;
    }[] = [];
    const failed: Result["failed"] = [];
    const warnings = new Set<string>();
    const raw: Result["raw"] = [];
    const readings: string[] = [];
    if (done.secondError) warnings.add(`${done.secondError} The first reading was used.`);
    for (const page of done.pages) {
      if (page.status !== "done" || !page.musicxml) {
        failed.push({ index: page.index, error: page.error ?? "No music recognised." });
        continue;
      }
      const name = selected[page.index]?.label ?? `Page ${page.index + 1}`;
      const candidates: Reading[] = [{ readBy: page.readBy, musicxml: page.musicxml, staffs: page.staffs }];
      if (page.alternative) candidates.push(page.alternative);
      for (const reading of candidates) {
        raw.push({ name: candidates.length > 1 && reading.readBy ? `${name} (${reading.readBy})` : name, musicxml: reading.musicxml });
      }
      try {
        const { imported, staffs, lineEngines, disagreements, note } = readPage(candidates, instrument, name);
        if (note) readings.push(note);
        imported.warnings.filter((w) => !w.includes("4/4")).forEach((w) => warnings.add(w));
        if (imported.warnings.some((w) => w.includes("4/4")) && page.index === done.pages[0]?.index) {
          warnings.add("No time signature was printed on the first page, so 4/4 was assumed. Change it if needed.");
        }
        scores.push(imported.score);
        layouts.push({
          page: page.index,
          staffs,
          systemStarts: imported.systemStarts,
          notePositions: imported.imagePositions,
          // homr reports either one box per staff or one per system (grand staff): use the ratio.
          staves: Math.max(1, Math.round(staffs.length / Math.max(1, imported.systemStarts.length))),
          ...(candidates.length > 1 ? { recognition: { lineEngines, disagreements } } : {}),
        });
      } catch (e) {
        failed.push({ index: page.index, error: (e as Error).message });
      }
    }
    if (!scores.length) throw new Error(failed[0]?.error ?? "No music was recognised.");
    const merged = mergeScores(scores);
    const repaired = repairRecognized(merged.score);
    const score = markPickup(repaired.score);
    const recognisedTitle = score.meta.title && score.meta.title !== "Untitled" && score.meta.title !== "Recognised page" ? score.meta.title : null;
    const finalTitle = titleEdited || !recognisedTitle ? title.trim() || "Scanned score" : recognisedTitle;
    const named = { ...score, meta: { ...score.meta, title: finalTitle } };
    const unrepaired = markPickup(merged.score);
    const pages: Result["pages"] = [];
    for (let i = 0; i < layouts.length; i++) {
      const layout = layouts[i]!;
      const info = done.pages[layout.page]!;
      const blob = await getPageImage(settings, done.id, layout.page);
      pages.push({
        index: i,
        name: selected[layout.page]?.label ?? `Page ${layout.page + 1}`,
        blob,
        width: info.width,
        height: info.height,
        layout: {
          staffs: layout.staffs,
          staffsPerSystem: layout.staves,
          measureRange: merged.ranges[i],
          systemStarts: layout.systemStarts,
          // Bars keep their ids through the repairs, so look them up where the page put them.
          systemStartIds: layout.systemStarts
            .map((relative) => merged.score.measures[(merged.ranges[i]?.[0] ?? 0) + relative]?.id)
            .filter((id): id is string => !!id),
          notePositions: layout.notePositions,
        },
        ...(layout.recognition ? { recognition: layout.recognition } : {}),
      });
    }
    return {
      score: named,
      pages,
      issues: checkScore(named, { comfortableRange: false }),
      failed,
      warnings: [...warnings],
      repairs: repaired.notes,
      raw,
      readings,
      unrepaired: { ...unrepaired, meta: { ...unrepaired.meta, title: finalTitle } },
    };
  }

  async function open() {
    if (!result) return;
    setSaving(true);
    try {
      const name = title.trim() || "Scanned score";
      const score = { ...result.score, meta: { ...result.score.meta, title: name } };
      // The reading before the automatic corrections stays in the history, to go back to.
      const before = result.repairs.length
        ? { score: { ...result.unrepaired, meta: { ...result.unrepaired.meta, title: name } }, label: "Recognised from scan, before automatic corrections" }
        : undefined;
      const id = await createProject(name, score, "scan", result.pages, before && "Corrected automatically", before);
      onDone(id);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  // How the part lines up with the score it joins. It is named after the instrument chosen, unless
  // the name printed on the page is that instrument's (e.g. "Horn 2 in F").
  const joined = useMemo(() => {
    if (!addTo || !result) return null;
    const chosen = getInstrument(instrument);
    const parts = result.score.parts.map((p) => (matchInstrument(p.name)?.id === chosen.id ? p : { ...p, name: chosen.name, abbreviation: chosen.abbreviation }));
    return addScannedPart(addTo.score, { ...result.score, parts }, { at: startBar });
  }, [addTo, result, startBar, instrument]);
  const barLabels = useMemo(() => (addTo ? aiBarLabels(addTo.score).map((label, i) => ({ value: String(i), label: `Bar ${label}` })) : []), [addTo]);

  async function addPart() {
    if (!result || !joined || !onAddPart) return;
    setSaving(true);
    try {
      // The pages' lines and disagreements follow the bars to where they are in the score now.
      const idOf = new Map(result.score.measures.map((m, j) => [m.id, joined.measureIds[j]!]));
      const partId = joined.partIds[0]!;
      const pages = result.pages.map(({ index: _index, ...page }) => ({
        ...page,
        partId,
        ...(page.layout
          ? {
              layout: {
                ...page.layout,
                ...(page.layout.measureRange ? { measureRange: [page.layout.measureRange[0] + startBar, page.layout.measureRange[1] + startBar] as [number, number] } : {}),
                ...(page.layout.systemStartIds ? { systemStartIds: page.layout.systemStartIds.map((id) => idOf.get(id) ?? id) } : {}),
              },
            }
          : {}),
        ...(page.recognition
          ? { recognition: { ...page.recognition, disagreements: page.recognition.disagreements.map((d) => ({ ...d, measureId: idOf.get(d.measureId) ?? d.measureId })) } }
          : {}),
      }));
      const name = joined.score.parts.find((p) => p.id === partId)?.name ?? prettyName(getInstrument(instrument).name);
      await onAddPart({ score: joined.score, pages, label: `Added the ${name} part from a scan` });
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  const instrumentData = useMemo(() => instrumentOptions(), []);
  const progress = job ? Math.round(((job.progress.done + (job.status === "running" ? 0.3 : 0)) / Math.max(1, job.progress.total)) * 100) : 0;

  return (
    <Modal opened onClose={onClose} title={addTo ? `Add a scanned part to ${addTo.name}` : "Read sheet music"} size="xl" fullScreen={mobile} closeOnClickOutside={false}>
      {!configured ? (
        <Stack>
          <Alert icon={<IconPlugConnected size={18} />} color="blue" title="Connect your server first">
            Reading PDFs and photos runs on your server. Enter its address and your API key in Settings.
          </Alert>
          <Group justify="flex-end">
            <Tip label="Close this window">
              <Button variant="default" onClick={onClose}>
                Close
              </Button>
            </Tip>
            <Tip label="Enter your server's address and API key, then try again">
              <Button
                onClick={() => {
                  onClose();
                  onOpenSettings();
                }}
              >
                Open settings
              </Button>
            </Tip>
          </Group>
        </Stack>
      ) : (
        <Stepper active={step} size="sm" allowNextStepsSelect={false}>
          <Stepper.Step label="Pages" description="Choose and straighten">
            <Stack mt="md">
              <Text size="sm" c="dimmed">
                Pages are read in this order. For photos, check that the corners sit on the sheet's corners: a straight,
                evenly lit page reads best.
              </Text>
              {loadingPages && <Loader size="sm" />}
              <SimpleGrid cols={{ base: 2, sm: 3, md: 4 }}>
                {items.map((item, i) => (
                  <Card key={item.key} withBorder padding="xs" style={{ opacity: item.include ? 1 : 0.45 }}>
                    <Card.Section style={{ position: "relative", background: "#f1f3f5" }}>
                      {item.thumb ? (
                        <div style={{ position: "relative", transform: `rotate(${item.rotation}deg)` }}>
                          <Image src={item.thumb} alt={item.label} h={180} fit="contain" />
                        </div>
                      ) : (
                        <Group h={180} justify="center">
                          <Loader size="sm" />
                        </Group>
                      )}
                      {item.corners && (
                        <Badge size="xs" style={{ position: "absolute", top: 6, left: 6 }} color="teal">
                          straightened
                        </Badge>
                      )}
                      {item.detecting && (
                        <Badge size="xs" style={{ position: "absolute", top: 6, left: 6 }} color="gray">
                          finding page…
                        </Badge>
                      )}
                    </Card.Section>
                    <Stack gap={4} mt="xs">
                      <Checkbox size="xs" label={<Text size="xs" lineClamp={1}>{item.label}</Text>} checked={item.include} onChange={(e) => update(item.key, { include: e.currentTarget.checked })} />
                      <Group gap={2} justify="space-between">
                        <Group gap={2}>
                          <Tip label="Turn the page a quarter turn to the left">
                            <ActionIcon size="sm" variant="subtle" onClick={() => update(item.key, { rotation: (item.rotation + 270) % 360 })} aria-label="Rotate left">
                              <IconRotate size={14} />
                            </ActionIcon>
                          </Tip>
                          <Tip label="Turn the page a quarter turn to the right">
                            <ActionIcon size="sm" variant="subtle" onClick={() => update(item.key, { rotation: (item.rotation + 90) % 360 })} aria-label="Rotate right">
                              <IconRotateClockwise size={14} />
                            </ActionIcon>
                          </Tip>
                          {item.photo && (
                            <Tip label="Mark the corners of the sheet in the photo, so the page is straightened before it is read">
                              <ActionIcon size="sm" variant="subtle" onClick={() => setEditing(item)} aria-label="Page corners">
                                <IconCrop size={14} />
                              </ActionIcon>
                            </Tip>
                          )}
                        </Group>
                        <Group gap={2}>
                          <Tip label={i === 0 ? "This is the first page" : "Move this page earlier"}>
                            <ActionIcon size="sm" variant="subtle" {...unavailable(i === 0)} onClick={() => i > 0 && moveItem(item.key, -1)} aria-label="Move earlier">
                              <IconArrowUp size={14} />
                            </ActionIcon>
                          </Tip>
                          <Tip label={i === items.length - 1 ? "This is the last page" : "Move this page later"}>
                            <ActionIcon
                              size="sm"
                              variant="subtle"
                              {...unavailable(i === items.length - 1)}
                              onClick={() => i < items.length - 1 && moveItem(item.key, 1)}
                              aria-label="Move later"
                            >
                              <IconArrowDown size={14} />
                            </ActionIcon>
                          </Tip>
                        </Group>
                      </Group>
                    </Stack>
                  </Card>
                ))}
              </SimpleGrid>
              <Group justify="space-between">
                <Tip label="Add more photos or PDF pages to read together">
                  <Button variant="default" leftSection={<IconPhotoPlus size={16} />} onClick={() => addInput.current?.click()}>
                    Add pages
                  </Button>
                </Tip>
                <input
                  ref={addInput}
                  type="file"
                  accept="image/*,.pdf"
                  multiple
                  hidden
                  onChange={(e) => {
                    const more = Array.from(e.currentTarget.files ?? []);
                    e.currentTarget.value = "";
                    if (!more.length) return;
                    const offset = files.length;
                    setFiles((f) => [...f, ...more]);
                    void addFiles(more, offset);
                  }}
                />
                <Group>
                  <Tip label="Close without reading anything">
                    <Button variant="default" onClick={onClose}>
                      Cancel
                    </Button>
                  </Tip>
                  <Tip label={selected.length === 0 ? "Tick at least one page" : "Next: say which instrument the music is written for"}>
                    <Button {...unavailable(selected.length === 0)} onClick={() => selected.length > 0 && setStep(1)}>
                      Next
                    </Button>
                  </Tip>
                </Group>
              </Group>
            </Stack>
          </Stepper.Step>

          <Stepper.Step label="Instrument" description="What it's written for">
            <Stack mt="md">
              <Text size="sm">
                Which instrument is this music written for? Notes are read as written for it, so a part for B♭ trumpet
                sounds a major 2nd lower, exactly as printed.
              </Text>
              <Chip.Group value={instrument} onChange={(v) => setInstrument(v as string)}>
                <Group gap={6}>
                  {QUICK.map((id) => (
                    <Chip key={id} value={id} size="sm">
                      {prettyName(getInstrument(id).name)}
                    </Chip>
                  ))}
                </Group>
              </Chip.Group>
              <Select label="Or choose another instrument" searchable value={instrument} onChange={(v) => setInstrument(v ?? "piano")} data={instrumentData} allowDeselect={false} />
              {!addTo && (
                <TextInput
                  label="Title"
                  description="Leave as is to use the title found on the page, if any."
                  value={title}
                  onChange={(e) => {
                    setTitle(e.currentTarget.value);
                    setTitleEdited(true);
                  }}
                />
              )}
              {secondEngine && (
                <Checkbox
                  checked={readTwice}
                  onChange={(e) => setReadTwice(e.currentTarget.checked)}
                  label={`Also read every page with ${secondEngine.name} ${secondEngine.version ?? ""}`.trim() + " and keep the better reading"}
                  description="Recognition versions read some pages differently. This takes longer: the second reading runs on the server's processor."
                  data-testid="read-twice"
                />
              )}
              <Group justify="flex-end">
                <Tip label="Back to the pages">
                  <Button variant="default" onClick={() => setStep(0)}>
                    Back
                  </Button>
                </Tip>
                <Tip label="Send the pages to the recognition service on your server and read the music">
                  <Button onClick={() => void recognise()}>
                    Read {selected.length} page{selected.length > 1 ? "s" : ""}
                  </Button>
                </Tip>
              </Group>
            </Stack>
          </Stepper.Step>

          <Stepper.Step label="Recognition" description="On your server">
            <Stack mt="md">
              {!error && (
                <>
                  <Text size="sm">{job ? job.progress.stage : "Uploading…"}</Text>
                  <Progress value={job ? progress : 5} animated />
                  <Text size="xs" c="dimmed">
                    A page takes a few seconds on a GPU and up to a minute on a CPU. You can keep this window open.
                  </Text>
                </>
              )}
              {error && (
                <Alert color="red" title="Recognition failed">
                  {error}
                </Alert>
              )}
              <Group justify="flex-end">
                {error ? (
                  <>
                    <Tip label="Back to the instrument and title">
                      <Button variant="default" onClick={() => setStep(1)}>
                        Back
                      </Button>
                    </Tip>
                    <Tip label="Send the pages to the recognition service again">
                      <Button onClick={() => void recognise()}>Try again</Button>
                    </Tip>
                  </>
                ) : (
                  <Tip label="Stop reading the pages">
                    <Button
                      variant="default"
                      onClick={() => {
                        cancelled.current = true;
                        setStep(1);
                      }}
                    >
                      Cancel
                    </Button>
                  </Tip>
                )}
              </Group>
            </Stack>
          </Stepper.Step>

          <Stepper.Step label="Review" description="Open and proofread">
            {result && (
              <Stack mt="md">
                {!addTo && <TextInput label="Title" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />}
                <Text size="sm">
                  Read <b>{result.score.measures.length}</b> bars from <b>{result.pages.length}</b> page
                  {result.pages.length > 1 ? "s" : ""} as <b>{prettyName(getInstrument(instrument).name)}</b>.
                </Text>
                {result.failed.length > 0 && (
                  <Alert color="orange" title={`${result.failed.length} page(s) could not be read`}>
                    {result.failed.map((f) => (
                      <Text key={f.index} size="sm">
                        Page {f.index + 1}: {f.error}
                      </Text>
                    ))}
                  </Alert>
                )}
                {result.warnings.map((w) => (
                  <Alert key={w} color="yellow" variant="light">
                    {w}
                  </Alert>
                ))}
                {result.readings.length > 0 && (
                  <Alert color="blue" variant="light" title="Two readings compared" data-testid="scan-readings">
                    <Stack gap={2}>
                      {result.readings.map((r) => (
                        <Text key={r} size="sm">
                          {r}
                        </Text>
                      ))}
                    </Stack>
                  </Alert>
                )}
                {result.repairs.length > 0 && (
                  <Alert color="teal" variant="light" title="Corrected automatically" data-testid="scan-repairs">
                    <Stack gap={2}>
                      {result.repairs.map((r) => (
                        <Text key={r} size="sm">
                          {r}
                        </Text>
                      ))}
                    </Stack>
                  </Alert>
                )}
                {error && (
                  <Alert color="red" title="The part could not be added">
                    {error}
                  </Alert>
                )}
                {addTo && joined && (
                  <Alert color="blue" variant="light" title={`How it lines up with ${addTo.name}`} data-testid="part-lineup">
                    <Stack gap={6}>
                      <Tip label="The bar of the score where the part's first bar goes: later if the scanned pages start further on">
                        <Select
                          size="xs"
                          w={160}
                          label="Its first bar goes to"
                          data={barLabels}
                          value={String(startBar)}
                          onChange={(v) => setStartBar(Number(v ?? 0))}
                          allowDeselect={false}
                          searchable
                        />
                      </Tip>
                      {joined.notes.length ? (
                        joined.notes.map((note) => (
                          <Text key={note} size="sm">
                            {note}
                          </Text>
                        ))
                      ) : (
                        <Text size="sm">Bar for bar, the same length as the score.</Text>
                      )}
                    </Stack>
                  </Alert>
                )}
                <Alert color={result.issues.length ? "blue" : "green"} variant="light">
                  {result.issues.length
                    ? `${result.issues.length} bar${result.issues.length > 1 ? "s" : ""} look suspicious (for example, notes that don't add up to the time signature). They are listed under Checks and marked in the score; compare them with the original page shown next to the score.`
                    : "No obvious problems found. Still compare the score with the original page."}
                </Alert>
                <Group justify="space-between">
                  <Tip label="Save what the recognition service read, before any corrections: useful when reporting a recognition problem">
                    <Button
                      variant="subtle"
                      size="xs"
                      leftSection={<IconDownload size={14} />}
                      onClick={() =>
                        result.raw.forEach((page) =>
                          downloadText(page.musicxml, `${safeFileName(`${title.trim() || "scan"} - ${page.name}`)} (recognised).musicxml`, "application/vnd.recordare.musicxml+xml"),
                        )
                      }
                    >
                      Recognition output
                    </Button>
                  </Tip>
                  <Group>
                    <Tip label="Back to the instrument and title (to read the pages again)">
                      <Button variant="default" onClick={() => setStep(1)}>
                        Back
                      </Button>
                    </Tip>
                    {addTo ? (
                      <Tip label={`Add this part to ${addTo.name}, lined up as above, with its pages beside the score; undo takes it out again`}>
                        <Button onClick={() => void addPart()} loading={saving}>
                          Add to the score
                        </Button>
                      </Tip>
                    ) : (
                      <Tip label="Save the score as a new project and open it, with the original pages beside it">
                        <Button onClick={() => void open()} loading={saving}>
                          Open score
                        </Button>
                      </Tip>
                    )}
                  </Group>
                </Group>
              </Stack>
            )}
          </Stepper.Step>
        </Stepper>
      )}
      {editing && editing.thumb && (
        <CornerEditor
          src={editing.thumb}
          initial={editing.corners}
          onDetect={async () => {
            const found = await detectCorners(settings, files[editing.file]!);
            return found.corners;
          }}
          onClose={(corners) => {
            if (corners !== null) update(editing.key, { corners });
            setEditing(null);
          }}
        />
      )}
    </Modal>
  );
}
