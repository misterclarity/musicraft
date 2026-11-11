/** A-Frame's elements in JSX: attributes are passed through as strings. */
import type { DetailedHTMLProps, HTMLAttributes } from "react";

type AFrameElement = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & { [attribute: string]: unknown };

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "a-scene": AFrameElement;
      "a-entity": AFrameElement;
    }
  }
}
