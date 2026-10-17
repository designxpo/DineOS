// Settings come from MEZMITRA_<NAME>, or from DINEOS_<NAME>, the product's earlier name, which
// print computers installed before the rename still have.
export const env = (name: string): string | undefined => process.env[`MEZMITRA_${name}`] ?? process.env[`DINEOS_${name}`];
