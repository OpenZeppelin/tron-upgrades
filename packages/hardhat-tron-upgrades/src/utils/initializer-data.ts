// Encode the initializer call that becomes the proxy's constructor data.
// `initializer: false` yields empty data — an uninitialized proxy, where the
// proxy kind allows it.
export function getInitializerData(
  iface: any,
  initializer: string | false,
  args: unknown[],
): string {
  return initializer === false ? '0x' : iface.encodeFunctionData(initializer, args);
}
