/** Tolerances of the geometry contract (docs/geometry-contract.md). All values are integer millimetres. */
export const GEOMETRY = {
  /** Wall thickness range. Thickness must also be even so wall faces stay on integer coordinates. */
  minThickness: 50,
  maxThickness: 1000,
  /** Minimum length of every wall segment between junctions, and minimum opening width. */
  minSegment: 100,
  /** Minimum clear distance between the bodies of walls that are not joined at a junction. */
  minGap: 200,
} as const;
