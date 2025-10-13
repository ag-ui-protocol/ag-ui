import { useEffect, useState } from "react";

export function useIsInsideIframe() {
  const [isInside, setIsInside] = useState(false);

  useEffect(() => {
    const check = () => {
      // Check if the window is a self-reference and not the top-level window
      setIsInside(window.self !== window.top);
    };
    check();
    // Optionally, you could add an event listener for resize if the iframe behavior needs to be tracked dynamically.
  }, []);

  return isInside;
}
