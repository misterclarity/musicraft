import { Tooltip, type TooltipProps } from "@mantine/core";

/**
 * The explanation shown when pointing at a control (or focusing it with the keyboard). Every
 * button in the app has one. A disabled Mantine button gets no pointer events, so controls that
 * can be unavailable use `unavailable()` instead of `disabled` and say why in the tip.
 */
export function Tip({ label, children, ...props }: TooltipProps) {
  return (
    <Tooltip
      label={label}
      openDelay={350}
      multiline
      maw={300}
      withArrow
      events={{ hover: true, focus: true, touch: false }}
      {...props}
    >
      {children}
    </Tooltip>
  );
}
