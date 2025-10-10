"use client";

import React, { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { View } from "@/types/interface";

interface URLParamsState {
  view: View;
  sidebarHidden: boolean;
  frameworkPickerHidden: boolean;
  viewPickerHidden: boolean;
  featurePickerHidden: boolean;
  file?: string;
  codeLayout: "sidebar" | "tabs";
}

interface URLParamsContextType extends URLParamsState {
  setView: (view: View) => void;
  setSidebarHidden: (disabled: boolean) => void;
  setFrameworkPickerHidden: (disabled: boolean) => void;
  setViewPickerHidden: (disabled: boolean) => void;
  setFeaturePickerHidden: (disabled: boolean) => void;
  setCodeFile: (fileName: string) => void;
  setCodeLayout: (layout: "sidebar" | "tabs") => void;
}

const URLParamsContext = createContext<URLParamsContextType | undefined>(undefined);

interface URLParamsProviderProps {
  children: ReactNode;
}

export function URLParamsProvider({ children }: URLParamsProviderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Initialize state from URL params
  const [state, setState] = useState<URLParamsState>(() => ({
    view: (searchParams.get("view") as View) || "preview",
    sidebarHidden: searchParams.get("sidebar") === "false",
    frameworkPickerHidden: searchParams.get("frameworkPicker") === "false",
    viewPickerHidden: searchParams.get("viewPicker") === "false",
    featurePickerHidden: searchParams.get("featurePicker") === "false",
    codeLayout: (searchParams.get("codeLayout") as "sidebar" | "tabs") || "sidebar",
  }));

  // Update URL when state changes
  const updateURL = (newState: Partial<URLParamsState>) => {
    const params = new URLSearchParams(searchParams.toString());

    // Update view param
    if (newState.view !== undefined) {
      if (newState.view === "preview") {
        params.delete("view"); // Remove default value to keep URL clean
      } else {
        params.set("view", newState.view);
      }
    }

    // Update sidebar param
    if (newState.sidebarHidden !== undefined) {
      if (newState.sidebarHidden) {
        params.set("sidebar", "false");
      } else {
        params.delete("sidebar");
      }
    }

    // Update frameworkPicker param
    if (newState.frameworkPickerHidden !== undefined) {
      if (newState.frameworkPickerHidden) {
        params.set("frameworkPicker", "false");
      } else {
        params.delete("frameworkPicker");
      }
    }

    // Update viewPicker param
    if (newState.viewPickerHidden !== undefined) {
      if (newState.viewPickerHidden) {
        params.set("viewPicker", "false");
      } else {
        params.delete("viewPicker");
      }
    }
    // Update featurePicker param
    if (newState.featurePickerHidden !== undefined) {
      if (newState.featurePickerHidden) {
        params.set("featurePicker", "false");
      } else {
        params.delete("features");
      }
    }

    // Update codeLayout param
    if (newState.codeLayout !== undefined) {
      if (newState.codeLayout === "sidebar") {
        params.delete("codeLayout");
      } else {
        params.set("codeLayout", newState.codeLayout);
      }
    }

    // Update file param
    if (newState.file !== undefined) {
      params.set("file", newState.file);
    }

    const queryString = params.toString();
    router.push(pathname + (queryString ? "?" + queryString : ""));
  };

  // Sync state with URL changes (e.g., browser back/forward)
  useEffect(() => {
    const newState: URLParamsState = {
      view: (searchParams.get("view") as View) || "preview",
      sidebarHidden: searchParams.get("sidebar") === "false",
      frameworkPickerHidden: searchParams.get("frameworkPicker") === "false",
      viewPickerHidden: searchParams.get("viewPicker") === "false",
      featurePickerHidden: searchParams.get("featurePicker") === "false",
      file: searchParams.get("file") || undefined,
      codeLayout: (searchParams.get("codeLayout") as "sidebar" | "tabs") || "sidebar",
    };

    setState(newState);
  }, [searchParams]);

  // Context methods
  const setView = (view: View) => {
    const newState = { ...state, view };
    setState(newState);
    updateURL({ view });
  };

  const setSidebarHidden = (sidebarHidden: boolean) => {
    const newState = { ...state, sidebarHidden };
    setState(newState);
    updateURL({ sidebarHidden });
  };

  const setFrameworkPickerHidden = (frameworkPickerHidden: boolean) => {
    const newState = { ...state, frameworkPickerHidden };
    setState(newState);
    updateURL({ frameworkPickerHidden });
  };

  const setViewPickerHidden = (viewPickerHidden: boolean) => {
    const newState = { ...state, viewPickerHidden };
    setState(newState);
    updateURL({ viewPickerHidden });
  };

  const setFeaturePickerHidden = (featurePickerHidden: boolean) => {
    const newState = { ...state, featurePickerHidden };
    setState(newState);
    updateURL({ featurePickerHidden });
  };

  const setCodeFile = (fileName: string) => {
    const newState = { ...state, file: fileName };
    setState(newState);
    updateURL({ file: fileName });
  };

  const setCodeLayout = (codeLayout: "sidebar" | "tabs") => {
    const newState = { ...state, codeLayout };
    setState(newState);
    updateURL({ codeLayout });
  };

  const contextValue: URLParamsContextType = {
    ...state,
    setView,
    setSidebarHidden,
    setFrameworkPickerHidden,
    setViewPickerHidden,
    setFeaturePickerHidden,
    setCodeFile,
    setCodeLayout,
  };

  return <URLParamsContext.Provider value={contextValue}>{children}</URLParamsContext.Provider>;
}

export function useURLParams(): URLParamsContextType {
  const context = useContext(URLParamsContext);
  if (context === undefined) {
    throw new Error("useURLParams must be used within a URLParamsProvider");
  }
  return context;
}
