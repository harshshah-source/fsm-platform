/**
 * Book8SourceReader — a TEST-ONLY implementation of the production `SourceReader` seam, backed by
 * `data/Book8_fixed.csv` instead of the AutoPlant DB.
 *
 * It lives under test/ and is wired NOWHERE in the production module graph. The real
 * SnapshotIngestionWorker / SnapshotIngestionService pipeline runs against it completely unchanged —
 * exactly the swap the SOURCE_READER abstraction was designed for. Production keeps binding
 * InMemorySourceReader([]) today and AutoPlantReader later; this never replaces either.
 *
 * Cursor semantics are identical to InMemorySourceReader (start-index encoded as a string).
 */
import type { SourceChunk, SourceReader, SourceSnapshotRow } from '../../../src/ingestion/source-reader';

export class Book8SourceReader implements SourceReader {
  constructor(private readonly rows: readonly SourceSnapshotRow[]) {}

  async readChunk(cursor: string | null, chunkSize: number): Promise<SourceChunk> {
    const start = cursor === null ? 0 : Number(cursor);
    const slice = this.rows.slice(start, start + chunkSize);
    const nextIndex = start + slice.length;
    const exhausted = slice.length === 0 || nextIndex >= this.rows.length;
    return { rows: [...slice], nextCursor: exhausted ? null : String(nextIndex) };
  }
}
