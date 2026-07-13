// upgrades-core matches revert errors case-sensitively ('revert'), but
// TRE/java-tron reports "REVERT opcode executed" — upper case. It also
// rejects eth_call against a no-code address ("Smart contract is not
// exist") where an EVM node would return empty data — which breaks
// upstream's optional probes (e.g. inferProxyAdmin against an EOA owner).
// Match the upstream list case-insensitively plus the TVM no-code wording;
// real transport errors still rethrow.
export function isOptionalCallRevert(error: unknown): boolean {
  const message = (error as any)?.message ?? '';
  return /revert|invalid opcode|execution error|function selector was not recognized|smart contract is not exist/i.test(
    message,
  );
}
