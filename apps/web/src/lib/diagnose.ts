/** Turn a failed check of the recognition service into a cause and concrete next steps. */
import { joinUrl, omrBaseUrl, ServerError } from "./server";
import type { Settings } from "./settings";

export interface Diagnosis {
  cause: string;
  steps: string[];
  /** A command to run anywhere to see what the gateway answers. */
  curl: string;
}

const START = "On the server, start the recognition container (docs/SERVER_SETUP.md, step 1) and check it there: curl http://127.0.0.1:8070/health";
const ROUTE =
  "Add the /omr route to gateway.py (docs/SERVER_SETUP.md, step 2): check the outside key as for /v1, then forward /omr/… to http://127.0.0.1:8070 with the internal key from omr_internal_key.txt.";
const CORS = "Give the /omr route the same CORS handling as /v1, including on its error replies (docs/SERVER_SETUP.md, step 3).";

export function diagnoseRecognition(error: unknown, settings: Settings, modelWorks: boolean): Diagnosis {
  const url = joinUrl(omrBaseUrl(settings), "/health");
  const curl = `curl -i -H "Authorization: Bearer YOUR_API_KEY" ${url}`;
  if (!(error instanceof ServerError)) {
    return { cause: error instanceof Error ? error.message : String(error), steps: [START, ROUTE], curl };
  }
  if (error.kind === "config") return { cause: "No server address is set.", steps: ["Enter your server's address above."], curl };
  if (error.kind === "timeout") {
    return {
      cause: `No answer from ${url} within 10 seconds.`,
      steps: ["gateway.py may be forwarding /omr to a port where nothing listens. " + START, ROUTE],
      curl,
    };
  }
  if (error.kind === "parse") {
    return {
      cause: `Something answered at ${url}, but not the recognition service (the reply isn't its JSON).`,
      steps: ["gateway.py probably sends /omr/… somewhere else, e.g. to llama-server. " + ROUTE],
      curl,
    };
  }
  if (error.kind === "network") {
    return {
      cause: modelWorks
        ? `The browser got no usable answer from ${url}, although the language model answers through the same gateway. Most likely gateway.py has no /omr route yet and its "not found" reply carries no CORS headers, so the browser hides it.`
        : `The browser got no answer from ${url}.`,
      steps: [START, ROUTE, CORS],
      curl,
    };
  }
  switch (error.status) {
    case 404:
      return {
        cause: `Your gateway answered 404 (not found) for ${url}: it has no /omr route yet, or the recognition service path in Settings is wrong.`,
        steps: [START, ROUTE],
        curl,
      };
    case 401:
    case 403:
      return {
        cause: `The key was refused at ${url} (HTTP ${error.status}).`,
        steps: [
          "gateway.py should accept the same outside key for /omr as for /v1.",
          "It must then send the internal key from omr_internal_key.txt to the service (Authorization: Bearer …); a mismatch there also ends in 401.",
        ],
        curl,
      };
    case 502:
    case 503:
    case 504:
      return {
        cause: `gateway.py couldn't reach the recognition service (HTTP ${error.status}).`,
        steps: [`${START}. In deploy/, docker compose ps shows whether it runs and docker compose logs why not.`, "Make sure gateway.py forwards /omr/… to http://127.0.0.1:8070."],
        curl,
      };
    default:
      return { cause: error.message, steps: [START, ROUTE], curl };
  }
}
