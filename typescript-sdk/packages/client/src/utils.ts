export const structuredClone_ = (obj: any) => {
  if (typeof structuredClone === "function") {
    return structuredClone(obj);
  }

  try {
    return JSON.parse(JSON.stringify(obj));
  } catch (err) {
    return { ...obj };
  }
};
