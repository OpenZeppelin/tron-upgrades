export function txHashOf(contract: any): string | undefined {
  try {
    return contract.deploymentTransaction?.()?.hash ?? undefined;
  } catch {
    return undefined;
  }
}
