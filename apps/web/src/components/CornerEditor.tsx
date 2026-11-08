import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { IconFocusCentered, IconMaximize, IconWand } from "@tabler/icons-react";
import { useRef, useState, type PointerEvent } from "react";
import type { Corners } from "../lib/omr";

const FULL: Corners = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/** Drag the four corners of the sheet in a photo; recognition straightens the page from them. */
export function CornerEditor({
  src,
  initial,
  onDetect,
  onClose,
}: {
  src: string;
  initial?: Corners;
  onDetect?: () => Promise<Corners | null>;
  /** Called with the new corners, `undefined` for the whole image, or `null` when cancelled. */
  onClose: (corners: Corners | undefined | null) => void;
}) {
  const [corners, setCorners] = useState<Corners>(initial ?? FULL);
  const [dragging, setDragging] = useState<number | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging === null || !box.current) return;
    const rect = box.current.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    setCorners((c) => c.map((p, i) => (i === dragging ? [x, y] : p)) as Corners);
  };

  async function detect() {
    if (!onDetect) return;
    setDetecting(true);
    setMessage(null);
    try {
      const found = await onDetect();
      if (found) setCorners(found);
      else setMessage("No page edges found. Drag the corners by hand.");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setDetecting(false);
    }
  }

  const isFull = corners.every((p, i) => Math.abs(p[0] - FULL[i]![0]) < 0.001 && Math.abs(p[1] - FULL[i]![1]) < 0.001);

  return (
    <Modal opened onClose={() => onClose(null)} title="Page corners" size="xl">
      <Stack>
        <Text size="sm" c="dimmed">
          Drag the four handles onto the corners of the sheet. The page is straightened before it is read.
        </Text>
        <div
          ref={box}
          style={{ position: "relative", touchAction: "none", userSelect: "none", maxHeight: "65vh", width: "fit-content", margin: "0 auto" }}
          onPointerMove={move}
          onPointerUp={() => setDragging(null)}
          onPointerLeave={() => setDragging(null)}
        >
          <img src={src} alt="Page" style={{ display: "block", maxWidth: "100%", maxHeight: "65vh" }} draggable={false} />
          <svg viewBox="0 0 1 1" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
            <polygon
              points={corners.map((p) => p.join(",")).join(" ")}
              fill="rgba(34,139,230,0.15)"
              stroke="#228be6"
              strokeWidth={0.004}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {corners.map((p, i) => (
            <div
              key={i}
              role="slider"
              aria-label={["Top left", "Top right", "Bottom right", "Bottom left"][i]}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                setDragging(i);
              }}
              onPointerUp={(e) => {
                e.currentTarget.releasePointerCapture(e.pointerId);
                setDragging(null);
              }}
              style={{
                position: "absolute",
                left: `calc(${p[0] * 100}% - 14px)`,
                top: `calc(${p[1] * 100}% - 14px)`,
                width: 28,
                height: 28,
                borderRadius: 14,
                background: "rgba(255,255,255,0.85)",
                border: "3px solid #228be6",
                cursor: "grab",
                boxShadow: "0 1px 4px rgba(0,0,0,0.4)",
              }}
            />
          ))}
        </div>
        {message && (
          <Text size="sm" c="orange">
            {message}
          </Text>
        )}
        <Group justify="space-between">
          <Group gap="xs">
            {onDetect && (
              <Button variant="light" leftSection={<IconWand size={16} />} loading={detecting} onClick={detect}>
                Detect automatically
              </Button>
            )}
            <Button variant="default" leftSection={<IconMaximize size={16} />} onClick={() => setCorners(FULL)}>
              Use whole image
            </Button>
          </Group>
          <Group gap="xs">
            <Button variant="default" onClick={() => onClose(null)}>
              Cancel
            </Button>
            <Button leftSection={<IconFocusCentered size={16} />} onClick={() => onClose(isFull ? undefined : corners)}>
              Done
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
