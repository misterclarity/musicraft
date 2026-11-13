/**
 * Marks a control that can't be used yet but keeps its tooltip (a disabled Mantine button gets no
 * pointer events): Mantine draws it disabled, and screen readers announce it as unavailable. Its
 * click handler must check as well.
 */
export function unavailable(when: boolean | undefined): { "data-disabled"?: true; "aria-disabled"?: true } {
  return when ? { "data-disabled": true, "aria-disabled": true } : {};
}
