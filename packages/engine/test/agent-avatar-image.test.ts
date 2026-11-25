import { expect, test } from "bun:test";
import { validAgentImage } from "../src/agent-avatar-image";

// Complete 2×2 fixtures encoded from one solid-color image: baseline/progressive JPEG and lossy/lossless WebP.
const images = {
  JPEG: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDDooor7w+iP//Z",
  PROGRESSIVE_JPEG:
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUAQEAAAAAAAAAAAAAAAAAAAAF/9oADAMBAAIQAxAAAAGEPI//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAn//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AX//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/An//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IX//2gAMAwEAAgADAAAAEAP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==",
  WEBP: "UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+7gpn/srH0rH0rH7wX/yU1/jbjsAA",
  LOSSLESS_WEBP: "UklGRh4AAABXRUJQVlA4TBEAAAAvAUAAAAdQmWaWu/+BiOh/AAA=",
};
for (const [name, base64] of Object.entries(images)) {
  test(`accepts complete ${name} payloads`, () => {
    const bytes = Buffer.from(base64, "base64");
    expect(validAgentImage(bytes, name.includes("JPEG") ? "image/jpeg" : "image/webp", { width: 2, height: 2 })).toBe(
      true,
    );
  });
}

test("rejects plausible headers with no encoded image payload", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
    "base64",
  );
  expect(validAgentImage(png, "image/png", { width: 1, height: 1 })).toBe(true);
  expect(
    validAgentImage(Buffer.concat([png.subarray(0, 33), png.subarray(-12)]), "image/png", { width: 1, height: 1 }),
  ).toBe(false);
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0);
  webp.writeUInt32LE(22, 4);
  webp.write("WEBPVP8X", 8);
  webp.writeUInt32LE(10, 16);
  expect(validAgentImage(webp, "image/webp", { width: 1, height: 1 })).toBe(false);
  const jpeg = Buffer.from(images.JPEG, "base64");
  const noScan = Buffer.concat([jpeg.subarray(0, jpeg.indexOf(Buffer.from([0xff, 0xda]))), Buffer.from([0xff, 0xd9])]);
  expect(validAgentImage(noScan, "image/jpeg", { width: 2, height: 2 })).toBe(false);
});

test("PNG integrity includes checksums and its decompressed scanline length", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
    "base64",
  );
  expect(validAgentImage(png, "image/png", { width: 2, height: 2 })).toBe(false);
  png[41] = (png[41] ?? 0) ^ 0xff;
  expect(validAgentImage(png, "image/png", { width: 1, height: 1 })).toBe(false);
});
