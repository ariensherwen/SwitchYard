export const stringSchema = () => ({ type: "string" });
export const booleanSchema = () => ({ type: "boolean" });
export const stringArraySchema = () => ({ type: "array", items: { type: "string" } });
export function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false };
}
export const enumSchema = (values: string[]) => ({ type: "string", enum: values });
