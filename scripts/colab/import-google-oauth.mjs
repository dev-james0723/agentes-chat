#!/usr/bin/env node
/**
 * Import a downloaded Google OAuth Web client into a self-hosted server's protected .env.
 * Reads credentials only when explicitly run; never prints their values or restarts the service.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

class ImportError extends Error {}

function refuse(message) {
  throw new ImportError(message);
}

function readRegular(path, label, maxBytes) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) refuse(`${label} must be a regular, reasonably sized file.`);
    return { bytes: readFileSync(fd), stat };
  } finally {
    closeSync(fd);
  }
}

function callbackFor(publicUrl) {
  let url;
  try {
    url = new URL(publicUrl);
  } catch {
    refuse("PUBLIC_URL must be an absolute HTTP(S) URL.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    refuse("PUBLIC_URL must use HTTPS (HTTP is allowed for localhost), with no credentials, query or fragment.");
  }
  return `${publicUrl.replace(/\/$/, "")}/api/app/connectors/oauth/callback`;
}

function envValue(raw) {
  const value = raw.trim();
  if (value.startsWith('"') || value.startsWith("'") || value.startsWith("`")) {
    const quote = value[0];
    const end = value.indexOf(quote, 1);
    if (end < 0 || !/^(?:\s*#.*)?$/.test(value.slice(end + 1))) {
      refuse("An existing Colab or PUBLIC_URL setting is not a single-line value. Resolve it before importing.");
    }
    return value.slice(1, end);
  }
  return value.replace(/\s+#.*$/, "").trim();
}

function hasClosingQuote(text, quote, from = 0) {
  let escaped = false;
  for (let index = from; index < text.length; index++) {
    const character = text[index];
    if (character === quote && !escaped) return true;
    escaped = character === "\\" && !escaped;
  }
  return false;
}

/** Only top-level assignments count; key-looking lines inside other multiline values are preserved. */
function withoutColabAssignments(current, publicUrl) {
  const kept = [];
  let quoted;
  for (const line of current.split(/(?<=\n)/)) {
    const body = line.replace(/\r?\n$/, "");
    if (quoted) {
      kept.push(line);
      if (hasClosingQuote(body, quoted)) quoted = undefined;
      continue;
    }
    const assignment = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/.exec(body);
    if (!assignment) {
      kept.push(line);
      continue;
    }
    const [, key, raw] = assignment;
    if (key === "PUBLIC_URL" && envValue(raw) !== publicUrl) {
      refuse("PUBLIC_URL does not match the existing .env setting.");
    }
    if (key === "CONNECTOR_COLAB_CLIENT_ID" || key === "CONNECTOR_COLAB_CLIENT_SECRET") {
      envValue(raw);
      continue;
    }
    kept.push(line);
    const value = raw.trimStart();
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === "`") && !hasClosingQuote(value, quote, 1)) quoted = quote;
  }
  if (quoted) refuse(".env has an unterminated quoted value. Resolve it before importing.");
  return kept.join("");
}

/** The only environment keys this helper writes. All other lines remain byte-for-byte intact. */
export function importGoogleOAuth({ oauthJsonPath, envPath, publicUrl, check = false }) {
  const callback = callbackFor(publicUrl);
  let downloaded;
  try {
    downloaded = JSON.parse(readRegular(oauthJsonPath, "OAuth JSON", 256 * 1024).bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof ImportError) throw error;
    refuse("Could not read a valid OAuth JSON file. No configuration was changed.");
  }
  const web = downloaded?.web;
  if (!web || downloaded.installed) refuse("Download an OAuth Web application client JSON, not a Desktop client.");
  if (
    typeof web.client_id !== "string" ||
    !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(web.client_id) ||
    typeof web.client_secret !== "string" ||
    !/^[A-Za-z0-9_-]{8,512}$/.test(web.client_secret)
  ) {
    refuse("The Web client ID or secret is missing or has an unexpected format.");
  }
  if (!Array.isArray(web.redirect_uris) || !web.redirect_uris.includes(callback)) {
    refuse("The Web client does not list the exact PUBLIC_URL OAuth callback. Add it in Google and download again.");
  }

  const target = resolve(envPath);
  const lockPath = `${target}.colab-import.lock`;
  const lock = openSync(lockPath, "wx", 0o600);
  let temporary;
  try {
    const original = readRegular(target, ".env", 2 * 1024 * 1024);
    if (process.getuid && original.stat.uid !== process.getuid()) {
      refuse("Run this helper as the owner of the existing .env file.");
    }
    const current = original.bytes.toString("utf8");
    if (!Buffer.from(current).equals(original.bytes)) refuse(".env must be valid UTF-8.");
    const kept = withoutColabAssignments(current, publicUrl);
    const eol = current.includes("\r\n") ? "\r\n" : "\n";
    const next = `${kept}${kept.endsWith("\n") || !kept ? "" : eol}CONNECTOR_COLAB_CLIENT_ID=${web.client_id}${eol}CONNECTOR_COLAB_CLIENT_SECRET=${web.client_secret}${eol}`;
    if (check) return { checked: true, changed: false };
    if (next === current && (original.stat.mode & 0o777) === 0o600) return { checked: true, changed: false };

    const tempPath = resolve(dirname(target), `.${basename(target)}.colab-${randomUUID()}.tmp`);
    const fd = openSync(tempPath, "wx", 0o600);
    temporary = tempPath;
    try {
      writeFileSync(fd, next);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const latest = readRegular(target, ".env", 2 * 1024 * 1024);
    if (
      latest.stat.dev !== original.stat.dev ||
      latest.stat.ino !== original.stat.ino ||
      !latest.bytes.equals(original.bytes)
    ) {
      refuse(".env changed during import. Nothing was replaced; retry after the other edit finishes.");
    }
    renameSync(temporary, target);
    temporary = undefined;
    return { checked: true, changed: true };
  } finally {
    if (temporary) unlinkSync(temporary);
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        "oauth-json": { type: "string" },
        "env-file": { type: "string" },
        "public-url": { type: "string" },
        check: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    });
    if (values.help) {
      console.log(
        "Usage: node scripts/colab/import-google-oauth.mjs --oauth-json /path/client.json --env-file /path/.env --public-url https://chat.example.com [--check]",
      );
    } else {
      if (!values["oauth-json"] || !values["env-file"] || !values["public-url"]) {
        refuse("Provide --oauth-json, --env-file and --public-url. Use --help for the command format.");
      }
      const result = importGoogleOAuth({
        oauthJsonPath: values["oauth-json"],
        envPath: values["env-file"],
        publicUrl: values["public-url"],
        check: values.check,
      });
      console.log(
        values.check
          ? "OAuth Web client and callback checked. No configuration changed."
          : result.changed
            ? "Colab OAuth application settings updated in .env with mode 0600. No service was restarted."
            : "Colab OAuth application settings already match. No service was restarted.",
      );
    }
  } catch (error) {
    console.error(
      error instanceof ImportError
        ? error.message
        : "Could not import credentials. Check the file paths, ownership, permissions and any active import lock.",
    );
    process.exitCode = 1;
  }
}
