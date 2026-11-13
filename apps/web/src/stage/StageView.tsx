/**
 * The 3D stage: the parts of the score as players in a concert hall or on a bandstand. Loaded on
 * demand (A-Frame and three.js are large). Playback lights up the players, the sound comes from
 * their seats and is heard from wherever the camera is, and each player can be selected, soloed,
 * muted, moved or given another instrument.
 */
import "aframe";
import "./scene";
import {
  ActionIcon,
  Badge,
  Button,
  CloseButton,
  Group,
  Kbd,
  Menu,
  Paper,
  Popover,
  SegmentedControl,
  Slider,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import { getInstrument, prettyName, type Score } from "@musicraft/score-core";
import type { Scene } from "aframe";
import {
  IconArrowsMove,
  IconCamera,
  IconChartBar,
  IconEye,
  IconHeadphones,
  IconHelp,
  IconLayoutGrid,
  IconTag,
  IconVolume,
  IconVolumeOff,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { ChangeInstrumentModal } from "../components/ChangeInstrumentModal";
import { Tip } from "../components/Tip";
import { unavailable } from "../components/unavailable";
import { onPlaybackFrame, partAudible, usePlayback } from "../state/playback";
import { useStage } from "../state/stage";
import { live, partActivity } from "./activity";
import { arrangeSeats, clampToStage, facingConductor, floorHeight, hasMovedPlayers, rowCount, STEREO_LISTENER, VENUES, viewpoint, type Seat, type ViewpointId } from "./layout";
import { familyColor } from "./models";
import { noteName, partRanges, type PartRange } from "./ranges";
import { players, stageState } from "./registry";

interface Props {
  score: Score;
  selectedPartId: string | null;
  onSelectPart: (partId: string | null) => void;
  onShowInScore: (partId: string) => void;
  onApply: (next: Score, label: string) => void;
}

const VIEWS: { id: ViewpointId; label: string; tip: string }[] = [
  { id: "overview", label: "Overview", tip: "The whole stage from the hall" },
  { id: "conductor", label: "Conductor", tip: "From the podium: the balance as the conductor hears it" },
  { id: "front-row", label: "Front row", tip: "From the front row of the audience" },
  { id: "balcony", label: "Balcony", tip: "From far back and high up, where the sound has blended" },
  { id: "above", label: "From above", tip: "A plan of the seating: the easiest view for moving players" },
];

interface CameraHandle {
  flyTo(position: { x: number; y: number; z: number }, target: { x: number; y: number; z: number }, duration?: number): void;
}

/** Whether this browser can draw 3D (WebGL) at all. */
function hasWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

export default function StageView(props: Props) {
  const [supported] = useState(hasWebGL);
  if (!supported) {
    return (
      <Stack align="center" justify="center" h="100%" p="xl" data-testid="stage">
        <Text size="sm" c="dimmed" ta="center" maw={420}>
          The stage needs 3D graphics (WebGL), which this browser or device has turned off. Everything else works as usual.
        </Text>
      </Stack>
    );
  }
  return <Stage {...props} />;
}

function Stage({ score, selectedPartId, onSelectPart, onShowInScore, onApply }: Props) {
  const stage = useStage();
  const playback = usePlayback();
  // With many players, names show for the one pointed at or selected unless asked for.
  const [showNames, setShowNames] = useState(score.parts.length <= 12);
  const [showMeters, setShowMeters] = useState(true);
  const [moving, setMoving] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [changing, setChanging] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const sceneRef = useRef<HTMLElement>(null);
  const cameraRef = useRef<HTMLElement>(null);
  const versions = useRef(new Map<string, { signature: string; version: number }>());

  const seats = useMemo(() => arrangeSeats(score, stage.venue, stage.seats), [score, stage.venue, stage.seats]);
  const rows = rowCount(seats);
  const ranges = useMemo(() => partRanges(score), [score]);
  const selectedSeat = seats.find((s) => s.partId === selectedPartId);

  // What the 3D components need, by part id; a new version number makes a player redraw.
  const playerVersion = (partId: string, signature: string) => {
    const previous = versions.current.get(partId);
    if (previous?.signature === signature) return previous.version;
    const version = (previous?.version ?? 0) + 1;
    versions.current.set(partId, { signature, version });
    return version;
  };
  const playerAttributes = new Map<string, string>();
  for (const part of score.parts) {
    const info = {
      partId: part.id,
      instrument: part.instrument,
      label: prettyName(part.name),
      color: familyColor(part.instrument),
      selected: part.id === selectedPartId,
      hovered: part.id === hovered,
      audible: partAudible(playback, part.id),
      solo: playback.solo.includes(part.id),
      showName: showNames,
      showMeter: showMeters,
      range: ranges.get(part.id)!,
    };
    players.set(part.id, info);
    playerAttributes.set(part.id, `part: ${part.id}; v: ${playerVersion(part.id, JSON.stringify(info))}`);
  }
  stageState.score = score;
  stageState.performance = playback.performance;
  stageState.spatial = stage.spatial;
  stageState.moving = moving;
  // Forget the players of deleted parts once their entities are gone.
  useEffect(() => {
    const ids = new Set(score.parts.map((p) => p.id));
    for (const id of [...players.keys()]) if (!ids.has(id)) players.delete(id);
    for (const id of [...versions.current.keys()]) if (!ids.has(id)) versions.current.delete(id);
  }, [score]);
  const moved = hasMovedPlayers(score, stage.seats);

  // Who is playing, frame by frame.
  useEffect(
    () =>
      onPlaybackFrame(({ time, notes }) => {
        live.time = time;
        live.playing = usePlayback.getState().playing;
        live.parts = partActivity(notes);
      }),
    [],
  );
  useEffect(() => {
    live.playing = playback.playing;
    if (!playback.playing) live.parts = new Map();
  }, [playback.playing]);

  // The sound comes from the seats and is heard from the camera (or plain stereo when switched off).
  useEffect(() => {
    const room = stage.venue === "hall" ? "hall" : "bandstand";
    usePlayback.getState().setSpace(stage.spatial ? "room" : "stereo", stage.spatial ? room : "dry");
    if (!stage.spatial) usePlayback.getState().setListener(STEREO_LISTENER.position, STEREO_LISTENER.forward);
  }, [stage.spatial, stage.venue]);
  useEffect(
    () => () => {
      usePlayback.getState().setSpace("stereo", "dry");
      usePlayback.getState().setListener(STEREO_LISTENER.position, STEREO_LISTENER.forward);
    },
    [],
  );

  // Browsers allow only a few WebGL contexts: give this one back when the stage closes.
  useEffect(() => {
    const scene = sceneRef.current as Scene | null;
    const onLoaded = () => setReady(true);
    if (scene?.hasLoaded) setReady(true);
    else scene?.addEventListener("loaded", onLoaded);
    return () => {
      scene?.removeEventListener("loaded", onLoaded);
      // In development React also runs this right after mounting, with the scene still on the page.
      setTimeout(() => {
        if (scene && !scene.isConnected) scene.renderer?.forceContextLoss();
      });
    };
  }, []);

  const camera = () => (cameraRef.current as unknown as { components?: Record<string, unknown> } | null)?.components?.["mc-camera"] as CameraHandle | undefined;
  const fly = (id: ViewpointId, duration?: number) => {
    const view = viewpoint(id, stage.venue, seats, selectedSeat);
    camera()?.flyTo(view.position, view.target, duration);
  };
  // Start with the whole stage in view, and again when the venue changes.
  useEffect(() => {
    if (ready) fly("overview", 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, stage.venue]);

  // Pointing at players: hover, select, and drag them around in "move" mode.
  const seatsRef = useRef(seats);
  seatsRef.current = seats;
  const selectRef = useRef(onSelectPart);
  selectRef.current = onSelectPart;
  useEffect(() => {
    const scene = sceneRef.current as Scene | null;
    if (!scene) return;
    const partOf = (event: Event) => (event.target as HTMLElement | null)?.dataset?.part;
    let dragged = false;
    const onEnter = (event: Event) => {
      const id = partOf(event);
      if (!id) return;
      setHovered(id);
      scene.style.cursor = stageState.moving ? "grab" : "pointer";
    };
    const onLeave = (event: Event) => {
      if (!partOf(event)) return;
      setHovered(null);
      scene.style.cursor = "";
    };
    const onClick = (event: Event) => {
      const id = partOf(event);
      if (id && !dragged) selectRef.current(id);
      dragged = false;
    };
    const onDown = (event: Event) => {
      const id = partOf(event);
      if (!id || !stageState.moving) return;
      const seat = seatsRef.current.find((s) => s.partId === id);
      const player = scene.querySelector<HTMLElement>(`[data-player="${id}"]`) as unknown as { object3D: THREE.Object3D } | null;
      const cameraEl = cameraRef.current;
      if (!seat || !player || !cameraEl) return;
      dragged = false;
      // Neither the mouse nor a finger turns the camera while a player is carried.
      cameraEl.setAttribute("look-controls", "enabled: false; touchEnabled: false");
      scene.style.cursor = "grabbing";
      const raycaster = new THREE.Raycaster();
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -seat.y);
      const hit = new THREE.Vector3();
      let place = { x: seat.x, z: seat.z };
      // The pointer (mouse, pen or finger) that carries the player.
      let pointer: number | null = null;
      const onMove = (move: PointerEvent) => {
        pointer ??= move.pointerId;
        if (move.pointerId !== pointer) return;
        const rect = scene.canvas.getBoundingClientRect();
        const ndc = new THREE.Vector2(((move.clientX - rect.left) / rect.width) * 2 - 1, -((move.clientY - rect.top) / rect.height) * 2 + 1);
        raycaster.setFromCamera(ndc, scene.camera);
        if (!raycaster.ray.intersectPlane(plane, hit)) return;
        place = clampToStage(stage.venue, hit.x, hit.z, rows);
        dragged = true;
        player.object3D.position.set(place.x, floorHeight(stage.venue, place.x, place.z, rows), place.z);
        player.object3D.rotation.y = (facingConductor(place.x, place.z) * Math.PI) / 180;
      };
      const onUp = (up: PointerEvent) => {
        if (pointer !== null && up.pointerId !== pointer) return;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        cameraEl.setAttribute("look-controls", "enabled: true; touchEnabled: true");
        scene.style.cursor = "";
        if (dragged) useStage.getState().moveSeat(id, place);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };
    // The cursor checks what the mouse points at only every few frames: on a quick click or a
    // tap, look again right away so the press lands on the player under it.
    const aim = (event: MouseEvent | TouchEvent) => {
      const cursor = scene.components.cursor as { onMouseMove?: (e: Event) => void } | undefined;
      const raycaster = scene.components.raycaster as { checkIntersections?: () => void } | undefined;
      cursor?.onMouseMove?.(event);
      raycaster?.checkIntersections?.();
    };
    const canvas = scene.canvas as HTMLCanvasElement | undefined;
    canvas?.addEventListener("mousedown", aim, true);
    canvas?.addEventListener("touchstart", aim, { capture: true, passive: true });
    scene.addEventListener("mouseenter", onEnter);
    scene.addEventListener("mouseleave", onLeave);
    scene.addEventListener("click", onClick);
    scene.addEventListener("mousedown", onDown);
    return () => {
      canvas?.removeEventListener("mousedown", aim, true);
      canvas?.removeEventListener("touchstart", aim, true);
      scene.removeEventListener("mouseenter", onEnter);
      scene.removeEventListener("mouseleave", onLeave);
      scene.removeEventListener("click", onClick);
      scene.removeEventListener("mousedown", onDown);
    };
  }, [stage.venue, rows, ready]);

  const selectedPart = score.parts.find((p) => p.id === selectedPartId);
  const venue = VENUES.find((v) => v.value === stage.venue)!;

  return (
    <div style={{ position: "relative", height: "100%", minHeight: 0, overflow: "hidden" }} data-testid="stage">
      <a-scene
        ref={sceneRef}
        embedded=""
        style={{ width: "100%", height: "100%", touchAction: "none" }}
        renderer="antialias: true; colorManagement: true; maxCanvasWidth: 2560; maxCanvasHeight: 1600"
        shadow="type: pcf"
        cursor="rayOrigin: mouse; fuse: false"
        raycaster="objects: .mc-clickable; interval: 40"
        loading-screen="enabled: false"
        vr-mode-ui="enabled: true"
        device-orientation-permission-ui="enabled: false"
        keyboard-shortcuts="enterVR: false"
      >
        <a-entity mc-venue={`type: ${stage.venue}; rows: ${rows}`} />
        <a-entity mc-conductor="" position={`0 ${floorHeight(stage.venue, 0, 0, rows)} 0`} />
        {seats.map((seat: Seat) => (
          <a-entity
            key={seat.partId}
            data-player={seat.partId}
            position={`${seat.x} ${seat.y} ${seat.z}`}
            rotation={`0 ${seat.rotation} 0`}
            mc-player={playerAttributes.get(seat.partId)}
          >
            <a-entity className="mc-clickable" data-part={seat.partId} mc-hitbox="" />
          </a-entity>
        ))}
        <a-entity
          ref={cameraRef}
          camera="fov: 60; near: 0.05; far: 300"
          position="0 3.4 9.5"
          look-controls="pointerLockEnabled: false; magicWindowTrackingEnabled: false; reverseMouseDrag: false"
          wasd-controls="acceleration: 28; fly: false"
          mc-camera=""
        />
        <a-entity laser-controls="hand: right" raycaster="objects: .mc-clickable; far: 40" />
        <a-entity laser-controls="hand: left" raycaster="objects: .mc-clickable; far: 40" />
      </a-scene>

      <Paper shadow="sm" radius="md" p={6} withBorder style={{ position: "absolute", top: 10, left: 10, right: 10, maxWidth: "fit-content", opacity: 0.96 }}>
        <Group gap={6} wrap="wrap">
          <Tip label={venue.description}>
            <SegmentedControl
              size="xs"
              value={stage.venue}
              onChange={(v) => stage.setVenue(v as typeof stage.venue)}
              data={VENUES.map((v) => ({ value: v.value, label: v.label }))}
              aria-label="Venue"
            />
          </Tip>
          <Menu position="bottom-start" withinPortal>
            <Menu.Target>
              <Tip label="Move the camera to a viewpoint. You can also drag to look around and walk with W A S D or the arrow keys.">
                <Button size="xs" variant="default" leftSection={<IconCamera size={14} />}>
                  View
                </Button>
              </Tip>
            </Menu.Target>
            <Menu.Dropdown>
              {VIEWS.map((v) => (
                <Menu.Item key={v.id} onClick={() => fly(v.id)}>
                  <Text size="sm">{v.label}</Text>
                  <Text size="xs" c="dimmed">
                    {v.tip}
                  </Text>
                </Menu.Item>
              ))}
              <Menu.Item disabled={!selectedSeat} onClick={() => fly("seat")}>
                <Text size="sm">Selected player&apos;s seat</Text>
                <Text size="xs" c="dimmed">
                  {selectedPart ? `Hear the band from ${prettyName(selectedPart.name)}'s chair` : "Select a player first"}
                </Text>
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
          <Tip label="Spatial sound: each part comes from its seat and you hear it from where the camera is, with the venue's echo. Off: plain stereo.">
            <Switch
              size="xs"
              label="Spatial sound"
              checked={stage.spatial}
              onChange={(e) => stage.setSpatial(e.currentTarget.checked)}
              styles={{ label: { paddingLeft: 6 } }}
            />
          </Tip>
          <Tip label={showNames ? "Show names only for the player you point at or select" : "Show the name card above every player"}>
            <ActionIcon variant={showNames ? "light" : "default"} onClick={() => setShowNames((v) => !v)} aria-label="Names">
              <IconTag size={16} />
            </ActionIcon>
          </Tip>
          <Tip label="Range meters beside each player: green is the instrument's comfortable range, white the notes the part uses (orange or red beyond the comfortable or possible range); a dot shows the note being played">
            <ActionIcon variant={showMeters ? "light" : "default"} onClick={() => setShowMeters((v) => !v)} aria-label="Range meters">
              <IconChartBar size={16} />
            </ActionIcon>
          </Tip>
          <Tip label={moving ? "Done moving players" : "Move players: drag a player to another place. Their sound moves with them."}>
            <ActionIcon variant={moving ? "filled" : "default"} onClick={() => setMoving((v) => !v)} aria-label="Move players" data-testid="move-players">
              <IconArrowsMove size={16} />
            </ActionIcon>
          </Tip>
          <Tip label={moved ? "Put every player back in the standard seating" : "Players are in the standard seating"}>
            <ActionIcon
              variant="default"
              {...unavailable(!moved)}
              onClick={() => moved && stage.resetSeats()}
              aria-label="Standard seating"
            >
              <IconLayoutGrid size={16} />
            </ActionIcon>
          </Tip>
          <StageHelp />
        </Group>
      </Paper>

      {moving && (
        <Badge style={{ position: "absolute", bottom: 14, left: "50%", transform: "translateX(-50%)" }} size="lg" variant="filled">
          Drag players to move them · View → From above helps
        </Badge>
      )}

      {selectedPart && (
        <PlayerCard
          key={selectedPart.id}
          name={prettyName(selectedPart.name)}
          instrument={getInstrument(selectedPart.instrument).name}
          range={ranges.get(selectedPart.id)!}
          bars={score.measures.length}
          muted={playback.muted.includes(selectedPart.id)}
          solo={playback.solo.includes(selectedPart.id)}
          volume={playback.volumes[selectedPart.id] ?? 1}
          onMute={() => playback.toggleMute(selectedPart.id)}
          onSolo={() => playback.toggleSolo(selectedPart.id)}
          onVolume={(v) => playback.setVolume(selectedPart.id, v)}
          onListen={() => fly("seat")}
          onChangeInstrument={() => setChanging(selectedPart.id)}
          onShowInScore={() => onShowInScore(selectedPart.id)}
          onClose={() => onSelectPart(null)}
        />
      )}
      {changing && (
        <ChangeInstrumentModal opened onClose={() => setChanging(null)} score={score} partId={changing} onApply={(next, label) => onApply(next, label)} />
      )}
    </div>
  );
}

function StageHelp() {
  return (
    <Popover width={320} position="bottom-end" withArrow shadow="md">
      <Popover.Target>
        <Tip label="How to move around and what you see">
          <ActionIcon variant="default" aria-label="Stage help">
            <IconHelp size={16} />
          </ActionIcon>
        </Tip>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap={6}>
          <Text size="sm" fw={600}>
            Getting around
          </Text>
          <Text size="xs">
            Drag with the mouse to look around; walk with <Kbd>W</Kbd> <Kbd>A</Kbd> <Kbd>S</Kbd> <Kbd>D</Kbd> or the arrow keys. <Kbd>Space</Kbd> plays and pauses.
            With a VR headset, use the goggles button at the bottom right.
          </Text>
          <Text size="sm" fw={600}>
            Players
          </Text>
          <Text size="xs">
            Click a player to select their part: you can solo or mute it, change its volume or instrument, or listen from their chair. While the music plays, each
            player lights up with their notes, brighter when they play louder.
          </Text>
          <Text size="sm" fw={600}>
            Range meters
          </Text>
          <Text size="xs">
            The bar beside each player is the instrument&apos;s whole range: green where it plays comfortably, white for the notes this part uses (orange or red when
            they go beyond comfortable or possible). The dot shows the note being played.
          </Text>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

interface CardProps {
  name: string;
  instrument: string;
  range: PartRange;
  bars: number;
  muted: boolean;
  solo: boolean;
  volume: number;
  onMute: () => void;
  onSolo: () => void;
  onVolume: (volume: number) => void;
  onListen: () => void;
  onChangeInstrument: () => void;
  onShowInScore: () => void;
  onClose: () => void;
}

function PlayerCard(props: CardProps) {
  const { range } = props;
  const used = range.low !== null && range.high !== null ? `${noteName(range.low)}–${noteName(range.high)}` : "no notes";
  return (
    <Paper shadow="md" radius="md" p="sm" withBorder w={290} style={{ position: "absolute", top: 64, right: 10, opacity: 0.97 }} data-testid="player-card">
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <div style={{ minWidth: 0 }}>
          <Text fw={650} truncate>
            {props.name}
          </Text>
          <Text size="xs" c="dimmed">
            {props.instrument}
          </Text>
        </div>
        <Tip label="Deselect this player">
          <CloseButton size="sm" onClick={props.onClose} aria-label="Close" />
        </Tip>
      </Group>
      <Stack gap={4} mt={6}>
        <Text size="xs">
          Plays in {range.barsWithNotes} of {props.bars} bars, {range.notes} notes.
        </Text>
        <Text size="xs" c={range.beyond === "range" ? "red" : range.beyond === "comfort" ? "orange" : undefined}>
          Uses {used} (written); comfortable {noteName(range.comfortLow)}–{noteName(range.comfortHigh)}.
          {range.beyond === "range" ? " Some notes are beyond what the instrument can play." : range.beyond === "comfort" ? " Some notes are outside the comfortable range." : ""}
        </Text>
      </Stack>
      <Group gap={6} mt="xs">
        <Tip label={props.solo ? "Stop hearing this part alone" : "Hear only this part (and any other solo parts)"}>
          <Button size="compact-xs" variant={props.solo ? "filled" : "default"} leftSection={<IconHeadphones size={12} />} onClick={props.onSolo}>
            Solo
          </Button>
        </Tip>
        <Tip label={props.muted ? "Hear this part again" : "Silence this part"}>
          <Button
            size="compact-xs"
            variant={props.muted ? "filled" : "default"}
            color={props.muted ? "gray" : undefined}
            leftSection={props.muted ? <IconVolumeOff size={12} /> : <IconVolume size={12} />}
            onClick={props.onMute}
          >
            {props.muted ? "Muted" : "Mute"}
          </Button>
        </Tip>
        <Tip label="Move the camera to this player's chair and hear the band from there">
          <Button size="compact-xs" variant="default" leftSection={<IconEye size={12} />} onClick={props.onListen}>
            Listen from here
          </Button>
        </Tip>
      </Group>
      <Text size="xs" mt="xs">
        Volume
      </Text>
      <Tip label="How loud this part plays back, from silent to twice as loud">
        <Slider
          size="sm"
          min={0}
          max={2}
          step={0.05}
          value={props.volume}
          onChange={props.onVolume}
          label={(v) => `${Math.round(v * 100)}%`}
          marks={[{ value: 1, label: "" }]}
          aria-label="Volume"
        />
      </Tip>
      <Group gap={6} mt="sm">
        <Tip label="Rewrite this part for another instrument (the music sounds the same)">
          <Button size="compact-xs" variant="light" onClick={props.onChangeInstrument}>
            Change instrument…
          </Button>
        </Tip>
        <Tip label="Switch to the score with this part selected">
          <Button size="compact-xs" variant="light" onClick={props.onShowInScore}>
            Show in score
          </Button>
        </Tip>
      </Group>
    </Paper>
  );
}
