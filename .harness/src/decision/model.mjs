export const SYSTEM_CHARACTERISTIC_IDS = Object.freeze([
  "interaction",
  "workload",
  "state",
  "consistency",
  "availability",
  "growth",
]);

export const SYSTEM_TARGET_GROUPS = Object.freeze(["initial", "expected_growth", "architecture_boundary"]);

export const SYSTEM_TARGET_METRICS = Object.freeze([
  "mau", "dau", "concurrency", "average_rps", "peak_rps", "burst_rps",
  "latency_p95_ms", "latency_p99_ms", "availability", "data_volume", "job_volume", "rpo", "rto",
]);

export function createSystemTargets(systemCharacteristics) {
  return {
    schema_version: 1,
    id: "system-targets",
    system_characteristics: systemCharacteristics,
    initial: [],
    expected_growth: [],
    architecture_boundary: [],
  };
}
