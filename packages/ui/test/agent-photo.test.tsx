import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { cleanup, fireEvent, render } from "@testing-library/react";
import { Avatar } from "../src/components/Avatar";

afterEach(() => cleanup());

const portrait = "/api/app/agent-avatars/org/agent/original.png";
const look = { color: "rose", eyes: "happy", accessory: "crown" } as const;

describe("agent photos", () => {
  test("a photo keeps the labelled agent, work state and presence badge at every size", () => {
    for (const size of ["xs", "sm", "md", "lg", "xl"] as const) {
      const { container, unmount, getByRole } = render(
        <Avatar
          kind="agent"
          name="Elliott | Inbox and Correspondence"
          labelled
          size={size}
          imageUrl={portrait}
          appearance={look}
          state="thinking"
          presence="busy"
          presenceLabel="Working"
        />,
      );
      const avatar = getByRole("img", { name: "Elliott | Inbox and Correspondence" });
      expect(avatar.querySelector("img")?.getAttribute("src")).toBe(portrait);
      expect(avatar.querySelector("canvas")).toBeNull();
      expect(avatar.classList.contains("ac-avatar--photo")).toBe(true);
      expect(avatar.classList.contains("ac-avatar--running")).toBe(true);
      expect(container.querySelector('.ac-avatar__badge [data-presence="busy"]')).not.toBeNull();
      expect(avatar.querySelector("img")?.getAttribute("alt")).toBe("");
      unmount();
    }
  });

  test("a failed photo restores the saved pixel appearance and keeps state and presence", () => {
    const { container } = render(
      <Avatar kind="agent" name="Henry" imageUrl={portrait} appearance={look} state="waiting" presence="online" />,
    );
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    const avatar = container.querySelector(".ac-avatar") as HTMLElement;
    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.querySelector("canvas.ac-avatar__canvas")).not.toBeNull();
    expect(avatar.classList.contains("ac-avatar--photo")).toBe(false);
    expect(avatar.getAttribute("data-state")).toBe("waiting");
    expect(avatar.getAttribute("data-eyes")).toBe("happy");
    expect(avatar.getAttribute("data-accessory")).toBe("crown");
    expect(avatar.querySelector('[data-presence="online"]')).not.toBeNull();
  });

  test("a replacement retries after an image failure; removal returns to the original look", () => {
    const { container, rerender } = render(<Avatar kind="agent" name="Arjun" imageUrl={portrait} appearance={look} />);
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    const replacement = "/api/app/agent-avatars/org/agent/replacement.png";
    rerender(<Avatar kind="agent" name="Arjun" imageUrl={replacement} appearance={look} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(replacement);
    expect(container.querySelector("canvas")).toBeNull();
    rerender(<Avatar kind="agent" name="Arjun" imageUrl={null} appearance={look} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("canvas")).not.toBeNull();
    // Re-applying even the previously failed address gets a new attempt.
    rerender(<Avatar kind="agent" name="Arjun" imageUrl={portrait} appearance={look} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(portrait);
  });

  test("an agent with no photo keeps its pixel canvas; a person's photo stays a photo", () => {
    const { container, rerender } = render(<Avatar kind="agent" name="Jasper" appearance={look} />);
    expect(container.querySelector("canvas.ac-avatar__canvas")).not.toBeNull();
    expect(container.querySelector(".ac-avatar--photo")).toBeNull();
    rerender(<Avatar name="James" imageUrl="/person.png" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/person.png");
    expect(container.querySelector("canvas")).toBeNull();
  });
});
