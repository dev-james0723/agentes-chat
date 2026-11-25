import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectCdp, deadline, launch } from "./browser";
import {
  bundleCss,
  cdpTransport,
  compare,
  coverage,
  cssSheets,
  DESKTOP_ONLY,
  edgesOf,
  keyOf,
  lasting,
  PHONE_ONLY,
  playwrightChromes,
  SELF_TESTED,
} from "./check";
import { runBounded, stageLimit } from "./run-bounded.mjs";

describe("CDP request deadlines", () => {
  // A deterministic mock transport: no browser, network or slow CI startup required.
  function socket() {
    const sent: string[] = [];
    const mock = {
      readyState: WebSocket.OPEN,
      send: (data: string) => {
        sent.push(data);
      },
      onmessage: (_event: { data: string }) => {},
      onclose: () => {},
      onerror: () => {},
    };
    return { mock, sent, send: cdpTransport(mock as unknown as WebSocket, 20) };
  }
  test("returns a matching result and clears its deadline", async () => {
    const { mock, sent, send } = socket();
    const result = send<{ value: number }>("Runtime.evaluate", {}, "page-1");
    const request = JSON.parse(sent[0] as string);
    mock.onmessage({ data: JSON.stringify({ id: request.id, result: { value: 7 } }) });
    expect(await result).toEqual({ value: 7 });
  });
  test("fails a stalled command with its method and session, rather than waiting forever", async () => {
    const { send } = socket();
    await expect(send("Runtime.evaluate", {}, "page-2")).rejects.toThrow(/CDP timeout.*Runtime.evaluate.*page-2/);
  });
  test("connection loss rejects every pending request and later sends fail immediately", async () => {
    const { mock, send } = socket();
    const a = send("Page.navigate");
    const b = send("Runtime.evaluate");
    mock.readyState = WebSocket.CLOSED;
    mock.onclose();
    const results = await Promise.allSettled([a, b]);
    expect(results.every((r) => r.status === "rejected" && String(r.reason).includes("WebSocket closed"))).toBe(true);
    await expect(send("Page.navigate")).rejects.toThrow("CDP socket is not open");
  });
});

