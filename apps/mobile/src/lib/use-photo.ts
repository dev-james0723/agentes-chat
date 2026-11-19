import { useMemo } from "react";
import { appHeaders, lastCookie } from "./auth";
import { type PhotoSource, photoSource } from "./photo";
import { serverUrl } from "./server";

/** A saved photo, with the current session only for our own server. */
export function usePhoto(url: string | null | undefined): PhotoSource | null {
  // Stable per URL, so rerendering a directory row does not refetch its image.
  return useMemo(() => photoSource(url, serverUrl(), appHeaders(lastCookie())), [url]);
}
