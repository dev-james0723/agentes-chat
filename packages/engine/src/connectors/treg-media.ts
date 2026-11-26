import { ARTIFACT_LIMITS, type ArtifactDeps, createFileArtifact, fileReach } from "../artifacts";
import { replyThreadOf } from "../runs";
import type { ToolContext } from "../tools/types";

/** Inline MCP bytes are kept out of prompts and run-step JSON. */
export interface TregInlineFile {
  data: string;
  mimeType: string;
}

const EXTENSIONS: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "audio/mp4": "m4a",
  "audio/webm": "webm",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

/** Bounded native storage with the run's own placement and access checks; never re-executes the remote tool. */
export async function keepTregMedia(
  artifacts: ArtifactDeps | undefined,
  ctx: ToolContext,
  files: TregInlineFile[],
): Promise<{ content: string; artifactIds: string[]; isError: boolean }> {
  const artifactIds: string[] = [];
  const notes: string[] = [];
  const failed = (why: string) => ({
    content: [
      ...notes,
      `TREG media could not all be retained: ${why}. The remote call was not retried; reconcile its result before generating again.`,
    ].join("\n"),
    artifactIds,
    isError: true,
  });
  if (!artifacts) return failed("file storage is unavailable");
  if (files.length > 8) return failed("more than eight files were returned");
  let total = 0;
  // Validate every payload and the aggregate decoded size before decoding or writing any file.
  for (const file of files) {
    const text = file.data;
    if (text.length > Math.ceil(ARTIFACT_LIMITS.fileBytes / 3) * 4) return failed("the 50 MB limit was exceeded");
    if (!text || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return failed("invalid base64 data");
    total += (text.length / 4) * 3 - (text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0);
    if (total > ARTIFACT_LIMITS.fileBytes) return failed("the aggregate 50 MB limit was exceeded");
  }
  for (const [index, file] of files.entries()) {
    const bytes = Buffer.from(file.data, "base64");
    if (bytes.toString("base64") !== file.data) return failed("noncanonical base64 data");
    const type = file.mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
    const known = EXTENSIONS[type];
    const name = `treg-media-${index + 1}.${known ?? "bin"}`;
    try {
      const saved = await createFileArtifact(
        { ...artifacts, db: ctx.db },
        {
          type: "agent",
          agentId: ctx.agentId,
          channelId: ctx.channelId,
          threadId: replyThreadOf(ctx),
          runId: ctx.runId,
        },
        ctx.orgId,
        {
          title: name,
          name,
          bytes,
          contentType: known ? type : "application/octet-stream",
          note: "From TREG",
          byProduct: true,
        },
      );
      artifactIds.push(saved.id);
      notes.push(`${name}: file ${saved.id} (untrusted content). ${await fileReach(ctx.db, ctx.orgId, saved.id)}`);
    } catch {
      return failed("native file storage refused the result");
    }
  }
  return { content: notes.join("\n"), artifactIds, isError: false };
}
