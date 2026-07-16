// Encode the initializer call that becomes the proxy's constructor data
// (upstream semantics): `false` explicitly skips initialization; an omitted
// initializer with no args tolerates a contract without an `initialize`
// function and deploys uninitialized; anything else must resolve to a real
// function or fail before the chain is touched.
export function getInitializerData(
  iface: any,
  args: unknown[],
  initializer?: string | false,
): string {
  if (initializer === false) return '0x';

  const allowNoInitialization = initializer === undefined && args.length === 0;
  initializer = initializer ?? 'initialize';

  let fragment: any = null;
  try {
    fragment = iface.getFunction(initializer);
  } catch {
    fragment = null;
  }
  if (fragment === null) {
    if (allowNoInitialization) return '0x';
    throw new Error(
      `The contract has no initializer function matching the name or signature: ${initializer}. ` +
        `Specify an existing function with the 'initializer' option, or set 'initializer: false' ` +
        `to omit the initializer call.`,
    );
  }
  return iface.encodeFunctionData(fragment, args);
}
