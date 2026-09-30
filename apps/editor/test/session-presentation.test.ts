import type { CloudSession } from "@or1/tools";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import type { ReviewSession } from "../src/review-session.ts";

// Snapshot-only static rendering: the production editor is client-rendered, not an SSR app.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));
const rendering = vi.hoisted(() => ({ session: undefined as unknown as ReviewSession }));
vi.mock("../src/review-session.ts", () => ({
  ReviewSession: class {
    getSnapshot = () => rendering.session.getSnapshot();
    subscribe = (listener: () => void) => rendering.session.subscribe(listener);
    unresolved = () => rendering.session.unresolved();
  },
}));
const { ReviewSession: Controller } = await vi.importActual<
  typeof import("../src/review-session.ts")
>("../src/review-session.ts");

const expiresAt = Date.parse("2026-10-02T12:34:56Z");
const fixture = (authentication?: CloudSession["authentication"]): CloudSession => ({
  mode: "cloud",
  ...(authentication ? { authentication } : {}),
  principalId: "synthetic-viewer",
  expiresAt,
  projects: [
    {
      projectId: "synthetic-project",
      label: "Synthetic demo",
      membership: "viewer",
      refs: ["main", "option-a"],
      permissions: { canReview: true, canAccept: false },
    },
  ],
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const render = () => renderToStaticMarkup(createElement(App));
const expectDemo = (html: string) => {
  expect(html).toContain(
    "Public development demo · synthetic data only · read-only · not Access-authenticated",
  );
  expect(html).toContain('<time dateTime="2026-10-02T12:34:56.000Z">');
  expect(html).toContain("2026");
  expect(html).toContain(`(${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
  expect(html).not.toMatch(
    /Session verified|Use Cloudflare|sign in|login required|Access identity/,
  );
  expect(html).not.toContain("Local owner token");
  expect(html).not.toContain("Accept this option");
};

afterEach(() => vi.useRealTimers());

describe("session presentation", () => {
  it("preserves verified Access presentation but does not assert provenance during discovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-30T08:00:00Z"));
    rendering.session = new Controller(
      vi.fn<typeof fetch>().mockResolvedValue(response(fixture())),
      "pilot.example.com",
    );
    expect(render()).not.toMatch(/Access login|Session verified|sign in/);
    await rendering.session.refreshSession();
    const html = render();
    expect(html).toContain("Use Cloudflare Access login, not a shared owner token.");
    expect(html).toContain("Session verified · expires");
    expect(html).not.toContain("Public development demo");
  });

  it("renders the demo notice and full expiry without Access verification or login", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-30T08:00:00Z"));
    rendering.session = new Controller(
      vi.fn<typeof fetch>().mockResolvedValue(response(fixture("development-bypass"))),
      "demo.example.com",
    );
    await rendering.session.refreshSession();
    const html = render();
    expectDemo(html);
    expect(html).toContain("Review option");
    expect(html).toContain("Demo expiry:");
    expect(html).toMatch(/October 2|2 October/);
    expect(html).toMatch(/12:34:56|[0-9]:34:56/);
  });

  it("keeps safe demo presentation while refreshing and unavailable, with no review controls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-30T08:00:00Z"));
    const pending = Promise.withResolvers<Response>();
    rendering.session = new Controller(
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response(fixture("development-bypass")))
        .mockReturnValueOnce(pending.promise),
      "demo.example.com",
    );
    await rendering.session.refreshSession();
    const refresh = rendering.session.refreshSession();
    expectDemo(render());
    expect(render()).toContain("Checking demo availability…");
    expect(render()).not.toContain("Review option");
    pending.resolve(response({}, 404));
    await refresh;
    const html = render();
    expectDemo(html);
    expect(html).toContain("Public development demo unavailable or expired");
    expect(html).toContain("Reload page");
    expect(html).not.toContain("Review option");
  });

  it("renders expiry as disabled demo review, never a request to sign in", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-30T08:00:00Z"));
    rendering.session = new Controller(
      vi.fn<typeof fetch>().mockResolvedValue(response(fixture("development-bypass"))),
      "demo.example.com",
    );
    await rendering.session.refreshSession();
    vi.setSystemTime(expiresAt);
    rendering.session.expireSession();
    const html = render();
    expectDemo(html);
    expect(html).toContain("Public development demo expired. Review is disabled.");
    expect(html).not.toContain("Review option");
  });
});
