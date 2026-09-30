import type { Brief, Scorecard } from "@or1/core";
import type { PlanReview } from "@or1/tools";
import { useEffect, useState, useSyncExternalStore } from "react";
import { PlanSvg } from "./PlanSvg.tsx";
import { comparisonBounds } from "./plan.ts";
import { ReviewSession } from "./review-session.ts";
import { Studio } from "./Studio.tsx";
import { StudioSession } from "./studio-session.ts";
import "./style.css";

export function App() {
  const [session] = useState(() => new ReviewSession());
  // One credential in page memory: the studio reads the review session's token on every call.
  const [studio] = useState(() => new StudioSession(() => session.getSnapshot().inputs.token));
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { inputs, review, acceptance } = state;
  useEffect(() => {
    if (state.mode !== "local") return;
    // `pnpm studio` prints a link with the token in the fragment, which is never sent over HTTP.
    // Adopt it into memory once and remove it from the address bar and history entry.
    const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
    if (!token) return;
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    session.setInputs({ ...session.getSnapshot().inputs, token });
  }, [session, state.mode]);
  useEffect(() => {
    if (state.mode !== "local") return;
    if (inputs.token.length < 32) {
      studio.disconnect();
      return;
    }
    const timer = window.setTimeout(() => void studio.connect(), 250);
    return () => window.clearTimeout(timer);
  }, [studio, state.mode, inputs.token]);
  useEffect(() => {
    if (acceptance?.status === "resolved") void studio.refresh();
  }, [studio, acceptance]);
  useEffect(() => () => studio.stopPolling(), [studio]);
  const unresolved = session.unresolved();
  const developmentDemo = state.developmentDemoExpiresAt !== undefined;
  const accessSession = !developmentDemo && state.cloudSession !== undefined;
  useEffect(() => {
    void session.refreshSession();
    const refresh = () => {
      if (document.visibilityState === "visible") void session.refreshSession();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [session]);
  useEffect(() => {
    if (state.mode !== "cloud" || !state.cloudSession) return;
    const timeout = window.setTimeout(
      () => session.expireSession(),
      Math.max(0, Math.min(state.cloudSession.expiresAt - Date.now(), 2_147_483_647)),
    );
    return () => window.clearTimeout(timeout);
  }, [session, state.mode, state.cloudSession]);
  useEffect(() => {
    if (!unresolved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unresolved]);

  const bounds = review ? comparisonBounds([review.main, review.option]) : undefined;
  return (
    <main>
      <header className="page-header">
        <div>
          <p className="eyebrow">
            or1 /{" "}
            {state.mode === "local"
              ? "local owner review"
              : developmentDemo
                ? "public development demo"
                : "read-only cloud pilot"}
          </p>
          <h1>{state.mode === "local" ? "Test-fit studio" : "Compare an option"}</h1>
        </div>
        <p>
          {state.mode === "local"
            ? "Review the current heads. Accept only the exact option you reviewed."
            : "Review the current heads. Acceptance and agent runs are disabled in this pilot."}
        </p>
      </header>
      {state.developmentDemoExpiresAt !== undefined && (
        <aside className="notice" aria-label="Public development demo">
          <strong>
            Public development demo · synthetic data only · read-only · not Access-authenticated
          </strong>
          Demo expiry:{" "}
          <time dateTime={new Date(state.developmentDemoExpiresAt).toISOString()}>
            {new Date(state.developmentDemoExpiresAt).toLocaleString(undefined, {
              dateStyle: "full",
              timeStyle: "long",
            })}{" "}
            ({Intl.DateTimeFormat().resolvedOptions().timeZone})
          </time>
          .
        </aside>
      )}
      <aside className="notice">
        <strong>Concept design only — not code certification.</strong> Gates check the brief and
        geometric consistency; heuristics do not establish regulatory compliance. Owner approval is
        a design decision, not a safety or construction sign-off.
      </aside>
      {state.mode !== "local" && (
        <form
          className="connection cloud-connection"
          onSubmit={(event) => {
            event.preventDefault();
            void session.review();
          }}
        >
          {state.mode === "cloud" && state.cloudSession && (
            <>
              <label>
                Project
                <select
                  value={inputs.projectId}
                  onChange={(event) =>
                    session.setInputs({ ...inputs, projectId: event.target.value })
                  }
                  required
                >
                  {!state.cloudSession.projects.length && (
                    <option value="">No projects assigned</option>
                  )}
                  {state.cloudSession.projects.map((project) => (
                    <option key={project.projectId} value={project.projectId}>
                      {project.label} · {project.membership}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Candidate ref
                <input
                  value={inputs.ref}
                  list="cloud-refs"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => session.setInputs({ ...inputs, ref: event.target.value })}
                  required
                />
                <datalist id="cloud-refs">
                  {state.cloudSession.projects
                    .find((project) => project.projectId === inputs.projectId)
                    ?.refs.map((ref) => (
                      <option key={ref} value={ref} />
                    ))}
                </datalist>
              </label>
              <button type="submit" disabled={state.reviewing || !inputs.projectId || !inputs.ref}>
                {state.reviewing ? "Reviewing…" : "Review option"}
              </button>
            </>
          )}
          <button
            type="button"
            className="secondary"
            disabled={state.refreshing}
            onClick={() => void session.refreshSession()}
          >
            {state.refreshing
              ? developmentDemo
                ? "Checking demo availability…"
                : accessSession
                  ? "Checking Access session…"
                  : "Checking session…"
              : "Refresh session"}
          </button>
          {state.mode === "blocked" && (
            <button type="button" className="secondary" onClick={() => window.location.reload()}>
              Reload page
            </button>
          )}
          <p className="setup cloud-status">
            <strong>{developmentDemo ? "Read-only demo." : "Read-only pilot."}</strong>{" "}
            {developmentDemo
              ? state.mode === "cloud"
                ? "Public synthetic review only. Acceptance and agent runs are disabled."
                : "Demo review is disabled until availability is confirmed."
              : accessSession
                ? "Use Cloudflare Access login, not a shared owner token."
                : "Session discovery must succeed before review is available."}
            {state.mode === "cloud" && state.cloudSession && !developmentDemo && (
              <>
                {" "}
                Session verified · expires{" "}
                {new Date(state.cloudSession.expiresAt).toLocaleTimeString()}.
              </>
            )}
            {state.mode === "cloud" &&
              !state.cloudSession?.projects.length &&
              (developmentDemo
                ? " No synthetic projects are available."
                : " Ask the pilot operator to assign a project to your Access identity.")}
          </p>
        </form>
      )}
      {state.mode === "local" && (
        <form
          className="connection"
          onSubmit={(event) => {
            event.preventDefault();
            void session.review();
          }}
        >
          <label>
            Project ID
            <input
              value={inputs.projectId}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => session.setInputs({ ...inputs, projectId: event.target.value })}
              required
            />
          </label>
          <label>
            Candidate ref
            <input
              value={inputs.ref}
              autoComplete="off"
              spellCheck={false}
              placeholder="option-a"
              onChange={(event) => session.setInputs({ ...inputs, ref: event.target.value })}
              required
            />
          </label>
          <label>
            Local owner token
            <input
              type="password"
              value={inputs.token}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => session.setInputs({ ...inputs, token: event.target.value })}
              required
            />
          </label>
          <button
            type="submit"
            disabled={
              state.reviewing ||
              state.accepting ||
              unresolved ||
              !inputs.projectId ||
              !inputs.ref ||
              !inputs.token
            }
          >
            {state.reviewing ? "Reviewing…" : "Review option"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!inputs.token}
            onClick={() => session.setInputs({ ...inputs, token: "" })}
          >
            Clear token
          </button>
          <details className="setup">
            <summary>Local connection and credential setup</summary>
            <p>
              Run the local server on 127.0.0.1:4310 and the editor on localhost:5173 or
              127.0.0.1:5173. Set <code>OR1_OWNER_TOKEN</code> on the server to a strong secret of
              at least 32 bearer-safe characters, then run <code>pnpm dev:server</code> and{" "}
              <code>pnpm dev:editor</code>. This configures the <strong>owner, unscoped</strong>{" "}
              local credential. Its namespace defaults to <code>local-owner</code>; keep the same
              namespace for the same principal. Paste the token here; never put it in a Vite
              environment variable, URL, or repository file.
            </p>
            <p>
              The token is held only in this page’s memory and sent in the Bearer header. No cookies
              or browser storage are used. Clearing any input invalidates the review. Resolve an
              uncertain acceptance before closing or reloading this page.
            </p>
          </details>
        </form>
      )}
      <div aria-live="polite">
        {state.message && (
          <p className="error" role="alert">
            {state.message}
          </p>
        )}
      </div>

      {state.mode === "local" && (
        <Studio
          studio={studio}
          onReview={(projectId, ref) => {
            session.setInputs({ ...session.getSnapshot().inputs, projectId, ref });
            void session
              .review()
              .then(() =>
                document.getElementById("review")?.scrollIntoView({ behavior: "smooth" }),
              );
          }}
        />
      )}

      {state.mode === "local" && acceptance && (
        <section className={`acceptance ${acceptance.status}`} aria-label="Acceptance request">
          <h2>
            {acceptance.status === "sending"
              ? "Accepting exact option…"
              : acceptance.status === "uncertain"
                ? "Acceptance outcome unknown"
                : acceptance.result.ok
                  ? "Acceptance receipt received"
                  : "Acceptance rejected"}
          </h2>
          <p>
            Project <code>{acceptance.intent.input.projectId}</code>: source{" "}
            <code>{acceptance.intent.input.body.sourceRef}</code> → target <strong>main</strong>
          </p>
          <dl className="pins">
            <Pin label="Request ID" value={acceptance.intent.input.requestId} />
            <Pin label="Source head" value={acceptance.intent.input.body.sourceRevisionId} />
            <Pin label="Expected main head" value={acceptance.intent.input.baseRevision} />
            <Pin label="Brief version" value={acceptance.intent.input.body.briefVersion} />
            <Pin label="Baseline" value={acceptance.intent.input.body.baselineRevisionId} />
            <Pin label="Evaluator" value={acceptance.intent.input.body.evaluatorVersion} />
          </dl>
          {acceptance.status === "uncertain" && (
            <>
              <p>
                The reply was lost or unavailable. Acceptance may already have committed; retry this
                exact request to learn its outcome, rather than starting another acceptance.
              </p>
              <p>
                This intent is retained even if inputs or the token are cleared. Re-enter the same
                owner token to retry; edited project/ref fields cannot retarget it. Do not close or
                reload this page: the unresolved intent is held only in memory.
              </p>
              <p>
                Token rotation cannot be resolved by this UI. If the original token was revoked, an
                operator must resolve the exact request through the API under the original
                credential namespace; a different token may select a different request ledger.
              </p>
              <button
                type="button"
                disabled={state.accepting || !inputs.token}
                onClick={() => void session.retry()}
              >
                {state.accepting ? "Retrying…" : "Retry exact acceptance request"}
              </button>
            </>
          )}
          {acceptance.status === "resolved" && acceptance.result.ok && (
            <>
              <p>
                Returned revision: <code>{acceptance.result.revisionId}</code>. A replay returns the
                original receipt; this is <strong>not proof of the latest main head</strong>.
              </p>
              <details>
                <summary>Returned receipt and transactional scorecard</summary>
                <pre>{JSON.stringify(acceptance.result.acceptance, null, 2)}</pre>
              </details>
            </>
          )}
        </section>
      )}

      {review && bounds ? (
        <>
          <section className="review-heading" id="review">
            <h2>{review.brief.name ?? "Project brief"}</h2>
            <dl className="pins">
              <Pin label="Project" value={review.projectId} />
              <Pin label="Brief version" value={review.briefVersion} />
              <Pin label="Option baseline" value={review.baselineRevisionId} />
            </dl>
            <details>
              <summary>Exact brief requirements and constraints</summary>
              <pre>{JSON.stringify(review.brief, null, 2)}</pre>
            </details>
          </section>
          <div className="comparison">
            <PlanCard
              title="Main · current target"
              plan={review.main}
              brief={review.brief}
              bounds={bounds}
            />
            <PlanCard
              title={`Candidate · ${review.ref}`}
              plan={review.option}
              brief={review.brief}
              bounds={bounds}
            />
          </div>
          {state.mode === "local" ? (
            <section className="decision">
              <div>
                <h2>Accept into main</h2>
                <p>
                  Source <code>{review.ref}</code> at <code>{review.option.revisionId}</code> →
                  target <strong>main</strong> at <code>{review.main.revisionId}</code>.
                </p>
                <p>
                  The server checks these pins and evaluates a fresh score in the acceptance
                  transaction. Manual and agent-created options use the same gate.
                </p>
                {!review.eligibility.allowed && (
                  <p className="error">
                    <strong>Not eligible: {review.eligibility.code}</strong>.{" "}
                    {review.eligibility.code === "stale_baseline"
                      ? "This option remains reviewable, but its baseline is no longer main. It cannot be accepted."
                      : "Resolve the option’s identity or scorecard problems before reviewing again."}
                  </p>
                )}
              </div>
              <button
                type="button"
                disabled={!review.eligibility.allowed || state.accepting || unresolved}
                onClick={() => void session.accept()}
              >
                {state.accepting ? "Preparing acceptance…" : "Accept this option into main"}
              </button>
            </section>
          ) : (
            <section className="decision">
              <div>
                <h2>{developmentDemo ? "Read-only demo" : "Read-only pilot"}</h2>
                <p>
                  Comparison and server scorecards only. Acceptance and agent runs are disabled for
                  all pilot members, including owners.
                </p>
                <p>Option eligibility describes the option’s state, not permission to accept it.</p>
              </div>
            </section>
          )}
        </>
      ) : (
        !acceptance && (
          <section className="empty">
            <h2>Bring an existing option to review</h2>
            <p>
              {state.mode === "local"
                ? "Enter a project ID, candidate ref, and local owner token above."
                : state.mode === "cloud"
                  ? "Choose an assigned project and candidate ref above. Ref suggestions are navigation aids, not access restrictions."
                  : developmentDemo
                    ? "Refresh the session to check whether public demo review is available."
                    : "Refresh the session to discover available projects."}{" "}
              Main and the candidate will be compared at the same scale, with their actual server
              scorecards.
            </p>
          </section>
        )
      )}
    </main>
  );
}

function Pin({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <code>{value ?? "none"}</code>
      </dd>
    </div>
  );
}

function PlanCard({
  title,
  plan,
  brief,
  bounds,
}: {
  title: string;
  plan: PlanReview;
  brief: Brief;
  bounds: ReturnType<typeof comparisonBounds>;
}) {
  return (
    <article className="plan-card">
      <header>
        <h2>{title}</h2>
        <span className={`badge ${plan.scorecard.valid ? "pass" : "fail"}`}>
          {plan.scorecard.valid ? "Gates pass" : "Gates fail"}
        </span>
      </header>
      <dl className="pins">
        <Pin label="Head revision" value={plan.revisionId} />
        <Pin label="Evaluator" value={plan.scorecard.evaluatorVersion} />
      </dl>
      <PlanSvg
        title={`${title} — server-derived plan`}
        model={plan.model}
        derived={plan.derived}
        bounds={bounds}
      />
      <p className="caption">
        Same scale · Y ↑ · dimensions in mm · blue windows · ochre door leaves · red entrance
      </p>
      <ul className="space-list">
        {plan.derived.spaces.map((space) => (
          <li key={space.id}>
            <strong>
              {space.id} · {space.label ?? space.program ?? "Unlabelled"}
            </strong>
            <span>
              {(space.netArea / 1e6).toFixed(2)} m² net · programme {space.program ?? "none"} ·
              assignment <code>{space.requirementId ?? "unassigned"}</code>
            </span>
          </li>
        ))}
      </ul>
      {!plan.derived.spaces.length && <p>No derived spaces.</p>}
      {plan.derived.problems.length > 0 && (
        <div className="error">
          <strong>Geometry problems</strong>
          <ul>
            {plan.derived.problems.map((problem) => (
              <li key={`${problem.code}-${problem.detail}-${problem.subjects.join(",")}`}>
                {problem.code}: {problem.detail} ({problem.subjects.join(", ") || "no subjects"})
              </li>
            ))}
          </ul>
        </div>
      )}
      <ScorecardView scorecard={plan.scorecard} brief={brief} />
    </article>
  );
}

function ScorecardView({ scorecard, brief }: { scorecard: Scorecard; brief: Brief }) {
  return (
    <section className="scorecard" aria-label="Actual scorecard">
      <h3>Requirements</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Requirement / programme</th>
              <th scope="col">Present / quantity</th>
              <th scope="col">Assignments</th>
            </tr>
          </thead>
          <tbody>
            {scorecard.requirements.map((requirement) => {
              const room = brief.rooms.find((r) => r.id === requirement.id);
              return (
                <tr key={requirement.id}>
                  <th scope="row">
                    <code>{requirement.id}</code>
                    <small>
                      {room?.program} · {room?.hard ? "hard" : "soft"}
                      {room?.targetAreaM2 !== undefined ? ` · target ${room.targetAreaM2} m²` : ""}
                    </small>
                  </th>
                  <td>
                    {requirement.present} / {requirement.quantity}
                  </td>
                  <td>{requirement.spaces.join(", ") || "None"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!scorecard.requirements.length && <p>No room requirements in this brief.</p>}
      <h3>Hard gates</h3>
      <ul className="gates">
        {scorecard.gates.map((gate) => (
          <li key={gate.gate}>
            <div className="gate-title">
              <strong>{gate.gate}</strong>
              <span className={`badge ${gate.passed ? "pass" : "fail"}`}>
                {gate.passed ? "Pass" : "Fail"}
              </span>
            </div>
            <small>Basis: {gate.basis}</small>
            {gate.failures.length > 0 && (
              <ul>
                {gate.failures.map((failure) => (
                  <li key={`${failure.detail}-${failure.subjects.join(",")}`}>
                    {failure.detail}
                    <small>Subjects: {failure.subjects.join(", ") || "none"}</small>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <h3>
        Soft scores <small>0–1 · higher is better</small>
      </h3>
      {scorecard.scores.length ? (
        <ul className="scores">
          {scorecard.scores.map((score) => (
            <li key={score.score}>
              <div>
                <strong>{score.score}</strong>
                <span>{score.value.toFixed(3)}</span>
              </div>
              <meter min={0} max={1} value={score.value} aria-label={score.score} />
              <small>{score.detail}</small>
            </li>
          ))}
        </ul>
      ) : (
        <p>No soft score inputs in this brief.</p>
      )}
      {scorecard.constraints.length > 0 && (
        <details>
          <summary>Individual constraint outcomes</summary>
          <ul>
            {scorecard.constraints.map((constraint) => (
              <li key={constraint.index}>
                #{constraint.index + 1} {constraint.kind} · {constraint.hard ? "hard" : "soft"} ·{" "}
                {constraint.met ? "met" : "not met"}
                <ul>
                  {constraint.failures.map((failure) => (
                    <li key={`${failure.detail}-${failure.subjects.join(",")}`}>
                      {failure.detail} ({failure.subjects.join(", ")})
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
