/**
 * Offset pagination over a live, mutable result set is not a snapshot. A row
 * moving across a page boundary can make another row disappear from the scan
 * without any request failing. Run complete scans until two consecutive ID
 * sequences agree; only then expose records to the ingestion pipeline.
 */
export async function stableListing<T>(
  label: string,
  scan: () => Promise<T[]>,
  keyOf: (item: T) => string,
  maxScans = 3,
): Promise<T[]> {
  let previousKeys: string[] | null = null;

  for (let attempt = 1; attempt <= maxScans; attempt++) {
    const rows = await scan();
    const keys = rows.map(keyOf);
    if (new Set(keys).size !== keys.length) {
      previousKeys = null;
      continue;
    }
    if (
      previousKeys !== null &&
      previousKeys.length === keys.length &&
      previousKeys.every((key, i) => key === keys[i])
    ) {
      return rows;
    }
    previousKeys = keys;
  }

  throw new Error(
    `${label} changed during offset pagination; refusing an incomplete listing after ${maxScans} scans`,
  );
}
