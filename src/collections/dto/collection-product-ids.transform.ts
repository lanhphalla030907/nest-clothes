/** Multipart forms carry an array as JSON text; JSON requests keep the array. */
export const toProductIds = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
