import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewSession } from "../src/review-session.ts";
import { acceptanceFixture, reviewFixture } from "./fixtures.ts";

const inputs = { projectId: "synthetic-project", ref: "option-a", token: "synthetic-owner-token" };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

async function localSession(fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
  const session = new ReviewSession(
    (url, init) =>
      url === "/api/session" ? Promise.resolve(response({}, 404)) : fetcher(url, init),
    "localhost",
  );
  await session.refreshSession();
  return session;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("review session", () => {
  it("binds native browser fetch to the global receiver", async () => {
    const fetcher = vi.fn<typeof fetch>(function (this: unknown, url) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(
        url === "/api/session" ? response({}, 404) : response(reviewFixture()),
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const session = new ReviewSession();
    await session.refreshSession();
    session.setInputs(inputs);
    await session.review();
    expect(session.getSnapshot().review?.option.revisionId).toBe("option-head-29");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["projectId", "ref", "token"] as const)(
    "ignores a late review after %s changes",
    async (field) => {
      const old = Promise.withResolvers<Response>();
      const fetcher = vi
        .fn<typeof fetch>()
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce(response(reviewFixture("new-option")));
      const session = await localSession(fetcher);
      session.setInputs(inputs);
      const first = session.review();
      session.setInputs({ ...inputs, [field]: "changed" });
      old.resolve(response(reviewFixture()));
      await first;
      expect(session.getSnapshot().review).toBeUndefined();
      session.setInputs({ ...inputs, ref: "new-option" });
      await session.review();
      expect(session.getSnapshot().review?.ref).toBe("new-option");
    },
  );

  it("does not let an older request replace a newer reviewed head", async () => {
    const old = Promise.withResolvers<Response>();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(response({ ...reviewFixture(), briefVersion: 8 }));
    const session = await localSession(fetcher);
    session.setInputs(inputs);
    const first = session.review();
    await session.review();
    old.resolve(response(reviewFixture()));
    await first;
    expect(session.getSnapshot().review?.briefVersion).toBe(8);
  });

  it("rejects a review for a different target and renders domain failures", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ ...reviewFixture(), projectId: "other-project" }))
      .mockResolvedValueOnce(response({ ok: false, code: "ref_not_found" }));
    const session = await localSession(fetcher);
    session.setInputs(inputs);
    await session.review();
    expect(session.getSnapshot().review).toBeUndefined();
    expect(session.getSnapshot().message).toContain("different project");
    await session.review();
    expect(session.getSnapshot().message).toBe("ref_not_found");
  });

  it.each(["stale_baseline", "invalid_option", "invalid_identity", "score_too_large"] as const)(
    "does not accept an ineligible %s option",
    async (code) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(response({ ...reviewFixture(), eligibility: { allowed: false, code } }));
      const session = await localSession(fetcher);
      session.setInputs(inputs);
      await session.review();
      await session.accept();
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("freezes exact intent, blocks double clicks/new reviews, and retries after token clearing", async () => {
    const sent = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<Response>();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(reviewFixture()))
      .mockImplementationOnce(() => {
        sent.resolve();
        return pending.promise;
      })
      .mockImplementationOnce((_url, init) =>
        Promise.resolve(response(acceptanceFixture(JSON.parse(init?.body as string)))),
      );
    const session = await localSession(fetcher);
    session.setInputs(inputs);
    await session.review();
    const accepting = session.accept();
    await sent.promise;
    await session.accept();
    await session.review();
    expect(fetcher).toHaveBeenCalledTimes(2);
    session.setInputs({ ...inputs, token: "" });
    pending.reject(new Error("reply lost"));
    await accepting;
    expect(session.getSnapshot().acceptance?.status).toBe("uncertain");
    const firstBody = fetcher.mock.calls[1]?.[1]?.body;
    expect(JSON.parse(firstBody as string)).toMatchObject({
      projectId: inputs.projectId,
      ref: "main",
      baseRevision: "main-head-13",
      requestId: expect.any(String),
      body: {
        sourceRef: "option-a",
        sourceRevisionId: "option-head-29",
        briefVersion: 7,
        baselineRevisionId: "main-head-13",
        evaluatorVersion: "2.0",
      },
    });
    session.setInputs({
      ...inputs,
      projectId: "edited-project",
      ref: "edited-ref",
      token: "other-token",
    });
    await session.retry();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot().message).toContain("same owner token");
    session.setInputs({ ...inputs, projectId: "edited-project", ref: "edited-ref" });
    await session.retry();
    expect(fetcher.mock.calls[2]?.[1]?.body).toBe(firstBody);
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
      credentials: "omit",
      headers: { Authorization: `Bearer ${inputs.token}`, "Content-Type": "application/json" },
    });
    expect(session.getSnapshot().acceptance).toMatchObject({
      status: "resolved",
      result: acceptanceFixture(JSON.parse(firstBody as string)),
    });
    expect(session.getSnapshot().review).toBeUndefined();
  });

  it("retains the original target and receipt when inputs are edited before a late success", async () => {
    const sent = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<Response>();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(reviewFixture()))
      .mockImplementationOnce(() => {
        sent.resolve();
        return pending.promise;
      });
    const session = await localSession(fetcher);
    session.setInputs(inputs);
    await session.review();
    const accepting = session.accept();
    await sent.promise;
    const intent = session.getSnapshot().acceptance?.intent;
    if (!intent) throw new Error("Missing acceptance intent");
    session.setInputs({ projectId: "different-project", ref: "different-ref", token: "" });
    await session.review();
    pending.resolve(response(acceptanceFixture(intent.input)));
    await accepting;
    expect(session.getSnapshot().acceptance).toEqual({
      status: "resolved",
      intent,
      result: acceptanceFixture(intent.input),
    });
    expect(session.getSnapshot().inputs.token).toBe("");
    expect(session.getSnapshot().review).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["unauthorized", "forbidden", "store_unavailable", "invalid_input", "request_conflict"])(
    "retains timeout intent when retry cannot resolve the ledger: %s",
    async (code) => {
      const sent = Promise.withResolvers<void>();
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response(reviewFixture()))
        .mockImplementationOnce((_url, init) => {
          sent.resolve();
          return new Promise((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new Error("timeout"))),
          );
        })
        .mockResolvedValueOnce(
          code === "unauthorized"
            ? response({ error: "unauthorized" }, 401)
            : response({ ok: false, code }),
        )
        .mockImplementationOnce((_url, init) =>
          Promise.resolve(response(acceptanceFixture(JSON.parse(init?.body as string)))),
        );
      const session = await localSession(fetcher);
      session.setInputs(inputs);
      await session.review();
      vi.useFakeTimers();
      const accepting = session.accept();
      await sent.promise;
      await vi.advanceTimersByTimeAsync(20_001);
      await accepting;
      expect(session.getSnapshot().acceptance?.status).toBe("uncertain");
      const intent = session.getSnapshot().acceptance?.intent;
      await session.retry();
      expect(session.getSnapshot().acceptance).toMatchObject({ status: "uncertain", intent });
      await session.retry();
      expect(session.getSnapshot().acceptance).toMatchObject({ status: "resolved", intent });
      expect(fetcher.mock.calls[2]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
      expect(fetcher.mock.calls[3]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
    },
  );

  it("does not send a new intent if inputs change while credentials are being fingerprinted", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(reviewFixture()));
    const session = await localSession(fetcher);
    session.setInputs(inputs);
    await session.review();
    const accepting = session.accept();
    session.setInputs({ ...inputs, ref: "changed-before-send" });
    await accepting;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().acceptance).toBeUndefined();
  });

  it("requires a new review/new intent after deterministic stale rejection", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(reviewFixture()))
      .mockResolvedValueOnce(response({ ok: false, code: "stale_base" }))
      .mockResolvedValueOnce(
        response({
          ...reviewFixture(),
          main: { ...reviewFixture().main, revisionId: "main-new-42" },
          baselineRevisionId: "main-new-42",
        }),
      )
      .mockResolvedValueOnce(response({ ok: false, code: "invalid_option" }));
    const session = await localSession(fetcher);
    session.setInputs(inputs);
    await session.review();
    await session.accept();
    expect(session.getSnapshot().message).toContain("Review again");
    await session.accept();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await session.review();
    await session.accept();
    const first = JSON.parse(fetcher.mock.calls[1]?.[1]?.body as string);
    const second = JSON.parse(fetcher.mock.calls[3]?.[1]?.body as string);
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.baseRevision).toBe("main-new-42");
  });
});
