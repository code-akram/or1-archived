import type { CloudSession } from "@or1/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewSession } from "../src/review-session.ts";
import { reviewFixture } from "./fixtures.ts";

const cloudFixture = (principalId = "access-owner"): CloudSession => ({
  mode: "cloud",
  principalId,
  expiresAt: Date.now() + 60_000,
  projects: [
    {
      projectId: "synthetic-project",
      label: "Synthetic demo",
      membership: "owner",
      refs: ["main", "option-a"],
      permissions: { canReview: true, canAccept: false },
    },
    {
      projectId: "second-demo",
      label: "Second synthetic project",
      membership: "viewer",
      refs: ["option-b"],
      permissions: { canReview: true, canAccept: false },
    },
  ],
});
const response = (body: unknown, principalId?: string, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: principalId ? { "X-Or1-Principal-Id": principalId } : {},
  });

afterEach(() => vi.useRealTimers());

describe("cloud session", () => {
  it("discovers assigned projects and uses cookies without any bearer or role", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(cloudFixture()))
      .mockResolvedValueOnce(response(reviewFixture(), "access-owner"));
    const session = new ReviewSession(fetcher, "pilot.example.com");
    session.setInputs({ projectId: "unassigned", ref: "option-a", token: "never-send" });
    await session.review();
    await session.accept();
    await session.retry();
    expect(fetcher).not.toHaveBeenCalled();
    await session.refreshSession();
    expect(session.getSnapshot().inputs).toEqual({
      projectId: "synthetic-project",
      ref: "option-a",
      token: "",
    });
    await session.review();
    expect(session.getSnapshot().review?.option.revisionId).toBe("option-head-29");
    expect(fetcher.mock.calls[0]).toEqual([
      "/api/session",
      expect.objectContaining({ credentials: "same-origin", redirect: "error" }),
    ]);
    expect(fetcher.mock.calls[1]).toEqual([
      "/api/tools/review_option",
      expect.objectContaining({
        credentials: "same-origin",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "synthetic-project", ref: "option-a" }),
      }),
    ]);
    await session.accept();
    await session.retry();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("restricts project navigation but permits unlisted refs for whole-project membership", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(cloudFixture()))
      .mockResolvedValueOnce(
        response({ ...reviewFixture("unlisted-ref"), projectId: "second-demo" }, "access-owner"),
      );
    const session = new ReviewSession(fetcher, "pilot.example.com");
    await session.refreshSession();
    session.setInputs({ projectId: "unassigned", ref: "unknown", token: "ignored" });
    expect(session.getSnapshot().inputs.projectId).toBe("synthetic-project");
    session.setInputs({ projectId: "second-demo", ref: "option-a", token: "ignored" });
    expect(session.getSnapshot().inputs).toEqual({
      projectId: "second-demo",
      ref: "option-b",
      token: "",
    });
    session.setInputs({ ...session.getSnapshot().inputs, ref: "unlisted-ref" });
    await session.review();
    expect(session.getSnapshot().review?.ref).toBe("unlisted-ref");
    await session.accept();
    await session.retry();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["owner", "viewer"] as const)(
    "guards accept and retry independently of UI eligibility, tokens or a stale intent: %s",
    async (membership) => {
      const localFetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response({}, undefined, 404))
        .mockResolvedValueOnce(response(reviewFixture()))
        .mockRejectedValueOnce(new Error("lost local acceptance reply"));
      const local = new ReviewSession(localFetcher, "localhost");
      await local.refreshSession();
      local.setInputs({ projectId: "synthetic-project", ref: "option-a", token: "local-token" });
      await local.review();
      await local.accept();
      expect(local.getSnapshot().acceptance?.status).toBe("uncertain");
      const fixture = cloudFixture();
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          response({ ...fixture, projects: [{ ...fixture.projects[0], membership }] }),
        )
        .mockResolvedValueOnce(response(reviewFixture(), "access-owner"));
      const cloud = new ReviewSession(fetcher, "pilot.example.com");
      await cloud.refreshSession();
      await cloud.review();
      // Deliberately retain stale local UI data: controller mode must still prohibit mutations.
      cloud.getSnapshot().inputs.token = "local-token";
      expect(cloud.getSnapshot().review?.eligibility.allowed).toBe(true);
      await cloud.accept();
      cloud.getSnapshot().acceptance = local.getSnapshot().acceptance;
      await cloud.retry();
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["401", () => response({}, undefined, 401)],
    ["public 404", () => response({}, undefined, 404)],
    ["redirect", () => new Response(null, { status: 302 })],
    ["login HTML", () => new Response("<!doctype html><title>Access login</title>")],
    [
      "missing projects",
      () => response({ mode: "cloud", principalId: "a", expiresAt: Date.now() + 1000 }),
    ],
    [
      "mutable permissions",
      () =>
        response({
          ...cloudFixture(),
          projects: [
            { ...cloudFixture().projects[0], permissions: { canReview: true, canAccept: true } },
          ],
        }),
    ],
    ["expired", () => response({ ...cloudFixture(), expiresAt: Date.now() })],
  ] as const)(
    "fails closed for %s and allows explicit recovery without a fetch loop",
    async (_name, makeResponse) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(makeResponse())
        .mockResolvedValueOnce(response(cloudFixture()));
      const session = new ReviewSession(fetcher, "pilot.example.com");
      await session.refreshSession();
      expect(session.getSnapshot().mode).toBe("blocked");
      expect(session.getSnapshot().cloudSession).toBeUndefined();
      expect(session.getSnapshot().message).toContain("Cloudflare Access login");
      session.setInputs({ projectId: "synthetic-project", ref: "option-a", token: "forbidden" });
      await session.review();
      await session.accept();
      await session.retry();
      expect(fetcher).toHaveBeenCalledTimes(1);
      await session.refreshSession();
      expect(session.getSnapshot().mode).toBe("cloud");
      expect(session.getSnapshot().message).toBe("");
    },
  );

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "allows only an initial loopback 404 to select local mode: %s",
    async (hostname) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({}, undefined, 404));
      const session = new ReviewSession(fetcher, hostname);
      await session.refreshSession();
      expect(session.getSnapshot().mode).toBe("local");
      session.setInputs({ projectId: "local", ref: "option-a", token: "owner" });
      await session.refreshSession();
      expect(session.getSnapshot().inputs.token).toBe("owner");
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("never degrades a known cloud session to local mode on a subsequent loopback 404", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(cloudFixture()))
      .mockResolvedValueOnce(response({}, undefined, 404));
    const session = new ReviewSession(fetcher, "localhost");
    await session.refreshSession();
    await session.refreshSession();
    expect(session.getSnapshot().mode).toBe("blocked");
  });

  it.each([undefined, "other-principal"])(
    "rejects a missing or mismatched review identity header: %s",
    async (header) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response(cloudFixture()))
        .mockResolvedValueOnce(response(reviewFixture(), header));
      const session = new ReviewSession(fetcher, "pilot.example.com");
      await session.refreshSession();
      await session.review();
      expect(session.getSnapshot().review).toBeUndefined();
      expect(session.getSnapshot().message).toContain("identity changed");
    },
  );

  it.each(["success", "unauthorized"])(
    "discards cross-principal late %s without replacing the new session",
    async (outcome) => {
      const late = Promise.withResolvers<Response>();
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response(cloudFixture()))
        .mockReturnValueOnce(late.promise)
        .mockResolvedValueOnce(response(cloudFixture("second-principal")))
        .mockResolvedValueOnce(
          response({ ...reviewFixture(), briefVersion: 9 }, "second-principal"),
        );
      const session = new ReviewSession(fetcher, "pilot.example.com");
      await session.refreshSession();
      const oldReview = session.review();
      await session.refreshSession();
      expect(session.getSnapshot().review).toBeUndefined();
      await session.review();
      late.resolve(
        outcome === "success"
          ? response(reviewFixture(), "access-owner")
          : response({}, undefined, 401),
      );
      await oldReview;
      expect(session.getSnapshot().mode).toBe("cloud");
      expect(session.getSnapshot().cloudSession?.principalId).toBe("second-principal");
      expect(session.getSnapshot().review?.briefVersion).toBe(9);
      expect(session.getSnapshot().message).toBe("");
    },
  );

  it("invalidates reviews immediately on refresh and deduplicates overlapping return events", async () => {
    const refreshing = Promise.withResolvers<Response>();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(cloudFixture()))
      .mockResolvedValueOnce(response(reviewFixture(), "access-owner"))
      .mockReturnValueOnce(refreshing.promise);
    const session = new ReviewSession(fetcher, "pilot.example.com");
    await session.refreshSession();
    await session.review();
    const refresh = session.refreshSession();
    await session.refreshSession();
    await session.review();
    expect(session.getSnapshot().review).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(3);
    refreshing.resolve(response(cloudFixture()));
    await refresh;
    expect(session.getSnapshot().mode).toBe("cloud");
  });

  it("guards expiry at the exact boundary, discards late results, and permits return refresh", async () => {
    vi.useFakeTimers();
    const late = Promise.withResolvers<Response>();
    const expiresAt = Date.now() + 500;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ ...cloudFixture(), expiresAt }))
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce(response({ ...cloudFixture(), expiresAt: expiresAt + 60_000 }));
    const session = new ReviewSession(fetcher, "pilot.example.com");
    await session.refreshSession();
    await vi.advanceTimersByTimeAsync(499);
    session.expireSession();
    expect(session.getSnapshot().mode).toBe("cloud");
    const reviewing = session.review();
    await vi.advanceTimersByTimeAsync(1);
    await session.review();
    expect(session.getSnapshot().mode).toBe("blocked");
    late.resolve(response(reviewFixture(), "access-owner"));
    await reviewing;
    expect(session.getSnapshot().review).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await session.refreshSession();
    expect(session.getSnapshot().mode).toBe("cloud");
    expect(session.getSnapshot().message).toBe("");
  });

  it("blocks on a current unauthorized review and clears the error after login refresh", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(cloudFixture()))
      .mockResolvedValueOnce(response({}, undefined, 401))
      .mockResolvedValueOnce(response(cloudFixture()));
    const session = new ReviewSession(fetcher, "pilot.example.com");
    await session.refreshSession();
    await session.review();
    expect(session.getSnapshot().mode).toBe("blocked");
    expect(session.getSnapshot().message).toContain("login required");
    await session.refreshSession();
    expect(session.getSnapshot().message).toBe("");
  });
});
