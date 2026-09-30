import { derive, type Model } from "@or1/core";
import type { PlanReview, ProjectOverview, RefOverview, RunSummary, Strategy } from "@or1/tools";
import { useMemo, useState, useSyncExternalStore } from "react";
import {
  blankRoom,
  compileBrief,
  compileShell,
  type OpeningDraft,
  PRESETS,
  type ProjectDraft,
  type RoomDraft,
  SIDES,
  type Side,
} from "./draft.ts";
import { PlanSvg } from "./PlanSvg.tsx";
import { comparisonBounds } from "./plan.ts";
import { isLive, type StudioSession } from "./studio-session.ts";

export function Studio({
  studio,
  onReview,
}: {
  studio: StudioSession;
  onReview: (projectId: string, ref: string) => void;
}) {
  const state = useSyncExternalStore(studio.subscribe, studio.getSnapshot);
  if (!state.status && state.busy !== "connecting")
    return (
      <section className="studio empty" aria-label="Studio">
        <h2>Studio</h2>
        <p>
          {state.message ||
            "Enter the local owner token above (or open the studio link printed by `pnpm studio`) to create projects and generate options."}
        </p>
      </section>
    );
  const agent = state.status?.agent;
  return (
    <section className="studio" aria-label="Studio">
      <header className="studio-header">
        <div>
          <h2>Studio</h2>
          <p className={`agent ${agent ? "on" : "off"}`}>
            {agent ? (
              <>
                Agent <strong>{agent.name}</strong>{" "}
                <code>
                  {agent.provider}/{agent.id}
                </code>
              </>
            ) : (
              "Offline: review and acceptance only. Restart `pnpm studio` without --offline to generate."
            )}
          </p>
        </div>
        <div className="studio-projects">
          <label>
            Project
            <select
              value={state.composing ? "" : state.projectId}
              onChange={(event) => void studio.select(event.target.value)}
              disabled={!state.projects.length}
            >
              {state.composing && <option value="">New project…</option>}
              {state.projects.map((project) => (
                <option key={project.projectId} value={project.projectId}>
                  {project.name ?? project.projectId} · {project.options} option
                  {project.options === 1 ? "" : "s"}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="secondary"
            onClick={() => studio.compose(!state.composing)}
          >
            {state.composing ? "Close composer" : "New project"}
          </button>
        </div>
      </header>
      <div aria-live="polite">
        {state.message && (
          <p className="error" role="alert">
            {state.message}
          </p>
        )}
      </div>
      {state.composing ? (
        <Composer
          draft={state.draft}
          onChange={(draft) => studio.setDraft(draft)}
          onCreate={() => void studio.create()}
          creating={state.busy === "creating"}
        />
      ) : state.overview ? (
        <Board
          overview={state.overview}
          strategies={state.status?.strategies ?? []}
          canGenerate={Boolean(agent)}
          generating={state.busy === "generating"}
          onGenerate={(count, note) => void studio.generate(count, note)}
          onCancel={(runId) => void studio.cancel(runId)}
          onReview={(ref) => onReview(state.overview?.projectId as string, ref)}
        />
      ) : (
        <p>{state.busy === "connecting" ? "Connecting…" : "Choose or create a project."}</p>
      )}
    </section>
  );
}

function Composer({
  draft,
  onChange,
  onCreate,
  creating,
}: {
  draft: ProjectDraft;
  onChange: (draft: ProjectDraft) => void;
  onCreate: () => void;
  creating: boolean;
}) {
  const shell = useMemo(() => compileShell(draft.shell), [draft.shell]);
  const brief = useMemo(() => compileBrief(draft.brief), [draft.brief]);
  const setShell = (change: Partial<ProjectDraft["shell"]>) =>
    onChange({ ...draft, shell: { ...draft.shell, ...change } });
  const setRooms = (rooms: RoomDraft[]) => onChange({ ...draft, brief: { ...draft.brief, rooms } });
  const setRoom = (index: number, change: Partial<RoomDraft>) =>
    setRooms(draft.brief.rooms.map((room, i) => (i === index ? { ...room, ...change } : room)));
  const setWindow = (index: number, change: Partial<OpeningDraft>) =>
    setShell({
      windows: draft.shell.windows.map((w, i) => (i === index ? { ...w, ...change } : w)),
    });
  const preview = shell.ok ? { model: shell.value, derived: derive(shell.value) } : undefined;
  const planBounds = preview ? comparisonBounds([preview]) : undefined;
  return (
    <div className="composer">
      <div className="presets">
        <span>Start from</span>
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="secondary"
            onClick={() => onChange(structuredClone(preset.draft))}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <div className="composer-grid">
        <div className="composer-forms">
          <fieldset>
            <legend>Shell · rectangular, millimetres</legend>
            <div className="row">
              <NumberField
                label="Width (x)"
                value={draft.shell.width}
                onChange={(width) => setShell({ width })}
              />
              <NumberField
                label="Depth (y)"
                value={draft.shell.depth}
                onChange={(depth) => setShell({ depth })}
              />
              <NumberField
                label="Wall"
                value={draft.shell.thickness}
                onChange={(thickness) => setShell({ thickness })}
              />
            </div>
            <OpeningRow
              label="Entrance door"
              opening={draft.shell.entrance}
              onChange={(change) => setShell({ entrance: { ...draft.shell.entrance, ...change } })}
            />
            {draft.shell.windows.map((window, index) => (
              <OpeningRow
                // biome-ignore lint/suspicious/noArrayIndexKey: windows have no identity before compilation.
                key={index}
                label={`Window ${index + 1}`}
                opening={window}
                onChange={(change) => setWindow(index, change)}
                onRemove={() =>
                  setShell({ windows: draft.shell.windows.filter((_, i) => i !== index) })
                }
              />
            ))}
            <button
              type="button"
              className="secondary small"
              onClick={() =>
                setShell({
                  windows: [...draft.shell.windows, { side: "north", offset: 1000, width: 1200 }],
                })
              }
            >
              Add window
            </button>
            <p className="hint">
              Offsets run from the west end of south/north walls and the south end of east/west
              walls.
            </p>
          </fieldset>
          <fieldset>
            <legend>Brief · every listed room is required</legend>
            <label className="wide">
              Name
              <input
                value={draft.brief.name}
                onChange={(event) =>
                  onChange({ ...draft, brief: { ...draft.brief, name: event.target.value } })
                }
              />
            </label>
            <div className="table-scroll">
              <table className="rooms">
                <thead>
                  <tr>
                    <th scope="col">ID</th>
                    <th scope="col">Programme</th>
                    <th scope="col">Qty</th>
                    <th scope="col">Min m²</th>
                    <th scope="col">Target m²</th>
                    <th scope="col">Daylight</th>
                    <th scope="col">Door to</th>
                    <th scope="col">
                      <span className="sr-only">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {draft.brief.rooms.map((room, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: IDs are being edited in place.
                    <tr key={index}>
                      <td>
                        <input
                          aria-label="Requirement ID"
                          value={room.id}
                          onChange={(event) => {
                            const id = event.target.value;
                            setRooms(
                              draft.brief.rooms.map((other, i) =>
                                i === index
                                  ? { ...other, id }
                                  : {
                                      ...other,
                                      doorTo: other.doorTo.map((t) => (t === room.id ? id : t)),
                                    },
                              ),
                            );
                          }}
                        />
                      </td>
                      <td>
                        <input
                          aria-label="Programme"
                          value={room.program}
                          onChange={(event) => setRoom(index, { program: event.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          aria-label="Quantity"
                          type="number"
                          min={1}
                          value={room.quantity}
                          onChange={(event) =>
                            setRoom(index, {
                              quantity: Math.max(1, Number(event.target.value) || 1),
                            })
                          }
                        />
                      </td>
                      <td>
                        <OptionalNumber
                          label="Minimum area"
                          value={room.minAreaM2}
                          onChange={(minAreaM2) => setRoom(index, { minAreaM2 })}
                        />
                      </td>
                      <td>
                        <OptionalNumber
                          label="Target area"
                          value={room.targetAreaM2}
                          onChange={(targetAreaM2) => setRoom(index, { targetAreaM2 })}
                        />
                      </td>
                      <td>
                        <input
                          aria-label="Needs daylight"
                          type="checkbox"
                          checked={room.daylight}
                          onChange={(event) => setRoom(index, { daylight: event.target.checked })}
                        />
                      </td>
                      <td className="doors">
                        {draft.brief.rooms
                          .filter((other) => other.id !== room.id)
                          .map((other) => (
                            <label key={other.id} className="chip">
                              <input
                                type="checkbox"
                                checked={room.doorTo.includes(other.id)}
                                onChange={(event) =>
                                  setRoom(index, {
                                    doorTo: event.target.checked
                                      ? [...room.doorTo, other.id]
                                      : room.doorTo.filter((t) => t !== other.id),
                                  })
                                }
                              />
                              {other.id}
                            </label>
                          ))}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="secondary small"
                          aria-label={`Remove ${room.id}`}
                          onClick={() =>
                            setRooms(
                              draft.brief.rooms
                                .filter((_, i) => i !== index)
                                .map((other) => ({
                                  ...other,
                                  doorTo: other.doorTo.filter((t) => t !== room.id),
                                })),
                            )
                          }
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              type="button"
              className="secondary small"
              onClick={() => setRooms([...draft.brief.rooms, blankRoom(draft.brief.rooms)])}
            >
              Add room
            </button>
            <p className="hint">
              Minimum areas, daylight and doors are hard gates; targets are soft scores. Programmes{" "}
              <code>hall</code> and <code>corridor</code> count as circulation.
            </p>
          </fieldset>
        </div>
        <aside className="composer-preview">
          <h3>Shell preview</h3>
          {preview && planBounds ? (
            <PlanSvg
              title="Shell preview"
              model={preview.model}
              derived={preview.derived}
              bounds={planBounds}
              labels="requirement"
            />
          ) : (
            <p className="error">{!shell.ok && shell.message}</p>
          )}
          <p className="caption">
            {draft.shell.width / 1000} × {draft.shell.depth / 1000} m ·{" "}
            {preview ? `${areaM2(preview.model).toFixed(1)} m² clear` : "invalid"} · rooms need{" "}
            {draft.brief.rooms
              .reduce((sum, r) => sum + (r.minAreaM2 ?? 0) * r.quantity, 0)
              .toFixed(1)}{" "}
            m² minimum
          </p>
          {!brief.ok && <p className="error">Brief: {brief.message}</p>}
          <button type="button" disabled={!shell.ok || !brief.ok || creating} onClick={onCreate}>
            {creating ? "Creating…" : "Create project"}
          </button>
        </aside>
      </div>
    </div>
  );
}

function areaM2(model: Model) {
  return derive(model).spaces.reduce((sum, space) => sum + space.netArea, 0) / 1e6;
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        step={50}
        value={value}
        onChange={(event) => onChange(Math.round(Number(event.target.value)))}
      />
    </label>
  );
}

function OptionalNumber({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  return (
    <input
      aria-label={label}
      type="number"
      min={0}
      step={0.5}
      value={value ?? ""}
      placeholder="—"
      onChange={(event) =>
        onChange(event.target.value === "" ? null : Math.max(0.01, Number(event.target.value)))
      }
    />
  );
}

function OpeningRow({
  label,
  opening,
  onChange,
  onRemove,
}: {
  label: string;
  opening: OpeningDraft;
  onChange: (change: Partial<OpeningDraft>) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="row opening-row">
      <span className="row-label">{label}</span>
      <label>
        Side
        <select value={opening.side} onChange={(e) => onChange({ side: e.target.value as Side })}>
          {SIDES.map((side) => (
            <option key={side} value={side}>
              {side}
            </option>
          ))}
        </select>
      </label>
      <NumberField
        label="Offset"
        value={opening.offset}
        onChange={(offset) => onChange({ offset })}
      />
      <NumberField label="Width" value={opening.width} onChange={(width) => onChange({ width })} />
      {onRemove && (
        <button
          type="button"
          className="secondary small"
          aria-label={`Remove ${label}`}
          onClick={onRemove}
        >
          ✕
        </button>
      )}
    </div>
  );
}

function Board({
  overview,
  strategies,
  canGenerate,
  generating,
  onGenerate,
  onCancel,
  onReview,
}: {
  overview: ProjectOverview;
  strategies: readonly Strategy[];
  canGenerate: boolean;
  generating: boolean;
  onGenerate: (count: number, note: string) => void;
  onCancel: (runId: string) => void;
  onReview: (ref: string) => void;
}) {
  const [count, setCount] = useState(3);
  const [note, setNote] = useState("");
  const bounds = comparisonBounds([overview.main, ...overview.options.map((o) => o.plan)]);
  const live = overview.options.filter((o) => o.runs.some((run) => isLive(run.status))).length;
  const options = overview.options;
  return (
    <div className="board">
      <div className="brief-line">
        <strong>{overview.brief.name ?? overview.projectId}</strong>
        <span>
          {overview.brief.rooms.map((room) => (
            <span key={room.id} className="chip static">
              {room.id}
              {room.quantity > 1 ? ` ×${room.quantity}` : ""}
            </span>
          ))}
        </span>
        <code>{overview.projectId}</code>
      </div>
      <form
        className="generate"
        onSubmit={(event) => {
          event.preventDefault();
          onGenerate(count, note);
        }}
      >
        <label>
          Agents
          <select value={count} onChange={(event) => setCount(Number(event.target.value))}>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          Direction for this batch (optional)
          <input
            value={note}
            maxLength={2000}
            placeholder="e.g. keep the living room on the east façade"
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <button type="submit" disabled={!canGenerate || generating}>
          {generating ? "Starting…" : `Generate ${count} option${count === 1 ? "" : "s"}`}
        </button>
        <p className="hint">
          Each agent gets its own option ref and a different direction
          {strategies.length ? ` (${strategies.map((s) => s.label).join(", ")})` : ""}. Runs have no
          time limit and stop as soon as every hard gate passes.
          {live > 0 && ` ${live} running now.`}
        </p>
      </form>
      <div className="options-grid">
        <OptionCard title="Main · current" plan={overview.main} bounds={bounds} />
        {options.map((option) => (
          <OptionCard
            key={option.ref}
            title={option.ref}
            option={option}
            plan={option.plan}
            bounds={bounds}
            onReview={() => onReview(option.ref)}
            onCancel={onCancel}
          />
        ))}
      </div>
      {!overview.options.length && (
        <p className="hint">No options yet. Generate some with the agents above.</p>
      )}
    </div>
  );
}

function OptionCard({
  title,
  option,
  plan,
  bounds,
  onReview,
  onCancel,
}: {
  title: string;
  option?: RefOverview;
  plan: PlanReview;
  bounds: ReturnType<typeof comparisonBounds>;
  onReview?: () => void;
  onCancel?: (runId: string) => void;
}) {
  const run = option?.runs.at(-1);
  const strategy = run?.strategySeed as Strategy | null | undefined;
  const failing = plan.scorecard.gates.filter((gate) => !gate.passed);
  // Offer acceptance only for a settled, current, freshly valid head; the server re-checks all pins.
  const acceptable =
    Boolean(option) && !option?.stale && plan.scorecard.valid && !(run && isLive(run.status));
  return (
    <article className={`option-card ${run && isLive(run.status) ? "live" : ""}`}>
      <header>
        <div>
          <h3>{title}</h3>
          {strategy?.label && <small title={strategy.direction}>{strategy.label}</small>}
        </div>
        <span className={`badge ${plan.scorecard.valid ? "pass" : "fail"}`}>
          {plan.scorecard.valid
            ? "Gates pass"
            : `${failing.length} gate${failing.length === 1 ? "" : "s"} fail`}
        </span>
      </header>
      <PlanSvg
        title={title}
        model={plan.model}
        derived={plan.derived}
        bounds={bounds}
        labels="requirement"
        className="plan thumb"
      />
      {run && <RunLine run={run} />}
      {!plan.scorecard.valid && failing.length > 0 && (
        <small className="failing">{failing.map((gate) => gate.gate).join(" · ")}</small>
      )}
      {plan.scorecard.scores.length > 0 && (
        <ul className="mini-scores">
          {plan.scorecard.scores.map((score) => (
            <li key={score.score} title={score.detail}>
              {score.score} <strong>{score.value.toFixed(2)}</strong>
            </li>
          ))}
        </ul>
      )}
      {option && (
        <div className="card-actions">
          {run && isLive(run.status) && onCancel && (
            <button type="button" className="secondary small" onClick={() => onCancel(run.id)}>
              Cancel run
            </button>
          )}
          {onReview && (
            <button
              type="button"
              className={`small ${acceptable ? "" : "secondary"}`}
              onClick={onReview}
            >
              {acceptable ? "Review & accept" : option.stale ? "Review (stale)" : "Review"}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function duration(ms: number) {
  const seconds = Math.round(ms / 1000);
  return seconds < 120 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function RunLine({ run }: { run: RunSummary }) {
  const spend = run.spend;
  const facts = [
    spend?.toolCalls ? `${spend.toolCalls} tool call${spend.toolCalls === 1 ? "" : "s"}` : null,
    spend?.tokens ? `${(spend.tokens / 1000).toFixed(1)}k tokens` : null,
    spend?.elapsedMs && spend.elapsedMs >= 1000 ? duration(spend.elapsedMs) : null,
    run.retryCount ? `${run.retryCount} rejected` : null,
  ].filter(Boolean);
  const label = isLive(run.status)
    ? `Agent working${run.lastEvent?.name ? ` · ${run.lastEvent.name}` : ""}`
    : run.status === "done"
      ? run.outcome === "options"
        ? "Found a valid option"
        : run.outcome === "infeasible"
          ? "Proven infeasible"
          : "No valid option found"
      : run.status;
  return (
    <p className={`run-line ${run.status}`}>
      <span className="run-status">{label}</span>
      {facts.length > 0 && <span> · {facts.join(" · ")}</span>}
      {run.lastEvent?.kind === "settled" && run.lastEvent.reason && (
        <span> · stopped: {run.lastEvent.reason}</span>
      )}
    </p>
  );
}
