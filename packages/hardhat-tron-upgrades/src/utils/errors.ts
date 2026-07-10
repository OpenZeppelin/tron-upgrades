// upgrades-core matches revert errors case-sensitively ('revert'), but
// TRE/java-tron reports "REVERT opcode executed" — upper case. Match the
// upstream list case-insensitively; real transport errors still rethrow.
export function isOptionalCallRevert(error: unknown): boolean {
  const message = (error as any)?.message ?? '';
  return /revert|invalid opcode|execution error|function selector was not recognized/i.test(message);
}
