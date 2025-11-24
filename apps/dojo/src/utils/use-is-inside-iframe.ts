import { useEffect, useState } from "react";

export function useIsInsideIframe() {
  const [isInside, setIsInside] = useState(false);

  useEffect(() => {
    const check = () => {
      setIsInside(window.self !== window.top);
    };
    check();
  }, []);

  return isInside;
}

// returns true if the iframe is inside a copilotkit.com or localhost (for local internal development)
export function useIsInsideCpkFrame(): boolean {
  const isInsideIframe = useIsInsideIframe();
  if (!isInsideIframe || typeof document === "undefined") return false;
  const referrer = document.referrer ?? "";
  const isInsideCpkFrame =
    referrer.includes("copilotkit.com") || referrer.includes("localhost");
  return isInsideCpkFrame;
}
