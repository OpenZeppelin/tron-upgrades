/**
 * Pattern 3 — render the invocation-context matrix instead of restating it.
 *
 * `slotRequirements` is the matrix as data (INV-14), and the seam's own
 * `EnvironmentIncompleteError` message renders from this same table. Hardcoding a
 * context list in your own diagnostic guarantees the two eventually contradict
 * each other.
 */
import {
  resolveEnvironment,
  slotNames,
  slotRequirements,
  type RawMigrationHandles,
  type SlotName,
} from '../../../src/environment';

export function whereIsAvailable(slot: SlotName): string {
  const requirement = slotRequirements[slot];
  return [
    `"${slot}" needs one of: ${requirement.handles.join(', ')}`,
    `  available in: ${requirement.providedIn.join(', ')}`,
    `  absent in:    ${requirement.absentIn.join(', ')}`,
  ].join('\n');
}

/** The whole capability table, for a `--verbose` diagnostic. */
export function capabilityTable(): string {
  return slotNames.map(whereIsAvailable).join('\n\n');
}

/**
 * `slotNames` is a frozen tuple, so it doubles as the "everything" spec with full
 * narrowing — every slot non-optional in the returned type.
 */
export function resolveEverything(
  handles: RawMigrationHandles,
): ReturnType<typeof resolveEnvironment<typeof slotNames>> {
  return resolveEnvironment(handles, { require: slotNames });
}

/**
 * Which slots a given set of handles could possibly satisfy, read from the table
 * rather than guessed. Useful for deciding a `require`/`optional` split at runtime
 * instead of hardcoding one.
 */
export function satisfiableSlots(
  handles: RawMigrationHandles,
): readonly SlotName[] {
  return slotNames.filter(slot =>
    slotRequirements[slot].handles.some(
      handle => handles[handle] !== undefined,
    ),
  );
}
