export function slotPositionChanged(current, next, tolerance = 0.25) {
  if (!Array.isArray(current) || current.length < 2) return true;
  return Math.abs(current[0] - next[0]) > tolerance
    || Math.abs(current[1] - next[1]) > tolerance;
}
