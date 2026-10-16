export function readBoundedRegularDescriptor(fd: number, limit: number): string;
export function readProtectedTlsMaterial<const T extends readonly string[]>(
  directory: string,
  filenames: T,
): Record<T[number], string>;
