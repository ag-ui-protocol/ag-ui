'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { View } from "@/types/interface";

interface URLParamsState {
  view: View;
  sidebarHidden: boolean;
  pickerDisabled: boolean;
  file?: string;
}

interface URLParamsContextType extends URLParamsState {
  setView: (view: View) => void;
  setSidebarHidden: (disabled: boolean) => void;
  setPickerDisabled: (disabled: boolean) => void;
  setCodeFile: (fileName: string) => void;
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
    sidebarHidden: searchParams.get("sidebar") === "disabled",
    pickerDisabled: searchParams.get("picker") === "false",
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
        params.set("sidebar", "disabled");
      } else {
        params.delete("sidebar");
      }
    }
    
    // Update picker param
    if (newState.pickerDisabled !== undefined) {
      if (newState.pickerDisabled) {
        params.set("picker", "false");
      } else {
        params.delete("picker");
      }
    }

    const queryString = params.toString();
    router.push(pathname + (queryString ? '?' + queryString : ''));
  };

  // Sync state with URL changes (e.g., browser back/forward)
  useEffect(() => {
    const newState: URLParamsState = {
      view: (searchParams.get("view") as View) || "preview",
      sidebarHidden: searchParams.get("sidebar") === "disabled",
      pickerDisabled: searchParams.get("picker") === "false",
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

  const setPickerDisabled = (pickerDisabled: boolean) => {
    const newState = { ...state, pickerDisabled };
    setState(newState);
    updateURL({ pickerDisabled });
  };

  const setCodeFile = (fileName: string) => {
    const newState = { ...state, file: fileName };
    setState(newState);
    updateURL({ file: fileName });
  };

  const contextValue: URLParamsContextType = {
    ...state,
    setView,
    setSidebarHidden,
    setPickerDisabled,
    setCodeFile,
  };

  return (
    <URLParamsContext.Provider value={contextValue}>
      {children}
    </URLParamsContext.Provider>
  );
}

export function useURLParams(): URLParamsContextType {
  const context = useContext(URLParamsContext);
  if (context === undefined) {
    throw new Error('useURLParams must be used within a URLParamsProvider');
  }
  return context;
}
