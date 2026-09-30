import type { Derived, Model } from "@or1/core";
import { type comparisonBounds, labelPoint, openingSegment, ringsPath } from "./plan.ts";

type Bounds = ReturnType<typeof comparisonBounds>;

/**
 * Presentation of a model and its server- or core-derived rings. It draws geometry only; every
 * room, slab and assignment comes from derived data, never from recomputation here.
 */
export function PlanSvg({
  title,
  model,
  derived,
  bounds,
  labels = "id",
  className = "plan",
}: {
  title: string;
  model: Model;
  derived: Pick<Derived, "spaces" | "slab">;
  bounds: Bounds;
  /** Space IDs for detailed review; requirement or programme names for thumbnails. */
  labels?: "id" | "requirement";
  className?: string;
}) {
  const labelSize = Math.max(bounds.width, bounds.height) / (labels === "id" ? 40 : 28);
  return (
    <svg
      className={className}
      viewBox={`${bounds.x0} ${-(bounds.y0 + bounds.height)} ${bounds.width} ${bounds.height}`}
      role="img"
      aria-label={`${title} plan. Positive Y points up; millimetres. Same scale as its neighbours.`}
    >
      <title>{title}</title>
      {model.walls.map((wall) => (
        <line
          key={wall.id}
          x1={wall.start.x}
          y1={-wall.start.y}
          x2={wall.end.x}
          y2={-wall.end.y}
          stroke="#354448"
          strokeWidth={wall.thickness}
        >
          <title>
            {wall.id}: {wall.thickness} mm{wall.locked ? ", locked" : ""}
            {wall.structural ? ", structural" : ""}
          </title>
        </line>
      ))}
      <path d={ringsPath(derived.slab.outline)} fill="#354448" fillRule="evenodd" />
      {derived.spaces.map((space, i) => (
        <path
          key={space.id}
          d={ringsPath(space.clear)}
          fill={space.requirementId ? (i % 2 ? "#dcece4" : "#e7e8f0") : "#f6f1e7"}
          fillRule="evenodd"
        >
          <title>
            {space.id}: {space.label ?? space.program ?? "unlabelled"}; assignment{" "}
            {space.requirementId ?? "unassigned"}; {(space.netArea / 1e6).toFixed(2)} m² net
          </title>
        </path>
      ))}
      {model.openings.map((opening) => {
        const wall = model.walls.find((wall) => wall.id === opening.wall);
        const segment = wall && openingSegment(wall, opening);
        if (!wall || !segment) return null;
        const { start, end, dx, dy } = segment;
        const hinge = opening.kind === "door" && opening.hinge === "end" ? end : start;
        const swing = opening.kind === "door" && opening.swing === "right" ? -1 : 1;
        return (
          <g key={opening.id}>
            <title>
              {opening.id}: {opening.kind}, {opening.width} mm, host {opening.wall}
            </title>
            <line
              x1={start.x}
              y1={-start.y}
              x2={end.x}
              y2={-end.y}
              stroke="#f8faf9"
              strokeWidth={wall.thickness + 2}
            />
            {opening.kind === "window" ? (
              <line
                x1={start.x}
                y1={-start.y}
                x2={end.x}
                y2={-end.y}
                stroke="#007f9e"
                strokeWidth={Math.max(25, wall.thickness / 4)}
              />
            ) : (
              <line
                x1={hinge.x}
                y1={-hinge.y}
                x2={hinge.x - dy * swing * opening.width}
                y2={-(hinge.y + dx * swing * opening.width)}
                stroke={opening.entrance ? "#b3261e" : "#916222"}
                strokeWidth={30}
              />
            )}
          </g>
        );
      })}
      {derived.spaces.map((space) => {
        const text =
          labels === "id" ? space.id : (space.requirementId ?? space.program ?? space.label);
        if (!text) return null;
        const at = labels === "id" ? space.anchor : labelPoint(space);
        return (
          <text
            key={space.id}
            x={at.x}
            y={-at.y}
            dx={labels === "id" ? labelSize / 2 : 0}
            dy={labels === "id" ? -labelSize / 2 : 0}
            textAnchor={labels === "id" ? "start" : "middle"}
            dominantBaseline={labels === "id" ? "auto" : "middle"}
            fontSize={labelSize}
            fill="#243237"
            paintOrder="stroke"
            stroke="#f8faf9"
            strokeWidth={labelSize / 8}
          >
            {text}
          </text>
        );
      })}
    </svg>
  );
}