describe("geometry check", () => {
  test("a new offender is new at its width, and words or size never make one", () => {
    const f = { rule: "edge", el: "a.ac-btn", box: "li.home-row", px: 1, text: "Abrir" };
    expect(keyOf(f, 320)).toBe("edge@320 a.ac-btn in li.home-row");
    expect(keyOf({ ...f, px: 5, text: "Responder" }, 320)).toBe(keyOf(f, 320));
    expect(keyOf(f, 1280)).not.toBe(keyOf(f, 320));
  });

  test("a finding named only by the kit's classes is keyed by its place too, so one entry can't excuse every screen", () => {
    const f = { rule: "edge", el: "button.ac-btn.ac-btn--sm", box: "section.ac-card", px: -93 };
    expect(keyOf({ ...f, at: "div.ai-panel" }, 320)).toBe(
      "edge@320 button.ac-btn.ac-btn--sm in section.ac-card at div.ai-panel",
    );
    expect(keyOf({ ...f, at: "div.home-row" }, 320)).not.toBe(keyOf({ ...f, at: "div.ai-panel" }, 320));
  });

  test("a sliver gone in a taller window was content as long as the window, not the layout: only one that stays fails", () => {
    const sliver = (el: string, box?: string) => ({ rule: "sliver", el, ...(box ? { box } : {}), px: 2 });
    const edge = { rule: "edge", el: "a.ac-btn", box: "li.home-row", px: 1 };
    const found = [sliver("main.shell__main"), sliver("div", "div.ac-menu.ac-menu--select"), edge];
    expect(lasting(found, [sliver("div", "div.ac-menu.ac-menu--select")], 1280)).toEqual([found[1], edge]);
    // Named by the box around it, a nameless one excuses no other nameless box.
    expect(keyOf(found[1] as (typeof found)[number], 320)).toBe("sliver@320 div in div.ac-menu.ac-menu--select");
  });

  test("only what the baseline doesn't know fails; what got fixed is listed", () => {
    expect(compare(["a", "b", "b"], ["b", "c"])).toEqual({ fresh: ["a"], gone: ["c"] });
  });

  test("with no Chrome installed, Playwright's newest Chromium will do", () => {
    const home = mkdtempSync(join(tmpdir(), "geometry-home-"));
    for (const v of ["1200", "1248"]) {
      const dir = join(home, ".cache/ms-playwright", `chromium-${v}`, "chrome-linux");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "chrome"), "#!/bin/sh\n");
    }
    const was = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(playwrightChromes()[0]).toBe(join(home, ".cache/ms-playwright/chromium-1248/chrome-linux/chrome"));
    } finally {
      process.env.HOME = was;
    }
  });

  test("a pair is a parent and a child with their classes, void tags closing themselves", () => {
    const edges = edgesOf('<ul class="list"><li><input class="x"><b>a</b></li></ul>');
    expect([...edges]).toEqual(["root>ul.list", "ul.list>li.", "li.>input.x", "li.>b."]);
  });

  test("a screen that adds no new pair isn't laid out again, whatever order they came in", () => {
    const html: Record<string, string> = {
      a: '<div class="a"><span class="c"></span></div>',
      b: '<div class="a"><span class="c"></span></div><div class="a"></div>',
      c: '<div class="a"><em></em></div>',
    };
    expect(coverage(["c", "b", "a"], (name) => html[name] as string)).toEqual(["a", "c"]);
  });

  test("every rule the run checks has an offender and a sound twin in the fixture, the floating panes, cards' sides, icon gaps and square icon buttons too", () => {
    const fixture = readFileSync(join(import.meta.dir, "fixture.html"), "utf8");
    const rules = readFileSync(join(import.meta.dir, "rules.js"), "utf8");
    const check = readFileSync(join(import.meta.dir, "check.ts"), "utf8");
    for (const rule of ["floating", "inset", "icongap", "square"]) expect(SELF_TESTED).toContain(rule);
    for (const rule of ["squarecol", "rim", "inlinebase", "iconmid", "fieldwidth", "corner", "clip", "cascadeorder"])
      expect(SELF_TESTED).toContain(rule);
    for (const rule of ["pagetop", "groupedge", "menuitem", "rowpad", "emptyselect", "toolorder", "toolrow", "captop"])
      expect(SELF_TESTED).toContain(rule);
    for (const rule of ["timeedge", "panefill", "bleed", "stampout", "stampover"]) expect(SELF_TESTED).toContain(rule);
    // Words squeezed beside actions, a lone main button on a phone, buttons 8 apart and never split by words before
    // them, one height in a row, a fact on one line, Desfazer in its sentence, a count that calls on someone readable
    // on what's behind it.
    for (const rule of [
      "squeeze",
      "loneprimary",
      "btngap",
      "btnsplit",
      "toolheight",
      "factwrap",
      "undoinline",
      "countfill",
    ])
      expect(SELF_TESTED).toContain(rule);
    // A calendar item never covers another: what meets sits beside it.
    expect(SELF_TESTED).toContain("calstack");
    // The working line's stop is at its end before its time comes, not beside its words.
    expect(SELF_TESTED).toContain("barend");
    // A task card's line of facts wraps between facts, never inside one.
    for (const twin of ["bad-factwrap--line", "good-factwrap--line"]) expect(fixture).toContain(twin);
    // A title in a row that wraps a word a line is squeezed; one long address wrapping its full lines is not.
    for (const twin of ["bad-wordwrap--row", "good-wordwrap--url"]) expect(fixture).toContain(twin);
    expect(rules).toContain('".ac-facts__value, .ac-factline__fact"');
    // A word broken at its syllables in a box that hyphenates (a narrow calendar item's title) is no midword.
    expect(fixture).toContain("good-midword--hyphens");
    // The face on a menu's top that changes the photo (`MenuFace`) is no row: neither its height nor its room.
    for (const twin of ["good-menuitem--face", "good-rim--face"]) expect(fixture).toContain(twin);
    for (const rule of SELF_TESTED) {
      expect(fixture).toContain(`bad-${rule}`);
      expect(fixture).toContain(`good-${rule}`);
      expect(`${rules}${check}`).toContain(`rule: "${rule}"`);
    }
  });

  test("the self-test runs every rule at every checked width, but a desktop-only rule at the phone's and a phone-only one at a desktop's", () => {
    const check = readFileSync(join(import.meta.dir, "check.ts"), "utf8");
    expect(check).toMatch(/async function selfTest[\s\S]*for \(const width of WIDTHS\)/);
    expect(check).toContain(
      "const here = (r: string) => (width >= 640 ? !PHONE_ONLY.includes(r) : !DESKTOP_ONLY.includes(r));",
    );
    expect(DESKTOP_ONLY).toEqual(["floating", "toolorder"]);
    expect(PHONE_ONLY).toEqual(["loneprimary"]);
    for (const rule of [...DESKTOP_ONLY, ...PHONE_ONLY]) expect(SELF_TESTED).toContain(rule);
    // The rule itself says nothing at a desktop's width, so a screen never fails it there.
    const rules = readFileSync(join(import.meta.dir, "rules.js"), "utf8");
    expect(rules).toMatch(/loneprimary\(out\) \{\s*if \(innerWidth >= 640\) return;/);
  });

  test("the self-test opens a card, a popover, a dialog and a list over each other: each must be the topmost", () => {
    const check = readFileSync(join(import.meta.dir, "check.ts"), "utf8");
    const rules = readFileSync(join(import.meta.dir, "rules.js"), "utf8");
    expect(check).toMatch(/async function selfTest[\s\S]*for \(const width of WIDTHS\)[\s\S]*geometry\.layers\(\)/);
    expect(rules).toContain('["a dialog from the popover", dialog]');
    expect(rules).toContain("document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)");
  });

  test("a captured toolbar stacks where the app's does: rules.js measures one row as Toolbar.tsx's fitsOneRow", () => {
    const rules = readFileSync(join(import.meta.dir, "rules.js"), "utf8");
    const toolbar = readFileSync(join(import.meta.dir, "../../packages/ui/src/components/Toolbar.tsx"), "utf8");
    for (const part of [
      'display !== "none"',
      ".columnGap",
      'classList.contains("ac-toolbar__search")',
      ".minWidth",
      "p.getBoundingClientRect().width",
      "need <= bar.clientWidth + 0.5",
    ]) {
      expect(rules).toContain(part);
      expect(toolbar).toContain(part);
    }
    // Stacked, the top row keeps the search at its floor beside the actions, or the search takes it alone (`split`).
    for (const part of [
      'querySelector(":scope > .ac-toolbar__actions")',
      "floor + gap + actions.getBoundingClientRect().width <= bar.clientWidth - 0.5",
      '"data-stack", topRowFits(',
    ]) {
      expect(rules).toContain(part);
      expect(toolbar).toContain(part);
    }
    expect(rules).toMatch(/detect\(\) \{\s*stackToolbars\(\);/);
    expect(rules).toMatch(/styles\(\) \{\s*stackToolbars\(\);/);
  });

  test("the reverse CSS order holds the same sheets: the page sheets backwards, then the app's entry last", () => {
    const app = cssSheets("app");
    const reverse = cssSheets("reverse");
    expect(app[0]).toBe("src/styles.css");
    expect(reverse.at(-1)).toBe("src/styles.css");
    expect([...reverse].sort()).toEqual([...app].sort());
    expect(reverse.slice(0, -1)).toEqual(app.slice(1).reverse());
    expect(app.length).toBeGreaterThan(10);
  });

  test("cascadeorder's twin sheets: a tie that flips with the order, and a layered rule that loses either way", () => {
    const a = readFileSync(join(import.meta.dir, "fixture-a.css"), "utf8");
    const b = readFileSync(join(import.meta.dir, "fixture-b.css"), "utf8");
    expect(a).toMatch(/\.bad-cascadeorder \{\s*padding-left: 4px;/);
    expect(a).toMatch(/@layer base \{\s*\.good-cascadeorder \{\s*padding-left: 4px;/);
    expect(b).toMatch(/\.bad-cascadeorder \{\s*padding-left: 8px;/);
    expect(b).toMatch(/\.good-cascadeorder \{\s*padding-left: 8px;/);
  });

  test("the check's CSS keeps the kit and the app's base sheets in their layer, as the build does", async () => {
    const out = mkdtempSync(join(tmpdir(), "geometry-css-"));
    const css = readFileSync(join(out, await bundleCss(out)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const blocks: [string, number, number][] = [];
    for (const m of css.matchAll(/@layer\s+([\w-]+)\s*\{/g)) {
      let depth = 0;
      let end = m.index + m[0].length - 1;
      for (; end < css.length; end++) {
        if (css[end] === "{") depth++;
        else if (css[end] === "}" && --depth === 0) break;
      }
      blocks.push([m[1] as string, m.index, end]);
    }
    const layerOf = (selector: RegExp) => {
      const at = css.search(selector);
      expect(at).toBeGreaterThanOrEqual(0);
      return blocks.find(([, start, end]) => at > start && at < end)?.[0];
    };
    expect(layerOf(/\n\s*\.ac-card\s*\{/)).toBe("base");
    expect(layerOf(/\n\s*\.page-title\s*\{/)).toBe("base");
    expect(layerOf(/\n\s*\.roles-list\s*\{/)).toBeUndefined();
  });
});

describe("geometry browser anti-stall", () => {
  const socketServer = (mode: "reply" | "silent" | "close" | "malformed") =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return;
        return new Response("websocket only", { status: 426 });
      },
      websocket: {
        message(ws, data) {
          if (mode === "close") ws.close();
          else if (mode === "malformed") ws.send("{bad json");
          else if (mode === "reply") {
            const request = JSON.parse(String(data));
            ws.send(JSON.stringify({ id: request.id, result: { method: request.method } }));
          }
        },
      },
    });

  test("a normal CDP request resolves and close is idempotent", async () => {
    const server = socketServer("reply");
    try {
      const cdp = await connectCdp(`ws://127.0.0.1:${server.port}`, { callMs: 1_000 });
      try {
        expect(await cdp.send("Target.getTargets")).toEqual({ method: "Target.getTargets" });
      } finally {
        cdp.close();
        cdp.close();
      }
      await expect(cdp.send("Runtime.evaluate")).rejects.toThrow("closed");
    } finally {
      server.stop(true);
    }
  });

  test("a silent CDP request fails within its deadline and rejects every outstanding call", async () => {
    const server = socketServer("silent");
    try {
      const cdp = await connectCdp(`ws://127.0.0.1:${server.port}`, { callMs: 150 });
      const began = Date.now();
      const results = await Promise.allSettled([cdp.send("Runtime.evaluate"), cdp.send("Target.getTargets")]);
      expect(results.every((r) => r.status === "rejected" && String(r.reason).includes("timed out"))).toBe(true);
      expect(Date.now() - began).toBeLessThan(4_000);
      await expect(cdp.send("Page.navigate")).rejects.toThrow("timed out");
    } finally {
      server.stop(true);
    }
  });

  for (const mode of ["close", "malformed"] as const) {
    test(`a ${mode} CDP transport rejects pending requests instead of waiting forever`, async () => {
      const server = socketServer(mode);
      try {
        const cdp = await connectCdp(`ws://127.0.0.1:${server.port}`, { callMs: 1_000 });
        const result = await Promise.allSettled([cdp.send("Runtime.evaluate"), cdp.send("Page.navigate")]);
        expect(result.every((r) => r.status === "rejected")).toBe(true);
        await expect(cdp.send("Target.getTargets")).rejects.toThrow();
      } finally {
        server.stop(true);
      }
    });
  }

  test("aborting a run rejects pending CDP operations and disallows new work", async () => {
    const server = socketServer("silent");
    const controller = new AbortController();
    try {
      const cdp = await connectCdp(`ws://127.0.0.1:${server.port}`, { signal: controller.signal, callMs: 5_000 });
      const pending = cdp.send("Runtime.evaluate");
      controller.abort(new Error("stage canceled"));
      await expect(pending).rejects.toThrow("stage canceled");
      await expect(cdp.send("Page.navigate")).rejects.toThrow("stage canceled");
    } finally {
      server.stop(true);
    }
  });

  test("a websocket handshake that never completes has a hard deadline", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      await expect(connectCdp(`ws://127.0.0.1:${server.port}`, { connectMs: 150 })).rejects.toThrow(
        "CDP connect: timed out",
      );
    } finally {
      server.stop(true);
    }
  });

  test("a Chrome process that never publishes its endpoint is terminated", async () => {
    const root = mkdtempSync(join(tmpdir(), "geometry-silent-chrome-"));
    try {
      const bin = join(root, "fake-chrome");
      const profile = join(root, "profile");
      // The OS may schedule the fixture only after the short startup deadline.
      // Read the real spawned PID from the launcher's failure, not a child-written file.
      writeFileSync(bin, "#!/bin/sh\nexec /bin/sleep 60\n");
      chmodSync(bin, 0o700);
      const failure = await launch(bin, profile, { startupMs: 250, closeMs: 1_000 }).then(
        () => {
          throw new Error("The silent browser unexpectedly started");
        },
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      const match = /Chrome startup: timed out after 250ms \(pid=(\d+)\)/.exec((failure as Error).message);
      expect(match).not.toBeNull();
      const pid = Number(match?.[1]);
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an already aborted deadline still consumes late promise rejections", async () => {
    const controller = new AbortController();
    controller.abort(new Error("canceled"));
    await expect(deadline("test", Promise.reject(new Error("late")), 500, controller.signal)).rejects.toThrow(
      "canceled",
    );
  });

  test("the independent watchdog propagates successful and failing child exits", async () => {
    const node = Bun.which("node");
    if (!node) throw new Error("node is required by local CI");
    expect(await runBounded(node, ["-e", "process.exit(0)"], { ms: 5_000, graceMs: 250 })).toBe(0);
    expect(await runBounded(node, ["-e", "process.exit(7)"], { ms: 5_000, graceMs: 250 })).toBe(7);
    expect(() => stageLimit("0")).toThrow();
    expect(() => stageLimit("540001")).toThrow();
  });

  test("the watchdog waits its grace for a runner's helpers to exit, and fails only on one that stays", async () => {
    const node = Bun.which("node");
    if (!node) throw new Error("node is required by local CI");
    // A helper in the runner's group that exits a moment after the runner, as Chrome's do after close().
    const brief = `require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},300)"],{stdio:"ignore"}).unref();process.exit(0)`;
    expect(await runBounded(node, ["-e", brief], { ms: 5_000, graceMs: 2_000 })).toBe(0);
    // One that never exits is a leak: the stage fails and the helper is stopped.
    const stuck = `require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}).unref();process.exit(0)`;
    const started = Date.now();
    expect(await runBounded(node, ["-e", stuck], { ms: 5_000, graceMs: 300 })).toBe(1);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  test("the independent watchdog kills even an unresponsive child that ignores TERM", async () => {
    const node = Bun.which("node");
    if (!node) throw new Error("node is required by local CI");
    const root = mkdtempSync(join(tmpdir(), "geometry-watchdog-"));
    try {
      const pidFile = join(root, "pid");
      const code = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)`;
      const started = Date.now();
      expect(await runBounded(node, ["-e", code], { ms: 800, graceMs: 250 })).toBe(124);
      expect(Date.now() - started).toBeLessThan(5_000);
      const pid = Number(readFileSync(pidFile, "utf8"));
      for (let i = 0; i < 20; i++) {
        try {
          process.kill(pid, 0);
          await Bun.sleep(50);
        } catch {
          break;
        }
      }
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
