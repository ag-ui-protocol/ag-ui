export const structuredClone_ = <T>(obj: T): T => {
  if (typeof structuredClone === "function") {
    return structuredClone(obj);
  }

  try {
    return JSON.parse(JSON.stringify(obj));
  } catch (err) {
    return { ...obj } as T;
  }
};
